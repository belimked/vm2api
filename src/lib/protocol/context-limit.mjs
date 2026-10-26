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

export function estimateRequestTokens(body = {}) {
  if (!body || typeof body !== 'object') return 0
  let total = 0
  for (const key of PROMPT_FIELDS) {
    if (body[key] == null) continue
    const value = body[key]
    total += typeof value === 'string' ? estimateTextTokens(value) : estimateTextTokens(JSON.stringify(value))
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

/** null when the request may proceed, otherwise { status, body } for the client. */
export function checkContextLimit(body = {}, headers = {}, { margin = CONTEXT_LIMIT_MARGIN } = {}) {
  const window = contextWindowFor(body?.model, headers)
  const estimated = estimateRequestTokens(body)
  if (estimated <= window * margin) return null
  return contextLimitError({ estimated, window })
}
