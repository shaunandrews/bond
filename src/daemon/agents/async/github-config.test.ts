import { describe, expect, it, vi } from 'vitest'
import type { SecretStore } from '../../mcp/keychain'
import { BOND_GITHUB_REPOSITORY, createGitHubConfigService } from './github-config'

function fixture() {
  const settings = new Map<string, string>()
  const values = new Map<string, string>()
  const secrets: SecretStore = {
    set: vi.fn(async (ref, value) => { values.set(ref, value) }),
    get: vi.fn(async ref => values.get(ref) ?? null),
    remove: vi.fn(async ref => values.delete(ref)),
    list: vi.fn(async () => [...values.keys()]),
  }
  const service = createGitHubConfigService({
    readSetting: key => settings.get(key) ?? null,
    writeSetting: (key, value) => settings.set(key, value),
    secrets,
  })
  return { service, secrets }
}

describe('GitHub handoff configuration', () => {
  it('is disabled and reports missing credentials without exposing a value', async () => {
    const { service } = fixture()
    expect(await service.getConfig()).toEqual({
      enabled: false,
      repository: BOND_GITHUB_REPOSITORY,
      remote: 'origin',
      credentialRef: 'github-bond-agent',
      credentialConfigured: false,
    })
    await expect(service.credential()).rejects.toThrow('disabled')
  })

  it('stores the value only through the injected Keychain boundary', async () => {
    const { service, secrets } = fixture()
    await service.configure({ enabled: true, repository: BOND_GITHUB_REPOSITORY, remote: 'origin', credentialRef: 'github-bond-agent' })
    await expect(service.credential()).rejects.toThrow('missing')
    await service.setCredential('github_pat_test_value')
    expect(secrets.set).toHaveBeenCalledWith('github-bond-agent', 'github_pat_test_value')
    expect(await service.getConfig()).toMatchObject({ enabled: true, credentialConfigured: true })
    await expect(service.credential()).resolves.toBe('github_pat_test_value')
  })

  it('rejects arbitrary repositories, remotes, and secret names', async () => {
    const { service } = fixture()
    await expect(service.configure({ enabled: true, repository: 'someone/else', remote: 'origin', credentialRef: 'x' })).rejects.toThrow('restricted')
    await expect(service.configure({ enabled: true, repository: BOND_GITHUB_REPOSITORY, remote: 'upstream', credentialRef: 'x' })).rejects.toThrow('origin')
    await expect(service.configure({ enabled: true, repository: BOND_GITHUB_REPOSITORY, remote: 'origin', credentialRef: 'bad ref' })).rejects.toThrow('valid')
  })
})
