import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureDeviceId, readDeviceState } from '../src/sync/migrate.ts'

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
