/** Fork-owned additions to the db barrel (src/db/index.ts re-exports this module). */
export {
  beginInboundDelivery,
  canPlatformProcessFromLedger,
  getInboundDelivery,
  markInboundDeliveryDropped,
  markInboundDeliveryFailed,
  markInboundDeliveryPersisted,
  markInboundDeliveryProcessed,
  type InboundDeliveryKey,
  type InboundDeliveryRow,
  type InboundDeliveryStatus,
} from './inbound-delivery-ledger.js';
export {
  deleteModuleState,
  getModuleState,
  listModuleState,
  setModuleState,
  type ModuleStateRow,
} from './module-state.js';
export { getActiveSessionsByMessagingGroup, closeActiveSessionsForMessagingGroup } from './fork-sessions.js';
