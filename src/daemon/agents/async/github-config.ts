import type { GitHubHandoffConfig } from '../../../shared/agent-runs'
import { SECRET_REF_RE, getSecretStore, type SecretStore } from '../../mcp/keychain'
import { getSetting, setSetting } from '../../settings'

export const BOND_GITHUB_REPOSITORY = 'shaunandrews/bond' as const
export const BOND_GITHUB_REMOTE = 'origin' as const
export const DEFAULT_GITHUB_CREDENTIAL_REF = 'github-bond-agent'

const ENABLED_KEY = 'agents.github.enabled'
const CREDENTIAL_REF_KEY = 'agents.github.credentialRef'

export interface GitHubConfigServiceOptions {
  readSetting?: (key: string) => string | null
  writeSetting?: (key: string, value: string) => unknown
  secrets?: SecretStore
}

export function createGitHubConfigService(options: GitHubConfigServiceOptions = {}) {
  const readSetting = options.readSetting ?? getSetting
  const writeSetting = options.writeSetting ?? setSetting
  const secrets = options.secrets ?? getSecretStore()

  function credentialRef(): string {
    const stored = readSetting(CREDENTIAL_REF_KEY)?.trim()
    return stored && SECRET_REF_RE.test(stored) ? stored : DEFAULT_GITHUB_CREDENTIAL_REF
  }

  async function getConfig(): Promise<GitHubHandoffConfig> {
    const ref = credentialRef()
    return {
      enabled: readSetting(ENABLED_KEY) === 'true',
      repository: BOND_GITHUB_REPOSITORY,
      remote: BOND_GITHUB_REMOTE,
      credentialRef: ref,
      credentialConfigured: (await secrets.get(ref)) !== null,
    }
  }

  async function configure(input: { enabled: boolean; repository: string; remote: string; credentialRef: string }): Promise<GitHubHandoffConfig> {
    if (input.repository !== BOND_GITHUB_REPOSITORY) throw new Error(`GitHub handoff is restricted to ${BOND_GITHUB_REPOSITORY}.`)
    if (input.remote !== BOND_GITHUB_REMOTE) throw new Error(`GitHub handoff is restricted to the ${BOND_GITHUB_REMOTE} remote.`)
    if (!SECRET_REF_RE.test(input.credentialRef)) throw new Error('credentialRef must be a valid Keychain reference name.')
    writeSetting(CREDENTIAL_REF_KEY, input.credentialRef)
    writeSetting(ENABLED_KEY, input.enabled ? 'true' : 'false')
    return getConfig()
  }

  async function setCredential(value: string): Promise<void> {
    if (!value.trim()) throw new Error('GitHub credential cannot be empty.')
    await secrets.set(credentialRef(), value)
  }

  async function credential(): Promise<string> {
    const config = await getConfig()
    if (!config.enabled) throw new Error('GitHub draft publishing is disabled. Configure and enable the scoped Bond repository handoff first.')
    const value = await secrets.get(config.credentialRef)
    if (!value) throw new Error(`GitHub credential is missing. Store a repo-scoped credential in Keychain reference "${config.credentialRef}".`)
    return value
  }

  return { getConfig, configure, setCredential, credential }
}

export const githubConfigService = createGitHubConfigService()
