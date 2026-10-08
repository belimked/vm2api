import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'

const MIGRATIONS = path.resolve(import.meta.dirname, '../../src/lib/db/migrations')

test('geo guard applied as 030 is re-keyed to 900 so upstream 030/031 still apply', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-mig-'))
  const oldDir = path.join(tmp, 'old-migrations')
  fs.mkdirSync(oldDir)
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (!/^\d+.*\.sql$/.test(f) || f >= '030') continue
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(oldDir, f))
  }
  fs.copyFileSync(path.join(MIGRATIONS, '900_proxy_geo_guard.sql'), path.join(oldDir, '030_proxy_geo_guard.sql'))
  const dataDir = path.join(tmp, 'data')
  try {
    createDatabase({ dataDir, migrationsDir: oldDir }).close()

    const db = createDatabase({ dataDir })
    try {
      const rows = db
        .prepare("SELECT version, name FROM schema_migrations WHERE version >= '030' ORDER BY version")
        .all()
      assert.deepEqual(
        rows.map((r) => [r.version, r.name]),
        [
          ['030', '030_refusal_near.sql'],
          ['031', '031_usage_logs_intercept.sql'],
          ['900', '900_proxy_geo_guard.sql'],
        ],
      )
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'refusal_device_blocks'").get())
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'proxy_geo_checks'").get())
    } finally {
      db.close()
    }

    createDatabase({ dataDir }).close()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('fresh database applies geo guard as 900', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-mig-fresh-'))
  try {
    const db = createDatabase({ dataDir })
    const row = db.prepare("SELECT name FROM schema_migrations WHERE version = '900'").get()
    db.close()
    assert.equal(row?.name, '900_proxy_geo_guard.sql')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
