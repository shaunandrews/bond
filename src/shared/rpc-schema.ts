/**
 * Single source of truth for the Bond daemon's JSON-RPC wire contract.
 *
 * Every method the daemon dispatches has an entry here mapping its name to
 * the TRUE params and result shapes as implemented in src/daemon/server.ts.
 * The registry is a compile-time contract, not a validator — runtime guards
 * stay in the handlers. Layering rule: this file lives in src/shared and must
 * never import from src/daemon; daemon-local result shapes (remote status,
 * skills, Pi auth) are mirrored structurally below.
 */
import type {
  AttachedImage,
  Collection,
  CollectionItem,
  EditMode,
  FieldDefInput,
  ImageMediaType,
  ImageRecord,
  ItemComment,
  Session,
  SessionMessage,
} from './session'
import type { BondSendInput, TaggedChunk } from './stream'
import type { TranscriptMessage, TranscriptPage } from './transcript'
import type { SenseSettings, SenseState, SessionDebrief } from './sense'
import type {
  CoreMemory,
  MemoryItem,
  MemoryItemInput,
  MemorySourcesResult,
  RetrievedMemory,
  WorkingState,
} from './memory'
import type { OnboardingFirstRunState, SandboxStatus } from './onboarding'
import type { WebRenderRequest, WebRenderResult } from './web'
import type { ModelId } from './models'
import type { AssetBacklink, AssetKind, AssetReference, LibraryAddDocumentInput, LibraryAsset } from './library'
import type { AgentRosterResult, AgentSettings, AgentSummary } from './agents'

// --- Named wire shapes ---

/** Result of bond.send — mirrors the turn runner's StartTurnResult. */
export interface BondSendResult {
  ok: true
  queued: boolean
  imageIds?: string[]
  turnId: string
  epochId: string
}

/** Mirrors src/daemon/remote.ts RemoteStatus (shared cannot import daemon). */
export interface RemoteStatusResult {
  running: boolean
  port: number | null
  token: string | null
  urls: string[]
}

/** Mirrors src/daemon/pairing.ts RemoteDevice (shared cannot import daemon). */
export interface RemoteDeviceSummary {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string | null
}

/** Mirrors src/daemon/skills.ts SkillInfo (shared cannot import daemon). */
export interface SkillInfo {
  name: string
  description: string
  argumentHint: string
}

/** Mirrors src/daemon/pi/runtime.ts PiAuthStatus (shared cannot import daemon). */
export interface PiAuthStatusResult {
  configured: boolean
  providers: Array<{ providerId: string; type: 'api_key' | 'oauth' }>
}

/** Mirrors src/daemon/pi/runtime.ts OAuthStart (shared cannot import daemon). */
export interface PiOAuthStartResult {
  url: string
  instructions?: string
  deviceCode?: string
}

/** Mirrors src/daemon/mcp/policy.ts McpPolicy (shared cannot import daemon). */
export interface McpPolicyWire {
  trust: 'ask' | 'trusted' | 'disabled'
  read: string[]
  write: string[]
  alwaysAsk: string[]
  promoted: string[]
}

/**
 * Mirrors src/daemon/mcp/config.ts McpServerConfig (shared cannot import
 * daemon). Header/env values may be `keychain:<ref>` references — a real
 * secret never crosses this wire in either direction.
 */
export interface McpServerConfigWire {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  policy: McpPolicyWire
}

/** Mirrors src/daemon/mcp/manager.ts McpServerStatus. */
export interface McpServerStatusWire {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  state: 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error'
  toolCount: number
  trust: McpPolicyWire['trust']
  /** Keychain reference names only. */
  secretRefs: string[]
  error?: string
  stderr?: string
}

/** Mirrors src/daemon/mcp/manager.ts McpToolInfo, joined with its policy classification. */
export interface McpToolInfoWire {
  server: string
  serverName: string
  name: string
  description: string
  inputSchema: unknown
  annotations?: Record<string, unknown>
  /**
   * Sub-operation routing for proxy tools — one tool name fronting many
   * operations selected by argument. `segments` names the routing arguments
   * (e.g. provider, subtool); `options` lists the known first-segment values;
   * `classes` gives each option's current classification.
   */
  route?: {
    segments: string[]
    options: string[]
    classes: Record<string, 'read' | 'write' | 'unknown'>
  }
  /** Human-confirmed classification driving the approval gate. */
  toolClass: 'read' | 'write' | 'unknown'
  /** What the server's own annotations suggest — never authoritative. */
  suggestedClass: 'read' | 'write' | 'unknown'
  alwaysAsk: boolean
  promoted: boolean
}

/** Mirrors src/daemon/mcp/config.ts McpServerPreset. */
export interface McpServerPresetWire extends Omit<McpServerConfigWire, 'enabled' | 'policy'> {
  description: string
}

/** Mirrors src/daemon/sense/storage.ts getStats() return shape. */
export interface SenseStatsResult {
  storageBytes: number
  captureCount: number
  sessionCount: number
  oldestCapture: string | null
}

// Raw snake_case SQLite rows — the sense.* query methods return DB rows
// verbatim (captured_at, app_name, …); useSense normalizes to camelCase.
export type SenseCaptureRow = Record<string, unknown>
export type SenseSessionRow = Record<string, unknown>
/** Raw aggregated app row (app_name, app_bundle_id, capture_count, first_seen, last_seen). */
export type SenseAppRow = Record<string, unknown>
/**
 * Cross-channel sense.search hit: either a raw capture row with
 * channel: 'see' or a SessionDebrief with channel: 'chat'; both carry a
 * _sortDate used for the unified ordering.
 */
export type SenseSearchHit = Record<string, unknown>

export type SessionUpdates = Partial<
  Pick<Session, 'title' | 'summary' | 'archived' | 'favorited' | 'quick' | 'iconSeed' | 'editMode'>
>

export type CollectionUpdates = Partial<
  Pick<Collection, 'name' | 'icon' | 'archived' | 'features' | 'issuePrefix'>
> & {
  /** Accepts legacy string[] options on the wire; the daemon normalizes. */
  schema?: FieldDefInput[]
}

/** One resolvable PREFIX-n issue key — powers composer autocomplete, chips, and hover cards. */
export interface CollectionReference {
  key: string            // "BOND-12"
  title: string          // primary field value, or "Untitled"
  collectionId: string
  itemId: string
  prefix: string
  displayNumber: number
  /** Present when the collection has a status field: true if the item sits in a done/cancelled category. */
  done?: boolean
}

// --- The method registry ---

export interface RpcMethods {
  // Auth (consumed by attachConnection before dispatch — see DispatchableMethod)
  'bond.auth': { params: { token: string }; result: { ok: true; protocolVersion: number } }

  // Chat
  'bond.send': { params: Partial<BondSendInput> & { sessionId?: string }; result: BondSendResult }
  'bond.cancel': { params: { sessionId?: string } | void; result: { ok: true } }
  'bond.approvalResponse': { params: { requestId: string; approved: boolean }; result: { ok: true } }
  'bond.ping': { params: void; result: { ok: true; protocolVersion: number } }

  // Remote access (LAN web server). The code EXCHANGE is not here — it runs
  // over plain HTTP (POST /api/pair) because an unpaired client cannot open
  // an authenticated socket to make an RPC in the first place.
  'remote.status': { params: void; result: RemoteStatusResult }
  'remote.createPairingCode': { params: void; result: { code: string; expiresAt: number } }
  'remote.listDevices': { params: void; result: { devices: RemoteDeviceSummary[] } }
  'remote.revokeDevice': { params: { id: string }; result: { ok: true } }
  'remote.revokeAllDevices': { params: void; result: { ok: true; revoked: number } }

  // Subscriptions
  'bond.subscribe': { params: { sessionId?: string } | void; result: { ok: true } }
  'bond.unsubscribe': { params: { sessionId?: string } | void; result: { ok: true } }

  // Model
  'bond.setModel': { params: { model: ModelId }; result: { ok: true } }
  'bond.getModel': { params: void; result: ModelId }

  // Continuous transcript
  'transcript.list': { params: { beforeSeq?: number; limit?: number } | void; result: TranscriptPage }
  'transcript.upsert': { params: { messages: TranscriptMessage[] }; result: { ok: true } }
  'transcript.search': { params: { query: string; limit?: number }; result: { messages: TranscriptMessage[] } }

  // Sessions
  'session.list': { params: void; result: Session[] }
  'session.create': { params: { title?: string } | void; result: Session }
  'session.get': { params: { id: string }; result: Session | null }
  'session.update': { params: { id: string; updates?: SessionUpdates }; result: Session | null }
  'session.delete': { params: { id: string }; result: boolean }
  'session.deleteArchived': { params: void; result: { ok: true; count: number } }
  'session.getMessages': { params: { sessionId: string }; result: SessionMessage[] }
  'session.saveMessages': { params: { sessionId: string; messages: SessionMessage[] }; result: boolean }

  // Pi setup
  'pi.status': { params: void; result: PiAuthStatusResult }
  'pi.startOAuth': { params: { provider: 'anthropic' | 'openai-codex' }; result: PiOAuthStartResult }

  // Settings
  'settings.getEditMode': { params: void; result: EditMode }
  'settings.setEditMode': { params: { editMode: EditMode }; result: { ok: true } }
  'settings.getSoul': { params: void; result: string }
  'settings.saveSoul': { params: { content: string }; result: boolean }
  'settings.getAccentColor': { params: void; result: string }
  'settings.saveAccentColor': { params: { hex: string }; result: boolean }
  'settings.getWindowOpacity': { params: void; result: number }
  'settings.saveWindowOpacity': { params: { opacity: number }; result: boolean }

  // MCP connections
  'mcp.list': { params: void; result: { servers: McpServerConfigWire[]; presets: McpServerPresetWire[] } }
  'mcp.add': { params: { server?: Partial<McpServerConfigWire>; preset?: string }; result: McpServerConfigWire }
  'mcp.update': { params: { id: string; updates: Partial<Omit<McpServerConfigWire, 'id' | 'transport'>> }; result: McpServerConfigWire }
  'mcp.remove': { params: { id: string }; result: { ok: boolean } }
  'mcp.status': { params: void; result: { servers: McpServerStatusWire[] } }
  'mcp.listTools': { params: { server?: string; query?: string } | void; result: { tools: McpToolInfoWire[]; errors: Array<{ server: string; error: string }> } }
  'mcp.reconnect': { params: { id: string }; result: { ok: true } }
  'mcp.setTrust': { params: { id: string; trust: McpPolicyWire['trust'] }; result: McpServerConfigWire }
  'mcp.classifyTool': { params: { id: string; tool: string; toolClass: 'read' | 'write' | 'unknown' }; result: McpServerConfigWire }
  'mcp.promoteTool': { params: { id: string; tool: string; promoted: boolean }; result: McpServerConfigWire }
  'mcp.setAlwaysAsk': { params: { id: string; tool: string; alwaysAsk: boolean }; result: McpServerConfigWire }
  /** Writes a secret into the macOS Keychain. The value is write-only — no RPC ever reads it back. */
  'mcp.setSecret': { params: { ref: string; value: string }; result: { ok: true; ref: string } }
  'mcp.deleteSecret': { params: { ref: string }; result: { ok: boolean } }
  'mcp.listSecrets': { params: void; result: { refs: string[] } }

  // Agents (specialist consultant roster)
  'agents.list': { params: void; result: AgentRosterResult }
  'agents.updateSettings': { params: { name: string; settings: Partial<AgentSettings> }; result: AgentSummary }
  'agents.revokeRunner': { params: { command: string }; result: AgentRosterResult }

  // Skills
  'skills.list': { params: void; result: SkillInfo[] }
  'skills.refresh': { params: void; result: SkillInfo[] }
  'skills.remove': { params: { name: string }; result: { ok: boolean } }

  // Images
  'image.list': { params: void; result: ImageRecord[] }
  'image.get': { params: { id: string }; result: AttachedImage | null }
  'image.getMultiple': { params: { ids: string[] }; result: (AttachedImage | null)[] }
  'image.import': { params: { data: string; mediaType: ImageMediaType }; result: ImageRecord }
  'image.delete': { params: { id: string }; result: boolean }

  // Collections
  'collection.list': { params: void; result: Collection[] }
  'collection.get': { params: { id: string }; result: Collection | null }
  'collection.create': { params: { name: string; schema: FieldDefInput[]; icon?: string; issuePrefix?: string }; result: Collection }
  'collection.update': { params: { id: string; updates?: CollectionUpdates }; result: Collection | null }
  'collection.delete': { params: { id: string }; result: boolean }
  'collection.renameField': { params: { id: string; oldName: string; newName: string }; result: boolean }
  'collection.listItems': { params: { collectionId: string }; result: CollectionItem[] }
  'collection.getItem': { params: { id: string }; result: CollectionItem | null }
  'collection.addItem': { params: { collectionId: string; data: Record<string, unknown> }; result: CollectionItem }
  'collection.updateItem': { params: { id: string; data: Record<string, unknown> }; result: CollectionItem | null }
  'collection.deleteItem': { params: { id: string }; result: boolean }
  'collection.reorderItems': { params: { ids: string[] }; result: true }
  'collection.addItemComment': { params: { itemId: string; author: 'user' | 'bond'; body: string }; result: ItemComment }
  'collection.deleteItemComment': { params: { id: string }; result: boolean }
  'collection.listItemComments': { params: { itemId: string }; result: ItemComment[] }
  'collection.searchItems': { params: { collectionId: string; query: string }; result: CollectionItem[] }
  'collection.getByName': { params: { name: string }; result: Collection | null }
  'collection.listReferences': { params: void; result: CollectionReference[] }

  // Library
  'library.list': { params: { kind?: AssetKind; query?: string } | void; result: LibraryAsset[] }
  'library.get': { params: { id: string }; result: LibraryAsset | null }
  'library.addDocument': { params: LibraryAddDocumentInput; result: LibraryAsset }
  'library.updateMetadata': { params: { id: string; updates: { title?: string; sourceUrl?: string } }; result: LibraryAsset | null }
  'library.delete': { params: { id: string }; result: { ok: boolean } }
  'library.addReference': { params: { assetId: string; itemId: string }; result: AssetReference }
  'library.removeReference': { params: { assetId: string; itemId: string }; result: { ok: boolean } }
  'library.listReferencesForItem': { params: { itemId: string }; result: LibraryAsset[] }
  'library.listBacklinksForAsset': { params: { assetId: string }; result: AssetBacklink[] }

  // Sense
  'sense.status': { params: void; result: { enabled: boolean; state: SenseState } & SenseStatsResult }
  'sense.enable': { params: void; result: { ok: true } }
  'sense.disable': { params: void; result: { ok: true } }
  'sense.pause': { params: { minutes?: number } | void; result: { ok: true; resumeAt: string } }
  'sense.resume': { params: void; result: { ok: true } }
  'sense.captureReady': { params: { captureId: string; imagePath: string }; result: { ok: true } }
  'sense.now': { params: void; result: { capture: SenseCaptureRow | null; state: SenseState } }
  'sense.today': { params: void; result: { sessions: SenseSessionRow[]; apps: SenseAppRow[] } }
  'sense.search': { params: { query: string; limit?: number }; result: SenseSearchHit[] }
  'sense.apps': { params: { range?: 'today' | 'week' } | void; result: SenseAppRow[] }
  'sense.timeline': { params: { from?: string; to?: string; limit?: number } | void; result: SenseCaptureRow[] }
  'sense.capture': { params: { id: string }; result: { capture: SenseCaptureRow; image: string | null } }
  'sense.sessions': { params: { from?: string; to?: string } | void; result: SenseSessionRow[] }
  'sense.settings': { params: void; result: SenseSettings }
  'sense.updateSettings': { params: { updates: Partial<SenseSettings> }; result: SenseSettings }
  'sense.clear': { params: { range?: { from?: string; to?: string } } | void; result: { deletedCount: number } }
  'sense.stats': { params: void; result: SenseStatsResult }

  // Web (hidden-browser render round-trip)
  'web.renderReady': { params: WebRenderResult; result: { ok: boolean } }

  // Onboarding
  'onboarding.status': { params: void; result: OnboardingFirstRunState }
  'onboarding.begin': { params: void; result: OnboardingFirstRunState }
  'onboarding.skip': { params: void; result: OnboardingFirstRunState }

  // New-user sandbox
  'sandbox.status': { params: void; result: SandboxStatus }
  'sandbox.enter': { params: void; result: SandboxStatus }
  'sandbox.exit': { params: void; result: SandboxStatus }

  // Memory
  'memory.core': { params: void; result: CoreMemory }
  'memory.updateCore': { params: { core: CoreMemory }; result: CoreMemory }
  'memory.working': { params: void; result: WorkingState }
  'memory.updateWorking': { params: { working: Partial<WorkingState> }; result: WorkingState }
  'memory.clearWorking': { params: void; result: WorkingState }
  'memory.search': { params: { query?: string; limit?: number } | void; result: { results: RetrievedMemory[] } }
  'memory.upsert': { params: { item: MemoryItemInput }; result: MemoryItem }
  'memory.delete': { params: { id: string }; result: { ok: boolean } }
  'memory.sources': { params: { id: string }; result: MemorySourcesResult }

  // Sense debriefs
  'sense.memory': { params: { limit?: number } | void; result: { debriefs: SessionDebrief[] } }
  'sense.debrief': { params: { id?: string; sessionId?: string } | void; result: SessionDebrief | null }
  'sense.deleteDebrief': { params: { id: string }; result: { ok: boolean } }
  'sense.systemPromptPreview': { params: { editMode?: EditMode } | void; result: { prompt: string } }
  'sense.backfill': { params: { limit?: number } | void; result: { ok: true; message: string } }
}

// --- Helper types ---

export type RpcMethodName = keyof RpcMethods
/** bond.auth is consumed by attachConnection before dispatch — not a handler. */
export type DispatchableMethod = Exclude<RpcMethodName, 'bond.auth'>
export type RpcParams<M extends RpcMethodName> = RpcMethods[M]['params']
export type RpcResult<M extends RpcMethodName> = RpcMethods[M]['result']
export type RpcParamsArg<M extends RpcMethodName> =
  RpcParams<M> extends void ? [] :
  void extends RpcParams<M> ? [params?: Exclude<RpcParams<M>, void>] :
  [params: RpcParams<M>]

// --- Notifications (daemon → client pushes; no id, no response) ---

export interface RpcNotifications {
  'bond.chunk': TaggedChunk
  'collection.changed': Record<string, never>
  'image.changed': Record<string, never>
  'library.changed': Record<string, never>
  'mcp.changed': Record<string, never>
  'sense.stateChanged': { state: SenseState }
  'sense.requestCapture': { captureDir: string; captureId: string }
  'web.requestRender': WebRenderRequest
}

export type RpcNotificationName = keyof RpcNotifications

// --- Runtime name list (compile-time checked for completeness) ---

export const RPC_METHOD_NAMES = [
  'bond.auth',
  'bond.send',
  'bond.cancel',
  'bond.approvalResponse',
  'bond.ping',
  'remote.status',
  'remote.createPairingCode',
  'remote.listDevices',
  'remote.revokeDevice',
  'remote.revokeAllDevices',
  'bond.subscribe',
  'bond.unsubscribe',
  'bond.setModel',
  'bond.getModel',
  'transcript.list',
  'transcript.upsert',
  'transcript.search',
  'session.list',
  'session.create',
  'session.get',
  'session.update',
  'session.delete',
  'session.deleteArchived',
  'session.getMessages',
  'session.saveMessages',
  'pi.status',
  'pi.startOAuth',
  'settings.getEditMode',
  'settings.setEditMode',
  'settings.getSoul',
  'settings.saveSoul',
  'settings.getAccentColor',
  'settings.saveAccentColor',
  'settings.getWindowOpacity',
  'settings.saveWindowOpacity',
  'mcp.list',
  'mcp.add',
  'mcp.update',
  'mcp.remove',
  'mcp.status',
  'mcp.listTools',
  'mcp.reconnect',
  'mcp.setTrust',
  'mcp.classifyTool',
  'mcp.promoteTool',
  'mcp.setAlwaysAsk',
  'mcp.setSecret',
  'mcp.deleteSecret',
  'mcp.listSecrets',
  'agents.list',
  'agents.updateSettings',
  'agents.revokeRunner',
  'skills.list',
  'skills.refresh',
  'skills.remove',
  'image.list',
  'image.get',
  'image.getMultiple',
  'image.import',
  'image.delete',
  'collection.list',
  'collection.get',
  'collection.create',
  'collection.update',
  'collection.delete',
  'collection.renameField',
  'collection.listItems',
  'collection.getItem',
  'collection.addItem',
  'collection.updateItem',
  'collection.deleteItem',
  'collection.reorderItems',
  'collection.addItemComment',
  'collection.deleteItemComment',
  'collection.listItemComments',
  'collection.searchItems',
  'collection.getByName',
  'collection.listReferences',
  'library.list',
  'library.get',
  'library.addDocument',
  'library.updateMetadata',
  'library.delete',
  'library.addReference',
  'library.removeReference',
  'library.listReferencesForItem',
  'library.listBacklinksForAsset',
  'sense.status',
  'sense.enable',
  'sense.disable',
  'sense.pause',
  'sense.resume',
  'sense.captureReady',
  'sense.now',
  'sense.today',
  'sense.search',
  'sense.apps',
  'sense.timeline',
  'sense.capture',
  'sense.sessions',
  'sense.settings',
  'sense.updateSettings',
  'sense.clear',
  'sense.stats',
  'web.renderReady',
  'onboarding.status',
  'onboarding.begin',
  'onboarding.skip',
  'sandbox.status',
  'sandbox.enter',
  'sandbox.exit',
  'memory.core',
  'memory.updateCore',
  'memory.working',
  'memory.updateWorking',
  'memory.clearWorking',
  'memory.search',
  'memory.upsert',
  'memory.delete',
  'memory.sources',
  'sense.memory',
  'sense.debrief',
  'sense.deleteDebrief',
  'sense.systemPromptPreview',
  'sense.backfill',
] as const satisfies readonly RpcMethodName[]

type _MissingFromList = Exclude<RpcMethodName, (typeof RPC_METHOD_NAMES)[number]>
const _assertComplete: _MissingFromList extends never ? true : _MissingFromList = true
void _assertComplete
