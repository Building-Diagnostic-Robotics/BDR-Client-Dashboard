import { createHash, randomUUID } from "node:crypto";

import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  adminInvitationSchema,
  clientUserSchema,
  inspectionSchema,
  organizationDocumentSchema,
  organizationSchema,
  projectSchema,
  reportSchema,
  type AdminInvitation,
  type ClientIdentity,
  type ClientUser,
  type Inspection,
  type Organization,
  type OrganizationDocument,
  type Project,
  type Report,
  type ReportDeliveryStatus,
  type ReportType,
} from "@bdr/contracts";
import {
  adminControlKeys,
  auditKeys,
  conflict,
  identityKeys,
  invalidState,
  normalizeEmail,
  notFound,
  tenantKeys,
} from "@bdr/domain";
import { z } from "zod";

import type { ActiveAdmin } from "../auth/admin";

const REPORT_TYPES: readonly ReportType[] = [
  "ASSESSMENT",
  "EVIDENCE",
  "ROOF_TAKEOFF",
  "CAPITAL_PLANNING",
];
const INVITATION_MS = 7 * 24 * 60 * 60 * 1000;

type Versioned<T> = T & { revision: string };
type Page<T> = Readonly<{ items: T[]; nextToken?: string }>;
type ListInput = Readonly<{ limit: number; nextToken?: string | undefined }>;
type ActionContext = Readonly<{ active: ActiveAdmin; requestId: string }>;
type Tables = Readonly<{
  identity: string;
  tenantData: string;
  adminControl: string;
  session: string;
  audit: string;
}>;

export interface PortalAdminOperations {
  listOrganizations(input: ListInput): Promise<Page<Versioned<Organization>>>;
  createOrganization(input: { displayName: string; idempotencyKey: string }, context: ActionContext): Promise<Versioned<Organization>>;
  getOrganization(organizationId: string): Promise<Versioned<Organization>>;
  updateOrganization(organizationId: string, input: { displayName: string; expectedRevision: string }, context: ActionContext): Promise<Versioned<Organization>>;
  listUsers(organizationId: string, input: ListInput): Promise<Page<Versioned<ClientUser>>>;
  listInvitations(organizationId: string, input: ListInput): Promise<Page<AdminInvitation>>;
  createInvitation(organizationId: string, input: { email: string; idempotencyKey: string }, context: ActionContext): Promise<AdminInvitation>;
  resendInvitation(organizationId: string, invitationId: string, context: ActionContext): Promise<AdminInvitation>;
  cancelInvitation(organizationId: string, invitationId: string, input: { expectedRevision: string }, context: ActionContext): Promise<AdminInvitation>;
  revokeUser(organizationId: string, userId: string, input: { expectedRevision: string }, context: ActionContext): Promise<Versioned<ClientUser>>;
  replaceIdentity(organizationId: string, userId: string, input: { email: string; expectedRevision: string; confirmedUserId: string; idempotencyKey: string }, context: ActionContext): Promise<AdminInvitation>;
  listProjects(organizationId: string, input: ListInput): Promise<Page<Versioned<Project>>>;
  createProject(organizationId: string, input: { displayName: string; address: string; timeZone: string; idempotencyKey: string }, context: ActionContext): Promise<Versioned<Project>>;
  getProject(organizationId: string, projectId: string): Promise<Versioned<Project>>;
  updateProject(organizationId: string, projectId: string, input: { displayName: string; address: string; timeZone: string; expectedRevision: string }, context: ActionContext): Promise<Versioned<Project>>;
  previewProject(organizationId: string, projectId: string): Promise<Record<string, unknown>>;
  archiveProject(organizationId: string, projectId: string, input: { expectedRevision: string; reason: string }, context: ActionContext): Promise<Versioned<Project>>;
  restoreProject(organizationId: string, projectId: string, input: { expectedRevision: string }, context: ActionContext): Promise<Versioned<Project>>;
  listInspections(organizationId: string, projectId: string, input: ListInput): Promise<Page<Versioned<Inspection>>>;
  createInspection(organizationId: string, projectId: string, input: { scannedAt: string; idempotencyKey: string }, context: ActionContext): Promise<Versioned<Inspection>>;
  getInspection(organizationId: string, projectId: string, inspectionId: string): Promise<Versioned<Inspection>>;
  updateInspection(organizationId: string, projectId: string, inspectionId: string, input: { scannedAt: string; expectedRevision: string }, context: ActionContext): Promise<Versioned<Inspection>>;
  previewInspection(organizationId: string, projectId: string, inspectionId: string): Promise<Record<string, unknown>>;
  archiveInspection(organizationId: string, projectId: string, inspectionId: string, input: { expectedRevision: string; reason: string }, context: ActionContext): Promise<Versioned<Inspection>>;
  restoreInspection(organizationId: string, projectId: string, inspectionId: string, input: { expectedRevision: string }, context: ActionContext): Promise<Versioned<Inspection>>;
  listReports(organizationId: string, projectId: string, inspectionId: string): Promise<Versioned<Report>[]>;
  updateReportStatus(organizationId: string, projectId: string, inspectionId: string, reportType: ReportType, input: { expectedRevision: string; deliveryStatus: Exclude<ReportDeliveryStatus, "PUBLISHED"> }, context: ActionContext): Promise<Versioned<Report>>;
  withdrawReport(organizationId: string, projectId: string, inspectionId: string, reportType: ReportType, input: { expectedRevision: string; deliveryStatus: Exclude<ReportDeliveryStatus, "PUBLISHED">; reason: string }, context: ActionContext): Promise<Versioned<Report>>;
  getHowToRead(organizationId: string): Promise<Versioned<OrganizationDocument>>;
  initializeHowToRead(organizationId: string, input: { idempotencyKey: string }, context: ActionContext): Promise<Versioned<OrganizationDocument>>;
}

export type AdminOperationsConfig = Readonly<{
  tables: Tables;
  clientUserPoolId: string;
  clientIssuer: string;
}>;

const versionedOrganizationSchema = organizationSchema.extend({ revision: z.string() });
const versionedUserSchema = clientUserSchema.extend({ revision: z.string() });
const versionedProjectSchema = projectSchema.extend({ revision: z.string() });
const versionedInspectionSchema = inspectionSchema.extend({ revision: z.string() });
const versionedReportSchema = reportSchema.extend({ revision: z.string() });
const versionedDocumentSchema = organizationDocumentSchema.extend({ revision: z.string() });

function revision(): string {
  return `rev_${randomUUID()}`;
}

function deterministicId(prefix: string, scope: string, key: string): string {
  return `${prefix}_${createHash("sha256").update(`${prefix}\0${scope}\0${key}`).digest("hex").slice(0, 32)}`;
}

function auditItem(context: ActionContext, organizationId: string | undefined, action: string, target: Record<string, string>, details?: Record<string, unknown>) {
  const occurredAt = new Date().toISOString();
  const eventId = `event_${randomUUID()}`;
  const key = organizationId
    ? auditKeys.organization(organizationId, occurredAt, eventId)
    : auditKeys.system(occurredAt, eventId);
  return {
    Put: {
      TableName: "",
      Item: {
        ...key,
        eventId,
        organizationId,
        occurredAt,
        action,
        actorId: context.active.profile.adminId,
        actorSub: context.active.identity.sub,
        requestId: context.requestId,
        target,
        details,
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    },
  };
}

export class AwsPortalAdminOperations implements PortalAdminOperations {
  private readonly dynamo: DynamoDBDocumentClient;
  private readonly cognito: CognitoIdentityProviderClient;

  constructor(
    private readonly config: AdminOperationsConfig,
    clients: { dynamo?: DynamoDBDocumentClient; cognito?: CognitoIdentityProviderClient } = {},
  ) {
    this.dynamo = clients.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    this.cognito = clients.cognito ?? new CognitoIdentityProviderClient({});
  }

  async listOrganizations(input: ListInput) {
    const page = await this.query(this.config.tables.adminControl, "DIRECTORY#ORGANIZATIONS", "ORG#", input);
    return { ...page, items: page.items.map((item) => versionedOrganizationSchema.parse(item)) };
  }

  async createOrganization(input: { displayName: string; idempotencyKey: string }, context: ActionContext) {
    const organizationId = deterministicId("org", "organizations", input.idempotencyKey);
    const key = tenantKeys.organization(organizationId);
    const existing = await this.get(this.config.tables.tenantData, key);
    if (existing) {
      const parsed = versionedOrganizationSchema.parse(existing);
      if (parsed.displayName !== input.displayName) conflict("Idempotency key was already used with different input");
      return parsed;
    }
    const organization: Versioned<Organization> = { organizationId, displayName: input.displayName, status: "ACTIVE", revision: revision() };
    const directory = { ...adminControlKeys.organizationDirectory(organizationId), ...organization };
    await this.transact([
      this.put(this.config.tables.tenantData, { ...key, ...organization }),
      this.put(this.config.tables.adminControl, directory),
      this.audit(context, undefined, "ORGANIZATION_CREATED", { organizationId }),
    ]);
    return organization;
  }

  async getOrganization(organizationId: string) {
    return this.require(this.config.tables.tenantData, tenantKeys.organization(organizationId), versionedOrganizationSchema);
  }

  async updateOrganization(organizationId: string, input: { displayName: string; expectedRevision: string }, context: ActionContext) {
    const current = await this.getOrganization(organizationId);
    const next = { ...current, displayName: input.displayName, revision: revision() };
    await this.transact([
      this.update(this.config.tables.tenantData, tenantKeys.organization(organizationId), "SET displayName = :name, revision = :next", "revision = :expected", { ":name": next.displayName, ":next": next.revision, ":expected": input.expectedRevision }),
      this.update(this.config.tables.adminControl, adminControlKeys.organizationDirectory(organizationId), "SET displayName = :name, revision = :next", "revision = :expected", { ":name": next.displayName, ":next": next.revision, ":expected": input.expectedRevision }),
      this.audit(context, organizationId, "ORGANIZATION_UPDATED", { organizationId }),
    ]);
    return next;
  }

  async listUsers(organizationId: string, input: ListInput) {
    await this.getOrganization(organizationId);
    const page = await this.query(this.config.tables.tenantData, `ORG#${organizationId}`, "USER#", input);
    return { ...page, items: page.items.map((item) => versionedUserSchema.parse(item)) };
  }

  async listInvitations(organizationId: string, input: ListInput) {
    await this.getOrganization(organizationId);
    const page = await this.query(this.config.tables.adminControl, `ORG#${organizationId}`, "INVITATION#", input);
    return { ...page, items: page.items.map((item) => adminInvitationSchema.parse(item)) };
  }

  async createInvitation(organizationId: string, input: { email: string; idempotencyKey: string }, context: ActionContext) {
    const organization = await this.getOrganization(organizationId);
    if (organization.status !== "ACTIVE") invalidState("Invitations require an active organization");
    const invitationId = deterministicId("invite", organizationId, input.idempotencyKey);
    const existing = await this.get(this.config.tables.adminControl, adminControlKeys.invitation(organizationId, invitationId));
    if (existing) {
      const parsed = adminInvitationSchema.parse(existing);
      if (parsed.normalizedEmail !== normalizeEmail(input.email)) conflict("Idempotency key was already used with different input");
      if (!parsed.sub && ["PENDING", "DELIVERY_FAILED"].includes(parsed.status)) {
        return this.resendInvitation(organizationId, parsed.invitationId, context);
      }
      return parsed;
    }
    const userId = deterministicId("user", organizationId, invitationId);
    return this.issueInvitation({ organizationId, userId, email: input.email, invitationId, expectedUserRevision: null }, context);
  }

  async resendInvitation(organizationId: string, invitationId: string, context: ActionContext) {
    const invitation = await this.require(this.config.tables.adminControl, adminControlKeys.invitation(organizationId, invitationId), adminInvitationSchema);
    if (!["PENDING", "EXPIRED", "DELIVERY_FAILED"].includes(invitation.status)) invalidState("Accepted or cancelled invitations cannot be resent");
    let sub = invitation.sub;
    let cognitoUsername = invitation.sub ?? invitation.normalizedEmail;
    try {
      if (!sub) {
        try {
          const existingUser = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.config.clientUserPoolId, Username: cognitoUsername }));
          sub = existingUser.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value ?? null;
          cognitoUsername = existingUser.Username ?? cognitoUsername;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "UserNotFoundException") throw error;
        }
      }
      const result = await this.cognito.send(new AdminCreateUserCommand({
        UserPoolId: this.config.clientUserPoolId,
        Username: cognitoUsername,
        UserAttributes: [{ Name: "email", Value: invitation.normalizedEmail }, { Name: "email_verified", Value: "true" }],
        ...(sub ? { MessageAction: "RESEND" as const } : {}),
      }));
      sub ??= result.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value ?? null;
      cognitoUsername = result.User?.Username ?? cognitoUsername;
      if (!sub) throw new Error("Cognito did not return a subject");
    } catch (error) {
      await this.markInvitationDeliveryFailed(invitation, context);
      throw error;
    }
    const next = { ...invitation, sub, cognitoUsername, status: "PENDING" as const, absoluteExpiresAt: new Date(Date.now() + INVITATION_MS).toISOString(), ttlExpiresAt: null, acceptedAt: null, revision: revision() };
    const actions: object[] = [];
    if (!invitation.sub) {
      const identity: ClientIdentity = { issuer: invitation.issuer, sub, organizationId, userId: invitation.userId, status: "INVITED", invitationId };
      const user: Versioned<ClientUser> = { organizationId, userId: invitation.userId, email: invitation.email, normalizedEmail: invitation.normalizedEmail, status: "INVITED", currentIssuer: invitation.issuer, currentSub: sub, cognitoUsername, revision: revision() };
      actions.push(this.put(this.config.tables.identity, { ...identityKeys.subject(identity.issuer, sub), ...identity }));
      actions.push(this.put(this.config.tables.tenantData, { ...tenantKeys.user(organizationId, invitation.userId), ...user }));
    }
    actions.push(
      this.update(this.config.tables.adminControl, adminControlKeys.invitation(organizationId, invitationId), "SET #status = :pending, absoluteExpiresAt = :expires, ttlExpiresAt = :ttl, acceptedAt = :accepted, #sub = :sub, cognitoUsername = :username, revision = :next", "revision = :expected", { ":pending": "PENDING", ":expires": next.absoluteExpiresAt, ":ttl": null, ":accepted": null, ":sub": sub, ":username": cognitoUsername, ":next": next.revision, ":expected": invitation.revision }, { "#status": "status", "#sub": "sub" }),
      this.audit(context, organizationId, "INVITATION_RESENT", { invitationId, userId: invitation.userId }),
    );
    await this.transact(actions);
    return next;
  }

  async cancelInvitation(organizationId: string, invitationId: string, input: { expectedRevision: string }, context: ActionContext) {
    const invitation = await this.require(this.config.tables.adminControl, adminControlKeys.invitation(organizationId, invitationId), adminInvitationSchema);
    if (!["PENDING", "EXPIRED", "DELIVERY_FAILED"].includes(invitation.status)) invalidState("Only an unaccepted invitation can be cancelled");
    const next = { ...invitation, status: "CANCELLED" as const, ttlExpiresAt: Math.ceil(Date.now() / 1000) + 30 * 24 * 60 * 60, revision: revision() };
    const actions: object[] = [
      this.update(this.config.tables.adminControl, adminControlKeys.invitation(organizationId, invitationId), "SET #status = :cancelled, ttlExpiresAt = :ttl, revision = :next", "revision = :expected", { ":cancelled": "CANCELLED", ":ttl": next.ttlExpiresAt, ":next": next.revision, ":expected": input.expectedRevision }, { "#status": "status" }),
      this.audit(context, organizationId, "INVITATION_CANCELLED", { invitationId, userId: invitation.userId }),
    ];
    if (invitation.sub) {
      actions.unshift(this.update(this.config.tables.identity, identityKeys.subject(invitation.issuer, invitation.sub), "SET #status = :revoked", "organizationId = :organizationId AND userId = :userId", { ":revoked": "REVOKED", ":organizationId": organizationId, ":userId": invitation.userId }, { "#status": "status" }));
      actions.unshift(this.update(this.config.tables.tenantData, tenantKeys.user(organizationId, invitation.userId), "SET #status = :revoked, revision = :next", "organizationId = :organizationId", { ":revoked": "REVOKED", ":next": revision(), ":organizationId": organizationId }, { "#status": "status" }));
    }
    await this.transact(actions);
    if (invitation.sub) await this.disableCognito(invitation.sub);
    return next;
  }

  async revokeUser(organizationId: string, userId: string, input: { expectedRevision: string }, context: ActionContext) {
    const user = await this.require(this.config.tables.tenantData, tenantKeys.user(organizationId, userId), versionedUserSchema);
    if (user.status === "REVOKED") {
      await this.revokeSubjectSessions(user.currentIssuer, user.currentSub);
      await this.disableCognito(user.currentSub);
      return user;
    }
    if (user.status !== "ACTIVE") invalidState("Cancel a pending invitation instead of revoking an invited user");
    const next = { ...user, status: "REVOKED" as const, revision: revision() };
    await this.transact([
      this.update(this.config.tables.tenantData, tenantKeys.user(organizationId, userId), "SET #status = :revoked, revision = :next", "revision = :expected", { ":revoked": "REVOKED", ":next": next.revision, ":expected": input.expectedRevision }, { "#status": "status" }),
      this.update(this.config.tables.identity, identityKeys.subject(user.currentIssuer, user.currentSub), "SET #status = :revoked", "organizationId = :organizationId AND userId = :userId", { ":revoked": "REVOKED", ":organizationId": organizationId, ":userId": userId }, { "#status": "status" }),
      this.audit(context, organizationId, "USER_REVOKED", { userId }),
    ]);
    await this.revokeSubjectSessions(user.currentIssuer, user.currentSub);
    await this.disableCognito(user.currentSub);
    return next;
  }

  async replaceIdentity(organizationId: string, userId: string, input: { email: string; expectedRevision: string; confirmedUserId: string; idempotencyKey: string }, context: ActionContext) {
    if (input.confirmedUserId !== userId) invalidState("Confirmed user does not match the requested user");
    const user = await this.require(this.config.tables.tenantData, tenantKeys.user(organizationId, userId), versionedUserSchema);
    if (user.status !== "REVOKED" || user.revision !== input.expectedRevision) invalidState("Identity replacement requires the current revoked user revision");
    const invitationId = deterministicId("invite", `${organizationId}:${userId}:replacement`, input.idempotencyKey);
    const existing = await this.get(this.config.tables.adminControl, adminControlKeys.invitation(organizationId, invitationId));
    if (existing) return adminInvitationSchema.parse(existing);
    return this.issueInvitation({ organizationId, userId, email: input.email, invitationId, expectedUserRevision: user.revision }, context);
  }

  async listProjects(organizationId: string, input: ListInput) {
    await this.getOrganization(organizationId);
    const page = await this.query(this.config.tables.tenantData, `ORG#${organizationId}`, "PROJECT#", input);
    return { ...page, items: page.items.map((item) => versionedProjectSchema.parse(item)) };
  }

  async createProject(organizationId: string, input: { displayName: string; address: string; timeZone: string; idempotencyKey: string }, context: ActionContext) {
    const projectId = deterministicId("project", organizationId, input.idempotencyKey);
    const key = tenantKeys.project(organizationId, projectId);
    const existing = await this.get(this.config.tables.tenantData, key);
    if (existing) {
      const parsed = versionedProjectSchema.parse(existing);
      if (parsed.displayName !== input.displayName || parsed.address !== input.address || parsed.timeZone !== input.timeZone) conflict("Idempotency key was already used with different input");
      return parsed;
    }
    const project: Versioned<Project> = { organizationId, projectId, displayName: input.displayName, address: input.address, timeZone: input.timeZone, lifecycleStatus: "ACTIVE", archivedAt: null, archivedByAdminId: null, archiveReason: null, revision: revision() };
    await this.transact([
      this.condition(this.config.tables.tenantData, tenantKeys.organization(organizationId), "#status = :active", { ":active": "ACTIVE" }, { "#status": "status" }),
      this.put(this.config.tables.tenantData, { ...key, ...project }),
      this.audit(context, organizationId, "PROJECT_CREATED", { projectId }),
    ]);
    return project;
  }

  async getProject(organizationId: string, projectId: string) {
    return this.require(this.config.tables.tenantData, tenantKeys.project(organizationId, projectId), versionedProjectSchema);
  }

  async updateProject(organizationId: string, projectId: string, input: { displayName: string; address: string; timeZone: string; expectedRevision: string }, context: ActionContext) {
    const organization = await this.getOrganization(organizationId);
    if (organization.status !== "ACTIVE") invalidState("Suspended organizations cannot be modified");
    const current = await this.getProject(organizationId, projectId);
    if (current.lifecycleStatus !== "ACTIVE") invalidState("Archived projects cannot be modified");
    const next = { ...current, displayName: input.displayName, address: input.address, timeZone: input.timeZone, revision: revision() };
    await this.transact([
      this.update(this.config.tables.tenantData, tenantKeys.project(organizationId, projectId), "SET displayName = :name, address = :address, timeZone = :timeZone, revision = :next", "revision = :expected AND lifecycleStatus = :active", { ":name": next.displayName, ":address": next.address, ":timeZone": next.timeZone, ":next": next.revision, ":expected": input.expectedRevision, ":active": "ACTIVE" }),
      this.audit(context, organizationId, "PROJECT_UPDATED", { projectId }),
    ]);
    return next;
  }

  async previewProject(organizationId: string, projectId: string) {
    const project = await this.getProject(organizationId, projectId);
    const items = await this.queryAll(this.config.tables.tenantData, `ORG#${organizationId}`);
    const inspections = items.filter((item) => String(item.SK).startsWith(`INSPECTION#${projectId}#`));
    const reports = items.filter((item) => String(item.SK).startsWith(`REPORT#${projectId}#`));
    return { revision: project.revision, activeInspectionCount: inspections.filter((item) => item.lifecycleStatus === "ACTIVE").length, publishedInspectionCount: inspections.filter((item) => item.lifecycleStatus === "ACTIVE" && item.publicationStatus === "PUBLISHED").length, publishedReportCount: reports.filter((item) => item.deliveryStatus === "PUBLISHED").length };
  }

  async archiveProject(organizationId: string, projectId: string, input: { expectedRevision: string; reason: string }, context: ActionContext) {
    const current = await this.getProject(organizationId, projectId);
    if (current.lifecycleStatus !== "ACTIVE") invalidState("Only active projects can be archived");
    const next: Versioned<Project> = { ...current, lifecycleStatus: "ARCHIVED", archivedAt: new Date().toISOString(), archivedByAdminId: context.active.profile.adminId, archiveReason: input.reason, revision: revision() };
    await this.writeProjectLifecycle(next, input.expectedRevision, "ACTIVE", context, "PROJECT_ARCHIVED");
    return next;
  }

  async restoreProject(organizationId: string, projectId: string, input: { expectedRevision: string }, context: ActionContext) {
    const current = await this.getProject(organizationId, projectId);
    if (current.lifecycleStatus !== "ARCHIVED") invalidState("Only archived projects can be restored");
    const next: Versioned<Project> = { ...current, lifecycleStatus: "ACTIVE", archivedAt: null, archivedByAdminId: null, archiveReason: null, revision: revision() };
    await this.writeProjectLifecycle(next, input.expectedRevision, "ARCHIVED", context, "PROJECT_RESTORED");
    return next;
  }

  async listInspections(organizationId: string, projectId: string, input: ListInput) {
    await this.getProject(organizationId, projectId);
    const page = await this.query(this.config.tables.tenantData, `ORG#${organizationId}`, `INSPECTION#${projectId}#`, input);
    return { ...page, items: page.items.map((item) => versionedInspectionSchema.parse(item)) };
  }

  async createInspection(organizationId: string, projectId: string, input: { scannedAt: string; idempotencyKey: string }, context: ActionContext) {
    const organization = await this.getOrganization(organizationId);
    if (organization.status !== "ACTIVE") invalidState("Inspections require an active organization");
    const project = await this.getProject(organizationId, projectId);
    if (project.lifecycleStatus !== "ACTIVE") invalidState("Inspections require an active project");
    const inspectionId = deterministicId("inspection", `${organizationId}:${projectId}`, input.idempotencyKey);
    const key = tenantKeys.inspection(organizationId, projectId, inspectionId);
    const existing = await this.get(this.config.tables.tenantData, key);
    if (existing) {
      const parsed = versionedInspectionSchema.parse(existing);
      if (parsed.scannedAt !== input.scannedAt) conflict("Idempotency key was already used with different input");
      return parsed;
    }
    const inspection: Versioned<Inspection> = { organizationId, projectId, inspectionId, scannedAt: input.scannedAt, scanTimeZone: project.timeZone, lifecycleStatus: "ACTIVE", publicationStatus: "DRAFT", archivedAt: null, archivedByAdminId: null, archiveReason: null, revision: revision() };
    const actions: object[] = [
      this.condition(this.config.tables.tenantData, tenantKeys.project(organizationId, projectId), "lifecycleStatus = :active AND revision = :revision", { ":active": "ACTIVE", ":revision": project.revision }),
      this.put(this.config.tables.tenantData, { ...key, ...inspection }),
    ];
    for (const reportType of REPORT_TYPES) {
      const report: Versioned<Report> = { organizationId, projectId, inspectionId, reportId: deterministicId("report", inspectionId, reportType), reportType, deliveryStatus: "EXPECTED", currentVersionId: null, revision: revision() };
      actions.push(this.put(this.config.tables.tenantData, { ...tenantKeys.report(organizationId, projectId, inspectionId, reportType), ...report }));
    }
    actions.push(this.audit(context, organizationId, "INSPECTION_CREATED", { projectId, inspectionId }));
    await this.transact(actions);
    return inspection;
  }

  async getInspection(organizationId: string, projectId: string, inspectionId: string) {
    return this.require(this.config.tables.tenantData, tenantKeys.inspection(organizationId, projectId, inspectionId), versionedInspectionSchema);
  }

  async updateInspection(organizationId: string, projectId: string, inspectionId: string, input: { scannedAt: string; expectedRevision: string }, context: ActionContext) {
    const project = await this.getProject(organizationId, projectId);
    if (project.lifecycleStatus !== "ACTIVE") invalidState("Inspections under archived projects cannot be modified");
    const current = await this.getInspection(organizationId, projectId, inspectionId);
    if (current.lifecycleStatus !== "ACTIVE" || current.publicationStatus !== "DRAFT") invalidState("Only active draft inspections can be modified");
    const next = { ...current, scannedAt: input.scannedAt, revision: revision() };
    await this.transact([
      this.update(this.config.tables.tenantData, tenantKeys.inspection(organizationId, projectId, inspectionId), "SET scannedAt = :scannedAt, revision = :next", "revision = :expected AND lifecycleStatus = :active AND publicationStatus = :draft", { ":scannedAt": next.scannedAt, ":next": next.revision, ":expected": input.expectedRevision, ":active": "ACTIVE", ":draft": "DRAFT" }),
      this.audit(context, organizationId, "INSPECTION_UPDATED", { projectId, inspectionId }),
    ]);
    return next;
  }

  async previewInspection(organizationId: string, projectId: string, inspectionId: string) {
    const inspection = await this.getInspection(organizationId, projectId, inspectionId);
    const reports = await this.listReports(organizationId, projectId, inspectionId);
    return { revision: inspection.revision, activeInspectionCount: inspection.lifecycleStatus === "ACTIVE" ? 1 : 0, publishedInspectionCount: inspection.lifecycleStatus === "ACTIVE" && inspection.publicationStatus === "PUBLISHED" ? 1 : 0, publishedReportCount: reports.filter((report) => report.deliveryStatus === "PUBLISHED").length };
  }

  async archiveInspection(organizationId: string, projectId: string, inspectionId: string, input: { expectedRevision: string; reason: string }, context: ActionContext) {
    const current = await this.getInspection(organizationId, projectId, inspectionId);
    if (current.lifecycleStatus !== "ACTIVE") invalidState("Only active inspections can be archived");
    const next: Versioned<Inspection> = { ...current, lifecycleStatus: "ARCHIVED", archivedAt: new Date().toISOString(), archivedByAdminId: context.active.profile.adminId, archiveReason: input.reason, revision: revision() };
    await this.writeInspectionLifecycle(next, input.expectedRevision, "ACTIVE", context, "INSPECTION_ARCHIVED");
    return next;
  }

  async restoreInspection(organizationId: string, projectId: string, inspectionId: string, input: { expectedRevision: string }, context: ActionContext) {
    const project = await this.getProject(organizationId, projectId);
    if (project.lifecycleStatus !== "ACTIVE") invalidState("An inspection cannot be restored under an archived project");
    const current = await this.getInspection(organizationId, projectId, inspectionId);
    if (current.lifecycleStatus !== "ARCHIVED") invalidState("Only archived inspections can be restored");
    const next: Versioned<Inspection> = { ...current, lifecycleStatus: "ACTIVE", archivedAt: null, archivedByAdminId: null, archiveReason: null, revision: revision() };
    await this.writeInspectionLifecycle(next, input.expectedRevision, "ARCHIVED", context, "INSPECTION_RESTORED");
    return next;
  }

  async listReports(organizationId: string, projectId: string, inspectionId: string) {
    await this.getInspection(organizationId, projectId, inspectionId);
    const page = await this.query(this.config.tables.tenantData, `ORG#${organizationId}`, `REPORT#${projectId}#${inspectionId}#`, { limit: 100 });
    return page.items.map((item) => versionedReportSchema.parse(item));
  }

  async updateReportStatus(organizationId: string, projectId: string, inspectionId: string, reportType: ReportType, input: { expectedRevision: string; deliveryStatus: Exclude<ReportDeliveryStatus, "PUBLISHED"> }, context: ActionContext) {
    const project = await this.getProject(organizationId, projectId);
    if (project.lifecycleStatus !== "ACTIVE") invalidState("Reports under archived projects cannot be modified");
    const inspection = await this.getInspection(organizationId, projectId, inspectionId);
    if (inspection.lifecycleStatus !== "ACTIVE" || inspection.publicationStatus !== "DRAFT") invalidState("Only reports on an active draft inspection can be classified");
    const key = tenantKeys.report(organizationId, projectId, inspectionId, reportType);
    const current = await this.require(this.config.tables.tenantData, key, versionedReportSchema);
    if (current.deliveryStatus === "PUBLISHED") invalidState("Use report withdrawal for a published report");
    const next = { ...current, deliveryStatus: input.deliveryStatus, revision: revision() };
    await this.transact([
      this.update(this.config.tables.tenantData, key, "SET deliveryStatus = :status, revision = :next", "revision = :expected AND currentVersionId = :null", { ":status": input.deliveryStatus, ":next": next.revision, ":expected": input.expectedRevision, ":null": null }),
      this.audit(context, organizationId, "REPORT_STATUS_CHANGED", { projectId, inspectionId, reportType }),
    ]);
    return next;
  }

  async withdrawReport(organizationId: string, projectId: string, inspectionId: string, reportType: ReportType, input: { expectedRevision: string; deliveryStatus: Exclude<ReportDeliveryStatus, "PUBLISHED">; reason: string }, context: ActionContext) {
    const project = await this.getProject(organizationId, projectId);
    const inspection = await this.getInspection(organizationId, projectId, inspectionId);
    if (project.lifecycleStatus !== "ACTIVE" || inspection.lifecycleStatus !== "ACTIVE" || inspection.publicationStatus !== "PUBLISHED") invalidState("Only reports on an active published inspection can be withdrawn");
    const key = tenantKeys.report(organizationId, projectId, inspectionId, reportType);
    const current = await this.require(this.config.tables.tenantData, key, versionedReportSchema);
    if (current.deliveryStatus !== "PUBLISHED" || !current.currentVersionId) invalidState("Only a published report can be withdrawn");
    const next = { ...current, deliveryStatus: input.deliveryStatus, currentVersionId: null, revision: revision() };
    await this.transact([
      this.update(this.config.tables.tenantData, key, "SET deliveryStatus = :status, currentVersionId = :null, revision = :next", "revision = :expected AND deliveryStatus = :published AND currentVersionId = :version", { ":status": input.deliveryStatus, ":null": null, ":next": next.revision, ":expected": input.expectedRevision, ":published": "PUBLISHED", ":version": current.currentVersionId }),
      this.audit(context, organizationId, "REPORT_WITHDRAWN", { projectId, inspectionId, reportType }, { previousVersionId: current.currentVersionId, reason: input.reason }),
    ]);
    return next;
  }

  async getHowToRead(organizationId: string) {
    return this.require(this.config.tables.tenantData, tenantKeys.organizationDocument(organizationId), versionedDocumentSchema);
  }

  async initializeHowToRead(organizationId: string, input: { idempotencyKey: string }, context: ActionContext) {
    const existing = await this.get(this.config.tables.tenantData, tenantKeys.organizationDocument(organizationId));
    if (existing) return versionedDocumentSchema.parse(existing);
    const document: Versioned<OrganizationDocument> = { organizationId, organizationDocumentId: deterministicId("document", organizationId, input.idempotencyKey), documentType: "HOW_TO_READ", status: "DRAFT", currentVersionId: null, revision: revision() };
    await this.transact([
      this.condition(this.config.tables.tenantData, tenantKeys.organization(organizationId), "#status = :active", { ":active": "ACTIVE" }, { "#status": "status" }),
      this.put(this.config.tables.tenantData, { ...tenantKeys.organizationDocument(organizationId), ...document }),
      this.audit(context, organizationId, "ORGANIZATION_DOCUMENT_INITIALIZED", { organizationDocumentId: document.organizationDocumentId }),
    ]);
    return document;
  }

  private async issueInvitation(input: { organizationId: string; userId: string; email: string; invitationId: string; expectedUserRevision: string | null }, context: ActionContext): Promise<AdminInvitation> {
    const normalizedEmail = normalizeEmail(input.email);
    const pending: AdminInvitation = { invitationId: input.invitationId, organizationId: input.organizationId, userId: input.userId, email: input.email.trim(), normalizedEmail, status: "PENDING", absoluteExpiresAt: new Date(Date.now() + INVITATION_MS).toISOString(), ttlExpiresAt: null, acceptedAt: null, cognitoUsername: normalizedEmail, issuer: this.config.clientIssuer, sub: null, revision: revision() };
    await this.transact([
      this.condition(this.config.tables.tenantData, tenantKeys.organization(input.organizationId), "#status = :active", { ":active": "ACTIVE" }, { "#status": "status" }),
      this.put(this.config.tables.identity, { ...identityKeys.emailReservation(normalizedEmail), normalizedEmail, organizationId: input.organizationId, userId: input.userId, invitationId: input.invitationId }),
      this.put(this.config.tables.adminControl, { ...adminControlKeys.invitation(input.organizationId, input.invitationId), ...pending }),
      this.audit(context, input.organizationId, input.expectedUserRevision ? "USER_IDENTITY_REPLACEMENT_STARTED" : "USER_INVITATION_STARTED", { userId: input.userId, invitationId: input.invitationId }),
    ]);
    let sub: string;
    let cognitoUsername = pending.cognitoUsername;
    try {
      const result = await this.cognito.send(new AdminCreateUserCommand({ UserPoolId: this.config.clientUserPoolId, Username: pending.cognitoUsername, UserAttributes: [{ Name: "email", Value: pending.normalizedEmail }, { Name: "email_verified", Value: "true" }] }));
      sub = result.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value ?? "";
      cognitoUsername = result.User?.Username ?? "";
      if (!sub || !cognitoUsername) throw new Error("Cognito did not return a username and subject");
    } catch (error) {
      await this.markInvitationDeliveryFailed(pending, context);
      throw error;
    }
    const identity: ClientIdentity = { issuer: this.config.clientIssuer, sub, organizationId: input.organizationId, userId: input.userId, status: "INVITED", invitationId: input.invitationId };
    const user: Versioned<ClientUser> = { organizationId: input.organizationId, userId: input.userId, email: pending.email, normalizedEmail, status: "INVITED", currentIssuer: this.config.clientIssuer, currentSub: sub, cognitoUsername, revision: revision() };
    const finalized = { ...pending, sub, cognitoUsername, revision: revision() };
    try {
      const userWrite = input.expectedUserRevision
        ? this.update(this.config.tables.tenantData, tenantKeys.user(input.organizationId, input.userId), "SET email = :email, normalizedEmail = :normalized, #status = :invited, currentIssuer = :issuer, currentSub = :sub, cognitoUsername = :username, revision = :next", "revision = :expected AND #status = :revoked", { ":email": user.email, ":normalized": normalizedEmail, ":invited": "INVITED", ":issuer": user.currentIssuer, ":sub": sub, ":username": user.cognitoUsername, ":next": user.revision, ":expected": input.expectedUserRevision, ":revoked": "REVOKED" }, { "#status": "status" })
        : this.put(this.config.tables.tenantData, { ...tenantKeys.user(input.organizationId, input.userId), ...user });
      await this.transact([
        this.put(this.config.tables.identity, { ...identityKeys.subject(identity.issuer, identity.sub), ...identity }),
        userWrite,
        this.update(this.config.tables.adminControl, adminControlKeys.invitation(input.organizationId, input.invitationId), "SET #sub = :sub, cognitoUsername = :username, revision = :next", "revision = :expected AND #status = :pending", { ":sub": sub, ":username": cognitoUsername, ":next": finalized.revision, ":expected": pending.revision, ":pending": "PENDING" }, { "#sub": "sub", "#status": "status" }),
        this.audit(context, input.organizationId, input.expectedUserRevision ? "USER_IDENTITY_REPLACEMENT_INVITED" : "USER_INVITED", { userId: input.userId, invitationId: input.invitationId }),
      ]);
      return finalized;
    } catch (error) {
      try { await this.cognito.send(new AdminDeleteUserCommand({ UserPoolId: this.config.clientUserPoolId, Username: cognitoUsername })); } catch { /* reservation remains fail-closed */ }
      await this.markInvitationDeliveryFailed(pending, context);
      throw error;
    }
  }

  private async markInvitationDeliveryFailed(invitation: AdminInvitation, context: ActionContext) {
    try {
      await this.transact([
        this.update(this.config.tables.adminControl, adminControlKeys.invitation(invitation.organizationId, invitation.invitationId), "SET #status = :failed, revision = :next", "revision = :expected", { ":failed": "DELIVERY_FAILED", ":next": revision(), ":expected": invitation.revision }, { "#status": "status" }),
        this.audit(context, invitation.organizationId, "INVITATION_DELIVERY_FAILED", { invitationId: invitation.invitationId, userId: invitation.userId }),
      ]);
    } catch { /* preserve original Cognito or transaction failure */ }
  }

  private async disableCognito(username: string) {
    try { await this.cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.config.clientUserPoolId, Username: username })); } catch { /* local revocation remains authoritative */ }
    try { await this.cognito.send(new AdminDisableUserCommand({ UserPoolId: this.config.clientUserPoolId, Username: username })); } catch { /* local revocation remains authoritative */ }
  }

  private async revokeSubjectSessions(issuer: string, sub: string) {
    const subjectPk = identityKeys.subject(issuer, sub).PK;
    const pointers = await this.queryAll(this.config.tables.session, subjectPk);
    const activePointers = pointers.filter((item) => typeof item.sessionIdHash === "string" && item.revokedAt === null);
    const revokedAt = new Date().toISOString();
    for (let offset = 0; offset < activePointers.length; offset += 50) {
      const actions: object[] = [];
      for (const pointer of activePointers.slice(offset, offset + 50)) {
        const sessionIdHash = String(pointer.sessionIdHash);
        actions.push(this.update(this.config.tables.session, { PK: subjectPk, SK: String(pointer.SK) }, "SET revokedAt = :at", "revokedAt = :null", { ":at": revokedAt, ":null": null }));
        actions.push(this.update(this.config.tables.session, { PK: `SESSION#${sessionIdHash}`, SK: "SESSION" }, "SET revokedAt = :at", "revokedAt = :null", { ":at": revokedAt, ":null": null }));
      }
      if (actions.length) await this.transact(actions);
    }
  }

  private async writeProjectLifecycle(project: Versioned<Project>, expectedRevision: string, expectedStatus: string, context: ActionContext, action: string) {
    await this.transact([
      this.update(this.config.tables.tenantData, tenantKeys.project(project.organizationId, project.projectId), "SET lifecycleStatus = :status, archivedAt = :at, archivedByAdminId = :by, archiveReason = :reason, revision = :next", "revision = :expected AND lifecycleStatus = :old", { ":status": project.lifecycleStatus, ":at": project.archivedAt, ":by": project.archivedByAdminId, ":reason": project.archiveReason, ":next": project.revision, ":expected": expectedRevision, ":old": expectedStatus }),
      this.audit(context, project.organizationId, action, { projectId: project.projectId }),
    ]);
  }

  private async writeInspectionLifecycle(inspection: Versioned<Inspection>, expectedRevision: string, expectedStatus: string, context: ActionContext, action: string) {
    await this.transact([
      this.update(this.config.tables.tenantData, tenantKeys.inspection(inspection.organizationId, inspection.projectId, inspection.inspectionId), "SET lifecycleStatus = :status, archivedAt = :at, archivedByAdminId = :by, archiveReason = :reason, revision = :next", "revision = :expected AND lifecycleStatus = :old", { ":status": inspection.lifecycleStatus, ":at": inspection.archivedAt, ":by": inspection.archivedByAdminId, ":reason": inspection.archiveReason, ":next": inspection.revision, ":expected": expectedRevision, ":old": expectedStatus }),
      this.audit(context, inspection.organizationId, action, { projectId: inspection.projectId, inspectionId: inspection.inspectionId }),
    ]);
  }

  private put(table: string, item: Record<string, unknown>) {
    return { Put: { TableName: table, Item: item, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } };
  }

  private update(table: string, key: Record<string, string>, updateExpression: string, conditionExpression: string, values: Record<string, unknown>, names?: Record<string, string>) {
    return { Update: { TableName: table, Key: key, UpdateExpression: updateExpression, ConditionExpression: conditionExpression, ExpressionAttributeValues: values, ...(names ? { ExpressionAttributeNames: names } : {}) } };
  }

  private condition(table: string, key: Record<string, string>, conditionExpression: string, values: Record<string, unknown>, names?: Record<string, string>) {
    return { ConditionCheck: { TableName: table, Key: key, ConditionExpression: conditionExpression, ExpressionAttributeValues: values, ...(names ? { ExpressionAttributeNames: names } : {}) } };
  }

  private audit(context: ActionContext, organizationId: string | undefined, action: string, target: Record<string, string>, details?: Record<string, unknown>) {
    const item = auditItem(context, organizationId, action, target, details);
    item.Put.TableName = this.config.tables.audit;
    return item;
  }

  private async transact(actions: object[]) {
    try {
      await this.dynamo.send(new TransactWriteCommand({ TransactItems: actions }));
    } catch (error) {
      if (error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException")) conflict();
      throw error;
    }
  }

  private async get(table: string, key: Record<string, string>) {
    const result = await this.dynamo.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    return result.Item;
  }

  private async require<T>(table: string, key: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const item = await this.get(table, key);
    if (!item) notFound();
    return schema.parse(item);
  }

  private async query(table: string, pk: string, prefix: string, input: ListInput): Promise<Page<Record<string, unknown>>> {
    const exclusiveStartKey = input.nextToken ? this.decodeToken(input.nextToken, pk, prefix) : undefined;
    const result = await this.dynamo.send(new QueryCommand({ TableName: table, KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, Limit: input.limit, ConsistentRead: true, ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}) }));
    return { items: result.Items ?? [], ...(result.LastEvaluatedKey ? { nextToken: Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") } : {}) };
  }

  private async queryAll(table: string, pk: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let last: Record<string, unknown> | undefined;
    do {
      const result = await this.dynamo.send(new QueryCommand({ TableName: table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, ...(last ? { ExclusiveStartKey: last } : {}) }));
      items.push(...(result.Items ?? []));
      last = result.LastEvaluatedKey;
    } while (last);
    return items;
  }

  private decodeToken(token: string, pk: string, prefix: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      if (!parsed || typeof parsed !== "object" || !("PK" in parsed) || !("SK" in parsed) || parsed.PK !== pk || typeof parsed.SK !== "string" || !parsed.SK.startsWith(prefix)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      invalidState("Invalid pagination token");
    }
  }
}
