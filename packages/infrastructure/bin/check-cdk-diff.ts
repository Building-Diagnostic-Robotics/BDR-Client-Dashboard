#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type StatefulResource = {
  type: string;
  logicalId: string;
  changeType: "REPLACEMENT" | "DELETION";
  details: string;
};

const STATEFUL_TYPES = [
  "AWS::DynamoDB::Table",
  "AWS::Cognito::UserPool",
  "AWS::Cognito::UserPoolClient",
  "AWS::KMS::Key",
  "AWS::S3::Bucket",
];

export function inspectCdkDiff(diffText: string): {
  hasDestructiveChanges: boolean;
  destructiveResources: StatefulResource[];
  summary: string;
} {
  const lines = diffText.split("\n");
  const destructiveResources: StatefulResource[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    for (const statefulType of STATEFUL_TYPES) {
      if (line.includes(statefulType)) {
        // Check for replacement indicator: (requires replacement)
        if (line.includes("(requires replacement)") || line.includes("replace")) {
          destructiveResources.push({
            type: statefulType,
            logicalId: extractLogicalId(line),
            changeType: "REPLACEMENT",
            details: line.trim(),
          });
        }
        // Check for deletion: [-] AWS::...
        else if (line.trim().startsWith("[-]")) {
          destructiveResources.push({
            type: statefulType,
            logicalId: extractLogicalId(line),
            changeType: "DELETION",
            details: line.trim(),
          });
        }
      }
    }
  }

  const hasDestructiveChanges = destructiveResources.length > 0;
  let summary = "";

  if (hasDestructiveChanges) {
    summary = `⚠️ Potentially destructive changes detected on ${destructiveResources.length} stateful resource(s):\n` +
      destructiveResources.map((r) => `  - [${r.changeType}] ${r.type} (${r.logicalId}): ${r.details}`).join("\n");
  } else {
    summary = "✅ No destructive changes detected against stateful resources (DynamoDB, Cognito, KMS, S3).";
  }

  return { hasDestructiveChanges, destructiveResources, summary };
}

function extractLogicalId(line: string): string {
  const match = line.match(/\s+([A-Za-z0-9_-]+)\s+AWS::/);
  if (match && match[1]) return match[1];
  const parts = line.split(/\s+/).filter(Boolean);
  return parts[1] || parts[0] || "unknown";
}

function main() {
  const args = process.argv.slice(2);
  let diffContent = "";

  const fileArgIndex = args.indexOf("--file");
  if (fileArgIndex !== -1 && args[fileArgIndex + 1]) {
    const rawPath = args[fileArgIndex + 1]!;
    const candidatePaths = [
      rawPath,
      resolve(process.cwd(), rawPath),
      resolve(process.env.INIT_CWD || process.cwd(), rawPath),
      resolve(process.cwd(), "..", "..", rawPath),
    ];
    const targetPath = candidatePaths.find((p) => existsSync(p)) || candidatePaths[0];
    diffContent = readFileSync(targetPath!, "utf-8");
  } else if (!process.stdin.isTTY) {
    try {
      diffContent = readFileSync(0, "utf-8");
    } catch {
      diffContent = "";
    }
  }

  const { hasDestructiveChanges, summary } = inspectCdkDiff(diffContent);
  console.log(summary);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `has_destructive_changes=${hasDestructiveChanges}\n`);
    const escapedSummary = summary.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    appendFileSync(githubOutput, `diff_summary=${escapedSummary}\n`);
  }

  if (args.includes("--fail-on-destructive") && hasDestructiveChanges) {
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("check-cdk-diff.ts") || process.argv[1]?.endsWith("check-cdk-diff.js")) {
  main();
}
