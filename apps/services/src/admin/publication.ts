import { createHash, randomUUID } from "node:crypto";

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  documentVersionSchema,
  inspectionSchema,
  organizationDocumentSchema,
  organizationSchema,
  projectSchema,
  reportSchema,
  reportVersionSchema,
  uploadSessionSchema,
  type CreateUploadSessionRequest,
  type DocumentVersion,
  type PublishArtifactRequest,
  type PublishInspectionRequest,
  type PublishReportRequest,
  type Report,
  type ReportVersion,
  type UploadSession,
  type UploadTarget,
} from "@bdr/contracts";
import { auditKeys, conflict, DomainError, invalidState, notFound, publishedArtifactKey, tenantKeys } from "@bdr/domain";
import { z } from "zod";

import type { ActiveAdmin } from "../auth/admin";

type Context = Readonly<{ active: ActiveAdmin; requestId: string }>;
type Versioned<T> = T & { revision: string };
type Locator = Readonly<{ target: UploadTarget }>;
type Config = Readonly<{
  tenantDataTableName: string;
  auditTableName: string;
  uploadPresignerFunctionName: string;
  publisherFunctionName: string;
  maxUploadBytes: number;
}>;

type Verification = Readonly<{ status: "VERIFIED" | "MISSING"; versionId?: string; sizeBytes?: number; sha256?: string; contentType?: "application/pdf" }>;
type CopyResult = Readonly<{ versionId: string; sizeBytes: number; sha256: string; contentType: "application/pdf" }>;

export interface PublicationOperations {
  createUploadSession(organizationId: string, request: CreateUploadSessionRequest, idempotencyKey: string, context: Context): Promise<Record<string, unknown>>;
  getUploadSession(organizationId: string, uploadSessionId: string, locator: Locator): Promise<UploadSession>;
  completeUpload(organizationId: string, uploadSessionId: string, locator: Locator, context: Context): Promise<UploadSession>;
  refreshUploadUrl(organizationId: string, uploadSessionId: string, locator: Locator, context: Context): Promise<Record<string, unknown>>;
  publishInspection(organizationId: string, projectId: string, inspectionId: string, request: PublishInspectionRequest, context: Context): Promise<Record<string, unknown>>;
  publishReport(organizationId: string, projectId: string, inspectionId: string, reportType: string, request: PublishReportRequest, context: Context): Promise<Record<string, unknown>>;
  publishDocument(organizationId: string, request: PublishArtifactRequest, replace: boolean, context: Context): Promise<Record<string, unknown>>;
  reportHistory(organizationId: string, projectId: string, inspectionId: string, reportType: string): Promise<ReportVersion[]>;
  documentHistory(organizationId: string): Promise<DocumentVersion[]>;
}

const versionedOrganization = organizationSchema.extend({ revision: z.string() });
const versionedProject = projectSchema.extend({ revision: z.string() });
const versionedInspection = inspectionSchema.extend({ revision: z.string() });
const versionedReport = reportSchema.extend({ revision: z.string() });
const versionedDocument = organizationDocumentSchema.extend({ revision: z.string() });

function revision() { return `rev_${randomUUID()}`; }
function id(prefix: string, scope: string, key: string) { return `${prefix}_${createHash("sha256").update(`${prefix}\0${scope}\0${key}`).digest("hex").slice(0, 32)}`; }

export class AwsPublicationOperations implements PublicationOperations {
  private readonly dynamo: DynamoDBDocumentClient;
  private readonly lambda: LambdaClient;

  constructor(private readonly config: Config, clients: { dynamo?: DynamoDBDocumentClient; lambda?: LambdaClient } = {}) {
    this.dynamo = clients.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    this.lambda = clients.lambda ?? new LambdaClient({});
  }

  async createUploadSession(organizationId: string, request: CreateUploadSessionRequest, idempotencyKey: string, context: Context) {
    if (request.target.organizationId !== organizationId) invalidState("Upload target organization does not match the route");
    if (request.sizeBytes > this.config.maxUploadBytes) invalidState("PDF exceeds the configured upload limit");
    await this.assertTarget(request.target);
    const uploadSessionId = id("upload", JSON.stringify(request.target), idempotencyKey);
    const key = this.sessionKey(request.target, uploadSessionId);
    const originalFilename = request.originalFilename.replace(/[\r\n]/g, " ").slice(0, 255);
    const existing = await this.get(key);
    if (existing) {
      const session = uploadSessionSchema.parse(existing);
      return this.existingUploadResponse(session, request, originalFilename);
    }
    const artifactVersionId = id(request.target.kind === "INSPECTION_REPORT" ? "reportversion" : "documentversion", uploadSessionId, idempotencyKey);
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const session: UploadSession = {
      uploadSessionId,
      target: request.target,
      state: "UPLOADING",
      uploadKey: `uploads/${uploadSessionId}/source.pdf`,
      originalFilename,
      declaredSizeBytes: request.sizeBytes,
      declaredSha256: request.sha256,
      contentType: "application/pdf",
      sourceS3VersionId: null,
      artifactVersionId,
      publishedKey: publishedArtifactKey(artifactVersionId),
      destinationS3VersionId: null,
      createdAt: now.toISOString(),
      absoluteExpiresAt: expires.toISOString(),
      ttlExpiresAt: Math.ceil(expires.getTime() / 1000),
      createdByAdminId: context.active.profile.adminId,
      revision: revision(),
      failureReason: null,
    };
    try {
      await this.transact([
        { Put: { TableName: this.config.tenantDataTableName, Item: { ...key, ...session }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
        this.audit(context, organizationId, "UPLOAD_SESSION_CREATED", { uploadSessionId, targetKind: request.target.kind }),
      ]);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "CONFLICT") throw error;
      const concurrent = await this.get(key);
      if (!concurrent) throw error;
      return this.existingUploadResponse(uploadSessionSchema.parse(concurrent), request, originalFilename);
    }
    return this.responseWithUrl(session);
  }

  async completeUpload(organizationId: string, uploadSessionId: string, locator: Locator, context: Context) {
    const session = await this.loadSession(organizationId, uploadSessionId, locator.target);
    if (session.state === "READY" || session.state === "PUBLISHING" || session.state === "PUBLISHED") return session;
    if (session.state !== "UPLOADING" || Date.parse(session.absoluteExpiresAt) <= Date.now()) invalidState("Upload session cannot be completed");
    let result: Verification;
    try {
      result = await this.invoke<Verification>(this.config.publisherFunctionName, { action: "VERIFY_UPLOAD", uploadKey: session.uploadKey, sizeBytes: session.declaredSizeBytes, sha256: session.declaredSha256 });
    } catch (error) {
      await this.failSession(session, "Uploaded object failed integrity verification", context);
      throw error;
    }
    if (result.status !== "VERIFIED" || !result.versionId) invalidState("The complete uploaded object is not available");
    const next = { ...session, state: "READY" as const, sourceS3VersionId: result.versionId, revision: revision() };
    try {
      await this.transact([
        this.updateSession(session, "SET #state = :ready, sourceS3VersionId = :version, revision = :next", "#state = :uploading AND revision = :expected", { ":ready": "READY", ":version": result.versionId, ":next": next.revision, ":uploading": "UPLOADING", ":expected": session.revision }),
        this.audit(context, organizationId, "UPLOAD_VERIFIED", { uploadSessionId }),
      ]);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "CONFLICT") throw error;
      const concurrent = await this.loadSession(organizationId, uploadSessionId, locator.target);
      if (["READY", "PUBLISHING", "PUBLISHED"].includes(concurrent.state) && concurrent.sourceS3VersionId === result.versionId) return concurrent;
      throw error;
    }
    return next;
  }

  async getUploadSession(organizationId: string, uploadSessionId: string, locator: Locator) {
    return this.loadSession(organizationId, uploadSessionId, locator.target);
  }

  async refreshUploadUrl(organizationId: string, uploadSessionId: string, locator: Locator, context: Context) {
    const session = await this.loadSession(organizationId, uploadSessionId, locator.target);
    if (session.state !== "UPLOADING" || Date.parse(session.absoluteExpiresAt) <= Date.now()) invalidState("Upload URL cannot be refreshed for this session");
    try {
      const result = await this.invoke<Verification>(this.config.publisherFunctionName, { action: "VERIFY_UPLOAD", uploadKey: session.uploadKey, sizeBytes: session.declaredSizeBytes, sha256: session.declaredSha256 });
      if (result.status === "VERIFIED") {
        const ready = await this.completeUpload(organizationId, uploadSessionId, locator, context);
        return { uploadSession: ready, uploadUrl: null, requiredHeaders: {} };
      }
    } catch (error) {
      await this.failSession(session, "Existing upload object did not match the declared PDF", context);
      throw error;
    }
    return this.responseWithUrl(session);
  }

  async publishInspection(organizationId: string, projectId: string, inspectionId: string, request: PublishInspectionRequest, context: Context) {
    const organization = await this.require(tenantKeys.organization(organizationId), versionedOrganization);
    const project = await this.require(tenantKeys.project(organizationId, projectId), versionedProject);
    const inspection = await this.require(tenantKeys.inspection(organizationId, projectId, inspectionId), versionedInspection);
    const byType = new Map(request.classifications.map((item) => [item.reportType, item]));
    if (byType.size !== 4 || !request.classifications.some((item) => item.deliveryStatus === "PUBLISHED")) invalidState("All four report types and at least one PDF are required");
    if (organization.status !== "ACTIVE" || project.lifecycleStatus !== "ACTIVE" || inspection.lifecycleStatus !== "ACTIVE" || request.confirmedProjectId !== projectId) invalidState("Inspection publication target is invalid");
    if (inspection.publicationStatus === "PUBLISHED") {
      const publishedVersionIds: string[] = [];
      for (const classification of request.classifications) {
        const report = await this.require(tenantKeys.report(organizationId, projectId, inspectionId, classification.reportType), versionedReport);
        if (classification.deliveryStatus === "PUBLISHED" && classification.uploadSessionId) {
          const target: UploadTarget = { kind: "INSPECTION_REPORT", organizationId, projectId, inspectionId, reportType: classification.reportType };
          const session = await this.loadSession(organizationId, classification.uploadSessionId, target);
          if (session.state !== "PUBLISHED" || report.deliveryStatus !== "PUBLISHED" || report.currentVersionId !== session.artifactVersionId) conflict("Inspection was already published with different report state");
          publishedVersionIds.push(session.artifactVersionId);
        } else if (report.deliveryStatus !== classification.deliveryStatus || report.currentVersionId !== null) {
          conflict("Inspection was already published with different report state");
        }
      }
      return { organizationId, projectId, inspectionId, publicationStatus: "PUBLISHED", publishedVersionIds };
    }
    if (inspection.publicationStatus !== "DRAFT" || inspection.revision !== request.expectedRevision) invalidState("Inspection publication revision is invalid");
    const prepared: Array<{ report: Versioned<Report>; session: UploadSession; copy: CopyResult }> = [];
    for (const classification of request.classifications) {
      const report = await this.require(tenantKeys.report(organizationId, projectId, inspectionId, classification.reportType), versionedReport);
      if (classification.deliveryStatus === "PUBLISHED") {
        if (!classification.uploadSessionId) invalidState("Published classifications require an upload session");
        const target: UploadTarget = { kind: "INSPECTION_REPORT", organizationId, projectId, inspectionId, reportType: classification.reportType };
        const session = await this.prepareSession(await this.loadSession(organizationId, classification.uploadSessionId, target));
        prepared.push({ report, session, copy: await this.copy(session) });
      }
    }
    const now = new Date().toISOString();
    const actions: object[] = [];
    for (const classification of request.classifications) {
      const report = await this.require(tenantKeys.report(organizationId, projectId, inspectionId, classification.reportType), versionedReport);
      if (classification.deliveryStatus === "PUBLISHED") {
        const item = prepared.find((value) => value.report.reportType === classification.reportType)!;
        const version = this.reportVersion(item.session, item.copy, context, now);
        actions.push(this.putVersion(tenantKeys.reportVersion(organizationId, projectId, inspectionId, classification.reportType, version.reportVersionId), version));
        actions.push(this.updateReport(report, "PUBLISHED", version.reportVersionId));
        actions.push(this.finishSession(item.session, item.copy));
      } else {
        actions.push(this.updateReport(report, classification.deliveryStatus, null));
      }
    }
    actions.push({ Update: { TableName: this.config.tenantDataTableName, Key: tenantKeys.inspection(organizationId, projectId, inspectionId), UpdateExpression: "SET publicationStatus = :published, revision = :next", ConditionExpression: "publicationStatus = :draft AND lifecycleStatus = :active AND revision = :expected", ExpressionAttributeValues: { ":published": "PUBLISHED", ":draft": "DRAFT", ":active": "ACTIVE", ":expected": request.expectedRevision, ":next": revision() } } });
    actions.push(this.audit(context, organizationId, "INSPECTION_PUBLISHED", { projectId, inspectionId }, this.approvalDetails(request, { organizationId, projectId, inspectionId, classifications: request.classifications })));
    await this.transact(actions);
    return { organizationId, projectId, inspectionId, publicationStatus: "PUBLISHED", publishedVersionIds: prepared.map((item) => item.session.artifactVersionId) };
  }

  async publishReport(organizationId: string, projectId: string, inspectionId: string, reportTypeInput: string, request: PublishReportRequest, context: Context) {
    const reportType = z.enum(["ASSESSMENT", "EVIDENCE", "ROOF_TAKEOFF", "CAPITAL_PLANNING"]).parse(reportTypeInput);
    if (request.confirmedProjectId !== projectId) invalidState("Confirmed project does not match");
    const organization = await this.require(tenantKeys.organization(organizationId), versionedOrganization);
    const project = await this.require(tenantKeys.project(organizationId, projectId), versionedProject);
    const inspection = await this.require(tenantKeys.inspection(organizationId, projectId, inspectionId), versionedInspection);
    const report = await this.require(tenantKeys.report(organizationId, projectId, inspectionId, reportType), versionedReport);
    if (organization.status !== "ACTIVE" || project.lifecycleStatus !== "ACTIVE" || inspection.lifecycleStatus !== "ACTIVE" || inspection.publicationStatus !== "PUBLISHED") invalidState("Report publication target is invalid");
    const target: UploadTarget = { kind: "INSPECTION_REPORT", organizationId, projectId, inspectionId, reportType };
    const loaded = await this.loadSession(organizationId, request.uploadSessionId, target);
    if (loaded.state === "PUBLISHED") {
      if (report.deliveryStatus !== "PUBLISHED" || report.currentVersionId !== loaded.artifactVersionId) conflict("Upload session was already published but is no longer current");
      return this.require(tenantKeys.reportVersion(organizationId, projectId, inspectionId, reportType, loaded.artifactVersionId), reportVersionSchema);
    }
    if (report.revision !== request.expectedRevision) invalidState("Report publication revision is invalid");
    const session = await this.prepareSession(loaded);
    const copy = await this.copy(session);
    const now = new Date().toISOString();
    const version = this.reportVersion(session, copy, context, now);
    const replacing = report.currentVersionId !== null;
    await this.transact([
      this.putVersion(tenantKeys.reportVersion(organizationId, projectId, inspectionId, reportType, version.reportVersionId), version),
      this.updateReport(report, "PUBLISHED", version.reportVersionId),
      this.finishSession(session, copy),
      this.audit(context, organizationId, replacing ? "REPORT_REPLACED" : "REPORT_PUBLISHED", { projectId, inspectionId, reportType }, { ...this.approvalDetails(request, { organizationId, projectId, inspectionId, reportType, uploadSessionId: request.uploadSessionId }), previousVersionId: report.currentVersionId }),
    ]);
    return version;
  }

  async publishDocument(organizationId: string, request: PublishArtifactRequest, replace: boolean, context: Context) {
    const organization = await this.require(tenantKeys.organization(organizationId), versionedOrganization);
    const document = await this.require(tenantKeys.organizationDocument(organizationId), versionedDocument);
    if (organization.status !== "ACTIVE") invalidState("How to Read organization is not active");
    const target: UploadTarget = { kind: "ORGANIZATION_DOCUMENT", organizationId, documentType: "HOW_TO_READ" };
    const loaded = await this.loadSession(organizationId, request.uploadSessionId, target);
    if (loaded.state === "PUBLISHED") {
      if (document.status !== "PUBLISHED" || document.currentVersionId !== loaded.artifactVersionId) conflict("Upload session was already published but is no longer current");
      return this.require(tenantKeys.documentVersion(organizationId, loaded.artifactVersionId), documentVersionSchema);
    }
    if (document.revision !== request.expectedRevision || (replace ? document.status !== "PUBLISHED" : document.status !== "DRAFT")) invalidState("How to Read publication target or revision is invalid");
    const session = await this.prepareSession(loaded);
    const copy = await this.copy(session);
    const now = new Date().toISOString();
    const version: DocumentVersion = { organizationId, documentType: "HOW_TO_READ", documentVersionId: session.artifactVersionId, s3Key: session.publishedKey, s3VersionId: copy.versionId, sha256: copy.sha256, sizeBytes: copy.sizeBytes, contentType: "application/pdf", integrityStatus: "VERIFIED", publishedAt: now, publishedByAdminId: context.active.profile.adminId };
    await this.transact([
      this.putVersion(tenantKeys.documentVersion(organizationId, version.documentVersionId), version),
      { Update: { TableName: this.config.tenantDataTableName, Key: tenantKeys.organizationDocument(organizationId), UpdateExpression: "SET #status = :published, currentVersionId = :version, revision = :next", ConditionExpression: "revision = :expected AND currentVersionId = :current", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":published": "PUBLISHED", ":version": version.documentVersionId, ":next": revision(), ":expected": request.expectedRevision, ":current": document.currentVersionId } } },
      this.finishSession(session, copy),
      this.audit(context, organizationId, replace ? "ORGANIZATION_DOCUMENT_REPLACED" : "ORGANIZATION_DOCUMENT_PUBLISHED", { documentVersionId: version.documentVersionId }, { ...this.approvalDetails(request, { organizationId, documentType: "HOW_TO_READ", uploadSessionId: request.uploadSessionId }), previousVersionId: document.currentVersionId }),
    ]);
    return version;
  }

  async reportHistory(organizationId: string, projectId: string, inspectionId: string, reportTypeInput: string) {
    const reportType = z.enum(["ASSESSMENT", "EVIDENCE", "ROOF_TAKEOFF", "CAPITAL_PLANNING"]).parse(reportTypeInput);
    const items = await this.query(`ORG#${organizationId}`, `VERSION#${projectId}#${inspectionId}#${reportType}#`);
    return items.map((item) => reportVersionSchema.parse(item)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }

  async documentHistory(organizationId: string) {
    const items = await this.query(`ORG#${organizationId}`, "DOCUMENT_VERSION#HOW_TO_READ#");
    return items.map((item) => documentVersionSchema.parse(item)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }

  private async responseWithUrl(session: UploadSession) {
    const signed = await this.invoke<{ uploadUrl: string; requiredHeaders: Record<string, string> }>(this.config.uploadPresignerFunctionName, { uploadKey: session.uploadKey, sizeBytes: session.declaredSizeBytes, sha256: session.declaredSha256 });
    return { uploadSession: session, ...signed };
  }

  private async existingUploadResponse(session: UploadSession, request: CreateUploadSessionRequest, originalFilename: string) {
    if (session.declaredSizeBytes !== request.sizeBytes || session.declaredSha256 !== request.sha256 || session.originalFilename !== originalFilename || JSON.stringify(session.target) !== JSON.stringify(request.target)) conflict("Idempotency key was already used with different input");
    if (session.state !== "UPLOADING") return { uploadSession: session, uploadUrl: null, requiredHeaders: {} };
    if (Date.parse(session.absoluteExpiresAt) <= Date.now()) invalidState("Upload session has expired");
    return this.responseWithUrl(session);
  }

  private async prepareSession(session: UploadSession) {
    if (session.state !== "READY" && session.state !== "PUBLISHING") invalidState("Only a verified upload can be published");
    if (!session.sourceS3VersionId) invalidState("Upload session has no verified source version");
    if (session.state === "READY") {
      const next = { ...session, state: "PUBLISHING" as const, revision: revision() };
      try {
        await this.dynamo.send(new UpdateCommand({ TableName: this.config.tenantDataTableName, Key: this.sessionKey(session.target, session.uploadSessionId), UpdateExpression: "SET #state = :publishing, revision = :next", ConditionExpression: "#state = :ready AND revision = :expected", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":publishing": "PUBLISHING", ":ready": "READY", ":next": next.revision, ":expected": session.revision } }));
        return next;
      } catch (error) {
        if (!(error instanceof Error) || !["ConditionalCheckFailedException", "TransactionConflictException"].includes(error.name)) throw error;
        const current = await this.require(this.sessionKey(session.target, session.uploadSessionId), uploadSessionSchema);
        if (current.state === "PUBLISHING") return current;
        conflict("Upload publication state changed");
      }
    }
    return session;
  }

  private copy(session: UploadSession) {
    if (!session.sourceS3VersionId) invalidState("Upload session has no verified source version");
    return this.invoke<CopyResult>(this.config.publisherFunctionName, { action: "COPY_AND_VERIFY", uploadKey: session.uploadKey, sourceVersionId: session.sourceS3VersionId, publishedKey: session.publishedKey, sizeBytes: session.declaredSizeBytes, sha256: session.declaredSha256 });
  }

  private approvalDetails(request: PublishArtifactRequest | PublishInspectionRequest, summary: unknown) {
    return {
      approvalStatementVersion: request.approvalStatementVersion,
      approvalConfirmed: true,
      summaryDigest: createHash("sha256").update(JSON.stringify(summary)).digest("hex"),
    };
  }

  private reportVersion(session: UploadSession, copy: CopyResult, context: Context, publishedAt: string): ReportVersion {
    if (session.target.kind !== "INSPECTION_REPORT") throw new Error("Upload target is not a report");
    return { organizationId: session.target.organizationId, projectId: session.target.projectId, inspectionId: session.target.inspectionId, reportType: session.target.reportType, reportVersionId: session.artifactVersionId, s3Key: session.publishedKey, s3VersionId: copy.versionId, sha256: copy.sha256, sizeBytes: copy.sizeBytes, contentType: "application/pdf", integrityStatus: "VERIFIED", publishedAt, publishedByAdminId: context.active.profile.adminId };
  }

  private updateReport(report: Versioned<Report>, deliveryStatus: string, currentVersionId: string | null) {
    return { Update: { TableName: this.config.tenantDataTableName, Key: tenantKeys.report(report.organizationId, report.projectId, report.inspectionId, report.reportType), UpdateExpression: "SET deliveryStatus = :status, currentVersionId = :version, revision = :next", ConditionExpression: "revision = :expected AND currentVersionId = :current", ExpressionAttributeValues: { ":status": deliveryStatus, ":version": currentVersionId, ":next": revision(), ":expected": report.revision, ":current": report.currentVersionId } } };
  }

  private finishSession(session: UploadSession, copy: CopyResult) {
    return this.updateSession(session, "SET #state = :published, destinationS3VersionId = :version, ttlExpiresAt = :ttl, revision = :next", "#state = :publishing AND revision = :expected", { ":published": "PUBLISHED", ":version": copy.versionId, ":ttl": null, ":next": revision(), ":publishing": "PUBLISHING", ":expected": session.revision });
  }

  private putVersion(key: Record<string, string>, version: ReportVersion | DocumentVersion) {
    return { Put: { TableName: this.config.tenantDataTableName, Item: { ...key, ...version }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } };
  }

  private updateSession(session: UploadSession, updateExpression: string, conditionExpression: string, values: Record<string, unknown>) {
    return { Update: { TableName: this.config.tenantDataTableName, Key: this.sessionKey(session.target, session.uploadSessionId), UpdateExpression: updateExpression, ConditionExpression: conditionExpression, ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: values } };
  }

  private async failSession(session: UploadSession, reason: string, context: Context) {
    try {
      await this.transact([
        this.updateSession(session, "SET #state = :failed, failureReason = :reason, revision = :next", "#state = :uploading AND revision = :expected", { ":failed": "FAILED", ":reason": reason, ":next": revision(), ":uploading": "UPLOADING", ":expected": session.revision }),
        this.audit(context, session.target.organizationId, "UPLOAD_FAILED", { uploadSessionId: session.uploadSessionId }, { reason }),
      ]);
    } catch { /* keep the original integrity failure */ }
  }

  private sessionKey(target: UploadTarget, uploadSessionId: string) {
    return target.kind === "INSPECTION_REPORT"
      ? tenantKeys.reportUpload(target.organizationId, target.projectId, target.inspectionId, uploadSessionId)
      : tenantKeys.documentUpload(target.organizationId, uploadSessionId);
  }

  private async loadSession(organizationId: string, uploadSessionId: string, target: UploadTarget) {
    if (target.organizationId !== organizationId) notFound();
    const session = await this.require(this.sessionKey(target, uploadSessionId), uploadSessionSchema);
    if (session.uploadSessionId !== uploadSessionId || JSON.stringify(session.target) !== JSON.stringify(target)) notFound();
    return session;
  }

  private async assertTarget(target: UploadTarget) {
    const organization = await this.require(tenantKeys.organization(target.organizationId), versionedOrganization);
    if (organization.status !== "ACTIVE") invalidState("Upload target organization is not active");
    if (target.kind === "ORGANIZATION_DOCUMENT") {
      await this.require(tenantKeys.organizationDocument(target.organizationId), versionedDocument);
      return;
    }
    const project = await this.require(tenantKeys.project(target.organizationId, target.projectId), versionedProject);
    const inspection = await this.require(tenantKeys.inspection(target.organizationId, target.projectId, target.inspectionId), versionedInspection);
    await this.require(tenantKeys.report(target.organizationId, target.projectId, target.inspectionId, target.reportType), versionedReport);
    if (project.lifecycleStatus !== "ACTIVE" || inspection.lifecycleStatus !== "ACTIVE") invalidState("Upload target is archived");
  }

  private async invoke<T>(functionName: string, payload: unknown): Promise<T> {
    const result = await this.lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(payload)) }));
    if (result.FunctionError || !result.Payload) throw new Error(`Worker ${functionName} failed`);
    return JSON.parse(Buffer.from(result.Payload).toString("utf8")) as T;
  }

  private async get(key: Record<string, string>) {
    return (await this.dynamo.send(new GetCommand({ TableName: this.config.tenantDataTableName, Key: key, ConsistentRead: true }))).Item;
  }

  private async require<T>(key: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const item = await this.get(key);
    if (!item) notFound();
    return schema.parse(item);
  }

  private async query(pk: string, prefix: string) {
    const items: Record<string, unknown>[] = [];
    let last: Record<string, unknown> | undefined;
    do {
      const result = await this.dynamo.send(new QueryCommand({ TableName: this.config.tenantDataTableName, KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true, ...(last ? { ExclusiveStartKey: last } : {}) }));
      items.push(...(result.Items ?? []));
      last = result.LastEvaluatedKey;
    } while (last);
    return items;
  }

  private audit(context: Context, organizationId: string, action: string, target: Record<string, string>, details?: Record<string, unknown>) {
    const occurredAt = new Date().toISOString();
    const eventId = `event_${randomUUID()}`;
    return { Put: { TableName: this.config.auditTableName, Item: { ...auditKeys.organization(organizationId, occurredAt, eventId), eventId, organizationId, occurredAt, action, actorId: context.active.profile.adminId, actorSub: context.active.identity.sub, requestId: context.requestId, target, details }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } };
  }

  private async transact(actions: object[]) {
    try { await this.dynamo.send(new TransactWriteCommand({ TransactItems: actions })); }
    catch (error) { if (error instanceof Error && ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(error.name)) conflict(); throw error; }
  }
}
