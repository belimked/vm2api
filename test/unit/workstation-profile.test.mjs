import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildKinSeedJson,
  isHostKernel,
  KIN_SEED_SCHEMA,
  MAC_RE,
  NIC_OUIS,
  resolveWorkstationProfile,
  SKU_ORDER,
  workstationFamily,
  workstationKernel,
  workstationMacAddress,
  workstationSkuId,
} from '../../src/lib/identity/workstation-profile.mjs'

test('sku is a catalog id, stable per slot, and a stored value wins', () => {
  for (const id of ['vm-01', 'vm-05', 'vm-10', '']) {
    const sku = workstationSkuId({ id })
    assert.ok(SKU_ORDER.includes(sku), `${id} -> ${sku}`)
    assert.equal(workstationSkuId({ id }), sku)
  }
  assert.equal(workstationSkuId({ id: 'vm-05', fingerprint: { sku: '2c4g' } }), '2c4g')
  assert.equal(workstationSkuId({ id: 'vm-05', fingerprint: { sku: 'bogus' } }), workstationSkuId({ id: 'vm-05' }))
})

test('slot attributes carry no index arithmetic', () => {
  // Index rotation made every slot N and N+4 share distro, kernel and sku,
  // which reads as one gateway cluster instead of unrelated workstations.
  const packFor = (n) => {
    const vm = { id: `vm-${String(n).padStart(2, '0')}`, kernel: 'ubuntu-24.04' }
    return `${workstationSkuId(vm)}|${workstationKernel(vm)}`
  }
  let mismatches = 0
  for (let n = 1; n <= 16; n++) if (packFor(n) !== packFor(n + 4)) mismatches += 1
  assert.ok(mismatches >= 10, `N vs N+4 repeated too often: ${16 - mismatches}/16`)

  const skus = new Set()
  for (let n = 1; n <= 16; n++) skus.add(workstationSkuId({ id: `vm-${n}` }))
  assert.equal(skus.size, 2)
})

test('slot mac is a vendor OUI, never the docker 02:42 range', () => {
  const seen = new Set()
  for (let n = 1; n <= 24; n++) {
    const mac = workstationMacAddress({ id: `vm-${String(n).padStart(2, '0')}` })
    assert.match(mac, MAC_RE)
    assert.ok(NIC_OUIS.includes(mac.slice(0, 8)), mac)
    assert.equal(mac.startsWith('02:42'), false)
    seen.add(mac)
  }
  assert.equal(seen.size, 24)
  // Stable for a slot, and a stored value pins it across restarts.
  assert.equal(workstationMacAddress({ id: 'vm-07' }), workstationMacAddress({ id: 'vm-07' }))
  assert.equal(
    workstationMacAddress({ id: 'vm-07', fingerprint: { mac_address: '00:14:22:AB:CD:EF' } }),
    '00:14:22:ab:cd:ef',
  )
})

test('family follows guest distro, not host kernel', () => {
  assert.equal(workstationFamily({ kernel: 'ubuntu-24.04' }), 'ubuntu')
  assert.equal(workstationFamily({ fingerprint: { os_id: 'debian' } }), 'debian')
  assert.equal(workstationFamily({ fingerprint: { os_id: 'arch' } }), 'arch')
  assert.equal(workstationFamily({ fingerprint: { kernel_release: '7.0.0-14-generic' } }), 'ubuntu')
})

test('kernel is distro generic and never the host 7.0.0-14-generic', () => {
  assert.equal(isHostKernel('7.0.0-14-generic'), true)
  assert.equal(isHostKernel('6.8.0-51-generic'), false)
  const ubuntu = resolveWorkstationProfile({
    id: 'vm-05',
    kernel: 'ubuntu-24.04',
    fingerprint: { os_id: 'ubuntu', os_pretty: 'Ubuntu 24.04.4 LTS', kernel_release: '7.0.0-14-generic' },
  })
  assert.equal(ubuntu.sku, '4c8g')
  assert.equal(ubuntu.linux_distro_id, 'ubuntu')
  assert.equal(ubuntu.linux_distro_version, '24.04.4')
  assert.equal(ubuntu.linux_kernel, '6.8.0-51-generic')
  assert.equal(ubuntu.os_version, 'Linux 6.8.0-51-generic')
  assert.equal(ubuntu.cpus, 4)
  assert.equal(ubuntu.package_managers, 'apt')
  assert.equal(ubuntu.terminal, 'xterm-256color')
  assert.equal(ubuntu.process.constrained_memory, 0)
  assert.ok(!isHostKernel(ubuntu.linux_kernel))

  const debian = resolveWorkstationProfile({
    id: 'vm-10',
    kernel: 'debian-12',
    fingerprint: { os_id: 'debian', os_pretty: 'Debian GNU/Linux 12 (bookworm)', kernel_release: '7.0.0-14-generic' },
  })
  assert.ok(['2c4g', '4c8g'].includes(debian.sku))
  assert.equal(debian.linux_distro_id, 'debian')
  assert.match(debian.linux_kernel, /6\.1\.0-\d+-amd64/)
  assert.equal(debian.package_managers, 'apt')

  const arch = resolveWorkstationProfile({
    id: 'vm-11',
    kernel: 'archlinux',
    fingerprint: { os_id: 'arch', os_pretty: 'Arch Linux', kernel_release: '7.0.0-14-generic' },
  })
  assert.equal(arch.package_managers, 'pacman')
  assert.match(arch.linux_kernel, /arch1/)
  assert.notEqual(workstationKernel({ fingerprint: { kernel_release: '7.0.0-14-generic' } }), '7.0.0-14-generic')
})

test('kin-seed/2 records catalog kernel and workstation image', () => {
  const doc = buildKinSeedJson(
    {
      id: 'vm-05',
      kernel: 'ubuntu-24.04',
      timezone: 'America/Los_Angeles',
      locale: 'en_US.UTF-8',
      fingerprint: { kernel_release: '7.0.0-14-generic' },
    },
    { telemetry_disabled: false },
    { cli_version: '2.1.241' },
  )
  assert.equal(doc.schema, KIN_SEED_SCHEMA)
  assert.equal(doc.kernel, 'ubuntu-24.04')
  assert.equal(doc.linux_kernel, '6.8.0-51-generic')
  assert.equal(doc.workstation_sku, '4c8g')
  assert.equal(doc.telemetry, 'enabled')
  assert.equal(doc.cli_version, '2.1.241')
})
