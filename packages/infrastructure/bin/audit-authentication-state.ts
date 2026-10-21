#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CognitoIdentityProviderClient, AdminGetUserCommand, AdminListGroupsForUserCommand, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { identityKeys } from "@bdr/domain";
import { clientAuthenticationFindings } from "../../../apps/services/src/operations/authentication-audit";
import { discoverSampleConfiguration } from "../../../apps/services/src/operations/sample-dashboard-aws";

async function main() {
  const { values } = parseArgs({ options: { environment: { type: "string" }, region: { type: "string", default: "us-east-1" } }, strict: true });
  if (values.environment !== "development" && values.environment !== "production") throw new Error("Select --environment development|production");
  const config = discoverSampleConfiguration(values.environment, values.region ?? "us-east-1");
  const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.context.region }));
  const cognito = new CognitoIdentityProviderClient({ region: config.context.region });
  const scan = async (table: string, fields: string[]) => {
    const items: Record<string, unknown>[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const names = Object.fromEntries(fields.map((field, i) => [`#f${i}`, field]));
      const result = await document.send(new ScanCommand({ TableName: table, ConsistentRead: true,
        ProjectionExpression: Object.keys(names).join(", "), ExpressionAttributeNames: names,
        ...(key ? { ExclusiveStartKey: key } : {}) }));
      items.push(...result.Items ?? []); key = result.LastEvaluatedKey;
    } while (key);
    return items;
  };
  // Explicit projections exclude token ciphertext, login nonces, PKCE values and credentials.
  const [identities, users, sessions, enrollments] = await Promise.all([
    scan(config.identityTable, ["PK", "SK", "issuer", "sub", "adminId", "status", "role", "totpEnrolled", "organizationId", "userId", "activeAdminCount", "normalizedEmail"]),
    scan(config.context.tenantTable, ["PK", "SK", "organizationId", "userId", "status", "currentIssuer", "currentSub", "normalizedEmail", "revision"]),
    scan(config.sessionTable, ["PK", "SK", "issuer", "sub", "sessionIdHash", "revokedAt", "absoluteExpiresAt"]),
    scan(config.adminControlTable, ["PK", "SK", "issuer", "sub", "adminId", "status", "email", "expiresAt"]),
  ]);
  const findings: Record<string, unknown>[] = [];
  const activeProfiles = identities.filter((row) => String(row.PK).startsWith("ADMIN#") && row.status === "ACTIVE" && row.role === "BDR_ADMIN" && row.totpEnrolled === true);
  const count = identities.find((row) => row.PK === "ADMIN_GUARD" && row.SK === "ACTIVE_COUNT")?.activeAdminCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count !== activeProfiles.length || activeProfiles.length === 0) findings.push({ kind: "ADMIN_GUARD_MISMATCH", recorded: count ?? null, eligibleProfiles: activeProfiles.length });
  let token: string | undefined;
  const seenAdminIds = new Set<string>();
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: config.adminPool, ...(token ? { PaginationToken: token } : {}) }));
    for (const account of page.Users ?? []) {
      const sub = account.Attributes?.find((item) => item.Name === "sub")?.Value;
      if (!sub || !account.Username) { findings.push({ kind: "MALFORMED_COGNITO_ADMIN" }); continue; }
      const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: config.adminPool, Username: account.Username }));
      const mappingKey = identityKeys.subject(`https://cognito-idp.${config.context.region}.amazonaws.com/${config.adminPool}`, sub);
      const mapping = identities.find((item) => item.PK === mappingKey.PK && item.SK === mappingKey.SK);
      const profile = activeProfiles.find((item) => item.adminId === mapping?.adminId);
      if (profile) seenAdminIds.add(String(profile.adminId));
      let next: string | undefined;
      let member = false;
      do {
        const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: config.adminPool, Username: account.Username, ...(next ? { NextToken: next } : {}) }));
        member ||= (groups.Groups ?? []).some((item) => item.GroupName === "bdr-admins"); next = groups.NextToken;
      } while (next);
      const pending = enrollments.find((item) => item.sub === sub && String(item.PK).startsWith("ADMIN_ENROLLMENT#") && item.status !== "ACCEPTED");
      if (user.Enabled && member && (!profile || !user.UserMFASettingList?.includes("SOFTWARE_TOKEN_MFA") || user.UserStatus !== "CONFIRMED")) {
        findings.push({ kind: pending ? "PENDING_ADMIN_ONBOARDING" : "ADMIN_REQUIRES_RECONCILIATION", sub, adminId: mapping?.adminId ?? null, enabled: user.Enabled,
          cognitoStatus: user.UserStatus, totpEnrolled: user.UserMFASettingList?.includes("SOFTWARE_TOKEN_MFA") ?? false, canonicalProfile: Boolean(profile) });
      }
      if (profile && (!user.Enabled || !member)) findings.push({ kind: "ACTIVE_PROFILE_WITH_INELIGIBLE_COGNITO_USER", sub, adminId: mapping?.adminId });
    }
    token = page.PaginationToken;
  } while (token);
  for (const pending of enrollments.filter((item) => String(item.PK).startsWith("ADMIN_ENROLLMENT#") && item.status !== "ACCEPTED")) {
    findings.push({ kind: "ADMIN_ENROLLMENT_REQUIRES_REVIEW", adminId: pending.adminId, sub: pending.sub, status: pending.status,
      expired: Date.parse(String(pending.expiresAt)) <= Date.now() });
  }
  const adminMappings = identities.filter((item) => typeof item.adminId === "string" && String(item.PK).startsWith("SUBJECT#"));
  for (const profile of activeProfiles) {
    const mappings = adminMappings.filter((item) => item.adminId === profile.adminId);
    if (mappings.length !== 1) findings.push({ kind: "ADMIN_MAPPING_COUNT_MISMATCH", adminId: profile.adminId, mappingCount: mappings.length });
  }
  for (const profile of activeProfiles) if (!seenAdminIds.has(String(profile.adminId))) findings.push({ kind: "ADMIN_PROFILE_WITHOUT_COGNITO_MAPPING", adminId: profile.adminId });
  findings.push(...clientAuthenticationFindings(identities, users, sessions));
  process.stdout.write(`${JSON.stringify({ readOnly: true, environment: values.environment, accountId: config.context.accountId, findings, repairsApplied: false }, null, 2)}\n`);
}
main().catch(() => { process.stderr.write("Authentication audit failed; no repairs were applied. Check AWS access, stack selection and resource configuration.\n"); process.exitCode = 1; });
