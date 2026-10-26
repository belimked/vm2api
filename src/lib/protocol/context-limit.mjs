/**
 * Context-length gate. Two paths return the same client error:
 *   1. pre-flight: a cheap character-based estimate of the inbound prompt is
 *      clearly over the model's context window → reject before scheduling,
 *      so no slot, no upstream call, no failover.
 *   2. upstream: Anthropic's 400 "prompt is too long" → mapped in errors.mjs.
 * The estimate is deliberately loose (only rejects when > window × margin):
 * a false reject would block a valid request, a miss just falls to path 2.
 */
import { getCapabilities } from './model-policy.mjs'
import { hasClaudeCode1mSuffix } from './context-1m.mjs'
import { contextLimitError } from '../core/errors.mjs'

export { CONTEXT_LIMIT_STATUS, contextLimitError, isUpstreamContextLimitMessage } from '../core/errors.mjs'

export const CONTEXT_LIMIT_MARGIN = 1.2
const DEFAULT_CONTEXT_WINDOW = 200_000
const CONTEXT_1M = 1_000_000
const PROMPT_FIELDS = ['system', 'messages', 'tools', 'input', 'instructions', 'prompt']

/** ASCII ≈ 4 chars/token, everything else (CJK, emoji) ≈ 1 char/token. */
export function estimateTextTokens(text = '') {
  const s = String(text || '')
  let ascii = 0
  let other = 0
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) < 128) ascii += 1
    else other += 1
  }
  return Math.ceil(ascii / 4) + other
}

/** Upstream bills an image by resolution, capped near 1600 tokens; base64 length says nothing. */
export const IMAGE_TOKENS = 1600
/** A base64 PDF/document: pages unknown here; a few pages of text is the common case. */
export const DOCUMENT_TOKENS = 2500
/** Fields that ride along in the JSON but are not prompt tokens upstream. */
const SKIP_KEYS = new Set(['signature', 'cache_control', 'id', 'tool_use_id', 'encrypted_content', 'encrypted_index'])
const BASE64_SOURCE = /^(base64|file|url)$/

function estimateValueTokens(value) {
  if (value == null) return 0
  if (typeof value === 'string') return estimateTextTokens(value)
  if (typeof value !== 'object') return estimateTextTokens(String(value))
  if (Array.isArray(value)) {
    let n = 0
    for (const item of value) n += estimateValueTokens(item)
    return n
  }
  const type = String(value.type || '')
  if (type === 'image') return IMAGE_TOKENS
  if (type === 'document') {
    const src = value.source || {}
    if (src.type === 'text' || (typeof src.data === 'string' && src.media_type?.startsWith('text/'))) {
      return estimateTextTokens(src.data || '')
    }
    return DOCUMENT_TOKENS
  }
  if (type === 'text' || type === 'thinking' || type === 'redacted_thinking') {
    return estimateTextTokens(value.text ?? value.thinking ?? '')
  }
  if (type === 'tool_use')
    return estimateTextTokens(value.name || '') + estimateTextTokens(JSON.stringify(value.input ?? {}))
  if (type === 'tool_result') return estimateValueTokens(value.content)
  // Unknown block carrying a binary source (future media types): never count its payload as text.
  if (value.source && typeof value.source === 'object' && BASE64_SOURCE.test(String(value.source.type || ''))) {
    return IMAGE_TOKENS
  }
  let n = 0
  for (const [key, child] of Object.entries(value)) {
    if (SKIP_KEYS.has(key)) continue
    n += estimateValueTokens(child)
  }
  return n
}

/**
 * Walks the prompt fields block by block: text-like blocks by characters,
 * images/documents at a fixed upstream-style cost, signatures ignored.
 * Blind JSON.stringify counted base64 screenshots as text and over-estimated
 * a 650k-token Claude Code session as 1.7M.
 */
export function estimateRequestTokens(body = {}) {
  if (!body || typeof body !== 'object') return 0
  let total = 0
  for (const key of PROMPT_FIELDS) {
    if (body[key] == null) continue
    total += key === 'tools' ? estimateTextTokens(JSON.stringify(body[key])) : estimateValueTokens(body[key])
  }
  return total
}

export function contextWindowFor(modelId = '', headers = {}) {
  const caps = getCapabilities(modelId) || {}
  const base = Number(caps.context_window) > 0 ? Number(caps.context_window) : DEFAULT_CONTEXT_WINDOW
  const beta = String(headers?.['anthropic-beta'] || '')
  if (hasClaudeCode1mSuffix(modelId) || /context-1m/i.test(beta)) return Math.max(base, CONTEXT_1M)
  return base
}

/** { estimated, window, error }: error is null when the request may proceed. */
export function assessContextLimit(body = {}, headers = {}, { margin = CONTEXT_LIMIT_MARGIN } = {}) {
  const window = contextWindowFor(body?.model, headers)
  const estimated = estimateRequestTokens(body)
  const error = estimated <= window * margin ? null : contextLimitError({ estimated, window })
  return { estimated, window, error }
}

/** null when the request may proceed, otherwise { status, body } for the client. */
export function checkContextLimit(body = {}, headers = {}, opts = {}) {
  return assessContextLimit(body, headers, opts).error
}
