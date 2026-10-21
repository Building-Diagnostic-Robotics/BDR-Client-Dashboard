import { expect, it } from "vitest";
import { identityKeys, tenantKeys } from "@bdr/domain";
import { clientAuthenticationFindings } from "./authentication-audit";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/client-pool";
const current = { ...tenantKeys.user("org_current_0123456789", "usr_current_0123456789"), organizationId: "org_current_0123456789", userId: "usr_current_0123456789", currentIssuer: issuer, currentSub: "subject", status: "ACTIVE", normalizedEmail: "client@example.com", revision: "current" };
const old = { ...current, ...tenantKeys.user("org_previous_0123456789", "usr_previous_0123456789"), organizationId: "org_previous_0123456789", userId: "usr_previous_0123456789", status: "REVOKED" };
const identity = { ...identityKeys.subject(issuer, "subject"), issuer, sub: "subject", organizationId: current.organizationId, userId: current.userId, status: "ACTIVE" };
const claim = { ...identityKeys.emailReservation(current.normalizedEmail), organizationId: current.organizationId, userId: current.userId, normalizedEmail: current.normalizedEmail };
const session = { PK: "SESSION#active", issuer, sub: "subject", revokedAt: null, absoluteExpiresAt: "2099-01-01T00:00:00Z" };
it("does not attribute the retained owner's session to a revoked historical membership", () => {
  expect(clientAuthenticationFindings([identity, claim], [old, current], [session])).toEqual([]);
});
it("still reports a revoked current owner with a live identity or session", () => {
  expect(clientAuthenticationFindings([identity, claim], [{ ...current, status: "REVOKED" }], [session])).toContainEqual(expect.objectContaining({ kind: "REVOKED_CLIENT_WITH_ACTIVE_IDENTITY_OR_SESSIONS", userId: current.userId }));
});
it("does not hide active sessions if the supposed replacement owner is missing or inconsistent", () => {
  for (const users of [[old], [old, { ...current, currentSub: "different" }]]) {
    expect(clientAuthenticationFindings([identity, claim], users, [session])).toContainEqual(expect.objectContaining({ kind: "REVOKED_CLIENT_WITH_ACTIVE_IDENTITY_OR_SESSIONS" }));
  }
});
it("reports an active duplicate and a stale global email reservation", () => {
  const findings = clientAuthenticationFindings([identity, { ...claim, organizationId: old.organizationId }], [current, { ...old, status: "ACTIVE" }], [session]);
  expect(findings).toContainEqual(expect.objectContaining({ kind: "CLIENT_MEMBERSHIP_MISMATCH", organizationId: old.organizationId }));
  expect(findings).toContainEqual(expect.objectContaining({ kind: "CLIENT_EMAIL_RESERVATION_MISMATCH", organizationId: current.organizationId }));
});
