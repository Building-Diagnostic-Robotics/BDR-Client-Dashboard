#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type S3CorsRule = {
  ID?: string;
  AllowedHeaders: string[];
  AllowedMethods: string[];
  AllowedOrigins: string[];
  ExposeHeaders?: string[];
  MaxAgeSeconds?: number;
};

export type S3CorsConfiguration = {
  CORSRules: S3CorsRule[];
};

export const DASHBOARD_CORS_RULE_ID = "BDRDashboardReportReads";

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://bdrdashboard.netlify.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

export function buildUpdatedCorsRules(
  currentRules: S3CorsRule[],
  additionalOrigins: string[] = [],
): S3CorsRule[] {
  const targetOrigins = Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...additionalOrigins]));

  const existingRule = currentRules.find((r) => r.ID === DASHBOARD_CORS_RULE_ID);
  const otherRules = currentRules.filter((r) => r.ID !== DASHBOARD_CORS_RULE_ID);

  const mergedOrigins = existingRule
    ? Array.from(new Set([...existingRule.AllowedOrigins, ...targetOrigins]))
    : targetOrigins;

  const updatedRule: S3CorsRule = {
    ID: DASHBOARD_CORS_RULE_ID,
    AllowedMethods: ["GET", "HEAD", "PUT"],
    AllowedHeaders: ["*"],
    AllowedOrigins: mergedOrigins,
    ExposeHeaders: ["Content-Length", "Content-Type", "Content-Disposition", "ETag"],
    MaxAgeSeconds: 3600,
  };

  return [...otherRules, updatedRule];
}

function tryConfigureOperatorCredentials(): void {
  try {
    const output = execFileSync(
      "aws",
      ["configure", "export-credentials", "--format", "process"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AWS_PAGER: "" },
      },
    );
    const credentials = JSON.parse(output) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      SessionToken?: string;
    };
    if (credentials.AccessKeyId && credentials.SecretAccessKey) {
      process.env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
      if (credentials.SessionToken) {
        process.env.AWS_SESSION_TOKEN = credentials.SessionToken;
      } else {
        delete process.env.AWS_SESSION_TOKEN;
      }
      delete process.env.AWS_PROFILE;
      delete process.env.AWS_DEFAULT_PROFILE;
    }
  } catch {
    // Fall back to standard environment / AWS SDK credentials
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      bucket: { type: "string", default: "bdr-roofus-uploads" },
      region: { type: "string", default: "us-east-1" },
      origin: { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(
      "Update CORS on S3 Data Bucket (bdr-roofus-uploads) for As-built upload\n\n" +
        "Usage:\n" +
        "  Preview (dry run):\n" +
        "    npm run update-data-bucket-cors --workspace @bdr/infrastructure\n\n" +
        "  Apply changes:\n" +
        "    npm run update-data-bucket-cors --workspace @bdr/infrastructure -- --apply\n\n" +
        "Options:\n" +
        "  --bucket   S3 bucket name (default: bdr-roofus-uploads)\n" +
        "  --region   AWS region (default: us-east-1)\n" +
        "  --origin   Additional allowed origin (can be specified multiple times)\n" +
        "  --apply    Actually write the updated CORS configuration to AWS S3\n" +
        "  --help     Show this help message\n",
    );
    return;
  }

  tryConfigureOperatorCredentials();

  const bucket = values.bucket ?? "bdr-roofus-uploads";
  const region = values.region ?? "us-east-1";
  const s3 = new S3Client({ region });

  process.stdout.write(`Fetching current CORS configuration for bucket "${bucket}" (${region})...\n`);

  let currentRules: S3CorsRule[] = [];
  try {
    const response = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
    currentRules = (response.CORSRules as S3CorsRule[]) ?? [];
  } catch (error: unknown) {
    const err = error as { name?: string };
    if (err.name === "NoSuchCORSConfiguration") {
      process.stdout.write("Bucket currently has no CORS configuration.\n");
      currentRules = [];
    } else {
      throw error;
    }
  }

  process.stdout.write(`Current CORS rules count: ${currentRules.length}\n`);

  const updatedRules = buildUpdatedCorsRules(currentRules, values.origin ?? []);

  process.stdout.write("\n--- Proposed CORS Configuration ---\n");
  process.stdout.write(JSON.stringify({ CORSRules: updatedRules }, null, 2) + "\n\n");

  if (!values.apply) {
    process.stdout.write(
      "DRY-RUN completed. No changes applied.\n" +
        "To apply this CORS configuration, rerun with: --apply\n",
    );
    return;
  }

  process.stdout.write(`Applying CORS configuration to bucket "${bucket}"...\n`);
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: updatedRules,
      },
    }),
  );

  process.stdout.write("✅ Successfully updated S3 CORS configuration on " + bucket + "\n");
}

if (process.argv[1]?.endsWith("update-data-bucket-cors.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`Failed to update bucket CORS: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
