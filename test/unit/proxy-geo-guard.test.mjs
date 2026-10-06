import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { ProxyGeoGuard } from '../../src/lib/vm/proxy-geo-guard.mjs'
import { ProxyGeoChecksRepo } from '../../src/lib/db/repos/proxy-geo-checks-repo.mjs'

const geo = (country_code, region = 'R') => ({ ok: true, geo: { country_code, region, ip: '1.2.3.4' } })

test('巡检：基准、同国家、变化去重、错误、恢复与确认', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-guard-'))
  const db = createDatabase({ dataDir: dir })
  try {
    let next = geo('JP', 'Tokyo')
    const pool = new ProxyPool({ db, geoLookup: async () => next })
    pool.importLines('127.0.0.1:1080')
    const p = pool.state.proxies[0]
    p.bound_vm_id = 'vm-a'
    p.bound_vm_ids = ['vm-a']
    pool.save()
    const events = []
    const recovered = []
    const guard = new ProxyGeoGuard({
      pool,
      now: () => Date.parse('2026-01-01T00:00:00Z'),
      onGeoChanged: (_p, bound, info) => events.push([bound, info]),
      onRecovered: (_p, bound) => recovered.push(bound),
    })
    assert.equal((await guard.run()).baseline, 1)
    assert.equal(p.geo_base_country_code, 'JP')
    next = geo('JP', 'Osaka')
    assert.equal((await guard.run()).same, 1)
    next = geo('US', 'CA')
    await guard.run()
    await guard.run()
    assert.equal(events.length, 1)
    assert.deepEqual(events[0][0], ['vm-a'])
    next = geo('DE', 'Berlin')
    await guard.run()
    assert.equal(events.length, 2)
    next = { ok: false, error: 'timeout' }
    await guard.run()
    assert.equal(p.geo_guard_status, 'error')
    next = geo('DE', 'Berlin')
    await guard.run()
    assert.equal(events.length, 2)
    next = { ok: false, error: 'timeout' }
    await guard.run()
    assert.equal(p.geo_base_country_code, 'JP')
    next = geo('JP', 'Tokyo')
    await guard.run()
    assert.equal(p.geo_guard_status, 'ok')
    // A previously changed proxy can recover even if an error intervenes.
    assert.equal(recovered.length, 1)
    next = geo('US', 'NY')
    await guard.run()
    assert.equal(guard.confirm(p.id).ok, true)
    assert.equal(p.geo_base_country_code, 'US')
    assert.equal(new ProxyGeoChecksRepo(db).list({ result: 'baseline' }).items.length, 2)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('巡检日志分页及清理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-log-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new ProxyGeoChecksRepo(db)
    repo.insert({ proxy_id: 'a', checked_at: '2000-01-01T00:00:00Z', result: 'same' })
    repo.insert({ proxy_id: 'a', checked_at: '2026-01-01T00:00:00Z', result: 'changed' })
    repo.insert({ proxy_id: 'b', checked_at: '2026-01-01T00:00:00Z', result: 'same' })
    const first = repo.list({ limit: 1 })
    assert.equal(repo.list({ before_id: first.next_before_id, limit: 1 }).items.length, 1)
    assert.equal(repo.list({ proxy_id: 'a', result: 'changed' }).items.length, 1)
    repo.prune(Date.parse('2026-01-02T00:00:00Z'))
    assert.equal(repo.list().items.length, 2)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
