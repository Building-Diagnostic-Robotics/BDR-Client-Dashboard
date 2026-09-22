import type {
  AdminIdentity,
  AdminProfile,
  AdminSession,
  ClientSession,
  VerifiedAdminToken,
} from "@bdr/contracts";

import { authenticationRequired, forbidden } from "./errors";
import { sha256 } from "./keys";

function isExpired(absoluteExpiresAt: string, now: Date): boolean {
  const expiresAt = Date.parse(absoluteExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

/** 30 minutes: maximum allowed idle time between authenticated requests. */
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export function assertActiveClientSession(
  session: ClientSession | null,
  rawSessionId: string,
  now: Date,
): asserts session is ClientSession {
  if (
    !session ||
    session.sessionIdHash !== sha256(rawSessionId) ||
    session.revokedAt !== null ||
    isExpired(session.absoluteExpiresAt, now)
  ) {
    authenticationRequired();
  }
  // Inactivity timeout: reject if the session has been idle longer than 30 minutes.
  const lastActivity = Date.parse(session.lastActivityAt);
  if (!Number.isFinite(lastActivity) || now.getTime() - lastActivity > INACTIVITY_TIMEOUT_MS) {
    authenticationRequired();
  }
}

export function assertActiveAdminAuthorization(input: {
  token: VerifiedAdminToken;
  session: AdminSession | null;
  identity: AdminIdentity | null;
  profile: AdminProfile | null;
  now: Date;
}): asserts input is {
  token: VerifiedAdminToken;
  session: AdminSession;
  identity: AdminIdentity;
  profile: AdminProfile;
  now: Date;
} {
  const { token, session, identity, profile, now } = input;
  if (token.tokenUse !== "access" || isExpired(token.expiresAt, now)) {
    authenticationRequired();
  }
  if (!token.groups.includes("bdr-admins")) {
    forbidden();
  }
  if (
    !session ||
    session.originJtiHash !== sha256(token.originJti) ||
    session.revokedAt !== null ||
    isExpired(session.absoluteExpiresAt, now)
  ) {
    authenticationRequired();
  }
  if (
    !identity ||
    identity.issuer !== token.issuer ||
    identity.sub !== token.sub ||
    identity.adminId !== session.adminId
  ) {
    forbidden();
  }
  if (
    !profile ||
    profile.adminId !== identity.adminId ||
    profile.status !== "ACTIVE" ||
    profile.role !== "BDR_ADMIN" ||
    !profile.totpEnrolled
  ) {
    forbidden();
  }
}

export function assertMayDeactivateAdministrator(input: {
  targetAdminId: string;
  targetStatus: AdminProfile["status"];
  activeAdminCount: number;
}): void {
  if (!Number.isSafeInteger(input.activeAdminCount) || input.activeAdminCount < 0) {
    throw new TypeError("Active administrator count must be a non-negative integer");
  }
  if (input.targetStatus === "ACTIVE" && input.activeAdminCount <= 1) {
    forbidden();
  }
}

export function sessionExpiresAt(
  createdAt: Date,
  durationMilliseconds: number,
): string {
  if (!Number.isSafeInteger(durationMilliseconds) || durationMilliseconds <= 0) {
    throw new TypeError("Session duration must be a positive integer");
  }
  return new Date(createdAt.getTime() + durationMilliseconds).toISOString();
}
