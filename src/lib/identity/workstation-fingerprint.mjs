/**
 * Create/reset Linux workstation identity for a slot.
 * Official ~/.claude.json machineID still overwrites device_id after init.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { US_TIMEZONES, validTimezone } from '../core/timezone.mjs'
import {
  MAC_RE,
  workstationFamily,
  workstationKernel,
  workstationMacAddress,
  workstationSkuId,
} from './workstation-profile.mjs'

export const HOSTNAME_RE = /^[a-z]+-[0-9a-f]{4}$/
export const DEVICE_ID_RE = /^[0-9a-f]{64}$/i
export const MACHINE_ID_RE = /^[0-9a-f]{32}$/i
export { MAC_RE }
export const STANDARD_LOCALE = 'en_US.UTF-8'

export function isHexDeviceId(value) {
  return DEVICE_ID_RE.test(String(value || '').trim())
}

export function isGeneratedHostname(value) {
  return HOSTNAME_RE.test(String(value || '').trim())
}

export function guestMachineIdPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'machine-id')
}

export function takenFingerprintKeys(vms, { exceptId } = {}) {
  const hostname = new Set()
  const device_id = new Set()
  const guest_machine_id = new Set()
  const mac_address = new Set()
  for (const vm of vms || []) {
    if (exceptId && vm.id === exceptId) continue
    const fp = vm.fingerprint || {}
    if (fp.hostname) hostname.add(String(fp.hostname))
    if (fp.device_id) device_id.add(String(fp.device_id))
    if (fp.guest_machine_id) guest_machine_id.add(String(fp.guest_machine_id))
    if (fp.mac_address) mac_address.add(String(fp.mac_address).toLowerCase())
  }
  return { hostname, device_id, guest_machine_id, mac_address }
}

function hex(n) {
  return crypto.randomBytes(n).toString('hex')
}

function pickTimezone(vm = {}) {
  return validTimezone(vm.timezone) || US_TIMEZONES[crypto.randomInt(0, US_TIMEZONES.length)]
}

export function generateWorkstationFingerprint(vm = {}, { taken, now } = {}) {
  const family = workstationFamily(vm)
  const usedHost = taken?.hostname || new Set()
  const usedDev = taken?.device_id || new Set()
  const usedMid = taken?.guest_machine_id || new Set()
  const usedMac = taken?.mac_address || new Set()
  const stamp = now || new Date().toISOString()
  let hostname = ''
  let device_id = ''
  let guest_machine_id = ''
  let mac_address = ''
  for (let i = 0; i < 16; i++) {
    hostname = `${family}-${hex(2)}`
    device_id = hex(32)
    guest_machine_id = hex(16)
    // Hardware follows the new machine-id, so a reset rotates the whole pack.
    mac_address = workstationMacAddress(vm, { seed: guest_machine_id })
    if (
      !usedHost.has(hostname) &&
      !usedDev.has(device_id) &&
      !usedMid.has(guest_machine_id) &&
      !usedMac.has(mac_address)
    ) {
      break
    }
  }
  if (usedHost.has(hostname) || usedDev.has(device_id) || usedMid.has(guest_machine_id) || usedMac.has(mac_address)) {
    throw new Error('workstation fingerprint collision')
  }
  return {
    hostname,
    guest_machine_id,
    device_id,
    mac_address,
    session_id: crypto.randomUUID(),
    sku: workstationSkuId(vm, { seed: guest_machine_id }),
    linux_kernel: workstationKernel(vm, { seed: guest_machine_id }),
    timezone: pickTimezone(vm),
    locale: String(vm.locale || '').trim() || STANDARD_LOCALE,
    source: 'generated',
    generated_at: stamp,
    reset_at: stamp,
  }
}

export function applyGeneratedFingerprint(prev = {}, generated = {}) {
  const next = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    hostname: generated.hostname,
    guest_machine_id: generated.guest_machine_id,
    device_id: generated.device_id,
    mac_address: generated.mac_address,
    session_id: generated.session_id,
    sku: generated.sku,
    linux_kernel: generated.linux_kernel,
    timezone: generated.timezone,
    locale: generated.locale,
    source: 'generated',
    generated_at: generated.generated_at,
    reset_at: generated.reset_at || generated.generated_at,
  }
  delete next.official_machine_id
  delete next.official_user_id
  delete next.identity_source
  return next
}

export function writeGuestMachineIdFile(projectRoot, vmId, machineId) {
  const id = String(machineId || '')
    .trim()
    .toLowerCase()
  if (!MACHINE_ID_RE.test(id)) throw new Error('invalid guest machine-id')
  fs.mkdirSync(path.join(projectRoot, 'vms', vmId), { recursive: true })
  const dest = guestMachineIdPath(projectRoot, vmId)
  try {
    const st = fs.lstatSync(dest)
    if (st.isDirectory()) fs.rmSync(dest, { recursive: true, force: true })
    else fs.unlinkSync(dest)
  } catch {}
  fs.writeFileSync(dest, `${id}\n`, { encoding: 'utf8', mode: 0o644 })
  return dest
}

export function ensureGuestMachineIdFile(projectRoot, vm) {
  const id = String(vm?.fingerprint?.guest_machine_id || '').trim()
  if (!MACHINE_ID_RE.test(id) || !vm?.id || !projectRoot) return null
  const dest = guestMachineIdPath(projectRoot, vm.id)
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).isFile()) return dest
  } catch {}
  return writeGuestMachineIdFile(projectRoot, vm.id, id)
}
