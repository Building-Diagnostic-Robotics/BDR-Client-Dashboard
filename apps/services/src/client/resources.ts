import { randomUUID } from "node:crypto";

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  documentVersionSchema,
  inspectionSchema,
  organizationDocumentSchema,
  organizationSchema,
  projectSchema,
  reportSchema,
  reportVersionSchema,
  type DocumentVersion,
  type Inspection,
  type Organization,
  type OrganizationDocument,
  type Project,
  type Report,
  type ReportType,
  type ReportVersion,
} from "@bdr/contracts";
import { auditKeys, ClientVisibilityPolicy, type AuthorizedArtifact, type ClientContext, type ClientVisibilityRepository, type ConsistentRead, type DynamoKey } from "@bdr/domain";

import { DynamoClientAuthStore, type ClientRuntimeConfig } from "../auth/aws-client";

type ResourceConfig = ClientRuntimeConfig & Readonly<{ artifactSignerFunctionName: string }>;

export class DynamoClientVisibilityRepository extends DynamoClientAuthStore implements ClientVisibilityRepository {
  private readonly document = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

  async getProject(key: DynamoKey, _options: ConsistentRead): Promise<Project | null> { return this.read(key, projectSchema); }
  async getInspection(key: DynamoKey, _options: ConsistentRead): Promise<Inspection | null> { return this.read(key, inspectionSchema); }
  async getReport(key: DynamoKey, _options: ConsistentRead): Promise<Report | null> { return this.read(key, reportSchema); }
  async getReportVersion(key: DynamoKey, _options: ConsistentRead): Promise<ReportVersion | null> { return this.read(key, reportVersionSchema); }
  async getOrganizationDocument(key: DynamoKey, _options: ConsistentRead): Promise<OrganizationDocument | null> { return this.read(key, organizationDocumentSchema); }
  async getDocumentVersion(key: DynamoKey, _options: ConsistentRead): Promise<DocumentVersion | null> { return this.read(key, documentVersionSchema); }
  async queryProjects(organizationPk: string, _options: ConsistentRead) { return (await this.query(organizationPk, "PROJECT#")).map((item) => projectSchema.parse(item)); }
  async queryInspections(organizationPk: string, projectId: string, _options: ConsistentRead) { return (await this.query(organizationPk, `INSPECTION#${projectId}#`)).map((item) => inspectionSchema.parse(item)); }
  async queryReports(organizationPk: string, projectId: string, inspectionId: string, _options: ConsistentRead) { return (await this.query(organizationPk, `REPORT#${projectId}#${inspectionId}#`)).map((item) => reportSchema.parse(item)); }

  private async read<T>(key: DynamoKey, schema: { parse(value: unknown): T }): Promise<T | null> {
    const result = await this.document.send(new GetCommand({ TableName: this.config.tenantDataTableName, Key: key, ConsistentRead: true }));
    return result.Item ? schema.parse(result.Item) : null;
  }

  private async query(pk: string, prefix: string) {
    const items: Record<string, unknown>[] = [];
    let last: Record<string, unknown> | undefined;
    do {
      const result = await this.document.send(new QueryCommand({ TableName: this.config.tenantDataTableName, KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true, ...(last ? { ExclusiveStartKey: last } : {}) }));
      items.push(...(result.Items ?? []));
      last = result.LastEvaluatedKey;
    } while (last);
    return items;
  }
}

export class ClientResourceService {
  readonly policy: ClientVisibilityPolicy;
  private readonly lambda = new LambdaClient({});
  private readonly dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

  constructor(private readonly config: ResourceConfig, readonly repository = new DynamoClientVisibilityRepository(config)) {
    this.policy = new ClientVisibilityPolicy(repository);
  }

  async projects(context: ClientContext) { return this.policy.listVisibleProjects(context); }
  async project(context: ClientContext, projectId: string) { return this.policy.loadVisibleProject(context, projectId); }
  async inspections(context: ClientContext, projectId: string) { return this.policy.listVisibleInspections(context, projectId); }
  async inspection(context: ClientContext, projectId: string, inspectionId: string) { return this.policy.loadVisibleInspection(context, projectId, inspectionId); }
  async reports(context: ClientContext, projectId: string, inspectionId: string) { return this.policy.listVisibleReportMetadata(context, projectId, inspectionId); }

  async howToRead(context: ClientContext) {
    const artifact = await this.policy.authorizeCurrentOrganizationDocumentAccess({ context, disposition: "VIEW" });
    return { available: true, filename: artifact.filename };
  }

  async reportAccess(context: ClientContext, projectId: string, inspectionId: string, reportType: ReportType, disposition: "VIEW" | "DOWNLOAD", requestId: string) {
    return this.sign(await this.policy.authorizeCurrentReportAccess({ context, projectId, inspectionId, reportType, disposition }), context, requestId, "REPORT_DOWNLOAD_LINK_ISSUED", { projectId, inspectionId, reportType });
  }

  async documentAccess(context: ClientContext, disposition: "VIEW" | "DOWNLOAD", requestId: string) {
    return this.sign(await this.policy.authorizeCurrentOrganizationDocumentAccess({ context, disposition }), context, requestId, "ORGANIZATION_DOCUMENT_LINK_ISSUED", { documentType: "HOW_TO_READ" });
  }

  private async sign(artifact: AuthorizedArtifact, context: ClientContext, requestId: string, action: string, target: Record<string, string>) {
    const result = await this.lambda.send(new InvokeCommand({ FunctionName: this.config.artifactSignerFunctionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(artifact)) }));
    if (result.FunctionError || !result.Payload) throw new Error("Artifact signer failed");
    const signed: unknown = JSON.parse(Buffer.from(result.Payload).toString("utf8"));
    if (!signed || typeof signed !== "object" || !("url" in signed) || typeof signed.url !== "string") throw new Error("Artifact signer returned an invalid response");
    const occurredAt = new Date().toISOString();
    const eventId = `event_${randomUUID()}`;
    await this.dynamo.send(new PutCommand({ TableName: this.config.auditTableName, Item: { ...auditKeys.organization(context.organization.organizationId, occurredAt, eventId), eventId, organizationId: context.organization.organizationId, occurredAt, action, actorId: context.userId, actorSub: context.sub, requestId, target }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" }));
    return signed;
  }
}
