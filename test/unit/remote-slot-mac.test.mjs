import test from 'node:test'
import assert from 'node:assert/strict'
import { slotContainerBody } from '../../src/lib/cluster/remote-slot.mjs'
import { workstationMacAddress } from '../../src/lib/identity/workstation-profile.mjs'

test('remote slot Docker body uses the workstation MAC except on special networks', () => {
  const vm = { id: 'vm-12', fingerprint: { hostname: 'kin-12' } }
  const args = { image: 'kin:test', network: 'kin-12-net', remoteDir: '/srv/vms/vm-12', user: '10012:987' }
  const body = slotContainerBody(vm, args)
  const mac = workstationMacAddress(vm)
  assert.equal(body.MacAddress, mac)
  assert.equal(body.NetworkingConfig.EndpointsConfig[args.network].MacAddress, mac)

  for (const network of ['host', 'bridge', 'none', 'container:other']) {
    const special = slotContainerBody(vm, { ...args, network })
    assert.equal('MacAddress' in special, false, network)
    assert.equal('NetworkingConfig' in special, false, network)
  }
})
