#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function aws(args) {
  return JSON.parse(execFileSync("aws", args, {
    encoding: "utf8",
    env: { ...process.env, AWS_PAGER: "" },
    maxBuffer: 16 * 1024 * 1024,
  }));
}

function emailSet(poolId, region) {
  const result = aws([
    "cognito-idp",
    "list-users",
    "--user-pool-id",
    poolId,
    "--region",
    region,
    "--output",
    "json",
  ]);
  return new Set((result.Users ?? []).flatMap((user) => {
    const email = (user.Attributes ?? []).find((attribute) => attribute.Name === "email")?.Value;
    return email ? [email.trim().toLowerCase()] : [];
  }));
}

const environment = argument("--environment");
const region = argument("--region") ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
let clientPoolId = argument("--client-pool-id");
let adminPoolId = argument("--admin-pool-id");

if ((clientPoolId && !adminPoolId) || (!clientPoolId && adminPoolId)) {
  throw new Error("Provide both --client-pool-id and --admin-pool-id");
}

if (!clientPoolId && !adminPoolId) {
  if (environment !== "development" && environment !== "production") {
    throw new Error("Provide --environment development|production or both explicit pool IDs");
  }
  const stack = aws([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    `BdrClientPortal-${environment}`,
    "--region",
    region,
    "--output",
    "json",
  ]).Stacks?.[0];
  const outputs = Object.fromEntries((stack?.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]));
  clientPoolId = outputs.ClientUserPoolId;
  adminPoolId = outputs.AdminUserPoolId;
  if (!clientPoolId || !adminPoolId) throw new Error("The selected stack does not expose both Cognito pool IDs");
}

const clientEmails = emailSet(clientPoolId, region);
const adminEmails = emailSet(adminPoolId, region);
const overlappingEmails = [...clientEmails].filter((email) => adminEmails.has(email)).sort();

process.stdout.write(`${JSON.stringify({
  environment: environment ?? null,
  region,
  clientUserPoolId: clientPoolId,
  adminUserPoolId: adminPoolId,
  clientEmailCount: clientEmails.size,
  adminEmailCount: adminEmails.size,
  overlapCount: overlappingEmails.length,
  overlappingEmails,
}, null, 2)}\n`);

if (overlappingEmails.length > 0) process.exitCode = 2;
