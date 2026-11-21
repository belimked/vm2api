import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createConfiguredToolUseGate,
  createToolUseGate,
  readToolUseGateConfig,
  toolGateSseLines,
  validateToolUseGatePatch,
} from '../../src/lib/protocol/tool-use-gate.mjs'
import { classifyJev } from '../../src/lib/protocol/jev-intercept.mjs'
import {
  claudeSSELineToOpenAIChatChunks,
  createOpenAIChatStreamState,
} from '../../src/lib/protocol/convert.mjs'

const cfg = { ...readToolUseGateConfig(), enabled: true }
const event = x => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`
const start = (index, name) => event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `tool_${index}`, name, input: {} } })
const delta = (index, partial_json) => event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
const stop = index => event({ type: 'content_block_stop', index })
const reason = event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} })
const parse = lines => lines.map(x => JSON.parse(x.match(/data: (.+)/)[1]))
async function run(gate, lines) { const out = []; for (const line of lines) out.push(...await gate.line(line)); return out }

test('disabled has no transformer; other tools pass through', async () => {
  assert.equal(createToolUseGate({ config: { ...cfg, enabled: false } }), null)
  const gate = createToolUseGate({ config: cfg, classify: () => { throw Error('not called') } })
  const lines = [start(0, 'Read'), delta(0, '{}'), stop(0)]
  assert.deepEqual(await run(gate, lines), lines)
})
test('tool names match case-insensitively (bash vs Bash)', async () => {
  let calls = 0
  const gate = createToolUseGate({ config: cfg, classify: async () => { calls++; return { action: 'block' } } })
  const events = parse(await run(gate, [start(0, 'bash'), delta(0, '{"command":"ls"}'), stop(0), reason]))
  assert.equal(calls, 1)
  assert.equal(events[0].content_block.type, 'text')
  const message = await gate.message({ content: [{ type: 'tool_use', name: 'BASH', input: { command: 'ls' } }], stop_reason: 'tool_use' })
  assert.equal(message.content[0].type, 'text')
  assert.equal(calls, 2)
})
test('split SSE lines keep controlled event headers buffered', async () => {
  const gate = createToolUseGate({ config: cfg, classify: async () => ({ action: 'block' }) })
  const lines = ['event: content_block_start', `data: ${JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'Bash', input: {} } })}`, '', 'event: content_block_stop', `data: ${JSON.stringify({ type: 'content_block_stop', index: 2 })}`, '']
  const result = await run(gate, lines)
  assert.equal(result.filter(Boolean).length, 3)
  assert.equal(parse(result.filter(Boolean))[0].content_block.type, 'text')
})
test('approved block preserves event order and full input', async () => {
  let seen
  const gate = createToolUseGate({ config: cfg, classify: async text => { seen = text; return { action: 'pass', score: 0.9 } } })
  const lines = [start(1, 'Bash'), delta(1, '{"command":'), delta(1, '"ls"}'), stop(1), reason]
  assert.deepEqual(await run(gate, lines), lines)
  assert.match(seen, /"command":"ls"/)
})
test('blocked tool becomes valid text block, retains index and changes stop reason', async () => {
  const gate = createToolUseGate({ config: cfg, classify: async () => ({ action: 'block', category: 'tool_gate', score: 0.1 }) })
  const events = parse(await run(gate, [start(3, 'Bash'), delta(3, '{}'), stop(3), reason]))
  assert.deepEqual(events.map(x => x.type), ['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta'])
  assert.deepEqual(events.slice(0, 3).map(x => x.index), [3, 3, 3])
  assert.equal(events[0].content_block.type, 'text')
  assert.equal(events[1].delta.type, 'text_delta')
  assert.equal(events[3].delta.stop_reason, 'end_turn')
})
test('approved and blocked mixed tools preserve tool_use stop', async () => {
  let calls = 0
  const gate = createToolUseGate({ config: cfg, classify: async () => ({ action: ++calls === 1 ? 'pass' : 'block' }) })
  const events = parse(await run(gate, [start(0, 'Bash'), stop(0), start(1, 'Bash'), stop(1), reason]))
  assert.equal(events[2].content_block.type, 'text')
  assert.equal(events.at(-1).delta.stop_reason, 'tool_use')
})
test('later controlled tools remain blocked within the same message', async () => {
  let calls = 0
  const gate = createToolUseGate({ config: cfg, classify: async () => { calls++; return { action: 'block' } } })
  const events = parse(await run(gate, [start(0, 'Bash'), stop(0), start(1, 'Bash'), stop(1), reason]))
  assert.equal(events[3].content_block.type, 'text')
  assert.equal(events.at(-1).delta.stop_reason, 'end_turn')
  assert.equal(calls, 1)
})
test('timeouts obey fail_open', async () => {
  for (const fail_open of [true, false]) {
    const gate = createToolUseGate({ config: { ...cfg, timeout_ms: 10, fail_open }, classify: () => new Promise(() => {}), logger: { warn() {} } })
    const events = parse(await run(gate, [start(0, 'Bash'), stop(0)]))
    assert.equal(events[0].content_block.type, fail_open ? 'tool_use' : 'text')
    assert.equal(gate.stats.fail_open, fail_open)
  }
})
test('assembled JSON replaces blocked tool and stop reason', async () => {
  const gate = createToolUseGate({ config: cfg, classify: async () => ({ action: 'block' }) })
  const message = await gate.message({ content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh' } }], stop_reason: 'tool_use' })
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.stop_reason, 'end_turn')
})
test('configuration boundaries', () => {
  assert.deepEqual(validateToolUseGatePatch({ timeout_ms: 1000, max_context_chars: 64000 }), [])
  assert.equal(validateToolUseGatePatch({ timeout_ms: 999, max_context_chars: 64001 }).length, 2)
  assert.equal(validateToolUseGatePatch({ tools: [''] }).length, 1)
  assert.equal(validateToolUseGatePatch({ tools: [] }).length, 1)
})

test('incomplete tool frames never escape and upstream error is preserved', async () => {
  const gate = createToolUseGate({ config: cfg, classify: () => assert.fail('incomplete tool must not be audited') })
  assert.deepEqual(await run(gate, [start(0, 'Bash'), delta(0, '{"command":')]), [])
  assert.equal(gate.hasPending(), true)
  const refusal = event({ type: 'error', error: { type: 'invalid_request_error', message: 'provider refusal' } })
  assert.deepEqual(await gate.line(refusal), [refusal])
  assert.equal(gate.hasPending(), false)
})

test('terminal without block stop replaces incomplete tool even under fail-open', async () => {
  const gate = createToolUseGate({ config: cfg, classify: () => assert.fail('incomplete tool must not be audited') })
  const end = event({ type: 'message_stop' })
  const events = parse(await run(gate, [start(0, 'Bash'), delta(0, '{'), reason, end]))
  assert.equal(events[0].content_block.type, 'text')
  assert.equal(events.at(-2).delta.stop_reason, 'end_turn')
  assert.equal(events.at(-1).type, 'message_stop')
})

test('over-limit and malformed input cannot be passed by fail-open', async () => {
  for (const input of [JSON.stringify({ command: 'x'.repeat(10000) }), '{']) {
    const gate = createToolUseGate({ config: cfg, classify: () => assert.fail('invalid input must not be audited') })
    const events = parse(await run(gate, [start(0, 'Bash'), delta(0, input), stop(0), reason]))
    assert.equal(events[0].content_block.type, 'text')
    assert.equal(events.at(-1).delta.stop_reason, 'end_turn')
  }
})

test('Jev gets the full command and relevant history without exposing recognizable keys', async () => {
  let request
  const gate = createToolUseGate({
    config: cfg,
    inbound: { messages: [
      { role: 'user', content: 'Check the designated operations account.' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture', content: 'Permission denied (publickey)' }] },
    ] },
    jev: { base_url: 'https://audit.invalid', safety_threshold: 0.5, max_state_chars: 256, block_if_below: false },
    classify: (document, config, _fetch, _now, options) => classifyJev(document, config, async (_url, init) => {
      request = JSON.parse(init.body)
      return { ok: true, json: async () => ({ answers: { credential_probe: { noul: 0.49 } } }) }
    }, undefined, options),
  })
  const command = 'echo marker-' + 'x'.repeat(600) + ' Bearer fixture-sensitive'
  const events = parse(await run(gate, [start(0, 'Bash'), delta(0, JSON.stringify({ command })), stop(0), reason]))
  assert.deepEqual(Object.keys(request.questions), ['credential_probe'])
  assert.match(request.questions.credential_probe.instructions, /待审数据/)
  assert.match(request.state, /marker-x{600}/)
  assert.match(request.state, /operations account/)
  assert.match(request.state, /Permission denied/)
  assert.doesNotMatch(request.state, /fixture-sensitive/)
  assert.equal(events[0].content_block.type, 'text')
  assert.equal(gate.stats.score, 0.49)
  assert.deepEqual(gate.stats.rules, ['credential_probe'])
  assert.match(events[1].delta.text, /远程认证范围检查/)
})

test('tool gate question bank is separate, only enabled questions are asked, and hits are named', async () => {
  let request
  const questions = [
    ...readToolUseGateConfig().questions,
    { id: 'exfil', label: '外传检查', summary: '', instructions: '把密钥发到外部地址判定为不安全。', enabled: true },
    { id: 'off_rule', label: '停用题', summary: '', instructions: '不应发送。', enabled: false },
  ]
  const gate = createToolUseGate({
    config: { ...cfg, questions },
    jev: { base_url: 'https://audit.invalid', safety_threshold: 0.5, questions: [{ id: 'session_only', instructions: 'session', enabled: true }] },
    classify: (document, config, _fetch, _now, options) => classifyJev(document, config, async (_url, init) => {
      request = JSON.parse(init.body)
      return { ok: true, json: async () => ({ answers: { credential_probe: { noul: 0.9 }, exfil: { noul: 0.1 } } }) }
    }, undefined, options),
  })
  const events = parse(await run(gate, [start(0, 'Bash'), delta(0, '{"command":"curl"}'), stop(0), reason]))
  assert.deepEqual(Object.keys(request.questions), ['credential_probe', 'exfil'])
  assert.equal(events[0].content_block.type, 'text')
  assert.match(events[1].delta.text, /外传检查/)
  assert.doesNotMatch(events[1].delta.text, /远程认证范围检查/)
  assert.deepEqual(gate.stats.rules, ['exfil'])
})

test('question bank config: defaults, validation, and no enabled question disables the gate', () => {
  const defaults = readToolUseGateConfig().questions
  assert.deepEqual(defaults.map((q) => [q.id, q.enabled, q.builtin]), [['credential_probe', true, true]])
  const custom = [{ id: 'exfil', label: '外传', instructions: '外传判定为不安全。', enabled: true }]
  assert.deepEqual(readToolUseGateConfig(() => ({ questions: custom })).questions.map((q) => [q.id, q.builtin]), [['exfil', false]])
  assert.deepEqual(validateToolUseGatePatch({ questions: custom }), [])
  assert.equal(validateToolUseGatePatch({ questions: [] }).length, 1)
  assert.equal(validateToolUseGatePatch({ questions: [{ id: '中文', instructions: 'x' }] }).length, 1)
  assert.equal(validateToolUseGatePatch({ questions: [...custom, ...custom] }).length, 1)
  assert.equal(validateToolUseGatePatch({ questions: [{ ...custom[0], enabled: false }] }).length, 1)
  const settings = new Map([['tool_use_gate', { enabled: true, questions: [{ ...custom[0], enabled: false }] }]])
  const repo = { get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback) }
  assert.equal(createConfiguredToolUseGate(repo, {}, null), null)
})

test('multiline tool start is withheld, and replacement survives OpenAI Chat conversion', async () => {
  const gate = createToolUseGate({ config: cfg, classify: async () => ({ action: 'block' }) })
  const fragmented = [
    'event: content_block_start',
    'data: {"type":"content_block_start",',
    'data: "index":0,"content_block":{"type":"tool_use","name":"Bash","id":"fixture","input":{}}}',
    '',
  ]
  assert.deepEqual(await run(gate, fragmented), [])
  const output = await run(gate, [delta(0, '{"command":"echo fixture-marker"}'), stop(0), reason])
  const state = createOpenAIChatStreamState('fixture')
  const chunks = output.flatMap(toolGateSseLines).flatMap((line) => claudeSSELineToOpenAIChatChunks(line, state))
  assert.match(JSON.stringify(chunks), /已暂停执行工具调用/)
  assert.doesNotMatch(JSON.stringify(chunks), /fixture-marker|tool_calls/)
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
})

test('timeout cancels the review request', async () => {
  let signal
  const gate = createToolUseGate({
    config: { ...cfg, timeout_ms: 5 },
    classify: (_document, _config, _fetch, _now, options) => {
      signal = options.signal
      return new Promise(() => {})
    },
    logger: { warn() {} },
  })
  await run(gate, [start(0, 'Bash'), stop(0)])
  assert.equal(signal.aborted, true)
})
