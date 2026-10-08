import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminGetUserCommand,
  AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, DescribeUserPoolCommand, ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand, DynamoDBDocumentClient, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { clientIdentitySchema, type PortalBuildingDetail, type PortalReportType } from "@bdr/contracts";
import { auditExpiresAt, auditKeys, identityKeys, tenantKeys } from "@bdr/domain";
import { z } from "zod";

import { isMissingS3Object, readJsonObject } from "../portal/json-state";
import {
  hash, REPORT_TYPES, SAMPLE_NAME, sampleDataset, setupManifestSchema,
  type ManifestSnapshot, type OriginalClient, type SampleContext, type SetupClient, type SetupManifest, type SetupPort,
} from "./sample-dashboard";

type RecordValue = Record<string, unknown>;
type Transaction = NonNullable<TransactWriteCommandInput["TransactItems"]>;
export type SetupConfiguration = { context: SampleContext; identityTable: string; sessionTable: string; adminControlTable: string; auditTable: string; adminPool: string; issuer: string };
const record = z.record(z.string(), z.unknown());
const string = (value: unknown) => z.string().min(1).parse(value);
const rows = (value: unknown): RecordValue[] => z.array(record).parse(value ?? []);

function aws(args: string[]): RecordValue {
  // Argument arrays avoid shell interpolation. Discovery never requests user passwords or tokens.
  return record.parse(JSON.parse(execFileSync("aws", [...args, "--output", "json"], {
    encoding: "utf8", env: { ...process.env, AWS_PAGER: "" }, stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  })));
}

export function discoverSampleConfiguration(environment: "development" | "production", region: string): SetupConfiguration {
  const caller = aws(["sts", "get-caller-identity", "--region", region]);
  const accountId = string(caller.Account);
  const stackName = `BdrClientPortal-${environment}`;
  const stack = rows(aws(["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region]).Stacks)[0];
  if (!stack || string(stack.StackId).split(":")[4] !== accountId || string(stack.StackId).split(":")[3] !== region) throw new Error("AWS account/region does not match the selected stack");
  const outputs = Object.fromEntries(rows(stack.Outputs).map((output) => [string(output.OutputKey), string(output.OutputValue)]));
  const resources = rows(aws(["cloudformation", "list-stack-resources", "--stack-name", stackName, "--region", region]).StackResourceSummaries);
  const functionName = string(resources.find((item) => item.ResourceType === "AWS::Lambda::Function" && String(item.LogicalResourceId).startsWith("ClientBffFunction"))?.PhysicalResourceId);
  const lambda = aws(["lambda", "get-function-configuration", "--function-name", functionName, "--region", region]);
  const variables = record.parse(record.parse(lambda.Environment).Variables);
  const config = {
    identityTable: string(variables.IDENTITY_TABLE_NAME), sessionTable: string(variables.SESSION_TABLE_NAME),
    adminControlTable: string(variables.ADMIN_CONTROL_TABLE_NAME), auditTable: string(variables.AUDIT_TABLE_NAME),
    adminPool: string(outputs.AdminUserPoolId), issuer: string(variables.CLIENT_ISSUER),
  };
  const clientPool = string(outputs.ClientUserPoolId);
  const tenantTable = string(variables.TENANT_DATA_TABLE_NAME);
  if (variables.CLIENT_USER_POOL_ID !== clientPool || config.issuer !== `https://cognito-idp.${region}.amazonaws.com/${clientPool}`
    || variables.ADMIN_ISSUER !== `https://cognito-idp.${region}.amazonaws.com/${config.adminPool}`) throw new Error("Stack and BFF Cognito configuration disagree");
  const actualTables = new Set(resources.filter((item) => item.ResourceType === "AWS::DynamoDB::Table").map((item) => item.PhysicalResourceId));
  for (const table of [tenantTable, config.identityTable, config.sessionTable, config.adminControlTable, config.auditTable]) {
    if (!actualTables.has(table) || !table.startsWith(`bdr-portal-${environment}-`)) throw new Error("A configured table does not belong to the selected stack");
  }
  const clientPrefix = environment === "production" ? "bdr_sample_dashboard" : "bdr_sample_dashboard_development";
  return { ...config, context: {
    environment, accountId, region, clientPool, tenantTable, clientPrefix,
    organizationId: `org${hash(clientPrefix)}`.slice(0, 32), bucket: string(variables.DATA_BUCKET_NAME),
    portalOrigin: new URL(string(variables.PORTAL_ORIGIN)).origin, operatorArn: string(caller.Arn),
  } };
}

export class AwsSampleDashboard implements SetupPort {
  readonly context: SampleContext;
  private readonly s3: S3Client;
  private readonly cognito: CognitoIdentityProviderClient;
  private readonly document: DynamoDBDocumentClient;
  private manifest: SetupManifest | null = null;
  private readonly runId = `sample_setup_${randomUUID()}`;
  constructor(private readonly config: SetupConfiguration) {
    this.context = config.context;
    const region = config.context.region;
    this.s3 = new S3Client({ region });
    this.cognito = new CognitoIdentityProviderClient({ region });
    this.document = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    // Existing catalog routines instantiate clients on import: import them only after configuration.
    Object.assign(process.env, {
      AWS_REGION: region, AWS_DEFAULT_REGION: region, DATA_BUCKET_NAME: this.context.bucket,
      TENANT_DATA_TABLE_NAME: this.context.tenantTable, AUDIT_TABLE_NAME: config.auditTable,
      IDENTITY_TABLE_NAME: config.identityTable, CLIENT_USER_POOL_ID: this.context.clientPool,
      CLIENT_ISSUER: config.issuer, ADMIN_ISSUER: `https://cognito-idp.${region}.amazonaws.com/${config.adminPool}`,
    });
  }
  emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
  private get manifestKey(): string { return `${this.context.clientPrefix}/seed-manifest.json`; }
  private userId(email: string): string { return `usr${hash(`${this.context.organizationId}:${email}`)}`.slice(0, 32); }
  private revocationRevision(original: OriginalClient): string { return `rev_${hash(`sample-reset:${original.sub}`).slice(0, 32)}`; }
  private audit(action: string, organizationId: string, target: Record<string, string>): Transaction[number] {
    const occurredAt = new Date().toISOString();
    const eventId = `event_${randomUUID()}`;
    return { Put: { TableName: this.config.auditTable, Item: {
      ...auditKeys.organization(organizationId, occurredAt, eventId), eventId, occurredAt, organizationId,
      ttlExpiresAt: auditExpiresAt(occurredAt), action, actorId: this.context.operatorArn, actorSub: this.context.operatorArn,
      requestId: this.runId, target, details: { operatorArn: this.context.operatorArn, environment: this.context.environment, seedId: "bdr-sample-dashboard-v1" },
    }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } };
  }
  private async get(table: string, key: { PK: string; SK: string }): Promise<RecordValue | null> {
    return (await this.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item ?? null;
  }
  private async scan(table: string, filter: string, values: RecordValue, names: Record<string, string> = {}, projection?: string): Promise<RecordValue[]> {
    const items: RecordValue[] = [];
    let key: RecordValue | undefined;
    do {
      const result = await this.document.send(new ScanCommand({
        TableName: table, ConsistentRead: true, FilterExpression: filter, ExpressionAttributeValues: values,
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ...(projection ? { ProjectionExpression: projection } : {}), ...(key ? { ExclusiveStartKey: key } : {}),
      }));
      items.push(...result.Items ?? []);
      key = result.LastEvaluatedKey;
    } while (key);
    return items;
  }
  async readManifest(): Promise<ManifestSnapshot> {
    const snapshot = await readJsonObject(this.s3, this.context.bucket, this.manifestKey);
    this.manifest = snapshot.eTag ? setupManifestSchema.parse(snapshot.value) : null;
    return { value: this.manifest, eTag: snapshot.eTag };
  }
  async saveManifest(manifest: SetupManifest, expectedETag: string | null): Promise<string> {
    const result = await this.s3.send(new PutObjectCommand({ Bucket: this.context.bucket, Key: this.manifestKey,
      Body: JSON.stringify(setupManifestSchema.parse(manifest)), ContentType: "application/json",
      ...(expectedETag ? { IfMatch: expectedETag } : { IfNoneMatch: "*" }),
    }));
    this.manifest = manifest;
    if (!result.ETag) throw new Error("Setup checkpoint has no ETag; stop and reconcile before retrying");
    return result.ETag;
  }
  async assertVacant(): Promise<void> {
    const objects = await this.s3.send(new ListObjectsV2Command({ Bucket: this.context.bucket, Prefix: `${this.context.clientPrefix}/`, MaxKeys: 1 }));
    const organization = await this.get(this.context.tenantTable, tenantKeys.organization(this.context.organizationId));
    const links = await readJsonObject(this.s3, this.context.bucket, "reportgen_portal/org_links.json");
    const collision = rows(links.value.organizations).some((row) => row.organizationId === this.context.organizationId || row.displayName === SAMPLE_NAME
      || (Array.isArray(row.clientPrefixes) && row.clientPrefixes.some((prefix) => String(prefix).replace(/\/$/, "") === this.context.clientPrefix)));
    if (objects.KeyCount || organization || collision) throw new Error("Reserved sample data already exists without a matching ownership manifest; refusing to adopt it");
  }
  private async poolUser(pool: string, email: string): Promise<{ username: string; sub: string } | null> {
    // Match normalized email across all pages, including disabled users and case variants.
    const matches: Array<{ username: string; sub: string }> = [];
    let token: string | undefined;
    do {
      const response = await this.cognito.send(new ListUsersCommand({ UserPoolId: pool, ...(token ? { PaginationToken: token } : {}) }));
      for (const user of response.Users ?? []) {
        if (user.Attributes?.find((attribute) => attribute.Name === "email")?.Value?.trim().toLowerCase() === email) {
          matches.push({ username: string(user.Username), sub: string(user.Attributes?.find((attribute) => attribute.Name === "sub")?.Value) });
        }
      }
      token = response.PaginationToken;
    } while (token);
    if (matches.length > 1) throw new Error(`Ambiguous Cognito email: ${email}`);
    return matches[0] ?? null;
  }
  private async assertNotAdministrator(email: string): Promise<void> {
    if (await this.poolUser(this.config.adminPool, email)) throw new Error(`Email belongs to an administrator; refusing to reset: ${email}`);
  }
  async inspectClient(email: string): Promise<OriginalClient | null> {
    await this.assertNotAdministrator(email);
    const current = await this.poolUser(this.context.clientPool, email);
    const memberships = await this.scan(this.context.tenantTable, "normalizedEmail = :email OR email = :email", { ":email": email });
    const active = memberships.filter((item) => item.status !== "REVOKED");
    const reservation = await this.get(this.config.identityTable, identityKeys.emailReservation(email));
    if (!current) {
      if (active.length) throw new Error(`Client membership exists without a Cognito account: ${email}`);
      const checkpoint = this.manifest?.clients.find((client) => client.email === email);
      const original = checkpoint?.original;
      if (reservation && !(original && reservation.organizationId === original.organizationId && reservation.userId === original.userId)
        && !(reservation.setupSeedId === "bdr-sample-dashboard-v1" && reservation.organizationId === this.context.organizationId && reservation.userId === this.userId(email))) {
        throw new Error(`Email is reserved by another workflow: ${email}`);
      }
      return null;
    }
    const identity = await this.get(this.config.identityTable, identityKeys.subject(this.config.issuer, current.sub));
    const checkpoint = this.manifest?.clients.find((client) => client.email === email);
    if (!identity && checkpoint?.phase === "created" && checkpoint.sub === current.sub && active.length === 0) {
      if (!reservation || reservation.setupSeedId !== "bdr-sample-dashboard-v1" || reservation.organizationId !== this.context.organizationId || reservation.userId !== this.userId(email)) throw new Error("New client reservation does not belong to this setup");
      return { ...current, issuer: this.config.issuer, organizationId: this.context.organizationId, userId: this.userId(email), revision: "pending", status: "ACTIVE" };
    }
    if (!identity) throw new Error(`Unmapped Cognito account: ${email}; do not delete or resend automatically`);
    const parsed = clientIdentitySchema.parse(identity);
    if (reservation && (reservation.organizationId !== parsed.organizationId || reservation.userId !== parsed.userId || reservation.normalizedEmail !== email)) throw new Error(`Email reservation ownership mismatch: ${email}`);
    const owners = memberships.filter((item) => item.currentSub === current.sub && item.organizationId === parsed.organizationId && item.userId === parsed.userId);
    if (owners.length !== 1 || active.some((item) => item.userId !== parsed.userId || item.organizationId !== parsed.organizationId)) throw new Error(`Ambiguous client membership: ${email}`);
    const membership = owners[0]!;
    if (parsed.issuer !== this.config.issuer || parsed.sub !== current.sub || membership.currentIssuer !== parsed.issuer
      || membership.PK !== `ORG#${parsed.organizationId}` || membership.SK !== `USER#${parsed.userId}` || membership.status !== parsed.status) throw new Error(`Client ownership mismatch: ${email}`);
    return { ...current, issuer: parsed.issuer, organizationId: parsed.organizationId, userId: parsed.userId, revision: string(membership.revision), status: string(membership.status) };
  }
  private async putImmutable(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const digest = hash(bytes);
    try {
      const existing = await this.s3.send(new HeadObjectCommand({ Bucket: this.context.bucket, Key: key }));
      if (existing.Metadata?.["sample-sha256"] !== digest || existing.ContentLength !== bytes.length || existing.ContentType !== contentType) throw new Error(`Sample object was changed: ${key}`);
      return;
    } catch (error) { if (!isMissingS3Object(error)) throw error; }
    await this.s3.send(new PutObjectCommand({ Bucket: this.context.bucket, Key: key, Body: bytes, ContentType: contentType,
      Metadata: { "sample-sha256": digest, "sample-seed": "bdr-sample-dashboard-v1" }, IfNoneMatch: "*",
    }));
  }
  async prepareDataset(manifest: SetupManifest, directory: string, checkpoint: () => Promise<void>): Promise<void> {
    const portal = await import("../portal/buildings");
    const catalog = await import("../portal/catalog");
    const mutation = (action: string) => ({ actorId: this.context.operatorArn, actorSub: this.context.operatorArn, requestId: this.runId, action });
    const dataset = sampleDataset(manifest.createdAt, manifest.clientPrefix);
    for (const building of dataset) for (const inspection of building.inspections) {
      await checkpoint();
      const reports: RecordValue = {};
      for (const type of REPORT_TYPES.filter((type) => type !== "AS_BUILT" && inspection.statuses[type] === "AVAILABLE")) {
        const filename = type === "CAPITAL_PLANNING" ? "capital_plan.pdf" : `${type.toLowerCase()}.pdf`;
        const key = `${inspection.prefix}reportgen/client_portal/versions/sample-v1/${filename}`;
        const bytes = await readFile(resolve(directory, manifest.files[type].filename));
        if (hash(bytes) !== manifest.files[type].sha256) throw new Error("Sample PDF changed during setup");
        await this.putImmutable(key, bytes, "application/pdf");
        reports[type === "CAPITAL_PLANNING" ? "CAPITAL_PLAN" : type] = {
          approvedKey: key, sourceKey: key, generatedAt: inspection.publishedAt, clientApprovedAt: inspection.publishedAt,
          clientVisible: true, stale: false, awaitingClientAdmin: false,
        };
      }
      const objects: Record<string, unknown> = {
        "general_data.json": { displayName: building.name, address: building.address, engineers: [building.engineerNames] },
        "section_1/gnss_session.json": { completion_tag: "complete_sample", collection_start_time: inspection.scannedAt, timezone: "America/New_York" },
        "section_1/_UPLOAD_COMPLETE.json": { completed_at_epoch: Date.parse(inspection.uploadedAt) / 1000 },
        "reportgen/client_portal/status.json": { displayName: building.name, address: building.address, engineers: [building.engineerNames],
          scanTime: inspection.scannedAt, uploadTime: inspection.uploadedAt, timeZone: "America/New_York", released: true, reports },
      };
      for (const [suffix, value] of Object.entries(objects)) await this.putImmutable(`${inspection.prefix}${suffix}`, Buffer.from(JSON.stringify(value)), "application/json");
    }
    await checkpoint();
    const linked = await portal.organizationForClientPrefix(manifest.clientPrefix);
    if (linked) {
      if (linked.organizationId !== manifest.organizationId || linked.displayName !== SAMPLE_NAME) throw new Error("Sample organization link changed");
      const organization = await this.get(this.context.tenantTable, tenantKeys.organization(manifest.organizationId));
      if (!organization) {
        // Resume a link write that succeeded before its corresponding organization write.
        await this.document.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: this.context.tenantTable, Item: { ...tenantKeys.organization(manifest.organizationId), organizationId: manifest.organizationId, displayName: SAMPLE_NAME, status: "ACTIVE" }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
          this.audit("SAMPLE_ORGANIZATION_CREATED", manifest.organizationId, { clientPrefix: manifest.clientPrefix }),
        ] }));
      } else if (organization.status !== "ACTIVE" || organization.displayName !== SAMPLE_NAME) throw new Error("Sample organization metadata changed");
    } else {
      await portal.linkClient({ displayName: SAMPLE_NAME, clientPrefix: manifest.clientPrefix });
      await this.document.send(new TransactWriteCommand({ TransactItems: [this.audit("SAMPLE_ORGANIZATION_CREATED", manifest.organizationId, { clientPrefix: manifest.clientPrefix })] }));
    }
    for (const building of dataset) {
      await checkpoint();
      const first = building.inspections[0]!;
      const buildingId = portal.provisionalPortalBuildingId(first.prefix);
      let detail = await catalog.getPortalCatalogBuilding(manifest.organizationId, buildingId, true);
      if (detail.provisional) detail = await catalog.updatePortalCatalogBuilding(manifest.organizationId, buildingId,
        { displayName: building.name, address: building.address, engineerNames: building.engineerNames, expectedRevision: null }, mutation("SAMPLE_BUILDING_CREATED"), true);
      const claims = await Promise.all(building.inspections.map(async (inspection) => {
        const claim = await this.get(this.context.tenantTable, tenantKeys.portalSource(hash(inspection.prefix.replace(/\/$/, ""))));
        if (claim && (claim.organizationId !== manifest.organizationId || claim.buildingId !== buildingId)) throw new Error("Sample scan is claimed by another building");
        return claim;
      }));
      for (const [index, inspection] of building.inspections.entries()) {
        const inspectionId = portal.provisionalPortalInspectionId(inspection.prefix);
        if (!detail.inspections.some((item) => item.inspectionId === inspectionId)) {
          if (claims[index]) throw new Error("Sample claim exists without its attached inspection");
          detail = await catalog.attachPortalInspection(manifest.organizationId, buildingId,
            { sourceId: portal.portalSourceId(inspection.prefix), includedSectionIds: ["section_1"], expectedRevision: detail.revision }, mutation("SAMPLE_INSPECTION_ATTACHED"));
        }
        const reportStatuses = Object.fromEntries(REPORT_TYPES.map((type) => [type, inspection.statuses[type] === "AVAILABLE" ? "IN_PREPARATION" : inspection.statuses[type]])) as Record<PortalReportType, "IN_PREPARATION" | "NOT_INCLUDED">;
        const current = detail.inspections.find((item) => item.inspectionId === inspectionId)!;
        if (current.reports.some((report) => report.deliveryStatus !== "AVAILABLE" && report.deliveryStatus !== reportStatuses[report.reportType])) {
          detail = await catalog.updatePortalInspectionStatuses(manifest.organizationId, buildingId, inspectionId, reportStatuses, string(detail.revision), mutation("SAMPLE_REPORT_STATUSES_SET"));
        }
        if (inspection.statuses.AS_BUILT === "AVAILABLE") {
          let upload = manifest.asBuilt[inspection.prefix];
          if (!upload) {
            const started = await catalog.startPortalAsBuiltUpload(manifest.organizationId, buildingId, inspectionId,
              { filename: manifest.files.AS_BUILT.filename, contentType: "application/pdf", sizeBytes: manifest.files.AS_BUILT.sizeBytes });
            upload = { uploadId: started.uploadId, key: started.key };
            manifest.asBuilt[inspection.prefix] = upload;
            await checkpoint();
          }
          const bytes = await readFile(resolve(directory, manifest.files.AS_BUILT.filename));
          if (hash(bytes) !== manifest.files.AS_BUILT.sha256) throw new Error("As-built sample changed during setup");
          await this.putImmutable(upload.key, bytes, "application/pdf");
          const stored = await this.get(this.context.tenantTable, tenantKeys.portalBuilding(manifest.organizationId, buildingId));
          const storedInspection = rows(stored?.inspections).find((item) => item.inspectionId === inspectionId);
          if (storedInspection?.asBuilt) {
            if (record.parse(storedInspection.asBuilt).key !== upload.key) throw new Error("The sample As-built was replaced outside setup");
          } else detail = await catalog.publishPortalAsBuilt(manifest.organizationId, buildingId, inspectionId,
            { ...upload, filename: manifest.files.AS_BUILT.filename, contentType: "application/pdf", sizeBytes: bytes.length, expectedRevision: string(detail.revision) }, mutation("SAMPLE_AS_BUILT_PUBLISHED"));
        }
      }
    }
  }
  async verifyDataset(manifest: SetupManifest): Promise<PortalBuildingDetail[]> {
    const portal = await import("../portal/buildings");
    const catalog = await import("../portal/catalog");
    const expected = sampleDataset(manifest.createdAt, manifest.clientPrefix);
    const summaries = await catalog.listPortalCatalogBuildings(manifest.organizationId);
    if (summaries.length !== 3) throw new Error("Sample organization must contain exactly three client-visible buildings");
    const details: PortalBuildingDetail[] = [];
    for (const building of expected) {
      const buildingId = portal.provisionalPortalBuildingId(building.inspections[0]!.prefix);
      const detail = await catalog.getPortalCatalogBuilding(manifest.organizationId, buildingId);
      if (detail.displayName !== building.name || detail.address !== building.address || detail.inspections.length !== building.inspections.length) throw new Error("Sample building metadata/count mismatch");
      for (const inspection of building.inspections) {
        const inspectionId = portal.provisionalPortalInspectionId(inspection.prefix);
        const actual = detail.inspections.find((item) => item.inspectionId === inspectionId);
        if (!actual || actual.reports.length !== 5) throw new Error("Sample inspection is missing");
        for (const type of REPORT_TYPES) {
          if (actual.reports.find((report) => report.reportType === type)?.deliveryStatus !== inspection.statuses[type]) throw new Error(`Sample status mismatch: ${building.name}/${type}`);
          if (inspection.statuses[type] === "AVAILABLE") {
            const artifact = await catalog.resolvePortalArtifact(manifest.organizationId, buildingId, inspectionId, type);
            const object = await this.s3.send(new HeadObjectCommand({ Bucket: manifest.bucket, Key: artifact.key }));
            if (object.Metadata?.["sample-sha256"] !== manifest.files[type].sha256 || object.ContentLength !== manifest.files[type].sizeBytes) throw new Error("Sample artifact content mismatch");
          }
        }
      }
      details.push(detail);
    }
    return details;
  }
  async resetClient(client: SetupClient): Promise<void> {
    await this.assertNotAdministrator(client.email);
    const original = client.original;
    if (!original) {
      if (await this.inspectClient(client.email)) throw new Error("A client appeared after preview; refusing to reset");
      return;
    }
    const current = await this.poolUser(this.context.clientPool, client.email);
    if (current && current.sub !== original.sub) throw new Error("The client subject changed before reset");
    const reservationKey = identityKeys.emailReservation(client.email);
    const reservation = await this.get(this.config.identityTable, reservationKey);
    if (reservation && (reservation.organizationId !== original.organizationId || reservation.userId !== original.userId || reservation.normalizedEmail !== client.email)) throw new Error("Email reservation ownership mismatch");
    if (current) {
      await this.cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.context.clientPool, Username: original.username }));
      await this.cognito.send(new AdminDisableUserCommand({ UserPoolId: this.context.clientPool, Username: original.username }));
    }
    const userKey = tenantKeys.user(original.organizationId, original.userId);
    const subjectKey = identityKeys.subject(original.issuer, original.sub);
    const user = await this.get(this.context.tenantTable, userKey);
    const identity = await this.get(this.config.identityTable, subjectKey);
    const revision = this.revocationRevision(original);
    if (!user || !identity || user.currentIssuer !== original.issuer || identity.issuer !== original.issuer || identity.sub !== original.sub) throw new Error("Client ownership changed before revocation");
    if (user.revision !== revision || user.status !== "REVOKED" || identity.status !== "REVOKED") {
      if (user.revision !== original.revision || user.currentSub !== original.sub || identity.organizationId !== original.organizationId || identity.userId !== original.userId) throw new Error("Client ownership changed before revocation");
      await this.document.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: this.context.tenantTable, Key: userKey, UpdateExpression: "SET #status = :revoked, revision = :next",
          ConditionExpression: "revision = :expected AND currentSub = :sub AND currentIssuer = :issuer", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":revoked": "REVOKED", ":next": revision, ":expected": original.revision, ":sub": original.sub, ":issuer": original.issuer } } },
        { Update: { TableName: this.config.identityTable, Key: subjectKey, UpdateExpression: "SET #status = :revoked",
          ConditionExpression: "organizationId = :org AND userId = :user AND #sub = :sub AND issuer = :issuer", ExpressionAttributeNames: { "#status": "status", "#sub": "sub" },
          ExpressionAttributeValues: { ":revoked": "REVOKED", ":org": original.organizationId, ":user": original.userId, ":sub": original.sub, ":issuer": original.issuer } } },
        this.audit("SAMPLE_CLIENT_ACCESS_REVOKED", original.organizationId, { userId: original.userId, sub: original.sub, email: client.email }),
      ] }));
    }
    // Scan canonical sessions as well as subject pointers so orphaned sessions cannot survive.
    const sessions = await this.scan(this.config.sessionTable, "issuer = :issuer AND #sub = :sub", { ":issuer": original.issuer, ":sub": original.sub }, { "#sub": "sub" }, "PK, SK, issuer, #sub, sessionIdHash, revokedAt");
    let startKey: RecordValue | undefined;
    const pointers: RecordValue[] = [];
    do {
      const page = await this.document.send(new QueryCommand({ TableName: this.config.sessionTable, ConsistentRead: true,
        KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": subjectKey.PK }, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
      pointers.push(...page.Items ?? []); startKey = page.LastEvaluatedKey;
    } while (startKey);
    for (const session of [...sessions, ...pointers]) {
      if (session.revokedAt) continue;
      const canonical = String(session.PK).startsWith("SESSION#");
      if (canonical ? session.issuer !== original.issuer || session.sub !== original.sub : session.PK !== subjectKey.PK) throw new Error("Session ownership mismatch");
      await this.document.send(new UpdateCommand({ TableName: this.config.sessionTable, Key: { PK: string(session.PK), SK: string(session.SK) },
        UpdateExpression: "SET revokedAt = :at", ConditionExpression: canonical ? "issuer = :issuer AND #sub = :sub" : "attribute_exists(PK) AND attribute_exists(SK)",
        ExpressionAttributeValues: { ":at": new Date().toISOString(), ...(canonical ? { ":issuer": original.issuer, ":sub": original.sub } : {}) },
        ...(canonical ? { ExpressionAttributeNames: { "#sub": "sub" } } : {}),
      }));
    }
    const invitations = await this.scan(this.config.adminControlTable, "normalizedEmail = :email AND organizationId = :org", { ":email": client.email, ":org": original.organizationId });
    for (const invitation of invitations.filter((item) => ["PENDING", "EXPIRED", "DELIVERY_FAILED"].includes(String(item.status)))) {
      if (invitation.userId !== original.userId || (invitation.sub && invitation.sub !== original.sub)) throw new Error("Invitation ownership mismatch");
      await this.document.send(new UpdateCommand({ TableName: this.config.adminControlTable, Key: { PK: string(invitation.PK), SK: string(invitation.SK) },
        UpdateExpression: "SET #status = :cancelled, revision = :next", ConditionExpression: "revision = :expected",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":cancelled": "CANCELLED", ":next": randomUUID(), ":expected": string(invitation.revision) },
      }));
    }
    if (current) {
      await this.cognito.send(new AdminDeleteUserCommand({ UserPoolId: this.context.clientPool, Username: original.username }));
      await this.document.send(new TransactWriteCommand({ TransactItems: [this.audit("SAMPLE_CLIENT_ACCOUNT_DELETED", original.organizationId, { email: client.email, sub: original.sub })] }));
    }
    if (reservation) {
      if (reservation.organizationId !== original.organizationId || reservation.userId !== original.userId || reservation.normalizedEmail !== client.email) throw new Error("Email reservation ownership mismatch");
      await this.document.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: this.config.identityTable, Key: reservationKey, ConditionExpression: "organizationId = :org AND userId = :user AND normalizedEmail = :email",
          ExpressionAttributeValues: { ":org": original.organizationId, ":user": original.userId, ":email": client.email } } },
        this.audit("SAMPLE_CLIENT_EMAIL_RELEASED", original.organizationId, { email: client.email, userId: original.userId }),
      ] }));
    }
  }
  async createClient(email: string): Promise<{ username: string; sub: string }> {
    await this.assertNotAdministrator(email);
    if (await this.poolUser(this.context.clientPool, email)) throw new Error("Client creation outcome is uncertain; refusing to adopt an existing Cognito subject");
    const reservationKey = identityKeys.emailReservation(email);
    const reservation = await this.get(this.config.identityTable, reservationKey);
    if (reservation) {
      if (reservation.setupSeedId !== "bdr-sample-dashboard-v1" || reservation.organizationId !== this.context.organizationId || reservation.userId !== this.userId(email)) throw new Error("Email is reserved by another workflow");
    } else await this.document.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.config.identityTable, Item: { ...reservationKey, normalizedEmail: email, organizationId: this.context.organizationId, userId: this.userId(email), setupSeedId: "bdr-sample-dashboard-v1" }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
      this.audit("SAMPLE_CLIENT_INVITATION_STARTED", this.context.organizationId, { email }),
    ] }));
    // Cognito generates and emails the password using the existing pool template. Never log this response.
    const result = await this.cognito.send(new AdminCreateUserCommand({ UserPoolId: this.context.clientPool, Username: email,
      UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }], DesiredDeliveryMediums: ["EMAIL"],
    }));
    return { username: string(result.User?.Username), sub: string(result.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value) };
  }
  async mapClient(client: SetupClient): Promise<void> {
    if (!client.sub || !client.username) throw new Error("New client subject was not checkpointed");
    await this.assertNotAdministrator(client.email);
    const current = await this.poolUser(this.context.clientPool, client.email);
    if (!current || current.sub !== client.sub || current.username !== client.username) throw new Error("New Cognito account changed before mapping");
    const userId = this.userId(client.email);
    const userKey = tenantKeys.user(this.context.organizationId, userId);
    const subjectKey = identityKeys.subject(this.config.issuer, client.sub);
    const existing = await this.get(this.config.identityTable, subjectKey);
    if (existing) {
      await this.verifyClient(client);
      return;
    }
    const identity = clientIdentitySchema.parse({ issuer: this.config.issuer, sub: client.sub, organizationId: this.context.organizationId, userId, status: "ACTIVE", invitationId: null });
    await this.document.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.context.tenantTable, Key: tenantKeys.organization(this.context.organizationId), ConditionExpression: "#status = :active", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "ACTIVE" } } },
      { ConditionCheck: { TableName: this.config.identityTable, Key: identityKeys.emailReservation(client.email), ConditionExpression: "organizationId = :org AND userId = :user AND setupSeedId = :seed", ExpressionAttributeValues: { ":org": this.context.organizationId, ":user": userId, ":seed": "bdr-sample-dashboard-v1" } } },
      { Put: { TableName: this.config.identityTable, Item: { ...subjectKey, ...identity }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
      { Put: { TableName: this.context.tenantTable, Item: { ...userKey, organizationId: this.context.organizationId, userId, email: client.email, normalizedEmail: client.email, status: "ACTIVE",
        currentIssuer: this.config.issuer, currentSub: client.sub, cognitoUsername: client.username, revision: `rev_${randomUUID()}` }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
      this.audit("SAMPLE_CLIENT_INVITED", this.context.organizationId, { email: client.email, userId, sub: client.sub }),
    ] }));
  }
  async verifyClient(client: SetupClient): Promise<void> {
    const current = await this.inspectClient(client.email);
    if (!current || current.sub !== client.sub || current.organizationId !== this.context.organizationId || current.status !== "ACTIVE") throw new Error("Sample client mapping verification failed");
    const user = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.context.clientPool, Username: current.username }));
    if (user.Enabled !== true || !["CONFIRMED", "FORCE_CHANGE_PASSWORD"].includes(user.UserStatus ?? "")) throw new Error("Sample client is not enabled or cannot accept its invitation");
  }
  async verifyInvitationTemplate(): Promise<void> {
    const response = await this.cognito.send(new DescribeUserPoolCommand({ UserPoolId: this.context.clientPool }));
    const template = response.UserPool?.AdminCreateUserConfig?.InviteMessageTemplate;
    if (template?.EmailSubject !== "Your BDR Inspections Dashboard invitation" || !template.EmailMessage?.includes(`${this.context.portalOrigin}/projects`)
      || !template.EmailMessage.includes("{username}") || !template.EmailMessage.includes("{####}")) throw new Error("The deployed invitation template differs from the expected branded template; inspect it before setup");
  }
}
