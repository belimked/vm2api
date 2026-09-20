/**
 * Linux 准系统画像 for telemetry + unofficial Environment.
 * Guest distro stays (ubuntu/debian/arch/fedora). Host kernel / docker
 * hostname / 768m cgroup never go outbound. Hardware SKU is 2C4G or 4C8G
 * presentation only — the box cannot actually host those limits.
 */
import crypto from 'node:crypto'
import { distroVersionFromPretty } from './telemetry-env.mjs'

export const WORKSTATION_SKUS = Object.freeze({
  '2c4g': Object.freeze({
    id: '2c4g',
    cpus: 2,
    memory_bytes: 4 * 1024 ** 3,
    process: Object.freeze({
      constrained_memory: 0,
      rss_range: [180_000_000, 380_000_000],
      heap_total_range: [48_000_000, 96_000_000],
      heap_used_range: [36_000_000, 88_000_000],
      external_range: [1_000_000, 3_000_000],
      array_buffers_range: [10_000, 50_000],
    }),
  }),
  '4c8g': Object.freeze({
    id: '4c8g',
    cpus: 4,
    memory_bytes: 8 * 1024 ** 3,
    process: Object.freeze({
      constrained_memory: 0,
      rss_range: [220_000_000, 480_000_000],
      heap_total_range: [56_000_000, 120_000_000],
      heap_used_range: [40_000_000, 100_000_000],
      external_range: [1_200_000, 3_500_000],
      array_buffers_range: [12_000, 60_000],
    }),
  }),
})

export const SKU_ORDER = Object.freeze(['2c4g', '4c8g'])

const FAMILY_KERNELS = Object.freeze({
  ubuntu: Object.freeze(['6.8.0-47-generic', '6.8.0-51-generic', '6.8.0-52-generic', '6.8.0-54-generic']),
  debian: Object.freeze(['6.1.0-25-amd64', '6.1.0-28-amd64', '6.1.0-31-amd64']),
  arch: Object.freeze(['6.12.8-arch1-1', '6.12.10-arch1-1', '6.13.1-arch1-1']),
  fedora: Object.freeze(['6.11.8-300.fc41.x86_64', '6.11.10-300.fc41.x86_64']),
})

const FAMILY_PACKAGES = Object.freeze({
  ubuntu: 'apt',
  debian: 'apt',
  arch: 'pacman',
  fedora: 'dnf',
})

const FAMILY_VERSION = Object.freeze({
  ubuntu: '24.04',
  debian: '12',
  arch: '',
  fedora: '41',
})

const HOST_KERNEL_RE = /^(7\.0\.0-\d+-generic|.*\bhost\b)/i

export const WORKSTATION_TERMINAL = 'xterm-256color'
export const WORKSTATION_SHELL = '/bin/bash'

/**
 * Vendor OUI prefixes for the slot NIC. Docker hands out 02:42:* — a range
 * that marks a container at a glance. A workstation carries a real vendor
 * prefix, so the slot picks one deterministically from its own hash seed.
 */
export const NIC_OUIS = Object.freeze([
  '00:1b:21', // Intel
  '3c:fd:fe', // Intel
  'a4:bb:6d', // Intel
  '00:14:22', // Dell
  'b8:2a:72', // Dell
  '00:1f:29', // HP
  '00:e0:4c', // Realtek
])

export const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

/**
 * Stable per-slot hash seed. The slot machine-id comes first so two slots
 * created back to back get unrelated hardware; vm id only covers the window
 * before a fingerprint exists.
 */
export function slotHashSeed(vm = {}) {
  const fp = vm.fingerprint || {}
  return String(fp.guest_machine_id || fp.device_id || vm.id || vm.vmId || '').trim()
}

function slotHash(seed, salt) {
  return crypto.createHash('sha256').update(`${salt}:${seed}`).digest().readUInt32BE(0)
}

/**
 * Pick from a catalog by slot hash instead of slot index. Index arithmetic
 * made slot N and slot N+4 share every attribute, which reads as one gateway
 * cluster rather than N unrelated workstations.
 */
export function slotPick(list, vm = {}, salt = '', seed = '') {
  const items = Array.isArray(list) && list.length ? list : ['']
  return items[slotHash(seed || slotHashSeed(vm), salt) % items.length]
}

/** Slot NIC address. A stored fingerprint value wins so a live slot never moves. */
export function workstationMacAddress(vm = {}, { seed = '' } = {}) {
  if (!seed) {
    const pinned = String(vm.fingerprint?.mac_address || '')
      .trim()
      .toLowerCase()
    if (MAC_RE.test(pinned)) return pinned
  }
  const src = seed || slotHashSeed(vm)
  const oui = slotPick(NIC_OUIS, vm, 'mac:oui', src)
  const tail = crypto.createHash('sha256').update(`mac:nic:${src}`).digest('hex').slice(0, 6)
  return `${oui}:${tail.slice(0, 2)}:${tail.slice(2, 4)}:${tail.slice(4, 6)}`
}

export function workstationFamily(vm = {}) {
  const osId = String(vm.fingerprint?.os_id || '').toLowerCase()
  const kernel = String(vm.kernel || vm.fingerprint?.os_pretty || '').toLowerCase()
  if (osId === 'ubuntu' || kernel.includes('ubuntu')) return 'ubuntu'
  if (osId === 'debian' || kernel.includes('debian')) return 'debian'
  if (osId === 'arch' || kernel.includes('arch')) return 'arch'
  if (osId === 'fedora' || kernel.includes('fedora')) return 'fedora'
  return 'ubuntu'
}

/** A stored sku wins; only a fresh pack (explicit seed) rotates it. */
export function workstationSkuId(vm = {}, { seed = '' } = {}) {
  if (!seed) {
    const pinned = String(vm.fingerprint?.sku || '').trim()
    if (WORKSTATION_SKUS[pinned]) return pinned
  }
  return slotPick(SKU_ORDER, vm, 'sku', seed)
}

/** A stored kernel wins only while it still belongs to the current distro. */
export function workstationKernel(vm = {}, { seed = '' } = {}) {
  const family = workstationFamily(vm)
  const list = FAMILY_KERNELS[family] || FAMILY_KERNELS.ubuntu
  if (!seed) {
    const pinned = String(vm.fingerprint?.linux_kernel || '').trim()
    if (list.includes(pinned)) return pinned
  }
  return slotPick(list, vm, `kernel:${family}`, seed)
}

export function isHostKernel(release = '') {
  return HOST_KERNEL_RE.test(String(release || '').trim())
}

export function resolveWorkstationProfile(vm = {}) {
  const family = workstationFamily(vm)
  const skuId = workstationSkuId(vm)
  const sku = WORKSTATION_SKUS[skuId]
  const guest = vm.fingerprint || {}
  const prettyVersion = distroVersionFromPretty(guest.os_pretty)
  const linux_kernel = workstationKernel(vm)
  return {
    sku: skuId,
    cpus: sku.cpus,
    family,
    linux_distro_id: family,
    linux_distro_version: prettyVersion || FAMILY_VERSION[family] || '',
    linux_kernel,
    os_version: `Linux ${linux_kernel}`,
    package_managers: FAMILY_PACKAGES[family] || 'apt',
    terminal: WORKSTATION_TERMINAL,
    shell: WORKSTATION_SHELL,
    process: { ...sku.process },
  }
}

export const KIN_SEED_SCHEMA = 'kin-seed/2'

/** Slot seed sidecar. Catalog kernel + workstation image, never host release. */
export function buildKinSeedJson(vm = {}, pol = {}, extras = {}) {
  const ws = resolveWorkstationProfile(vm)
  return {
    schema: KIN_SEED_SCHEMA,
    pure: true,
    kernel: vm.kernel || extras.kernel || null,
    linux_kernel: ws.linux_kernel,
    workstation_sku: ws.sku,
    timezone: vm.timezone || extras.timezone || null,
    locale: vm.locale || extras.locale || null,
    seed_policy: pol && typeof pol === 'object' ? pol : {},
    telemetry: pol.telemetry_disabled === false ? 'enabled' : 'disabled',
    cli_version: extras.cli_version || null,
    seeded_at: extras.seeded_at || new Date().toISOString(),
  }
}
