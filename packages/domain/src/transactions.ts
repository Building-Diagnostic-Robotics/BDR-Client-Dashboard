import type {
  AdminIdentity,
  AdminProfile,
  AdminSession,
  ClientIdentity,
  ClientSession,
  Inspection,
  Invitation,
  Project,
} from "@bdr/contracts";

import { invalidState } from "./errors";
import {
  adminControlKeys,
  auditKeys,
  identityKeys,
  sessionKeys,
  tenantKeys,
  type DynamoKey,
} from "./keys";
import { normalizeEmail } from "./invitations";

export type LogicalTable =
  | "IDENTITY"
  | "TENANT_DATA"
  | "ADMIN_CONTROL"
  | "SESSION"
  | "AUDIT";

export type TransactionCondition = Readonly<{
  kind: "CONDITION_CHECK";
  table: LogicalTable;
  key: DynamoKey;
  conditionExpression: string;
  expressionAttributeNames?: Readonly<Record<string, string>>;
  expressionAttributeValues?: Readonly<Record<string, unknown>>;
}>;

export type TransactionPut = Readonly<{
  kind: "PUT";
  table: LogicalTable;
  item: Readonly<Record<string, unknown>>;
  conditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)";
}>;

export type TransactionUpdate = Readonly<{
  kind: "UPDATE";
  table: LogicalTable;
  key: DynamoKey;
  updateExpression: string;
  conditionExpression: string;
  expressionAttributeNames?: Readonly<Record<string, string>>;
  expressionAttributeValues?: Readonly<Record<string, unknown>>;
}>;

export type TransactionAction = TransactionCondition | TransactionPut | TransactionUpdate;
export type TransactionPlan = readonly TransactionAction[];

export type AuditEventInput = Readonly<{
  eventId: string;
  organizationId?: string;
  occurredAt: string;
  action: string;
  actorId: string;
  requestId: string;
  target: Readonly<Record<string, string>>;
  details?: Readonly<Record<string, unknown>>;
}>;

function activeParent(table: LogicalTable, key: DynamoKey, statusAttribute: string): TransactionCondition {
  return {
    kind: "CONDITION_CHECK",
    table,
    key,
    conditionExpression: "attribute_exists(PK) AND #status = :active",
    expressionAttributeNames: { "#status": statusAttribute },
    expressionAttributeValues: { ":active": "ACTIVE" },
  };
}

function absentPut(
  table: LogicalTable,
  key: DynamoKey,
  item: Readonly<Record<string, unknown>>,
): TransactionPut {
  return {
    kind: "PUT",
    table,
    item: { ...key, ...item },
    conditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
  };
}

export function auditPut(event: AuditEventInput): TransactionPut {
  const key = event.organizationId
    ? auditKeys.organization(event.organizationId, event.occurredAt, event.eventId)
    : auditKeys.system(event.occurredAt, event.eventId);
  return absentPut("AUDIT", key, event);
}

export function buildCreateProjectTransaction(input: {
  project: Project;
  audit: AuditEventInput & { organizationId: string };
}): TransactionPlan {
  if (
    input.audit.organizationId !== input.project.organizationId ||
    input.project.lifecycleStatus !== "ACTIVE"
  ) {
    invalidState("Project and audit organization must match");
  }
  return [
    activeParent(
      "TENANT_DATA",
      tenantKeys.organization(input.project.organizationId),
      "status",
    ),
    absentPut(
      "TENANT_DATA",
      tenantKeys.project(input.project.organizationId, input.project.projectId),
      input.project,
    ),
    auditPut(input.audit),
  ];
}

export function buildCreateInspectionTransaction(input: {
  project: Project;
  inspection: Inspection;
  audit: AuditEventInput & { organizationId: string };
}): TransactionPlan {
  const { project, inspection, audit } = input;
  if (
    inspection.organizationId !== project.organizationId ||
    inspection.projectId !== project.projectId ||
    inspection.scanTimeZone !== project.timeZone ||
    audit.organizationId !== project.organizationId ||
    project.lifecycleStatus !== "ACTIVE" ||
    inspection.lifecycleStatus !== "ACTIVE" ||
    inspection.publicationStatus !== "DRAFT"
  ) {
    invalidState("Inspection parentage and timezone snapshot must match its project");
  }
  return [
    activeParent("TENANT_DATA", tenantKeys.organization(project.organizationId), "status"),
    activeParent(
      "TENANT_DATA",
      tenantKeys.project(project.organizationId, project.projectId),
      "lifecycleStatus",
    ),
    absentPut(
      "TENANT_DATA",
      tenantKeys.inspection(project.organizationId, project.projectId, inspection.inspectionId),
      inspection,
    ),
    auditPut(audit),
  ];
}

export function buildClientSessionTransaction(input: {
  rawSessionId: string;
  session: ClientSession;
}): TransactionPlan {
  const expectedKey = sessionKeys.clientSession(input.rawSessionId);
  if (input.session.sessionIdHash !== expectedKey.PK.slice("SESSION#".length)) {
    invalidState("Session hash does not match the issued session identifier");
  }
  return [
    absentPut("SESSION", expectedKey, input.session),
    absentPut(
      "SESSION",
      sessionKeys.clientSubjectPointer(
        input.session.issuer,
        input.session.sub,
        input.rawSessionId,
      ),
      {
        sessionIdHash: input.session.sessionIdHash,
        absoluteExpiresAt: input.session.absoluteExpiresAt,
        ttlExpiresAt: input.session.ttlExpiresAt,
        revokedAt: input.session.revokedAt,
      },
    ),
  ];
}

export function buildInvitationIntentTransaction(input: {
  invitation: Invitation;
  userId: string;
  audit: AuditEventInput & { organizationId: string };
}): TransactionPlan {
  const normalizedEmail = normalizeEmail(input.invitation.email);
  if (
    normalizedEmail !== input.invitation.normalizedEmail ||
    input.invitation.status !== "PENDING" ||
    input.invitation.organizationId !== input.audit.organizationId
  ) {
    invalidState("Invitation intent is inconsistent");
  }
  return [
    activeParent(
      "TENANT_DATA",
      tenantKeys.organization(input.invitation.organizationId),
      "status",
    ),
    absentPut("IDENTITY", identityKeys.emailReservation(normalizedEmail), {
      normalizedEmail,
      invitationId: input.invitation.invitationId,
      organizationId: input.invitation.organizationId,
      userId: input.userId,
    }),
    absentPut(
      "ADMIN_CONTROL",
      adminControlKeys.invitation(
        input.invitation.organizationId,
        input.invitation.invitationId,
      ),
      input.invitation,
    ),
    auditPut(input.audit),
  ];
}

export function buildInvitedClientIdentityTransaction(input: {
  identity: ClientIdentity;
  invitation: Invitation;
  audit: AuditEventInput & { organizationId: string };
}): TransactionPlan {
  if (
    input.identity.organizationId !== input.invitation.organizationId ||
    input.identity.organizationId !== input.audit.organizationId ||
    input.identity.status !== "INVITED"
  ) {
    invalidState("Client identity does not match its invitation");
  }
  return [
    activeParent(
      "TENANT_DATA",
      tenantKeys.organization(input.identity.organizationId),
      "status",
    ),
    {
      kind: "CONDITION_CHECK",
      table: "ADMIN_CONTROL",
      key: adminControlKeys.invitation(
        input.invitation.organizationId,
        input.invitation.invitationId,
      ),
      conditionExpression: "#status = :pending AND absoluteExpiresAt = :absoluteExpiresAt",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":pending": "PENDING",
        ":absoluteExpiresAt": input.invitation.absoluteExpiresAt,
      },
    },
    absentPut(
      "IDENTITY",
      identityKeys.subject(input.identity.issuer, input.identity.sub),
      input.identity,
    ),
    absentPut(
      "TENANT_DATA",
      tenantKeys.user(input.identity.organizationId, input.identity.userId),
      {
        userId: input.identity.userId,
        organizationId: input.identity.organizationId,
        status: "INVITED",
      },
    ),
    auditPut(input.audit),
  ];
}

export function buildAcceptInvitationTransaction(input: {
  identity: ClientIdentity;
  invitation: Invitation;
  acceptedAt: string;
  audit: AuditEventInput & { organizationId: string };
}): TransactionPlan {
  if (
    input.identity.organizationId !== input.invitation.organizationId ||
    input.identity.organizationId !== input.audit.organizationId ||
    input.identity.status !== "INVITED"
  ) {
    invalidState("Client identity does not match its invitation");
  }
  return [
    activeParent(
      "TENANT_DATA",
      tenantKeys.organization(input.identity.organizationId),
      "status",
    ),
    {
      kind: "UPDATE",
      table: "ADMIN_CONTROL",
      key: adminControlKeys.invitation(
        input.invitation.organizationId,
        input.invitation.invitationId,
      ),
      updateExpression: "SET #status = :accepted, acceptedAt = :acceptedAt",
      conditionExpression:
        "#status = :pending AND absoluteExpiresAt = :absoluteExpiresAt AND absoluteExpiresAt > :acceptedAt",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":pending": "PENDING",
        ":accepted": "ACCEPTED",
        ":acceptedAt": input.acceptedAt,
        ":absoluteExpiresAt": input.invitation.absoluteExpiresAt,
      },
    },
    {
      kind: "UPDATE",
      table: "IDENTITY",
      key: identityKeys.subject(input.identity.issuer, input.identity.sub),
      updateExpression: "SET #status = :active",
      conditionExpression:
        "#status = :invited AND organizationId = :organizationId AND userId = :userId",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":invited": "INVITED",
        ":active": "ACTIVE",
        ":organizationId": input.identity.organizationId,
        ":userId": input.identity.userId,
      },
    },
    {
      kind: "UPDATE",
      table: "TENANT_DATA",
      key: tenantKeys.user(input.identity.organizationId, input.identity.userId),
      updateExpression: "SET #status = :active",
      conditionExpression: "#status = :invited AND organizationId = :organizationId",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":invited": "INVITED",
        ":active": "ACTIVE",
        ":organizationId": input.identity.organizationId,
      },
    },
    auditPut(input.audit),
  ];
}

export function buildAdminSessionTransaction(input: {
  originJti: string;
  identity: AdminIdentity;
  profile: AdminProfile;
  session: AdminSession;
}): TransactionPlan {
  const expectedKey = sessionKeys.adminSession(input.originJti);
  if (
    input.identity.adminId !== input.profile.adminId ||
    input.identity.adminId !== input.session.adminId ||
    input.session.originJtiHash !== expectedKey.PK.slice("ADMIN_SESSION#".length) ||
    input.profile.status !== "ACTIVE" ||
    input.profile.role !== "BDR_ADMIN" ||
    !input.profile.totpEnrolled
  ) {
    invalidState("Administrator is not eligible for a privileged session");
  }
  return [
    {
      kind: "CONDITION_CHECK",
      table: "IDENTITY",
      key: identityKeys.subject(input.identity.issuer, input.identity.sub),
      conditionExpression: "adminId = :adminId",
      expressionAttributeValues: { ":adminId": input.identity.adminId },
    },
    {
      kind: "CONDITION_CHECK",
      table: "IDENTITY",
      key: identityKeys.adminProfile(input.profile.adminId),
      conditionExpression:
        "#status = :active AND #role = :role AND totpEnrolled = :totpEnrolled",
      expressionAttributeNames: { "#status": "status", "#role": "role" },
      expressionAttributeValues: {
        ":active": "ACTIVE",
        ":role": "BDR_ADMIN",
        ":totpEnrolled": true,
      },
    },
    absentPut("SESSION", expectedKey, input.session),
    absentPut(
      "SESSION",
      sessionKeys.adminPointer(input.profile.adminId, input.originJti),
      {
        originJtiHash: input.session.originJtiHash,
        adminId: input.profile.adminId,
        absoluteExpiresAt: input.session.absoluteExpiresAt,
        ttlExpiresAt: input.session.ttlExpiresAt,
        revokedAt: input.session.revokedAt,
      },
    ),
  ];
}

export function buildDisableAdministratorTransaction(input: {
  target: AdminProfile;
  expectedActiveAdminCount: number;
  audit: AuditEventInput;
}): TransactionPlan {
  if (input.target.status !== "ACTIVE" || input.expectedActiveAdminCount <= 1) {
    invalidState("The last active administrator cannot be disabled");
  }
  return [
    {
      kind: "UPDATE",
      table: "IDENTITY",
      key: identityKeys.adminGuard(),
      updateExpression: "SET activeAdminCount = activeAdminCount - :one",
      conditionExpression: "activeAdminCount = :expected AND activeAdminCount > :one",
      expressionAttributeValues: {
        ":expected": input.expectedActiveAdminCount,
        ":one": 1,
      },
    },
    {
      kind: "UPDATE",
      table: "IDENTITY",
      key: identityKeys.adminProfile(input.target.adminId),
      updateExpression: "SET #status = :disabled",
      conditionExpression: "#status = :active AND #role = :role",
      expressionAttributeNames: { "#status": "status", "#role": "role" },
      expressionAttributeValues: {
        ":active": "ACTIVE",
        ":disabled": "DISABLED",
        ":role": "BDR_ADMIN",
      },
    },
    auditPut(input.audit),
  ];
}
