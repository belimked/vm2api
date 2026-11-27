import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  BodyArchive,
  bodyArchiveReasons,
  looksLikeAutoModeClassifier,
  normalizeBodyArchiveConfig,
  safeArchiveId,
} from '../../src/lib/admin/body-archive.mjs'
import { RequestLogStore, normalizeLoggingConfig } from '../../src/lib/admin/request-log.mjs'

const MARK = 'You are a security monitor for autonomous AI coding agents.\n\n## Context'

function tmpDir(prefix = 'kin-barc-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  return fn()
}

function readArchive(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
}

test('normalizeBodyArchiveConfig: off by default, 3 days, 3 GB, clamped', () => {
  assert.deepEqual(normalizeBodyArchiveConfig(undefined), { enabled: false, retain_days: 3, max_mb: 3072 })
  assert.deepEqual(normalizeBodyArchiveConfig({ enabled: 'yes', retain_days: 0, max_mb: -5 }), {
    enabled: false,
    retain_days: 1,
    max_mb: 0,
  })
  assert.deepEqual(normalizeBodyArchiveConfig({ enabled: true, retain_days: 500, max_mb: 10 }), {
    enabled: true,
    retain_days: 90,
    max_mb: 10,
  })
  assert.deepEqual(normalizeLoggingConfig({}).body_archive, { enabled: false, retain_days: 3, max_mb: 3072 })
})

test('safeArchiveId strips path characters from client-supplied ids', () => {
  assert.equal(safeArchiveId('b19a5ea0-c088-4625-934b-58a9aed8f1b8'), 'b19a5ea0-c088-4625-934b-58a9aed8f1b8')
  assert.equal(safeArchiveId('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(safeArchiveId('..'), null)
  assert.equal(safeArchiveId(''), null)
})

test('bodyArchiveReasons: classifier, non-200, Usage Policy on 200', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  assert.deepEqual(bodyArchiveReasons({ status: 200, inbound_body: body }, { body: 'ok' }), [])
  assert.deepEqual(
    bodyArchiveReasons({ status: 200, inbound_body: body, classifier: { purpose: 'auto_mode_classifier' } }),
    ['classifier'],
  )
  // Classifier tag missing (detection gap): fall back to the system prompt.
  assert.equal(looksLikeAutoModeClassifier({ system: [{ type: 'text', text: 'x-anthropic-billing-header' }, { type: 'text', text: MARK }] }), true)
  assert.equal(looksLikeAutoModeClassifier({ system: MARK }), true)
  assert.deepEqual(bodyArchiveReasons({ status: 200, inbound_body: { system: MARK } }), ['classifier'])
  assert.deepEqual(bodyArchiveReasons({ status: 429, inbound_body: body }), ['status'])
  assert.deepEqual(bodyArchiveReasons({ status: null, inbound_body: body }), ['status'])
  assert.deepEqual(
    bodyArchiveReasons(
      { status: 200, inbound_body: body },
      { body: 'data: {"text":"appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)"}' },
    ),
    ['usage_policy'],
  )
  assert.deepEqual(bodyArchiveReasons({ status: 200, inbound_body: body, stop_reason: 'refusal' }), ['usage_policy'])
  assert.deepEqual(
    bodyArchiveReasons({
      status: 400,
      inbound_body: { system: MARK },
      error_message: 'API Error: ... violate our Usage Policy',
    }),
    ['classifier', 'status', 'usage_policy'],
  )
})

test('RequestLogStore archives classifier bodies even in normal mode, redacted and gzip', async () => {
  const dataDir = tmpDir()
  const store = new RequestLogStore({ dataDir, mode: 'normal' })
  store.setConfig({ bodyArchive: { enabled: true } })
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
  assert.equal(ctx.archive_bodies, true)
  const body = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: MARK }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<transcript> key sk-ant-api03-abcdefghijklmnop </transcript>' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4000) } },
        ],
      },
    ],
  }
  const summary = store.finish(ctx, {
    status: 400,
    model: 'claude-opus-5-5',
    inbound_body: body,
    classifier: { purpose: 'auto_mode_classifier', stage: 'xml_s2' },
    error_message: 'API Error: Claude Code is unable to respond ... Usage Policy',
  })
  const hit = await waitFor(() => store.bodyArchiveFile(summary.request_id, summary.ts))
  assert.ok(hit, 'archive file written')
  assert.equal(hit.file, path.join(dataDir, 'request-logs', 'bodies', summary.ts.slice(0, 10), `${summary.request_id}.json.gz`))
  assert.equal(fs.statSync(hit.file).mode & 0o777, 0o600)
  const saved = readArchive(hit.file)
  assert.deepEqual(saved.meta.reasons, ['classifier', 'status', 'usage_policy'])
  assert.equal(saved.meta.request_id, summary.request_id)
  assert.equal(saved.meta.classifier.stage, 'xml_s2')
  const text = JSON.stringify(saved.inbound_body)
  assert.equal(text.includes('<transcript>'), true, 'full transcript kept')
  assert.equal(text.includes('abcdefghijklmnop'), false, 'secrets masked')
  assert.equal(text.includes('A'.repeat(100)), false, 'image payload summarized')
  assert.deepEqual(store.bodyArchiveInfo(summary.request_id, null)?.bytes, hit.bytes)
})

test('RequestLogStore skips ordinary 200s, and everything when disabled', async () => {
  const dataDir = tmpDir()
  const store = new RequestLogStore({ dataDir, mode: 'debug' })
  const off = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  assert.equal(off.archive_bodies, false)
  const s0 = store.finish(off, { status: 500, inbound_body: { messages: [] } })
  store.setConfig({ bodyArchive: { enabled: true } })
  const ok = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  ok.response = { status: 200, body: 'data: {"type":"message_stop"}', bytes: 10, truncated: false }
  const s1 = store.finish(ok, { status: 200, inbound_body: { messages: [{ role: 'user', content: 'hi' }] } })
  const bad = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  const s2 = store.finish(bad, { status: 503, inbound_body: { messages: [{ role: 'user', content: 'hi' }] } })
  assert.ok(await waitFor(() => store.bodyArchiveFile(s2.request_id, s2.ts)))
  assert.equal(store.bodyArchiveFile(s0.request_id, s0.ts), null)
  assert.equal(store.bodyArchiveFile(s1.request_id, s1.ts), null)
  // Debug record keeps the classifier contract (no body in the DB) but flags the file.
  const cls = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  const s3 = store.finish(cls, {
    status: 200,
    inbound_body: { system: MARK, messages: [{ role: 'user', content: 'sensitive transcript' }] },
    classifier: { purpose: 'auto_mode_classifier' },
  })
  const [debug] = store.listDebug({ limit: 1 })
  assert.equal(debug.request_id, s3.request_id)
  assert.equal(debug.inbound_body, null)
  assert.deepEqual(debug.body_archive, { reasons: ['classifier'] })
  assert.ok(await waitFor(() => store.bodyArchiveFile(s3.request_id, s3.ts)))
})

test('BodyArchive.cleanup: retention by mtime, whole old days, stale tmp, size cap from oldest', () => {
  const dir = tmpDir()
  const archive = new BodyArchive({ dir, config: { enabled: true, retain_days: 3, max_mb: 1 } })
  const now = Date.parse('2026-11-27T12:00:00Z')
  const put = (day, name, bytes, ageMs) => {
    fs.mkdirSync(path.join(dir, day), { recursive: true })
    const file = path.join(dir, day, name)
    fs.writeFileSync(file, Buffer.alloc(bytes))
    const t = (now - ageMs) / 1000
    fs.utimesSync(file, t, t)
    return file
  }
  const ancient = put('2026-11-01', 'a.json.gz', 10, 26 * 86400_000)
  const expired = put('2026-11-24', 'b.json.gz', 10, 3 * 86400_000 + 60_000)
  const tmp = put('2026-11-27', 'x.json.gz.1.2.tmp', 10, 2 * 3600_000)
  const old1 = put('2026-11-25', 'c.json.gz', 600 * 1024, 2 * 86400_000)
  const old2 = put('2026-11-26', 'd.json.gz', 600 * 1024, 86400_000)
  const fresh = put('2026-11-27', 'e.json.gz', 600 * 1024, 60_000)
  const snap = archive.cleanup(now)
  assert.equal(fs.existsSync(path.join(dir, '2026-11-01')), false, 'old day dir removed')
  assert.equal(fs.existsSync(ancient), false)
  assert.equal(fs.existsSync(expired), false, 'older than retain_days by mtime')
  assert.equal(fs.existsSync(path.join(dir, '2026-11-24')), false, 'empty day dir removed')
  assert.equal(fs.existsSync(tmp), false, 'stale tmp removed')
  assert.equal(fs.existsSync(old1), false, 'cap deletes oldest first')
  assert.equal(fs.existsSync(old2), false)
  assert.equal(fs.existsSync(fresh), true)
  assert.equal(snap.used_bytes, 600 * 1024)
  assert.equal(snap.file_count, 1)
  // Disabled archives still age out.
  archive.setConfig({ enabled: false, retain_days: 1, max_mb: 0 })
  archive.cleanup(now + 2 * 86400_000)
  assert.equal(fs.existsSync(fresh), false)
})

test('BodyArchive.write refuses when disabled and finds files without ts', async () => {
  const dir = tmpDir()
  const archive = new BodyArchive({ dir })
  assert.equal(await archive.write({ requestId: 'r1', ts: '2026-11-27T08:20:35.451Z', bodyJson: '{}' }), null)
  archive.setConfig({ enabled: true })
  const out = await archive.write({ requestId: 'r1', ts: '2026-11-27T08:20:35.451Z', meta: { a: 1 }, bodyJson: '{"x":1}' })
  assert.equal(out.day, '2026-11-27')
  assert.deepEqual(readArchive(out.file), { meta: { a: 1 }, inbound_body: { x: 1 } })
  assert.equal(archive.find('r1')?.file, out.file)
  assert.equal(archive.find('r1', '2026-11-20T00:00:00Z')?.file, out.file)
  assert.equal(archive.find('missing'), null)
})
