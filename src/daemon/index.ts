export { setDataDir, getDataDir } from './paths'
export { closeDb } from './db'
export { runBondQuery, resolvePendingApproval, clearSessionApprovals, bondMessageToChunks } from './agent'
export type { BondStreamChunk } from './agent'
export {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
  getMessages,
  saveMessages
} from './sessions'
export { generateTitleAndSummary } from './generate-title'
export {
  getSoul,
  saveSoul,
  getModelSetting,
  saveModelSetting,
  getAccentColor,
  saveAccentColor
} from './settings'
export { startServer, type BondServer } from './server'
