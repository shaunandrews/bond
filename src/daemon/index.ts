export { setDataDir, getDataDir } from './paths'
export { closeDb } from './db'
export { runBondQuery } from './agent'
export { resolveApproval, clearTurnApprovals, registerApproval } from './approvals'
export { resolveQuestion, clearTurnQuestions, registerQuestion, currentPendingQuestion } from './questions'
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
  calculateSoftLimit,
  closeEpoch,
  createEpoch,
  ensureActiveEpoch,
  findActiveEpoch,
  findEpoch,
  type Epoch,
  type EnsureActiveEpochOptions,
  type EnsureActiveEpochResult,
} from './epochs'
export {
  getSoul,
  saveSoul,
  getModelSetting,
  saveModelSetting,
  getAccentColor,
  saveAccentColor
} from './settings'
export { startServer, type BondServer } from './server'
