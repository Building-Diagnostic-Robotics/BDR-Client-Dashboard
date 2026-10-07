import { createHash, randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { conflict, identityKeys, tenantKeys } from "@bdr/domain";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { cognitoUserExists, normalizeLoginEmail } from "../auth/cognito-user-pools";
import { readJsonObject, writeJsonObject, type JsonObjectSnapshot } from "./json-state";
import { artifactContentDisposition } from "./artifact-filenames";

const s3 = new S3Client({});
const LINKS_KEY = "reportgen_portal/org_links.json";

type PortalListMetrics = {
  getObjectCount: number;
  listObjectCount: number;
};

export type PortalBuilding = {
  buildingId: string;
  buildingPrefix: string;
  displayName: string;
  address: string;
  scanTime: string | null;
  uploadTime: string | null;
  timeZone: string | null;
  readyReports: string[];
  awaitingReports: string[];
  roofTakeoffOnly: boolean;
  buildingMark: string | null;
  legacy: boolean;
  mapReady: boolean;
  latestReportUpdate: string | null;
  clientVisible: boolean;
};

export type PortalSourceSection = {
  sectionId: string;
  scannedAt: string | null;
  uploadCompletedAt: string;
  completionTag: string;
  eligible: boolean;
};

export type PortalSourceInspection = {
  sourceId: string;
  prefix: string;
  clientPrefix: string;
  displayName: string;
  address: string;
  engineerNames: string;
  timeZone: string | null;
  sections: PortalSourceSection[];
};

function bucket(): string {
  const name = process.env.DATA_BUCKET_NAME;
  if (!name) throw new Error("Missing DATA_BUCKET_NAME");
  return name;
}

async function readJsonVersion(
  key: string,
  metrics?: PortalListMetrics,
): Promise<JsonObjectSnapshot> {
  if (metrics) metrics.getObjectCount += 1;
  return readJsonObject(s3, bucket(), key);
}

async function readJson(
  key: string,
  metrics?: PortalListMetrics,
): Promise<Record<string, unknown>> {
  return (await readJsonVersion(key, metrics)).value;
}

async function writeJson(
  key: string,
  data: Record<string, unknown>,
  expectedETag: string | null,
): Promise<void> {
  await writeJsonObject(s3, bucket(), key, data, expectedETag);
}

async function listChildren(prefix: string, metrics?: PortalListMetrics): Promise<string[]> {
  if (metrics) metrics.listObjectCount += 1;
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: bucket(),
    ...(prefix ? { Prefix: prefix } : {}),
    Delimiter: "/",
  }));
  return (response.CommonPrefixes ?? [])
    .map((item) => item.Prefix ?? "")
    .filter(Boolean);
}

export const PORTAL_ADMIN_ORGANIZATION_ID = "bdr_portal_admins";

async function assertClientEmailAvailable(
  cognito: CognitoIdentityProviderClient,
  email: string,
): Promise<void> {
  const adminPoolId = process.env.ADMIN_ISSUER?.split("/").pop();
  if (!adminPoolId) throw new Error("missing_configuration");
  if (await cognitoUserExists(cognito, adminPoolId, email)) {
    conflict("This email already belongs to an administrator account");
  }
}

async function assertAdminEmailAvailable(
  cognito: CognitoIdentityProviderClient,
  email: string,
): Promise<void> {
  const clientPoolId = process.env.CLIENT_USER_POOL_ID;
  if (!clientPoolId) throw new Error("missing_configuration");
  if (await cognitoUserExists(cognito, clientPoolId, email)) {
    conflict("This email already belongs to a client account");
  }
}

export async function grantPortalAdmin(organizationId: string): Promise<void> {
  const snapshot = await readJsonVersion(LINKS_KEY);
  const links = snapshot.value;
  const admins = Array.isArray(links.portalAdminOrganizationIds) ? links.portalAdminOrganizationIds : [];
  let changed = false;
  if (!admins.includes(organizationId)) {
    admins.push(organizationId);
    changed = true;
  }
  links.portalAdminOrganizationIds = admins;
  if (!Array.isArray(links.organizations)) {
    links.organizations = [];
    changed = true;
  }
  if (changed) await writeJson(LINKS_KEY, links, snapshot.eTag);
}

export async function isPortalAdmin(organizationId: string): Promise<boolean> {
  const snapshot = await readJsonVersion(LINKS_KEY);
  const links = snapshot.value;
  const admins = Array.isArray(links.portalAdminOrganizationIds) ? links.portalAdminOrganizationIds : [];
  return admins.includes(organizationId);
}

const SKIP_PREFIXES = new Set([
  "Dependencies",
  "Sam3-checkpoint",
  "database_bundle",
  "pdlxgpnr_slim",
  "reportgen",
  "reportgen_portal",
]);

type OrgLink = {
  organizationId?: string;
  displayName?: string;
  clientPrefixes?: string[];
  howToReadKey?: string | null;
  howToReadHistory?: string[];
};

function folderOf(clientPrefix: string): string {
  return clientPrefix.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
}

function organizationIdFor(folder: string): string {
  return `org${createHash("sha256").update(folder).digest("hex")}`.slice(0, 32);
}

export function portalSourceId(prefix: string): string {
  return `src_${createHash("sha256").update(prefix.replace(/^\/+|\/+$/g, "")).digest("hex").slice(0, 24)}`;
}

export function provisionalPortalBuildingId(prefix: string): string {
  return `pbl_${createHash("sha256").update(prefix.replace(/^\/+|\/+$/g, "")).digest("hex").slice(0, 24)}`;
}

export function provisionalPortalInspectionId(prefix: string): string {
  return `pin_${createHash("sha256").update(`inspection:${prefix.replace(/^\/+|\/+$/g, "")}`).digest("hex").slice(0, 24)}`;
}

function orgRows(links: Record<string, unknown>): OrgLink[] {
  return Array.isArray(links.organizations) ? links.organizations as OrgLink[] : [];
}

function orgForFolder(rows: OrgLink[], folder: string): OrgLink | undefined {
  return rows.find((row) => (row.clientPrefixes ?? []).some((item) => item.replace(/\/$/, "") === folder));
}

export async function organizationForClientPrefix(clientPrefix: string): Promise<{ organizationId: string; displayName: string } | null> {
  const folder = folderOf(clientPrefix);
  const org = orgForFolder(orgRows(await readJson(LINKS_KEY)), folder);
  if (!org) return null;
  return {
    organizationId: String(org.organizationId || organizationIdFor(folder)),
    displayName: String(org.displayName || folder),
  };
}

export async function linkedPrefixesForOrganization(organizationId: string): Promise<string[]> {
  return prefixesFor(organizationId, false);
}

export async function listLinkedClients(): Promise<Array<{ clientPrefix: string; displayName: string; organizationId: string; buildings: number }>> {
  const snapshot = await readJsonVersion(LINKS_KEY);
  const links = snapshot.value;
  const rows = [];
  for (const org of orgRows(links)) {
    const prefixes = (org.clientPrefixes ?? []).map((item) => item.replace(/\/$/, "")).filter(Boolean);
    for (const [index, clientPrefix] of prefixes.entries()) {
      const buildings = await buildingsUnder(clientPrefix);
      const sharedName = index === 0 ? String(org.displayName || clientPrefix) : clientPrefix;
      rows.push({
        clientPrefix,
        displayName: sharedName,
        organizationId: String(org.organizationId || organizationIdFor(clientPrefix)),
        buildings: buildings.length,
      });
    }
  }
  return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listUnlinkedFolders(): Promise<string[]> {
  const links = await readJson(LINKS_KEY);
  const linked = new Set(orgRows(links).flatMap((org) => (org.clientPrefixes ?? []).map((item) => item.replace(/\/$/, ""))));
  const names = [];
  for (const name of await allClientPrefixes()) {
    if (linked.has(name)) continue;
    if ((await buildingsUnder(name)).length === 0) continue;
    names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function linkClient(input: { displayName: string; clientPrefix: string }): Promise<{ organizationId: string; displayName: string; clientPrefix: string }> {
  const clientPrefix = folderOf(input.clientPrefix);
  const displayName = input.displayName.trim();
  if (!displayName || !clientPrefix || SKIP_PREFIXES.has(clientPrefix)) throw new Error("invalid_request");
  if ((await buildingsUnder(clientPrefix)).length === 0) throw new Error("invalid_request");
  const snapshot = await readJsonVersion(LINKS_KEY);
  const links = snapshot.value;
  const current = orgRows(links);
  if (orgForFolder(current, clientPrefix)) throw new Error("already_linked");
  const organizationId = organizationIdFor(clientPrefix);
  current.push({ organizationId, displayName, clientPrefixes: [clientPrefix], howToReadHistory: [] });
  links.organizations = current;
  await writeJson(LINKS_KEY, links, snapshot.eTag);
  const tenantTable = process.env.TENANT_DATA_TABLE_NAME;
  if (tenantTable) {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    await dynamo.send(new PutCommand({
      TableName: tenantTable,
      Item: { ...tenantKeys.organization(organizationId), organizationId, displayName, status: "ACTIVE" },
    }));
  }
  return { organizationId, displayName, clientPrefix };
}

export async function renameClient(clientPrefix: string, displayName: string): Promise<void> {
  const folder = folderOf(clientPrefix);
  const name = displayName.trim();
  if (!folder || !name) throw new Error("invalid_request");
  const snapshot = await readJsonVersion(LINKS_KEY);
  const links = snapshot.value;
  const current = orgRows(links);
  const org = orgForFolder(current, folder);
  if (!org) throw new Error("not_found");
  org.displayName = name;
  org.organizationId = organizationIdFor(folder);
  links.organizations = current;
  await writeJson(LINKS_KEY, links, snapshot.eTag);
  const table = process.env.TENANT_DATA_TABLE_NAME;
  if (!table) return;
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await dynamo.send(new PutCommand({
    TableName: table,
    Item: { ...tenantKeys.organization(org.organizationId), organizationId: org.organizationId, displayName: name, status: "ACTIVE" },
  }));
}

async function allClientPrefixes(metrics?: PortalListMetrics): Promise<string[]> {
  const children = await listChildren("", metrics);
  return children
    .map((prefix) => prefix.replace(/\/$/, ""))
    .filter((name) => name && !SKIP_PREFIXES.has(name));
}

export async function ownsPrefix(organizationId: string | null, admin: boolean, prefix: string): Promise<boolean> {
  if (admin) return true;
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  const roots = await prefixesFor(organizationId, false);
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export async function createPortalAdmin(
  emailInput: string,
  cognito = new CognitoIdentityProviderClient({}),
): Promise<{ email: string }> {
  const email = normalizeLoginEmail(emailInput);
  if (!email.includes("@")) throw new Error("invalid_request");
  const poolId = process.env.ADMIN_ISSUER?.split("/").pop();
  if (!poolId) throw new Error("missing_configuration");
  await assertAdminEmailAvailable(cognito, email);
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "UsernameExistsException") throw error;
  }
  await cognito.send(new AdminAddUserToGroupCommand({
    UserPoolId: poolId,
    Username: email,
    GroupName: "bdr-admins",
  }));
  return { email };
}

export async function createClientAccount(
  input: { email: string; clientPrefix: string },
  cognito = new CognitoIdentityProviderClient({}),
): Promise<{ email: string; organizationId: string }> {
  const email = normalizeLoginEmail(input.email);
  const clientPrefix = input.clientPrefix.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  if (!email.includes("@") || !clientPrefix || SKIP_PREFIXES.has(clientPrefix)) throw new Error("invalid_request");
  const poolId = process.env.CLIENT_USER_POOL_ID;
  const issuer = process.env.CLIENT_ISSUER;
  const identityTable = process.env.IDENTITY_TABLE_NAME;
  const tenantTable = process.env.TENANT_DATA_TABLE_NAME;
  if (!poolId || !issuer || !identityTable || !tenantTable) throw new Error("missing_configuration");
  await assertClientEmailAvailable(cognito, email);
  let sub: string | undefined;
  let username = email;
  try {
    const created = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    }));
    sub = created.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
    username = created.User?.Username ?? email;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "UsernameExistsException") throw error;
    const existing = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
    sub = existing.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value;
    username = existing.Username ?? email;
    if (existing.Enabled === false) {
      await cognito.send(new AdminEnableUserCommand({ UserPoolId: poolId, Username: username }));
    }
  }
  if (!sub) throw new Error("missing_subject");
  const snapshot = await readJsonVersion(LINKS_KEY);
  const links = snapshot.value;
  const current = orgRows(links);
  const existing = orgForFolder(current, clientPrefix);
  if (!existing) throw new Error("not_linked");
  const organizationId = organizationIdFor(clientPrefix);
  const displayName = String(existing.displayName || clientPrefix);
  const userId = `usr${createHash("sha256").update(`${organizationId}:${email}`).digest("hex")}`.slice(0, 32);
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const identity = {
    issuer,
    sub,
    userId,
    organizationId,
    status: "ACTIVE" as const,
    invitationId: null,
  };
  await dynamo.send(new PutCommand({
    TableName: tenantTable,
    Item: {
      ...tenantKeys.organization(organizationId),
      organizationId,
      displayName,
      status: "ACTIVE",
    },
  }));
  await dynamo.send(new PutCommand({
    TableName: tenantTable,
    Item: {
      ...tenantKeys.user(organizationId, userId),
      organizationId,
      userId,
      email,
      normalizedEmail: email,
      status: "ACTIVE",
      currentIssuer: issuer,
      currentSub: sub,
      cognitoUsername: username,
      revision: randomUUID(),
    },
  }));
  await dynamo.send(new PutCommand({
    TableName: identityTable,
    Item: { ...identityKeys.subject(issuer, sub), ...identity },
  }));
  existing.organizationId = organizationId;
  existing.displayName = displayName;
  existing.clientPrefixes = [clientPrefix];
  links.organizations = current;
  await writeJson(LINKS_KEY, links, snapshot.eTag);
  return { email, organizationId };
}

export async function listClientUsers(clientPrefix: string): Promise<Array<{ email: string; status: string; userId: string }>> {
  const organizationId = `org${createHash("sha256").update(clientPrefix.replace(/\/$/, "").split("/")[0] || "").digest("hex")}`.slice(0, 32);
  const table = process.env.TENANT_DATA_TABLE_NAME;
  if (!table) return [];
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const page = await dynamo.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :user)",
    ExpressionAttributeValues: { ":pk": `ORG#${organizationId}`, ":user": "USER#" },
  }));
  const poolId = process.env.CLIENT_USER_POOL_ID;
  const cognito = poolId ? new CognitoIdentityProviderClient({}) : null;
  const users = [];
  for (const item of page.Items ?? []) {
    let status = String(item.status || "");
    const email = String(item.email || "");
    if (status !== "REVOKED" && cognito && poolId && email) {
      try {
        const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
        status = clientUserStatus(status, user);
      } catch {
        status = status || "ACTIVE";
      }
    }
    users.push({ email, status, userId: String(item.userId || "") });
  }
  return users;
}

export function clientUserStatus(
  storedStatus: string,
  cognitoUser: { Enabled?: boolean | undefined; UserStatus?: string | undefined },
): string {
  if (storedStatus === "REVOKED" || cognitoUser.Enabled === false) return "REVOKED";
  return cognitoUser.UserStatus === "FORCE_CHANGE_PASSWORD" ? "INVITED" : "ACTIVE";
}

export async function resendClientInvite(
  clientPrefix: string,
  email: string,
  cognito = new CognitoIdentityProviderClient({}),
): Promise<void> {
  const match = (await listClientUsers(clientPrefix)).find((user) => user.email.toLowerCase() === email.trim().toLowerCase());
  if (!match || match.status !== "INVITED") throw new Error("invalid_request");
  const poolId = process.env.CLIENT_USER_POOL_ID;
  if (!poolId) throw new Error("missing_configuration");
  const normalizedEmail = normalizeLoginEmail(email);
  await assertClientEmailAvailable(cognito, normalizedEmail);
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: poolId,
    Username: normalizedEmail,
    MessageAction: "RESEND",
    DesiredDeliveryMediums: ["EMAIL"],
  }));
}

export async function replaceClientEmail(
  clientPrefix: string,
  email: string,
  nextEmail: string,
  cognito = new CognitoIdentityProviderClient({}),
): Promise<void> {
  await assertClientEmailAvailable(cognito, normalizeLoginEmail(nextEmail));
  await revokeClientUser(clientPrefix, email);
  await createClientAccount({ email: nextEmail, clientPrefix }, cognito);
}

export async function howToReadFor(clientPrefix: string): Promise<{ published: boolean; history: number }> {
  const org = orgForFolder(orgRows(await readJson(LINKS_KEY)), folderOf(clientPrefix));
  return { published: Boolean(org?.howToReadKey), history: org?.howToReadHistory?.length ?? 0 };
}

export async function howToReadUpload(clientPrefix: string): Promise<{ url: string; key: string }> {
  const folder = folderOf(clientPrefix);
  if (!orgForFolder(orgRows(await readJson(LINKS_KEY)), folder)) throw new Error("not_found");
  const key = `reportgen_portal/how_to_read/${folder}/${randomUUID()}.pdf`;
  return { url: await signedUpload(key, "application/pdf"), key };
}

export async function commitHowToRead(clientPrefix: string, key: string): Promise<void> {
  const folder = folderOf(clientPrefix);
  if (!key.startsWith(`reportgen_portal/how_to_read/${folder}/`) || !key.endsWith(".pdf")) throw new Error("invalid_request");
  const snapshot = await readJsonVersion(LINKS_KEY);
  const links = snapshot.value;
  const current = orgRows(links);
  const org = orgForFolder(current, folder);
  if (!org) throw new Error("not_found");
  const history = Array.isArray(org.howToReadHistory) ? org.howToReadHistory : [];
  if (org.howToReadKey) history.push(org.howToReadKey);
  org.howToReadKey = key;
  org.howToReadHistory = history.slice(-20);
  links.organizations = current;
  await writeJson(LINKS_KEY, links, snapshot.eTag);
}

export async function currentHowToReadForOrg(
  organizationId: string,
): Promise<{ key: string; updatedAt: string } | null> {
  const links = await readJson(LINKS_KEY);
  const rows = orgRows(links);
  const org = rows.find(
    (row) => row.organizationId === organizationId || (row.clientPrefixes ?? []).some((p) => organizationIdFor(folderOf(p)) === organizationId),
  );
  if (!org || !org.howToReadKey) return null;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: org.howToReadKey }));
    return {
      key: org.howToReadKey,
      updatedAt: head.LastModified?.toISOString() ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function revokeClientUser(clientPrefix: string, email: string): Promise<void> {
  const users = await listClientUsers(clientPrefix);
  const match = users.find((user) => user.email.toLowerCase() === email.trim().toLowerCase());
  if (!match) throw new Error("not_found");
  const poolId = process.env.CLIENT_USER_POOL_ID;
  const table = process.env.TENANT_DATA_TABLE_NAME;
  if (!poolId || !table) throw new Error("missing_configuration");
  const organizationId = `org${createHash("sha256").update(clientPrefix.replace(/\/$/, "").split("/")[0] || "").digest("hex")}`.slice(0, 32);
  await new CognitoIdentityProviderClient({}).send(new AdminDisableUserCommand({
    UserPoolId: poolId,
    Username: email.trim().toLowerCase(),
  }));
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await dynamo.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `ORG#${organizationId}`, SK: `USER#${match.userId}` },
    UpdateExpression: "SET #status = :revoked",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":revoked": "REVOKED" },
  }));
}

export async function prefixesFor(
  organizationId: string | null,
  admin: boolean,
  metrics?: PortalListMetrics,
): Promise<string[]> {
  if (admin) return allClientPrefixes(metrics);
  const links = await readJson(LINKS_KEY, metrics);
  const orgs = Array.isArray(links.organizations) ? links.organizations : [];
  const prefixes: string[] = [];
  for (const org of orgs) {
    if (!org || typeof org !== "object") continue;
    const row = org as { organizationId?: string; clientPrefixes?: string[] };
    if (row.organizationId !== organizationId) continue;
    for (const prefix of row.clientPrefixes ?? []) prefixes.push(prefix.replace(/\/$/, ""));
  }
  return prefixes;
}

async function buildingsUnder(clientPrefix: string, metrics?: PortalListMetrics): Promise<string[]> {
  const found: string[] = [];
  const robots = await listChildren(`${clientPrefix}/`, metrics);
  for (const robot of robots) {
    const dates = await listChildren(robot, metrics);
    for (const date of dates) {
      const buildings = await listChildren(date, metrics);
      found.push(...buildings.filter((prefix) => prefix.replace(/\/$/, "").split("/").length === 4));
    }
  }
  return found;
}

function normalizeEngineerNames(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).map((name) => name.trim()).filter(Boolean).join(", ");
  return typeof value === "string" ? value.trim() : "";
}

function epochIso(value: unknown): string | null {
  const epoch = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const date = new Date(epoch * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validTimeZone(value: unknown): string | null {
  const timeZone = nonEmptyString(value);
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return null;
  }
}

export function normalizePortalTimestamp(value: unknown, timeZone: string | null): string | null {
  if (typeof value === "number") return epochIso(value);
  const raw = nonEmptyString(value);
  if (!raw) return null;
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    const absolute = new Date(raw);
    return Number.isNaN(absolute.getTime()) ? null : absolute.toISOString();
  }

  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(raw);
  if (!local) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const wallClock = Date.UTC(
    Number(local[1]),
    Number(local[2]) - 1,
    Number(local[3]),
    Number(local[4]),
    Number(local[5]),
    Number(local[6]),
  );
  const milliseconds = Number((local[7] ?? "").slice(0, 3).padEnd(3, "0"));
  let instant = wallClock;
  if (timeZone) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const parts = Object.fromEntries(
          formatter.formatToParts(new Date(instant))
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value]),
        );
        const representedWallClock = Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1,
          Number(parts.day),
          Number(parts.hour),
          Number(parts.minute),
          Number(parts.second),
        );
        const correction = wallClock - representedWallClock;
        instant += correction;
        if (correction === 0) break;
      }
    } catch {
      instant = wallClock;
    }
  }
  const parsed = new Date(instant + milliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function inspectPortalSource(prefixInput: string): Promise<PortalSourceInspection> {
  const prefix = `${prefixInput.replace(/^\/+|\/+$/g, "")}/`;
  const parts = prefix.replace(/\/$/, "").split("/");
  if (parts.length !== 4) throw new Error("invalid_request");
  const [status, general, children] = await Promise.all([
    readJson(`${prefix}reportgen/client_portal/status.json`),
    readJson(`${prefix}general_data.json`),
    listChildren(prefix),
  ]);
  const identity = mergePortalListMetadata(status, general);
  const sections: PortalSourceSection[] = [];
  let timeZone: string | null = validTimeZone(status.timeZone);
  for (const child of children) {
    const sectionId = child.replace(prefix, "").replace(/\/$/, "");
    if (!/^section_/i.test(sectionId)) continue;
    const [metadata, upload] = await Promise.all([
      readFirst([`${child}gnss_session.json`, `${child}session_config.json`]),
      readJson(`${child}_UPLOAD_COMPLETE.json`),
    ]);
    const uploadCompletedAt = epochIso(upload.completed_at_epoch);
    if (!uploadCompletedAt) continue;
    const completionTag = nonEmptyString(metadata.completion_tag) ?? "unknown";
    const scannedAt = nonEmptyString(metadata.collection_start_time)
      ?? nonEmptyString(metadata.driver_boot_time);
    if (!timeZone) {
      timeZone = validTimeZone(metadata.timezone)
        ?? validTimeZone(metadata.timeZone)
        ?? validTimeZone(metadata.iana_timezone);
    }
    sections.push({
      sectionId,
      scannedAt,
      uploadCompletedAt,
      completionTag,
      eligible: /^complete(?:_|$)/i.test(completionTag),
    });
  }
  sections.sort((left, right) => left.sectionId.localeCompare(right.sectionId));
  return {
    sourceId: portalSourceId(prefix),
    prefix,
    clientPrefix: parts[0]!,
    displayName: String(identity.displayName || parts[3] || "Building"),
    address: String(identity.address || ""),
    engineerNames: normalizeEngineerNames(status.engineers ?? general.engineers),
    timeZone,
    sections: sections.map((section) => ({
      ...section,
      scannedAt: normalizePortalTimestamp(section.scannedAt, timeZone),
    })),
  };
}

export async function discoverPortalSources(clientPrefix: string): Promise<PortalSourceInspection[]> {
  const folder = folderOf(clientPrefix);
  if (!folder || !(await organizationForClientPrefix(folder))) throw new Error("not_found");
  const prefixes = await buildingsUnder(folder);
  const inspected = await Promise.all(prefixes.map((prefix) => inspectPortalSource(prefix)));
  return inspected
    .filter((source) => source.sections.length > 0)
    .sort((left, right) => {
      const leftTime = left.sections.reduce((max, section) => Math.max(max, Date.parse(section.uploadCompletedAt)), 0);
      const rightTime = right.sections.reduce((max, section) => Math.max(max, Date.parse(section.uploadCompletedAt)), 0);
      return rightTime - leftTime;
    });
}

export function reportFileMatches(reportType: string, key: string): boolean {
  const name = (key.split("/").pop() || "").toLowerCase().replace(/[_\s-]/g, "");
  if (!name || name.includes("howtoread") || name.includes("compressed")) return false;
  return name.includes(reportType.toLowerCase().replace(/_/g, ""));
}

async function generatedAt(report: Record<string, unknown>): Promise<string | null> {
  const existing = report.reportgenApprovedAt || report.generatedAt || report.clientApprovedAt || report.at;
  if (existing) return String(existing);
  const key = String(report.approvedKey || report.key || "");
  if (!key) return null;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return head.LastModified?.toISOString() ?? null;
  } catch {
    return null;
  }
}

async function findAsBuilt(root: string): Promise<string | null> {
  for (const ext of ["png", "jpg", "jpeg", "webp", "tif", "tiff"]) {
    const key = `${root}reportgen/takeoff/asbuilt.${ext}`;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
      return key;
    } catch {
      continue;
    }
  }
  return null;
}

async function readFirst(
  keys: string[],
  metrics?: PortalListMetrics,
): Promise<Record<string, unknown>> {
  for (const key of keys) {
    const data = await readJson(key, metrics);
    if (Object.keys(data).length > 0) return data;
  }
  return {};
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

export function mergePortalListMetadata(
  status: Record<string, unknown>,
  general: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...status };
  if (!nonEmptyString(merged.displayName)) {
    const displayName = nonEmptyString(general.displayName)
      ?? nonEmptyString(general.display_name)
      ?? nonEmptyString(general.building_name)
      ?? nonEmptyString(general.name);
    if (displayName) merged.displayName = displayName;
    else delete merged.displayName;
  }
  if (!nonEmptyString(merged.address)) {
    const address = nonEmptyString(general.address) ?? nonEmptyString(general.location);
    merged.address = address ?? "";
  }
  return merged;
}

async function portalListStatus(
  prefix: string,
  status: Record<string, unknown>,
  metrics: PortalListMetrics,
): Promise<Record<string, unknown>> {
  let result = status;
  if (!nonEmptyString(status.displayName) || !nonEmptyString(status.address)) {
    const general = await readJson(`${prefix.replace(/\/?$/, "/")}general_data.json`, metrics);
    result = mergePortalListMetadata(status, general);
  }

  if (nonEmptyString(result.scanTime) || Boolean(result.roofTakeoffOnly)) return result;

  const root = prefix.replace(/\/?$/, "/");
  const sectionPrefixes = (await listChildren(root, metrics)).filter((child) => {
    const name = child.replace(root, "").replace(/\/$/, "");
    return Boolean(name) && name !== "reportgen" && /section/i.test(name);
  });
  const sectionMetadata = await Promise.all(sectionPrefixes.map((child) => readFirst([
    `${child}gnss_session.json`,
    `${child}session_config.json`,
  ], metrics)));

  let earliestScan: string | null = null;
  for (const metadata of sectionMetadata) {
    const scanTime = nonEmptyString(metadata.collection_start_time)
      ?? nonEmptyString(metadata.driver_boot_time);
    if (scanTime && (!earliestScan || scanTime < earliestScan)) earliestScan = scanTime;
    if (!nonEmptyString(result.timeZone)) {
      const timeZone = nonEmptyString(metadata.timezone)
        ?? nonEmptyString(metadata.timeZone)
        ?? nonEmptyString(metadata.iana_timezone);
      if (timeZone) result = { ...result, timeZone };
    }
  }
  return earliestScan ? { ...result, scanTime: earliestScan } : result;
}

export async function enrichPortalStatus(prefix: string, status: Record<string, unknown>): Promise<Record<string, unknown>> {
  const root = prefix.replace(/\/?$/, "/");
  const takeoffOnly = Boolean(status.roofTakeoffOnly) || root.split("/").includes("roof_takeoff");
  const children = await listChildren(root);
  const sections: Array<Record<string, unknown>> = [];
  let earliestScan: string | null = null;
  let earliestUpload: string | null = null;
  const marks = status.marks && typeof status.marks === "object" ? status.marks as Record<string, string> : {};
  for (const child of children) {
    const name = child.replace(root, "").replace(/\/$/, "");
    if (!name || name === "reportgen" || !/section/i.test(name)) continue;
    const gnss = await readFirst([
      `${child}gnss_session.json`,
      `${child}session_config.json`,
    ]);
    const scanTime = String(gnss.collection_start_time || gnss.driver_boot_time || "") || null;
    const manifest = await readJson(`${child}manifest.json`);
    const uploadTime = String(manifest.uploadedAt || manifest.uploadTime || manifest.completedAt || "") || null;
    if (scanTime && (!earliestScan || scanTime < earliestScan)) earliestScan = scanTime;
    if (uploadTime && (!earliestUpload || uploadTime < earliestUpload)) earliestUpload = uploadTime;
    const zone = gnss.timezone || gnss.timeZone || gnss.iana_timezone;
    if (zone && !status.timeZone) status.timeZone = String(zone);
    sections.push({ sectionId: name, scanTime, uploadTime, mark: marks[name] || null });
  }
  if (!takeoffOnly) {
    if (!status.scanTime && earliestScan) status.scanTime = earliestScan;
    if (!status.uploadTime && earliestUpload) status.uploadTime = earliestUpload;
  } else if (!status.uploadTime) {
    const asbuilt = await readJson(`${root}reportgen/takeoff/asbuilt.json`);
    status.uploadTime = String(asbuilt.uploadedAt || status.asBuiltUploadedAt || "") || null;
    status.scanTime = null;
  }
  const reports = status.reports && typeof status.reports === "object"
    ? status.reports as Record<string, Record<string, unknown>>
    : {};
  for (const report of Object.values(reports)) {
    report.generatedAt = await generatedAt(report);
  }
  if (Array.isArray(status.history)) {
    for (const item of status.history) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      row.generatedAt = await generatedAt(row);
    }
  }
  status.sections = sections;
  status.asBuiltKey = await findAsBuilt(root);
  if (!status.displayName) {
    const id = root.replace(/\/$/, "").split("/").pop() || "";
    status.displayName = id.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  const reportsForCheck = status.reports && typeof status.reports === "object"
    ? status.reports as Record<string, Record<string, unknown>>
    : {};
  for (const [reportType, report] of Object.entries(reportsForCheck)) {
    const source = String(report.sourceKey || report.approvedKey || "");
    if (source && !reportFileMatches(reportType, source)) {
      report.awaitingClientAdmin = false;
      report.clientVisible = false;
      report.approvedKey = null;
      report.generatedAt = null;
    }
  }
  status.roofTakeoffOnly = takeoffOnly;
  delete status.operatorError;
  return status;
}

export function summary(prefix: string, status: Record<string, unknown>): PortalBuilding {
  const timeZone = validTimeZone(status.timeZone);
  const reports = status.reports && typeof status.reports === "object"
    ? status.reports as Record<string, {
        clientVisible?: boolean;
        stale?: boolean;
        awaitingClientAdmin?: boolean;
        generatedAt?: string | null;
        reportgenApprovedAt?: string | null;
        clientApprovedAt?: string | null;
        approvedAt?: string | null;
        at?: string | null;
      }>
    : {};
  const ready = Object.entries(reports)
    .filter(([, report]) => report?.clientVisible)
    .map(([name]) => name);
  const awaiting = Object.entries(reports)
    .filter(([, report]) => report?.awaitingClientAdmin && !report.stale && !report.clientVisible)
    .map(([name]) => name);

  let newestTimestamp: string | null = null;
  let newestMs = -Infinity;
  for (const [, report] of Object.entries(reports)) {
    if (!report?.clientVisible) continue;
    const ts = report.generatedAt || report.reportgenApprovedAt || report.clientApprovedAt || report.approvedAt || report.at;
    if (ts) {
      const ms = new Date(ts).getTime();
      if (!Number.isNaN(ms) && ms > newestMs) {
        newestMs = ms;
        newestTimestamp = new Date(ms).toISOString();
      }
    }
  }

  const parts = prefix.replace(/\/$/, "").split("/");
  return {
    buildingId: provisionalPortalBuildingId(prefix),
    buildingPrefix: prefix,
    displayName: String(status.displayName || parts[parts.length - 1] || prefix),
    address: String(status.address || ""),
    scanTime: normalizePortalTimestamp(status.scanTime, timeZone),
    uploadTime: normalizePortalTimestamp(status.uploadTime, timeZone),
    timeZone,
    readyReports: ready,
    awaitingReports: awaiting,
    roofTakeoffOnly: Boolean(status.roofTakeoffOnly),
    buildingMark: status.buildingMark ? String(status.buildingMark) : null,
    legacy: Boolean(status.legacyVisible),
    mapReady: Boolean(status.mapReady) && ready.some((name) => name === "ASSESSMENT" || name === "EVIDENCE"),
    latestReportUpdate: newestTimestamp,
    clientVisible: clientCanSee(status, null, false),
  };
}

export async function listPortalBuildings(
  organizationId: string | null,
  admin: boolean,
  clientPrefixesOverride?: readonly string[],
): Promise<PortalBuilding[]> {
  const startedAt = Date.now();
  const metrics: PortalListMetrics = { getObjectCount: 0, listObjectCount: 0 };
  let clientPrefixCount = 0;
  let discoveredBuildingCount = 0;
  let returnedBuildingCount = 0;
  let outcome = "success";
  try {
    const clientPrefixes = clientPrefixesOverride
      ? [...clientPrefixesOverride]
      : await prefixesFor(organizationId, admin, metrics);
    clientPrefixCount = clientPrefixes.length;
    const prefixes = (await Promise.all(
      clientPrefixes.map((clientPrefix) => buildingsUnder(clientPrefix, metrics)),
    )).flat();
    discoveredBuildingCount = prefixes.length;
    const rows = await Promise.all(prefixes.map(async (prefix) => {
      const status = await readJson(`${prefix}reportgen/client_portal/status.json`, metrics);
      if (Object.keys(status).length === 0) return null;
      if (!clientCanSee(status, organizationId, admin)) return null;
      return summary(prefix, await portalListStatus(prefix, status, metrics));
    }));
    const visible = rows.filter((row): row is PortalBuilding => row !== null);
    returnedBuildingCount = visible.length;
    return visible;
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    console.info(JSON.stringify({
      event: "portal_buildings_list",
      outcome,
      admin,
      durationMs: Date.now() - startedAt,
      clientPrefixCount,
      discoveredBuildingCount,
      returnedBuildingCount,
      s3GetObjectCount: metrics.getObjectCount,
      s3ListObjectCount: metrics.listObjectCount,
    }));
  }
}

export async function loadPortalStatus(prefix: string): Promise<Record<string, unknown>> {
  return (await loadPortalStatusVersion(prefix)).status;
}

// Artifact access needs current publication state, not operational page enrichment.
export async function loadPortalReportStatus(prefix: string): Promise<Record<string, unknown>> {
  return readJson(`${prefix.replace(/\/?$/, "/")}reportgen/client_portal/status.json`);
}

export async function resolvePortalArtifactSource(
  organizationId: string,
  buildingId: string,
): Promise<{ prefix: string; displayName: string; status: Record<string, unknown> }> {
  const linked = await linkedPrefixesForOrganization(organizationId);
  const prefixes = (await Promise.all(linked.map((prefix) => buildingsUnder(prefix)))).flat();
  const matches = [...new Set(prefixes)].filter((prefix) => provisionalPortalBuildingId(prefix) === buildingId);
  if (matches.length !== 1) throw new Error("not_found");
  const prefix = matches[0]!;
  const status = await loadPortalReportStatus(prefix);
  if (!clientCanSee(status, organizationId, false)) throw new Error("not_found");
  const identity = mergePortalListMetadata(status, await readJson(`${prefix}general_data.json`));
  return { prefix, displayName: String(identity.displayName || prefix.replace(/\/$/, "").split("/").pop() || "Building"), status };
}

export type PortalStatusSnapshot = {
  status: Record<string, unknown>;
  eTag: string | null;
};

export async function loadPortalStatusVersion(prefix: string): Promise<PortalStatusSnapshot> {
  const snapshot = await readJsonVersion(`${prefix.replace(/\/?$/, "/")}reportgen/client_portal/status.json`);
  return {
    status: await enrichPortalStatus(prefix, snapshot.value),
    eTag: snapshot.eTag,
  };
}

export async function signedRead(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: 300 });
}

export async function signedReadWithDisposition(
  key: string,
  disposition: "VIEW" | "DOWNLOAD",
  filename = "How-to-Read-Your-BDR-Reports.pdf",
): Promise<{ url: string; expiresInSeconds: number }> {
  const mode = disposition === "DOWNLOAD" ? "attachment" : "inline";
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ResponseContentType: "application/pdf",
    ResponseCacheControl: "private, no-store",
    ResponseContentDisposition: `${mode}; filename="${filename}"`,
  });
  return {
    url: await getSignedUrl(s3, command, { expiresIn: 300 }),
    expiresInSeconds: 300,
  };
}

export async function signedArtifactRead(
  key: string,
  disposition: "VIEW" | "DOWNLOAD",
  filename: string,
  contentType: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ResponseContentType: contentType,
    ResponseCacheControl: "private, no-store",
    ResponseContentDisposition: artifactContentDisposition(filename, disposition),
  });
  return {
    url: await getSignedUrl(s3, command, { expiresIn: 300 }),
    expiresInSeconds: 300,
  };
}

export async function portalObjectMetadata(key: string): Promise<{ sizeBytes: number; contentType: string | null }> {
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  return {
    sizeBytes: head.ContentLength ?? 0,
    contentType: head.ContentType ?? null,
  };
}

export async function signedUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(s3, new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    ContentType: contentType,
  }), { expiresIn: 300 });
}

export function allowedClientKey(prefix: string, key: string): boolean {
  const root = prefix.replace(/\/?$/, "/");
  if (!key.startsWith(root)) return false;
  return key.includes("/reportgen/client_portal/")
    || key.endsWith("/reportgen/aerial/aerial.png")
    || key.includes("/reportgen/takeoff/asbuilt.");
}

export async function savePortalStatus(
  prefix: string,
  status: Record<string, unknown>,
  expectedETag: string | null,
): Promise<void> {
  const key = `${prefix.replace(/\/?$/, "/")}reportgen/client_portal/status.json`;
  status.updatedAt = new Date().toISOString();
  await writeJson(key, status, expectedETag);
}

export function clientCanSee(status: Record<string, unknown>, organizationId: string | null, admin: boolean): boolean {
  if (admin) return true;
  const reports = status.reports && typeof status.reports === "object"
    ? status.reports as Record<string, { clientVisible?: boolean }>
    : {};
  return Boolean(
    status.released
    || status.legacyVisible
    || Object.values(reports).some((report) => report?.clientVisible),
  );
}
