import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyJevPatch,
  classifyJevSession,
  clearJevLongVerdicts,
  headTail,
  normalizeJevConfig,
  publicJevConfig,
} from '../../src/lib/protocol/jev-intercept.mjs'

const M = 2000
const cfg = (extra = {}) => ({
  enabled: true,
  base_url: 'https://jev.test',
  api_key: 'k',
  dedup_sec: 0,
  max_state_chars: M,
  question_ids: ['usage_policy'],
  ...extra,
})

/** Records every state sent; any state containing a word in `bad` scores unsafe. */
function fakeJev(bad = []) {
  const states = []
  const fetchImpl = async (_url, init) => {
    const { state } = JSON.parse(init.body)
    states.push(state)
    const noul = bad.some((word) => state.includes(word)) ? 0.05 : 0.95
    return { ok: true, status: 200, json: async () => ({ answers: { usage_policy: { type: 'noul', noul } } }) }
  }
  return { states, fetchImpl }
}

const filler = (n, seed = 'x') => Array.from({ length: n }, (_, i) => `${seed}${i % 10}`).join('').slice(0, n)
const ask = (...texts) => ({ messages: texts.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })) })

test('headTail keeps head and tail inside the cap', () => {
  const text = `HEAD${filler(5000)}TAIL`
  const out = headTail(text, 1000)
  assert.ok(out.length <= 1000)
  assert.ok(out.startsWith('HEAD'))
  assert.ok(out.endsWith('TAIL'))
  assert.match(out, /…\[省略 \d+ 字\]…/)
  assert.equal(headTail('short', 1000), 'short')
})

test('short conversations are sent unchanged in one call', async () => {
  clearJevLongVerdicts()
  const jev = fakeJev()
  const verdict = await classifyJevSession(ask('hello', 'hi', 'how are you'), undefined, cfg(), jev.fetchImpl)
  assert.equal(verdict.action, 'pass')
  assert.equal(jev.states.length, 1)
  assert.match(jev.states[0], /^\[user message 1\]\nhello\n\[user message 3\]\nhow are you\n\[current ask\]/)
})

test('the start of a long history paste now reaches Jev', async () => {
  clearJevLongVerdicts()
  const jev = fakeJev(['secret_start'])
  const paste = `secret_start ${filler(6000)} paste end`
  const verdict = await classifyJevSession(ask(paste, 'ok', 'why was it blocked'), undefined, cfg(), jev.fetchImpl)
  assert.equal(jev.states.length, 1)
  assert.ok(jev.states[0].length <= M)
  assert.ok(jev.states[0].includes('secret_start'))
  assert.ok(jev.states[0].endsWith('why was it blocked'))
  assert.equal(verdict.action, 'block')
})

test('duplicate pastes collapse to the latest copy', async () => {
  clearJevLongVerdicts()
  const jev = fakeJev()
  const paste = `P${filler(3000)}`
  await classifyJevSession(ask(paste, 'a', paste, 'b', 'now'), undefined, cfg(), jev.fetchImpl)
  assert.equal(jev.states.length, 1)
  assert.ok(!jev.states[0].includes('[user message 1]'))
  assert.ok(jev.states[0].includes('[user message 3]'))
})

test('a long current message is audited in overlapping windows; any failing window blocks', async () => {
  clearJevLongVerdicts()
  const jev = fakeJev(['needle'])
  const body = `${filler(3000, 'a')}needle${filler(2000, 'b')}`
  const verdict = await classifyJevSession(ask(body), undefined, cfg(), jev.fetchImpl)
  assert.ok(jev.states.length >= 3 && jev.states.length <= 4)
  for (const state of jev.states) assert.ok(state.length <= M)
  assert.match(jev.states[0], /第 1\/\d 段\]/)
  assert.equal(verdict.action, 'block')
  assert.equal(verdict.windows, jev.states.length)
  assert.ok(verdict.state.includes('needle'))
})

test('windows cover the whole message within the cap, else head windows plus the tail', async () => {
  clearJevLongVerdicts()
  const covered = fakeJev()
  const body = filler(5000)
  await classifyJevSession(ask(body), undefined, cfg(), covered.fetchImpl)
  const seen = covered.states.map((s) => s.slice(s.indexOf('段]\n') + 3)).join('')
  for (let i = 0; i < body.length; i += 997) assert.ok(seen.includes(body.slice(i, i + 3)))

  clearJevLongVerdicts()
  const capped = fakeJev(['ztail'])
  const verdict = await classifyJevSession(ask(`${filler(20000)}ztail`), undefined, cfg({ long_windows: 3 }), capped.fetchImpl)
  assert.equal(capped.states.length, 3)
  assert.equal(verdict.action, 'block')
  assert.equal(verdict.window, 3)
})

test('a blocked long paste stays blocked in later turns without calling Jev', async () => {
  clearJevLongVerdicts()
  const jev = fakeJev(['needle'])
  const paste = `${filler(2500)}needle${filler(2500)}`
  const first = await classifyJevSession(ask(paste), undefined, cfg(), jev.fetchImpl)
  assert.equal(first.action, 'block')
  const calls = jev.states.length
  const later = await classifyJevSession(ask(paste, 'refused', 'why was this blocked'), undefined, cfg(), jev.fetchImpl)
  assert.equal(later.action, 'block')
  assert.equal(later.reason, 'replay')
  assert.equal(jev.states.length, calls)
})

test('a passed long paste is not windowed again once it is history', async () => {
  clearJevLongVerdicts()
  const jev = fakeJev()
  const paste = filler(6000)
  assert.equal((await classifyJevSession(ask(paste), undefined, cfg(), jev.fetchImpl)).action, 'pass')
  assert.ok(jev.states.length > 1)
  const calls = jev.states.length
  await classifyJevSession(ask(paste, 'ok', 'next question'), undefined, cfg(), jev.fetchImpl)
  assert.equal(jev.states.length, calls + 1)
  await classifyJevSession(ask(paste), undefined, cfg(), jev.fetchImpl)
  assert.equal(jev.states.length, calls + 2)
})

test('long_windows 1 turns windowing off', async () => {
  clearJevLongVerdicts()
  const jev = fakeJev()
  await classifyJevSession(ask(filler(6000)), undefined, cfg({ long_windows: 1 }), jev.fetchImpl)
  assert.equal(jev.states.length, 1)
  assert.ok(jev.states[0].length <= M)
})

test('fail-open window errors pass, fail-closed block, neither is cached', async () => {
  clearJevLongVerdicts()
  let n = 0
  const flaky = async () => {
    n++
    if (n === 2) throw new Error('down')
    return { ok: true, status: 200, json: async () => ({ answers: { usage_policy: { type: 'noul', noul: 0.95 } } }) }
  }
  const body = filler(6000)
  const open = await classifyJevSession(ask(body), undefined, cfg(), flaky)
  assert.equal(open.action, 'pass')
  assert.equal(open.reason, 'unavailable')
  n = 0
  const closed = await classifyJevSession(ask(body), undefined, cfg({ fail_open: false }), flaky)
  assert.equal(closed.action, 'block')
  assert.equal(closed.reason, 'unavailable')
})

test('long_windows is normalised, validated and exposed', () => {
  assert.equal(normalizeJevConfig({}).long_windows, 4)
  assert.equal(normalizeJevConfig({ long_windows: 6 }).long_windows, 6)
  assert.equal(normalizeJevConfig({ long_windows: 0 }).long_windows, 4)
  assert.equal(publicJevConfig({ long_windows: 2 }).long_windows, 2)
  assert.equal(publicJevConfig({}).defaults.long_windows, 4)
  const store = new Map()
  const settings = { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) }
  assert.equal(applyJevPatch(settings, { long_windows: 9 }).ok, false)
  assert.equal(applyJevPatch(settings, { long_windows: 3 }).ok, true)
  assert.equal(publicJevConfig(store.get('jev_intercept')).long_windows, 3)
})
