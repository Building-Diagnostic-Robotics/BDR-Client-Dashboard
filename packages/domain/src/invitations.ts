import type { Invitation } from "@bdr/contracts";

import { conflict, invalidState } from "./errors";

export function normalizeEmail(email: string): string {
  const normalized = email.trim().normalize("NFKC").toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw new TypeError("Email is invalid");
  }
  return normalized;
}

export function assertInvitationCanBeAccepted(invitation: Invitation, now: Date): void {
  if (invitation.status !== "PENDING") {
    invalidState("Only pending invitations can be accepted");
  }
  const expiresAt = Date.parse(invitation.absoluteExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    invalidState("Invitation has expired");
  }
}

export function assertInvitationCanBeResent(invitation: Invitation): void {
  if (
    invitation.status !== "PENDING" &&
    invitation.status !== "EXPIRED" &&
    invitation.status !== "DELIVERY_FAILED"
  ) {
    invalidState("Accepted or cancelled invitations cannot be resent");
  }
}

export function assertEmailReservationMatches(
  reservedNormalizedEmail: string,
  requestedEmail: string,
): void {
  if (reservedNormalizedEmail !== normalizeEmail(requestedEmail)) {
    conflict("Email is already reserved for another identity");
  }
}

export function acceptInvitation(invitation: Invitation, now: Date): Invitation {
  assertInvitationCanBeAccepted(invitation, now);
  return {
    ...invitation,
    status: "ACCEPTED",
    acceptedAt: now.toISOString(),
  };
}

export function expireInvitation(invitation: Invitation, now: Date): Invitation {
  if (invitation.status !== "PENDING") {
    invalidState("Only a pending invitation can expire");
  }
  const expiresAt = Date.parse(invitation.absoluteExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) {
    invalidState("Invitation has not reached its absolute expiry");
  }
  return { ...invitation, status: "EXPIRED" };
}
