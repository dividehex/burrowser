import { isValidRpId } from './persistence.ts';

export type EnrollmentState = { rpId: string; baselineIds: ReadonlySet<string>; expiresAt: number };
export type PollResult =
  | { status: 'idle' }
  | { status: 'awaiting_ceremony'; rpId: string; expiresAt: number }
  | { status: 'expired'; rpId: string }
  | { status: 'completed'; rpId: string; credentialId: string };

const ENROLLMENT_TTL_MS = 5 * 60_000;

/** Administrator-supervised enrollment has no "success" callback from the website - the only
 * signal is a new credential id appearing for the rpId that wasn't there when enrollment began. */
export function beginEnrollment(rpId: string, existingCredentialIds: readonly string[], now: number, ttlMs = ENROLLMENT_TTL_MS): EnrollmentState {
  if (!isValidRpId(rpId)) throw new Error('invalid relying party id');
  return { rpId, baselineIds: new Set(existingCredentialIds), expiresAt: now + ttlMs };
}

export function pollEnrollment(state: EnrollmentState | undefined, currentCredentialIds: readonly string[], now: number): { result: PollResult; next: EnrollmentState | undefined } {
  if (!state) return { result: { status: 'idle' }, next: undefined };
  if (now >= state.expiresAt) return { result: { status: 'expired', rpId: state.rpId }, next: undefined };
  const newId = currentCredentialIds.find(id => !state.baselineIds.has(id));
  if (newId) return { result: { status: 'completed', rpId: state.rpId, credentialId: newId }, next: undefined };
  return { result: { status: 'awaiting_ceremony', rpId: state.rpId, expiresAt: state.expiresAt }, next: state };
}
