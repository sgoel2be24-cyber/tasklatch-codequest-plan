/** Session lifecycle states. Outcomes are only set by the controller, never by an agent. */
export const SessionStatus = {
  DRAFT: 'DRAFT',                       // plan proposed, operator reviewing scope
  READY: 'READY',                       // scope accepted, not yet started
  RUNNING: 'RUNNING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  VERIFYING: 'VERIFYING',
  SUCCEEDED: 'SUCCEEDED',               // all required deliverables verified
  PARTIAL: 'PARTIAL',                   // some deliverables verified, others unresolved
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  NEEDS_VERIFICATION: 'NEEDS_VERIFICATION', // outcome uncertain (e.g. submission timed out)
  STOP_REQUESTED: 'STOP_REQUESTED',
  INTERRUPTED: 'INTERRUPTED',
} as const;
export type SessionStatus = typeof SessionStatus[keyof typeof SessionStatus];

export const ACTIVE_STATES: ReadonlySet<string> = new Set([
  SessionStatus.RUNNING, SessionStatus.AWAITING_APPROVAL, SessionStatus.VERIFYING,
]);
export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  SessionStatus.SUCCEEDED, SessionStatus.PARTIAL, SessionStatus.FAILED, SessionStatus.CANCELLED,
  SessionStatus.BUDGET_EXHAUSTED, SessionStatus.NEEDS_VERIFICATION,
]);

/** Plain-language labels shown to the operator. */
export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Reviewing scope', READY: 'Ready', RUNNING: 'Running',
  AWAITING_APPROVAL: 'Waiting for your approval', VERIFYING: 'Being verified',
  SUCCEEDED: 'Verified', PARTIAL: 'Partly verified', FAILED: 'Failed', CANCELLED: 'Cancelled',
  BUDGET_EXHAUSTED: 'Budget exhausted', NEEDS_VERIFICATION: 'Could not verify',
  STOP_REQUESTED: 'Stop requested', INTERRUPTED: 'Interrupted',
};

export const Decision = { ALLOW: 'ALLOW', REQUIRE_APPROVAL: 'REQUIRE_APPROVAL', DENY: 'DENY' } as const;
export type Decision = typeof Decision[keyof typeof Decision];
export const DECISION_LABEL: Record<string, string> = {
  ALLOW: 'Allowed', REQUIRE_APPROVAL: 'Needs your approval', DENY: 'Blocked',
};

export const ACTION_TYPES = [
  'browser.navigate', 'browser.read', 'browser.click', 'browser.submit_form',
  'finding.record', 'artifact.write_candidate', 'artifact.publish_local', 'artifact.overwrite',
  'file.read', 'upload.send', 'request.prepare', 'request.submit',
] as const;
export type ActionType = typeof ACTION_TYPES[number];

export type ResultKind = 'comparison' | 'draft' | 'submission';
