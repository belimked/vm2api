import { ProxyGeoChecksRepo } from '../db/repos/proxy-geo-checks-repo.mjs'
import { boundVmIdsOf } from './proxy-pool.mjs'
import { isLocalEgressProxy } from './egress.mjs'
import { proxyBlockedReason } from './proxy-policy.mjs'

export const GEO_FAIL_PAUSE_THRESHOLD = 5
export const GEO_RECOVER_CHECKS = 2

export class ProxyGeoGuard {
  constructor({ pool, repo, onGeoChanged, onRecovered, onUnreachable, onReachable, now = () => Date.now() }) {
    this.pool = pool
    this.repo = repo || new ProxyGeoChecksRepo(pool.db)
    this.onGeoChanged = onGeoChanged
    this.onRecovered = onRecovered
    this.onUnreachable = onUnreachable
    this.onReachable = onReachable
    this.now = now
    this.timer = null
    this.running = false
    this.lastChanged = new Map()
    this.failStreak = new Map()
    this.okStreak = new Map()
  }

  restart() {
    this.stop()
    if (!this.pool.state.config.geo_guard_enabled) return
    const interval = Math.min(86400, Math.max(60, Number(this.pool.state.config.geo_guard_interval_sec) || 300))
    this.timer = setInterval(() => {
      void this.run().catch((error) => console.error('[geo-guard]', error))
    }, interval * 1000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async run() {
    if (this.running) return { ok: false, error: 'already_running' }
    this.running = true
    const summary = { ok: true, checked: 0, baseline: 0, same: 0, changed: 0, error: 0 }
    try {
      for (const p of this.pool.state.proxies) {
        if (!p.enabled || proxyBlockedReason(p, this.pool.state.config.ipv6_enabled)) continue
        const bound = boundVmIdsOf(p)
        if (!bound.length) continue
        const start = this.now()
        let response
        try {
          response = await this.pool.geoLookup(isLocalEgressProxy(p) ? '' : this.pool._withAuth(p).url, {
            timeoutMs: this.pool.state.config.geo_timeout_ms,
          })
        } catch (error) {
          response = { ok: false, error: String(error?.message || error) }
        }
        const checkedAt = new Date(this.now()).toISOString()
        const previous = p.geo_guard_status
        const previousReason = p.geo_guard_reason
        const baseCountry = String(p.geo_base_country_code || '')
          .trim()
          .toUpperCase()
        const baseRegion = p.geo_base_region
        const geo = response?.geo || {}
        const country = String(geo.country_code || '')
          .trim()
          .toUpperCase()
        let result
        let action = null
        this.pool._applyGeoResult(p, response)
        p.geo_guard_checked_at = checkedAt
        const pauseMode = this.pool.state.config.geo_guard_action === 'notify_pause'
        if (!response?.ok || !country) {
          result = 'error'
          const failures = (this.failStreak.get(p.id) || 0) + 1
          this.failStreak.set(p.id, failures)
          this.okStreak.delete(p.id)
          p.geo_guard_reason = String(response?.error || 'missing_country_code').slice(0, 200)
          if (previous === 'unreachable') {
            p.geo_guard_status = 'unreachable'
          } else if (failures >= GEO_FAIL_PAUSE_THRESHOLD) {
            p.geo_guard_status = 'unreachable'
            action = pauseMode ? `paused:${bound.join(',')}` : 'notified'
            action =
              (await this.onUnreachable?.(p, bound, { failures, error: p.geo_guard_reason, action })) || action
          } else {
            p.geo_guard_status = 'error'
          }
        } else {
          this.failStreak.delete(p.id)
          let recovering = 0
          let reachable = false
          if (previous === 'unreachable') {
            const oks = (this.okStreak.get(p.id) || 0) + 1
            if (oks >= GEO_RECOVER_CHECKS) {
              this.okStreak.delete(p.id)
              reachable = true
            } else {
              this.okStreak.set(p.id, oks)
              recovering = oks
            }
          }
          if (!baseCountry) {
            result = 'baseline'
            p.geo_base_country_code = country
            p.geo_base_region = geo.region || null
            p.geo_base_at = checkedAt
            p.geo_guard_status = 'ok'
            p.geo_guard_reason = null
          } else {
            const changed = baseCountry !== country
            result = changed ? 'changed' : 'same'
            p.geo_guard_status = changed ? 'changed' : 'ok'
            p.geo_guard_reason = changed ? `${baseCountry} → ${country}` : null
            const lastChanged = this.lastChanged.get(p.id) || (previous === 'changed' ? previousReason : null)
            if (changed && lastChanged !== p.geo_guard_reason) {
              this.lastChanged.set(p.id, p.geo_guard_reason)
              action = pauseMode ? `paused:${bound.join(',')}` : 'notified'
              action =
                (await this.onGeoChanged?.(p, bound, {
                  old: { country_code: baseCountry, region: baseRegion },
                  geo,
                  action,
                })) || action
            } else if (!changed && (previous === 'changed' || previous === 'error' || lastChanged)) {
              this.lastChanged.delete(p.id)
              await this.onRecovered?.(p, bound)
              action = 'recovered'
            }
          }
          if (recovering && result !== 'changed') {
            p.geo_guard_status = 'unreachable'
            p.geo_guard_reason = `recovering ${recovering}/${GEO_RECOVER_CHECKS}`
          } else if (recovering) {
            this.okStreak.delete(p.id)
          }
          if (reachable) {
            const resumed = await this.onReachable?.(p, bound, { geo })
            action = action || resumed || 'reachable'
          }
        }
        this.repo.insert({
          proxy_id: p.id,
          proxy_label: p.label,
          checked_at: checkedAt,
          ok: result === 'error' ? 0 : 1,
          ip: geo.ip,
          country_code: geo.country_code,
          country: geo.country,
          region: geo.region,
          city: geo.city,
          isp: geo.isp,
          timezone: geo.timezone,
          latency_ms: Math.max(0, this.now() - start),
          result,
          base_country_code: baseCountry,
          base_region: baseRegion,
          action,
          error: result === 'error' ? p.geo_guard_reason : null,
        })
        summary.checked++
        summary[result]++
      }
      this.repo.prune(this.now())
      return summary
    } finally {
      if (summary.checked) this.pool.save()
      this.running = false
    }
  }

  confirm(id) {
    if (this.running) return { ok: false, error: 'already_running' }
    const p = this.pool.state.proxies.find((item) => item.id === id)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if (!p.geo_country_code || p.geo_error) return { ok: false, error: 'geo_unavailable' }
    const oldCountry = p.geo_base_country_code
    const oldRegion = p.geo_base_region
    const wasUnreachable = p.geo_guard_status === 'unreachable'
    p.geo_base_country_code = String(p.geo_country_code).trim().toUpperCase()
    p.geo_base_region = p.geo_region || null
    p.geo_base_at = new Date(this.now()).toISOString()
    p.geo_guard_checked_at = p.geo_base_at
    p.geo_guard_status = 'ok'
    p.geo_guard_reason = null
    this.lastChanged.delete(p.id)
    this.failStreak.delete(p.id)
    this.okStreak.delete(p.id)
    this.pool.save()
    this.onRecovered?.(p, boundVmIdsOf(p))
    if (wasUnreachable) this.onReachable?.(p, boundVmIdsOf(p), { geo: { ip: p.geo_ip, country_code: p.geo_country_code } })
    this.repo.insert({
      proxy_id: p.id,
      proxy_label: p.label,
      checked_at: p.geo_base_at,
      ok: 1,
      ip: p.geo_ip,
      country_code: p.geo_country_code,
      country: p.geo_country,
      region: p.geo_region,
      city: p.geo_city,
      isp: p.geo_isp,
      timezone: p.geo_timezone,
      result: 'baseline',
      base_country_code: oldCountry,
      base_region: oldRegion,
      action: 'confirmed',
    })
    return { ok: true, proxy: this.pool.publicProxy(p) }
  }
}
