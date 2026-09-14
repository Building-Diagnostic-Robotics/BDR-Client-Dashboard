import { describe, expect, it } from "vitest";

import type {
  AdminIdentity,
  AdminProfile,
  AdminSession,
  ClientIdentity,
  ClientSession,
  Invitation,
  Project,
} from "@bdr/contracts";

import { DomainError } from "./errors";

import { sha256 } from "./keys";
import { createInspection } from "./transitions";
import {
  buildAcceptInvitationTransaction,
  buildAdminSessionTransaction,
  buildDisableAdministratorTransaction,
  buildClientSessionTransaction,
  buildCreateInspectionTransaction,
  buildCreateProjectTransaction,
  buildInvitationIntentTransaction,
} from "./transactions";

const organizationId = "org_0123456789abcdef";
const project: Project = {
  organizationId,
  projectId: "project_0123456789abcdef",
  displayName: "Midland Business Park",
  address: "4300 West Loop, Fort Worth, TX",
  timeZone: "America/Chicago",
  lifecycleStatus: "ACTIVE",
  archivedAt: null,
  archivedByAdminId: null,
  archiveReason: null,
};
const audit = {
  eventId: "event_0123456789abcdef",
  organizationId,
  occurredAt: "2026-09-13T14:00:00.000Z",
  action: "PROJECT_CREATED",
  actorId: "admin_0123456789abcdef",
  requestId: "request_0123456789abcdef",
  target: { projectId: project.projectId },
} as const;

describe("transaction plans", () => {
  it("condition-checks the organization and appends audit when creating a project", () => {
    const plan = buildCreateProjectTransaction({ project, audit });
    expect(plan.map(({ kind }) => kind)).toEqual(["CONDITION_CHECK", "PUT", "PUT"]);
    expect(plan[0]).toMatchObject({
      table: "TENANT_DATA",
      key: { PK: `ORG#${organizationId}`, SK: "META" },
    });
    expect(plan[2]).toMatchObject({
      table: "AUDIT",
      conditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    });
  });

  it("condition-checks both organization and project for an inspection", () => {
    const inspection = createInspection({
      organizationId,
      project,
      inspectionId: "inspection_0123456789abcdef",
      scannedAt: "2026-09-04T14:30:00.000Z",
    });
    const plan = buildCreateInspectionTransaction({
      project,
      inspection,
      audit: { ...audit, action: "INSPECTION_CREATED" },
    });
    expect(plan.slice(0, 2).map(({ kind }) => kind)).toEqual([
      "CONDITION_CHECK",
      "CONDITION_CHECK",
    ]);
    expect(plan[1]).toMatchObject({
      key: { PK: `ORG#${organizationId}`, SK: `PROJECT#${project.projectId}` },
    });
  });

  it("reserves normalized email and invitation atomically", () => {
    const invitation: Invitation = {
      invitationId: "invitation_0123456789abcdef",
      organizationId,
      email: "Client@Example.com",
      normalizedEmail: "client@example.com",
      status: "PENDING",
      absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
      ttlExpiresAt: null,
      acceptedAt: null,
    };
    const plan = buildInvitationIntentTransaction({
      invitation,
      userId: "user_0123456789abcdef",
      audit: { ...audit, action: "USER_INVITED" },
    });
    expect(plan).toHaveLength(4);
    expect(plan[1]).toMatchObject({ table: "IDENTITY", kind: "PUT" });
    expect(plan[2]).toMatchObject({ table: "ADMIN_CONTROL", kind: "PUT" });
  });

  it("activates the invitation, identity, and tenant user in one plan", () => {
    const invitation: Invitation = {
      invitationId: "invitation_0123456789abcdef",
      organizationId,
      email: "client@example.com",
      normalizedEmail: "client@example.com",
      status: "PENDING",
      absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
      ttlExpiresAt: null,
      acceptedAt: null,
    };
    const identity: ClientIdentity = {
      issuer: "https://client.example.com/",
      sub: "client-subject",
      userId: "user_0123456789abcdef",
      organizationId,
      status: "INVITED",
    };
    const plan = buildAcceptInvitationTransaction({
      invitation,
      identity,
      acceptedAt: "2026-09-13T14:00:00.000Z",
      audit: { ...audit, action: "INVITATION_ACCEPTED" },
    });
    expect(plan.map(({ kind }) => kind)).toEqual([
      "CONDITION_CHECK",
      "UPDATE",
      "UPDATE",
      "UPDATE",
      "PUT",
    ]);
  });

  it("creates admin session and revocation pointer only for an eligible profile", () => {
    const originJti = "origin-jti";
    const identity: AdminIdentity = {
      issuer: "https://admin.example.com/",
      sub: "admin-subject",
      adminId: "admin_0123456789abcdef",
    };
    const profile: AdminProfile = {
      adminId: identity.adminId,
      status: "ACTIVE",
      role: "BDR_ADMIN",
      totpEnrolled: true,
    };
    const session: AdminSession = {
      originJtiHash: sha256(originJti),
      adminId: identity.adminId,
      absoluteExpiresAt: "2026-09-13T22:00:00.000Z",
      ttlExpiresAt: 1,
      revokedAt: null,
    };
    const plan = buildAdminSessionTransaction({ originJti, identity, profile, session });
    expect(plan.map(({ kind }) => kind)).toEqual([
      "CONDITION_CHECK",
      "CONDITION_CHECK",
      "PUT",
      "PUT",
    ]);
  });

  it("creates a client session and subject revocation pointer atomically", () => {
    const rawSessionId = "client-session-secret";
    const session: ClientSession = {
      sessionIdHash: sha256(rawSessionId),
      issuer: "https://client.example.com/",
      sub: "client-subject",
      accessTokenCiphertext: "encrypted-access",
      refreshTokenCiphertext: "encrypted-refresh",
      accessTokenExpiresAt: "2026-09-13T14:15:00.000Z",
      csrfTokenHash: sha256("csrf-token"),
      absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
      ttlExpiresAt: 1,
      revokedAt: null,
    };
    const plan = buildClientSessionTransaction({ rawSessionId, session });
    expect(plan.map(({ kind }) => kind)).toEqual(["PUT", "PUT"]);
    expect(plan[1]).toMatchObject({
      table: "SESSION",
      item: { sessionIdHash: session.sessionIdHash },
    });
  });

  it("guards administrator disablement with an atomic active-count decrement", () => {
    const target: AdminProfile = {
      adminId: "admin_0123456789abcdef",
      status: "ACTIVE",
      role: "BDR_ADMIN",
      totpEnrolled: true,
    };
    expect(() =>
      buildDisableAdministratorTransaction({ target, expectedActiveAdminCount: 1, audit }),
    ).toThrowError(DomainError);
    const plan = buildDisableAdministratorTransaction({
      target,
      expectedActiveAdminCount: 2,
      audit,
    });
    expect(plan[0]).toMatchObject({
      kind: "UPDATE",
      key: { PK: "ADMIN_GUARD", SK: "ACTIVE_COUNT" },
      conditionExpression: "activeAdminCount = :expected AND activeAdminCount > :one",
    });
  });
});
