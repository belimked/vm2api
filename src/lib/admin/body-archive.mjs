/**
 * 完整请求体文件（gzip 落盘），补 request_log_debug 的两个缺口：
 *   - 自动模式审核请求（auto_mode_classifier）在库里不存请求体；
 *   - 其余请求体超过 maxDebugBodyChars 时库里只剩前缀。
 *
 * 只存这几类：自动模式审核请求、状态不是 200、状态 200 但返回里有 Usage Policy。
 * 布局：<dataDir>/request-logs/bodies/YYYY-MM-DD/<request_id>.json.gz（UTC 日期，取日志 ts）。
 * 内容：紧凑 JSON `{"meta":{…},"inbound_body":…}`，先 redactSecrets、图片数据替换成摘要再压缩。
 * 清理：按文件 mtime 超过 retain_days 删除；总量超过 max_mb 时从最旧的删起（0 表示不限）。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'

const gzip = promisify(zlib.gzip)

export const BODY_ARCHIVE_DEFAULTS = Object.freeze({ enabled: false, retain_days: 3, max_mb: 3072 })

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86400_000
const STALE_TMP_MS = 3600_000
const CLASSIFIER_MARK = 'You are a security monitor for autonomous AI coding agents'
const USAGE_POLICY_RE = /usage policy/i

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function normalizeBodyArchiveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: src.enabled === true,
    retain_days: clampInt(src.retain_days ?? src.retainDays, 1, 90, BODY_ARCHIVE_DEFAULTS.retain_days),
    max_mb: clampInt(src.max_mb ?? src.maxMb, 0, 102400, BODY_ARCHIVE_DEFAULTS.max_mb),
  }
}

/** 文件名只留安全字符：request_id 可能来自客户端的 X-Request-ID。 */
export function safeArchiveId(requestId) {
  const id = String(requestId || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 128)
  if (!id || /^\.+$/.test(id)) return null
  return id
}

function dayOf(ts) {
  const day = String(ts || '').slice(0, 10)
  return DAY_RE.test(day) ? day : new Date().toISOString().slice(0, 10)
}

function systemHead(body) {
  const sys = body?.system
  if (typeof sys === 'string') return sys.slice(0, 4000)
  if (!Array.isArray(sys)) return ''
  let out = ''
  for (const block of sys.slice(0, 4)) {
    out += typeof block === 'string' ? block : String(block?.text || '')
    if (out.length >= 4000) break
  }
  return out
}

/** classifier 标记缺失时（识别有漏网），按 Claude Code 审核 system 开头兜底。 */
export function looksLikeAutoModeClassifier(body) {
  return systemHead(body).includes(CLASSIFIER_MARK)
}

function responseText(response) {
  const body = response?.body
  if (typeof body === 'string') return body
  if (body == null) return ''
  try {
    return JSON.stringify(body)
  } catch {
    return ''
  }
}

/** 返回要落盘的原因；空数组表示不存。response 是 tapResponse 抓到的客户端响应。 */
export function bodyArchiveReasons(extra = {}, response = null) {
  const reasons = []
  if (extra.classifier?.purpose || looksLikeAutoModeClassifier(extra.inbound_body)) reasons.push('classifier')
  if (Number(extra.status) !== 200) reasons.push('status')
  if (
    extra.stop_reason === 'refusal' ||
    USAGE_POLICY_RE.test(String(extra.error_message || '')) ||
    USAGE_POLICY_RE.test(responseText(response))
  ) {
    reasons.push('usage_policy')
  }
  return reasons
}

export class BodyArchive {
  constructor({ dir, config } = {}) {
    this.dir = dir
    this.config = normalizeBodyArchiveConfig(config)
    this.usedBytes = null
    this.fileCount = null
    this.lastCleanupAt = null
    this._capCleanupQueued = false
  }

  get enabled() {
    return this.config.enabled === true
  }

  setConfig(raw) {
    this.config = normalizeBodyArchiveConfig(raw)
    return this.snapshot()
  }

  snapshot() {
    return {
      ...this.config,
      used_bytes: this.usedBytes,
      file_count: this.fileCount,
      last_cleanup_at: this.lastCleanupAt,
    }
  }

  _capBytes() {
    return this.config.max_mb > 0 ? this.config.max_mb * 1024 * 1024 : 0
  }

  /** bodyJson 是已脱敏的 JSON 字符串，原样嵌进文件，不再解析一次。 */
  async write({ requestId, ts, meta = {}, bodyJson }) {
    if (!this.enabled || typeof bodyJson !== 'string' || !this.dir) return null
    const id = safeArchiveId(requestId)
    if (!id) return null
    const day = dayOf(ts)
    const file = path.join(this.dir, day, `${id}.json.gz`)
    const gz = await gzip(`{"meta":${JSON.stringify(meta)},"inbound_body":${bodyJson}}`)
    const cap = this._capBytes()
    if (cap && gz.length > cap) return null
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.promises.writeFile(tmp, gz, { mode: 0o600 })
    await fs.promises.rename(tmp, file)
    if (this.usedBytes != null) {
      this.usedBytes += gz.length
      if (this.fileCount != null) this.fileCount += 1
      if (cap && this.usedBytes > cap && !this._capCleanupQueued) {
        this._capCleanupQueued = true
        setImmediate(() => {
          this._capCleanupQueued = false
          try {
            this.cleanup()
          } catch {}
        })
      }
    }
    return { day, file, bytes: gz.length }
  }

  /** 先查日志 ts 那天的目录，找不到再扫其余日期目录（新的在前）。 */
  find(requestId, ts = null) {
    const id = safeArchiveId(requestId)
    if (!id || !this.dir) return null
    const name = `${id}.json.gz`
    const tryDay = (day) => {
      const file = path.join(this.dir, day, name)
      try {
        const st = fs.statSync(file)
        return st.isFile() ? { day, file, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() } : null
      } catch {
        return null
      }
    }
    const first = ts ? String(ts).slice(0, 10) : ''
    if (DAY_RE.test(first)) {
      const hit = tryDay(first)
      if (hit) return hit
    }
    let days = []
    try {
      days = fs
        .readdirSync(this.dir)
        .filter((n) => DAY_RE.test(n) && n !== first)
        .sort()
        .reverse()
    } catch {
      return null
    }
    for (const day of days) {
      const hit = tryDay(day)
      if (hit) return hit
    }
    return null
  }

  /** 关闭后也照样清理，旧文件不会因为关了开关一直留着。 */
  cleanup(now = Date.now()) {
    if (!this.dir) return this.snapshot()
    let days = []
    try {
      days = fs
        .readdirSync(this.dir)
        .filter((n) => DAY_RE.test(n))
        .sort()
    } catch {
      this.usedBytes = 0
      this.fileCount = 0
      this.lastCleanupAt = new Date(now).toISOString()
      return this.snapshot()
    }
    const cutoff = now - this.config.retain_days * DAY_MS
    const files = []
    const rm = (file) => {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
    }
    for (const day of days) {
      const dir = path.join(this.dir, day)
      const dayEnd = Date.parse(`${day}T00:00:00Z`) + DAY_MS
      if (Number.isFinite(dayEnd) && dayEnd <= cutoff) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {}
        continue
      }
      let names = []
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const file = path.join(dir, name)
        let st
        try {
          st = fs.statSync(file)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        if (name.endsWith('.tmp')) {
          if (now - st.mtimeMs > STALE_TMP_MS) rm(file)
          continue
        }
        if (st.mtimeMs <= cutoff) {
          rm(file)
          continue
        }
        files.push({ file, size: st.size, mtime: st.mtimeMs })
      }
    }
    let total = files.reduce((n, f) => n + f.size, 0)
    let count = files.length
    const cap = this._capBytes()
    if (cap && total > cap) {
      files.sort((a, b) => a.mtime - b.mtime)
      for (const f of files) {
        if (total <= cap) break
        rm(f.file)
        total -= f.size
        count -= 1
      }
    }
    for (const day of days) {
      const dir = path.join(this.dir, day)
      try {
        if (!fs.readdirSync(dir).length) fs.rmdirSync(dir)
      } catch {}
    }
    this.usedBytes = total
    this.fileCount = count
    this.lastCleanupAt = new Date(now).toISOString()
    return this.snapshot()
  }
}
