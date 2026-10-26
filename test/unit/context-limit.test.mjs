import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_LIMIT_STATUS,
  IMAGE_TOKENS,
  assessContextLimit,
  checkContextLimit,
  contextWindowFor,
  estimateRequestTokens,
  estimateTextTokens,
} from '../../src/lib/protocol/context-limit.mjs'
import { mapUpstreamError } from '../../src/lib/core/errors.mjs'

test('estimateTextTokens counts ascii at 4 chars/token and CJK at 1 char/token', () => {
  assert.equal(estimateTextTokens('abcdefgh'), 2)
  assert.equal(estimateTextTokens('你好世界'), 4)
  assert.equal(estimateTextTokens(''), 0)
})

test('estimateRequestTokens walks system, messages and tools', () => {
  const body = {
    model: 'claude-sonnet-4-5',
    system: 'a'.repeat(400),
    messages: [{ role: 'user', content: 'b'.repeat(400) }],
    tools: [{ name: 't', input_schema: { type: 'object' } }],
  }
  const n = estimateRequestTokens(body)
  assert.ok(n > 200 && n < 260, `estimate ${n}`)
})

test('contextWindowFor defaults to the model window and honours the 1M beta', () => {
  assert.equal(contextWindowFor('claude-sonnet-4-5', {}), 200000)
  assert.equal(contextWindowFor('claude-sonnet-4-5', { 'anthropic-beta': 'context-1m-2025-08-07' }), 1000000)
  assert.equal(contextWindowFor('claude-sonnet-4-5[1m]', {}), 1000000)
})

test('checkContextLimit rejects only when clearly over the window', () => {
  const small = { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(checkContextLimit(small, {}), null)
  const nearLimit = { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x'.repeat(4 * 220_000) }] }
  assert.equal(checkContextLimit(nearLimit, {}), null, '220k on a 200k window stays below the 1.2 margin')
  const over = { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x'.repeat(4 * 260_000) }] }
  const rejected = checkContextLimit(over, {})
  assert.equal(rejected.status, CONTEXT_LIMIT_STATUS)
  assert.equal(rejected.body.error.code, 'context_length_exceeded')
  assert.equal(rejected.body.error.type, 'invalid_request_error')
  assert.match(rejected.body.error.message, /压缩上下文|新开会话/)
  assert.equal(rejected.body.error.details.context_window, 200000)
  assert.ok(rejected.body.error.details.estimated_tokens > 200000)
  assert.equal(checkContextLimit(over, { 'anthropic-beta': 'context-1m-2025-08-07' }), null)
})

test('upstream "prompt is too long" maps to the same 405 error', () => {
  const mapped = mapUpstreamError(400, {
    error: { type: 'invalid_request_error', message: 'prompt is too long: 213445 tokens > 200000 maximum' },
  })
  assert.equal(mapped.status, 405)
  assert.equal(mapped.body.error.code, 'context_length_exceeded')
  assert.match(mapped.body.error.details.upstream_message, /213445 tokens/)
  const other = mapUpstreamError(400, {
    error: { type: 'invalid_request_error', message: 'messages: roles must alternate' },
  })
  assert.notEqual(other.body.error.code, 'context_length_exceeded')
})

test('base64 images and signatures are not counted as text', () => {
  const png = 'A'.repeat(800_000) // ~800 KB screenshot
  const body = {
    model: 'claude-opus-5-5',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'short', signature: 'B'.repeat(4000) },
          { type: 'tool_use', id: 'toolu_1', name: 'screenshot', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
          },
        ],
      },
    ],
  }
  const n = estimateRequestTokens(body)
  assert.ok(n < IMAGE_TOKENS + 100, `estimate ${n} should be about one image, not 200k text tokens`)
  // Ten screenshots in a 1M-window session must not trip the gate.
  const many = { ...body, messages: Array.from({ length: 10 }, () => body.messages).flat() }
  assert.equal(checkContextLimit(many, {}), null)
})

test('web search results, redacted thinking and unknown binary blocks are not counted as text', () => {
  const body = {
    model: 'claude-sonnet-4-5',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'C'.repeat(300_000) },
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'vm2api' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              { type: 'web_search_result', url: 'https://x', title: 't', encrypted_content: 'D'.repeat(400_000) },
            ],
          },
          { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'E'.repeat(900_000) } },
        ],
      },
    ],
  }
  const n = estimateRequestTokens(body)
  assert.ok(n < 2000, `estimate ${n} must not include encrypted/binary payloads`)
})

test('assessContextLimit returns the estimate for logging even when the request passes', () => {
  const body = { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x'.repeat(4000) }] }
  const out = assessContextLimit(body, {})
  assert.equal(out.error, null)
  assert.equal(out.window, 200000)
  assert.ok(out.estimated >= 1000 && out.estimated <= 1100, `estimate ${out.estimated}`)
})
