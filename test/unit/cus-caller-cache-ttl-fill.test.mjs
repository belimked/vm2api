import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callerCacheTtlFillEnabled, prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

const shaped = (messages, extra = {}) => ({
  model: 'claude-opus-5-5',
  max_tokens: 256,
  system: [
    { type: 'text', text: 'harness', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__' },
    { type: 'text', text: 'guidance' },
  ],
  messages,
  ...extra,
})
const ttlLess = () => [
  { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
  { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
  { role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }] },
]
const withFill = (fn) => {
  const prev = process.env.VM2API_CALLER_CACHE_TTL_FILL
  process.env.VM2API_CALLER_CACHE_TTL_FILL = '1'
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.VM2API_CALLER_CACHE_TTL_FILL
    else process.env.VM2API_CALLER_CACHE_TTL_FILL = prev
  }
}
const opts = (ttl) => ({ cacheTtl: ttl, personaPreset: 'official' })

test('switch is off by default: upstream keeps implicit 5m caller markers', () => {
  assert.equal(callerCacheTtlFillEnabled({}), false)
  const prev = process.env.VM2API_CALLER_CACHE_TTL_FILL
  delete process.env.VM2API_CALLER_CACHE_TTL_FILL
  try {
    const out = prepareCliHopBody(shaped(ttlLess()), opts('1h'))
    assert.equal(out.messages[2].content[0].cache_control.ttl, undefined)
  } finally {
    if (prev !== undefined) process.env.VM2API_CALLER_CACHE_TTL_FILL = prev
  }
})

test('switch on: ttl-less caller message markers take the session TTL', () => {
  withFill(() => {
    const out = prepareCliHopBody(shaped(ttlLess()), opts('1h'))
    assert.equal(out.messages[0].content[0].cache_control.ttl, '1h')
    assert.equal(out.messages[2].content[0].cache_control.ttl, '1h')
    const five = prepareCliHopBody(shaped(ttlLess()), opts('5m'))
    assert.equal(five.messages[2].content[0].cache_control.ttl, '5m')
  })
})

test('switch on: an explicit 5m message marker makes the fill 5m', () => {
  withFill(() => {
    const messages = ttlLess()
    messages[0].content[0].cache_control = { type: 'ephemeral', ttl: '5m' }
    const out = prepareCliHopBody(shaped(messages), opts('1h'))
    assert.equal(out.messages[0].content[0].cache_control.ttl, '5m')
    assert.equal(out.messages[2].content[0].cache_control.ttl, '5m')
  })
})

test('switch on: a ttl-less prefix marker keeps messages at 5m (no 1h after 5m)', () => {
  withFill(() => {
    const body = shaped(ttlLess())
    body.system[2] = { type: 'text', text: 'guidance', cache_control: { type: 'ephemeral' } }
    const out = prepareCliHopBody(body, opts('1h'))
    for (const m of [out.messages[0], out.messages[2]]) assert.equal(m.content[0].cache_control.ttl, '5m')
  })
})
