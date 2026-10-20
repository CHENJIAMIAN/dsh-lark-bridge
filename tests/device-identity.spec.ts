import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureDeviceId,
  legacyMachineFingerprint,
  machineFingerprint,
  readDeviceState,
} from '../src/sync/migrate.ts'

/**
 * A machine that copies the whole home directory brings the old machine's
 * identity with it. Two machines answering the same chat, and a retired
 * flag that silences the fresh one, are both worse than losing history —
 * so the identity has to notice that it landed on a different machine.
 */
describe('a copied home directory does not carry the old machine identity over', () => {
  /** A home whose device state was copied from another machine. */
  function copiedHome(state: Record<string, unknown>): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-copied-'))
    fs.mkdirSync(path.join(home, 'dsh-lark-bridge'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'dsh-lark-bridge', 'device-state.json'),
      JSON.stringify(state, null, 2) + '\n',
    )
    return home
  }

  it('mints a new identity when the state came from another machine', async () => {
    const home = copiedHome({
      deviceId: 'dev-oldmachine-0001',
      deviceName: 'OLD-BOX',
      machineFingerprint: 'fingerprint-of-the-old-machine',
    })
    const identity = await ensureDeviceId(home, { fingerprint: 'fingerprint-of-this-machine' })
    expect(identity.deviceId).not.toBe('dev-oldmachine-0001')
    expect(identity.deviceId).toMatch(/^dev-/)
  })

  it('drops a retired flag that arrived with the copy', async () => {
    const home = copiedHome({
      deviceId: 'dev-oldmachine-0001',
      deviceName: 'OLD-BOX',
      retired: true,
      retiredAt: '2026-01-01T00:00:00.000Z',
      machineFingerprint: 'fingerprint-of-the-old-machine',
    })
    await ensureDeviceId(home, { fingerprint: 'fingerprint-of-this-machine' })
    const state = await readDeviceState(home)
    expect(state.retired).toBeUndefined()
    expect(state.deviceId).not.toBe('dev-oldmachine-0001')
  })

  it('keeps the identity when the machine is the same one', async () => {
    const home = copiedHome({
      deviceId: 'dev-samemachine-002',
      deviceName: 'THIS-BOX',
      machineFingerprint: 'fingerprint-of-this-machine',
    })
    const identity = await ensureDeviceId(home, { fingerprint: 'fingerprint-of-this-machine' })
    expect(identity.deviceId).toBe('dev-samemachine-002')
  })

  it('keeps a state that predates the fingerprint, so an upgrade does not renumber devices', async () => {
    const home = copiedHome({ deviceId: 'dev-legacy-000003', deviceName: 'LEGACY-BOX' })
    const identity = await ensureDeviceId(home, { fingerprint: 'fingerprint-of-this-machine' })
    expect(identity.deviceId).toBe('dev-legacy-000003')
  })

  it('records the fingerprint so the next start can compare again', async () => {
    const home = copiedHome({ deviceId: 'dev-legacy-000003', deviceName: 'LEGACY-BOX' })
    await ensureDeviceId(home, { fingerprint: 'fingerprint-of-this-machine' })
    const state = await readDeviceState(home)
    expect(state.machineFingerprint).toBe('fingerprint-of-this-machine')
  })
})


/**
 * The digest that tells this machine from another one has to survive a
 * rename. A host that gets renamed — a WSL distribution, a container, a
 * cloud instance — is the same machine with a different name, and a digest
 * that folds the name in would report it as a copy: the identity would be
 * re-minted, the retirement an operator set would be cleared, and the
 * device would answer the chat again.
 */
describe('the machine digest survives a rename', () => {
  it('digests only the machine id, with no hostname in it', () => {
    // The expectation is computed from the identifiers that exist on this
    // host, so a digest that folded anything else in cannot match it.
    const sources = ['/etc/machine-id', '/var/lib/dbus/machine-id']
      .map(file => {
        try {
          const value = fs.readFileSync(file, 'utf8').trim()
          return value === '' ? undefined : value
        } catch {
          return undefined
        }
      })
      .filter((value): value is string => value !== undefined)

    const current = machineFingerprint()
    if (sources.length === 0) {
      // No stable identifier here: the hostname is the only thing left.
      expect(current).toBeDefined()
      return
    }
    const expected = createHash('sha256')
      .update(sources.join('\u0000'))
      .digest('hex')
      .slice(0, 32)
    expect(current).toBe(expected)
  })

  it('keeps a device recorded under the old digest, and its retirement', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-legacy-digest-'))
    fs.mkdirSync(path.join(home, 'dsh-lark-bridge'), { recursive: true })
    const oldDigest = legacyMachineFingerprint()
    expect(oldDigest).toBeDefined()
    fs.writeFileSync(
      path.join(home, 'dsh-lark-bridge', 'device-state.json'),
      JSON.stringify({
        deviceId: 'dev-renamed-box-004',
        deviceName: 'RENAMED-BOX',
        retired: true,
        retiredAt: '2026-01-01T00:00:00.000Z',
        machineFingerprint: oldDigest,
      }, null, 2) + '\n',
    )

    const identity = await ensureDeviceId(home)

    expect(identity.deviceId).toBe('dev-renamed-box-004')
    const state = await readDeviceState(home)
    expect(state.retired).toBe(true)
    expect(state.machineFingerprint).toBe(machineFingerprint())
    // The old digest is kept, so the next start recognises this machine
    // under either rule.
    expect(state.machineFingerprintLegacy).toBe(oldDigest)
  })

  it('still re-mints a state that came from a genuinely different machine', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-other-box-'))
    fs.mkdirSync(path.join(home, 'dsh-lark-bridge'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'dsh-lark-bridge', 'device-state.json'),
      JSON.stringify({
        deviceId: 'dev-other-000005',
        deviceName: 'OTHER-BOX',
        retired: true,
        machineFingerprint: 'digest-of-a-different-machine',
      }, null, 2) + '\n',
    )

    const identity = await ensureDeviceId(home)

    expect(identity.deviceId).not.toBe('dev-other-000005')
    const state = await readDeviceState(home)
    expect(state.retired).toBeUndefined()
  })
})
