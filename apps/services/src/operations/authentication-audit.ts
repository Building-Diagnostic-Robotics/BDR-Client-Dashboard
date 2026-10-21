import { clientIdentitySchema } from "@bdr/contracts";
import { identityKeys, tenantKeys } from "@bdr/domain";

type Row = Record<string, unknown>;
/** A revoked historical row is not the owner of a subject's current session. */
export function clientAuthenticationFindings(identities: Row[], memberships: Row[], sessions: Row[], now = Date.now()): Row[] {
  const findings: Row[] = [];
  const users = memberships.filter((row) => String(row.SK).startsWith("USER#"));
  for (const user of users) {
    const target = { organizationId: user.organizationId, userId: user.userId, sub: user.currentSub };
    if (typeof user.currentIssuer !== "string" || typeof user.currentSub !== "string" || !user.currentSub) {
      findings.push({ kind: "CLIENT_MEMBERSHIP_MISMATCH", ...target }); continue;
    }
    let key: { PK: string; SK: string };
    try { key = identityKeys.subject(user.currentIssuer, user.currentSub); }
    catch { findings.push({ kind: "CLIENT_MEMBERSHIP_MISMATCH", ...target }); continue; }
    const identity = identities.find((row) => row.PK === key.PK && row.SK === key.SK && row.issuer === user.currentIssuer && row.sub === user.currentSub);
    const parsed = clientIdentitySchema.safeParse(identity);
    const sameOwner = identity?.organizationId === user.organizationId && identity?.userId === user.userId;
    const currentOwner = parsed.success && users.find((row) => row.organizationId === parsed.data.organizationId && row.userId === parsed.data.userId
      && row.PK === tenantKeys.user(parsed.data.organizationId, parsed.data.userId).PK && row.SK === tenantKeys.user(parsed.data.organizationId, parsed.data.userId).SK
      && row.currentIssuer === identity?.issuer && row.currentSub === identity?.sub && row.status === identity?.status
      && ["ACTIVE", "INVITED"].includes(String(row.status)));
    const activeSessions = sessions.filter((row) => String(row.PK).startsWith("SESSION#") && row.issuer === user.currentIssuer && row.sub === user.currentSub
      && row.revokedAt === null && Date.parse(String(row.absoluteExpiresAt)) > now);
    if (user.status === "REVOKED" && !(currentOwner && !sameOwner)
      && ((identity && identity.status !== "REVOKED") || activeSessions.length)) findings.push({ kind: "REVOKED_CLIENT_WITH_ACTIVE_IDENTITY_OR_SESSIONS", ...target, identityStatus: identity?.status ?? null, activeSessions: activeSessions.length });
    if (user.status !== "REVOKED" && (!sameOwner || identity?.status !== user.status)) findings.push({ kind: "CLIENT_MEMBERSHIP_MISMATCH", ...target });
    if (typeof user.revision !== "string") findings.push({ kind: "CLIENT_REVISION_MISSING", ...target });
    if (sameOwner && currentOwner && typeof user.normalizedEmail === "string") {
      const reservationKey = identityKeys.emailReservation(user.normalizedEmail);
      const reservation = identities.find((row) => row.PK === reservationKey.PK && row.SK === reservationKey.SK);
      if (!reservation || reservation.organizationId !== user.organizationId || reservation.userId !== user.userId || reservation.normalizedEmail !== user.normalizedEmail) findings.push({ kind: "CLIENT_EMAIL_RESERVATION_MISMATCH", ...target });
    }
  }
  return findings;
}
