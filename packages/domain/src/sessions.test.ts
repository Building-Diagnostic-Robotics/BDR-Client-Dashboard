import { describe, expect, it } from "vitest";

import type {
  AdminIdentity,
  AdminProfile,
  AdminSession,
  ClientSession,
  VerifiedAdminToken,
} from "@bdr/contracts";

import { DomainError } from "./errors";
import { sha256 } from "./keys";
import {
  assertActiveAdminAuthorization,
  assertActiveClientSession,
  assertMayDeactivateAdministrator,
} from "./sessions";

const now = new Date("2026-09-13T14:00:00.000Z");
const rawSessionId = "client-session-secret";

const clientSession: ClientSession = {
  sessionIdHash: sha256(rawSessionId),
  issuer: "https://issuer.example.com/",
  sub: "client-subject",
  accessTokenCiphertext: "encrypted-access",
  refreshTokenCiphertext: "encrypted-refresh",
  accessTokenExpiresAt: "2026-09-13T14:15:00.000Z",
  csrfTokenHash: sha256("csrf-token"),
  absoluteExpiresAt: "2026-09-13T15:00:00.000Z",
  ttlExpiresAt: 1,
  revokedAt: null,
  lastActivityAt: "2026-09-13T14:00:00.000Z",
};

describe("session authorization", () => {
  it("authorizes by absolute expiry and ignores TTL cleanup timing", () => {
    expect(() => assertActiveClientSession(clientSession, rawSessionId, now)).not.toThrow();
    expect(() =>
      assertActiveClientSession(
        { ...clientSession, absoluteExpiresAt: "2026-09-13T13:59:59.000Z", ttlExpiresAt: 9_999_999_999 },
        rawSessionId,
        now,
      ),
    ).toThrowError(DomainError);
  });

  it("enforces a 30-minute inactivity timeout", () => {
    // Active within 30 minutes: authorized (29 minutes later)
    const twentyNineMinutesLater = new Date("2026-09-13T14:29:00.000Z");
    expect(() => assertActiveClientSession(clientSession, rawSessionId, twentyNineMinutesLater)).not.toThrow();

    // Idle for more than 30 minutes: rejected
    const thirtyOneMinutesLater = new Date("2026-09-13T14:31:00.000Z");
    expect(() =>
      assertActiveClientSession(clientSession, rawSessionId, thirtyOneMinutesLater),
    ).toThrowError(DomainError);

    // Invalid activity timestamp: rejected
    expect(() =>
      assertActiveClientSession(
        { ...clientSession, lastActivityAt: "invalid-date" },
        rawSessionId,
        now,
      ),
    ).toThrowError(DomainError);
  });

  it("rejects revoked or mismatched client sessions", () => {
    expect(() =>
      assertActiveClientSession(
        { ...clientSession, revokedAt: "2026-09-13T13:00:00.000Z" },
        rawSessionId,
        now,
      ),
    ).toThrowError(DomainError);
    expect(() => assertActiveClientSession(clientSession, "different-secret", now)).toThrowError(
      DomainError,
    );
  });

  it("requires the admin group, active database role, session, identity, and TOTP", () => {
    const token: VerifiedAdminToken = {
      issuer: "https://admin.example.com/",
      sub: "admin-subject",
      clientId: "admin-client",
      originJti: "origin-jti",
      tokenUse: "access",
      groups: ["bdr-admins"],
      scopes: ["openid", "email"],
      expiresAt: "2026-09-13T14:15:00.000Z",
    };
    const session: AdminSession = {
      originJtiHash: sha256(token.originJti),
      adminId: "admin_0123456789abcdef",
      absoluteExpiresAt: "2026-09-13T22:00:00.000Z",
      ttlExpiresAt: 1,
      revokedAt: null,
    };
    const identity: AdminIdentity = {
      issuer: token.issuer,
      sub: token.sub,
      adminId: session.adminId,
    };
    const profile: AdminProfile = {
      adminId: session.adminId,
      status: "ACTIVE",
      role: "BDR_ADMIN",
      totpEnrolled: true,
    };

    expect(() =>
      assertActiveAdminAuthorization({ token, session, identity, profile, now }),
    ).not.toThrow();
    expect(() =>
      assertActiveAdminAuthorization({
        token,
        session,
        identity,
        profile: { ...profile, totpEnrolled: false },
        now,
      }),
    ).toThrowError(DomainError);
  });

  it("prevents disabling the last active administrator", () => {
    expect(() =>
      assertMayDeactivateAdministrator({
        targetAdminId: "admin_0123456789abcdef",
        targetStatus: "ACTIVE",
        activeAdminCount: 1,
      }),
    ).toThrowError(DomainError);
    expect(() =>
      assertMayDeactivateAdministrator({
        targetAdminId: "admin_0123456789abcdef",
        targetStatus: "ACTIVE",
        activeAdminCount: 2,
      }),
    ).not.toThrow();
  });
});
