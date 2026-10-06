import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { ProxyGeoGuard } from '../../src/lib/vm/proxy-geo-guard.mjs'
import { ProxiesRepo } from '../../src/lib/db/repos/proxies-repo.mjs'

test('配置校验、无绑定及禁用代理跳过、并发保护', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-guard-config-'))
  const db = createDatabase({ dataDir: dir })
  try {
    new ProxiesRepo(db).setConfig({ geo_guard_match: 'region' })
    let release
    let calls = 0
    let wait = false
    const pool = new ProxyPool({
      db,
      geoLookup: async () => {
        calls++
        if (wait)
          await new Promise((resolve) => {
            release = resolve
          })
        return { ok: true, geo: { country_code: 'JP', region: calls === 1 ? 'Tokyo' : 'Osaka' } }
      },
    })
    assert.equal(pool.state.config.geo_guard_enabled, false)
    assert.equal(Object.hasOwn(pool.state.config, 'geo_guard_match'), false)
    assert.equal(pool.updateConfig({ geo_guard_match: 'region' }).ok, true)
    assert.equal(Object.hasOwn(pool.snapshot().config, 'geo_guard_match'), false)
    assert.equal(pool.updateConfig({ geo_guard_interval_sec: 1 }).config.geo_guard_interval_sec, 60)
    assert.equal(pool.updateConfig({ geo_guard_interval_sec: 999999 }).config.geo_guard_interval_sec, 86400)
    assert.equal(pool.updateConfig({ geo_guard_interval_sec: 1.5 }).ok, false)
    assert.equal(pool.updateConfig({ geo_guard_action: 'pause' }).ok, false)
    assert.equal(pool.updateConfig({ geo_guard_enabled: 'true' }).ok, false)
    pool.importLines('127.0.0.1:1080\n127.0.0.2:1080')
    const p = pool.state.proxies[0]
    p.bound_vm_id = 'vm-a'
    p.bound_vm_ids = ['vm-a']
    const events = []
    const guard = new ProxyGeoGuard({ pool, onGeoChanged: () => events.push('changed') })
    assert.equal((await guard.run()).checked, 1)
    assert.equal((await guard.run()).same, 1)
    assert.equal(events.length, 0)
    p.enabled = false
    assert.equal((await guard.run()).checked, 0)
    p.enabled = true
    p.host = '::1'
    p.port = 1080
    pool.state.config.ipv6_enabled = false
    assert.equal((await guard.run()).checked, 0)
    p.host = '127.0.0.1'
    wait = true
    const active = guard.run()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await guard.run()).error, 'already_running')
    release()
    await active
    assert.equal(calls, 3)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
