import { getDb } from '../database.mjs'

const COLUMNS = [
  'proxy_id',
  'proxy_label',
  'checked_at',
  'ok',
  'ip',
  'country_code',
  'country',
  'region',
  'city',
  'isp',
  'timezone',
  'latency_ms',
  'result',
  'base_country_code',
  'base_region',
  'action',
  'error',
]

export class ProxyGeoChecksRepo {
  constructor(db) {
    try {
      this.db = db || getDb()
      this.insertStmt = this.db.prepare(
        `INSERT INTO proxy_geo_checks (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
      )
    } catch {
      this.db = null
    }
  }

  insert(row) {
    if (!this.db) return null
    return this.insertStmt.run(...COLUMNS.map((key) => row[key] ?? null)).lastInsertRowid
  }

  list({ proxy_id, result, limit = 50, before_id } = {}) {
    if (!this.db) return { items: [], next_before_id: null }
    const count = Math.min(500, Math.max(1, Number(limit) || 50))
    const where = []
    const args = []
    if (proxy_id) {
      where.push('proxy_id = ?')
      args.push(proxy_id)
    }
    if (result) {
      where.push('result = ?')
      args.push(result)
    }
    if (Number(before_id) > 0) {
      where.push('id < ?')
      args.push(Number(before_id))
    }
    const items = this.db
      .prepare(
        `SELECT * FROM proxy_geo_checks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, count + 1)
    const more = items.length > count
    if (more) items.pop()
    return { items, next_before_id: more ? items.at(-1).id : null }
  }

  prune(now = Date.now()) {
    if (!this.db) return
    this.db
      .prepare('DELETE FROM proxy_geo_checks WHERE checked_at < ?')
      .run(new Date(now - 7 * 86400_000).toISOString())
    this.db.exec(
      'DELETE FROM proxy_geo_checks WHERE id NOT IN (SELECT id FROM proxy_geo_checks ORDER BY id DESC LIMIT 20000)',
    )
  }
}
