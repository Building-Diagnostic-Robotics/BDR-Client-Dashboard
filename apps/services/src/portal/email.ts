/**
 * SES in us-east-1 has no verified sending domain.
 * bdrsnap.com and info@bdrsnap.com are FAILED and sending is disabled.
 * buildingdiagnosticrobotics.com is not an identity.
 * Notices stay on status.pendingAdminEmail until a domain is verified.
 */
export const SES_SEND_BLOCKER =
  "SES identity bdrsnap.com is not verified (FAILED, sending disabled). No portal mail is sent.";

export function emailBlocked(): string {
  return SES_SEND_BLOCKER;
}
