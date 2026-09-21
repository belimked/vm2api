import test from 'node:test'
import assert from 'node:assert/strict'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

// dofastted/vm2api#32: kin-egress dies with the control-plane container while
// the KEG* iptables chains keep redirecting slot traffic to its port.
function reconcile({ proxies, listening, withHooks = true }) {
  const repaired = []
  const self = {
    state: { proxies },
    egressCheck: withHooks ? (proxy) => ({ ok: listening.has(proxy.id) }) : undefined,
    repairEgress: withHooks
      ? (proxy) => {
          repaired.push(proxy.id)
          listening.add(proxy.id)
        }
      : undefined,
  }
  return { out: ProxyPool.prototype.reconcileEgress.call(self), repaired }
}

test('reconcileEgress re-seats only dead forwarders of enabled bound proxies', () => {
  const listening = new Set(['px-live'])
  const { out, repaired } = reconcile({
    listening,
    proxies: [
      { id: 'px-dead', enabled: true, bound_vm_ids: ['vm-01'] },
      { id: 'px-live', enabled: true, bound_vm_ids: ['vm-02'] },
      { id: 'px-unbound', enabled: true, bound_vm_ids: [] },
      { id: 'px-disabled', enabled: false, bound_vm_ids: ['vm-03'] },
    ],
  })
  assert.deepEqual(repaired, ['px-dead'])
  assert.deepEqual(out.repaired, [{ id: 'px-dead', ok: true }])
})

test('reconcileEgress reports a forwarder that still will not listen', () => {
  const listening = new Set()
  const self = {
    state: { proxies: [{ id: 'px-stuck', enabled: true, bound_vm_ids: ['vm-01'] }] },
    egressCheck: () => ({ ok: false }),
    repairEgress: () => {
      throw new Error('iptables unavailable')
    },
  }
  const out = ProxyPool.prototype.reconcileEgress.call(self)
  assert.deepEqual(out.repaired, [{ id: 'px-stuck', ok: false }])
  assert.equal(listening.size, 0)
})

test('reconcileEgress is a no-op without egress hooks', () => {
  const { out } = reconcile({
    listening: new Set(),
    withHooks: false,
    proxies: [{ id: 'px-a', enabled: true, bound_vm_ids: ['vm-01'] }],
  })
  assert.deepEqual(out, { ok: true, skipped: true, repaired: [] })
})
