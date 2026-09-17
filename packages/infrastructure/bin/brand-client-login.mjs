#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function main() {
  const { values } = parseArgs({
    options: {
      environment: { type: "string" },
      region: { type: "string" },
      profile: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Usage: npm run brand-client-login --workspace @bdr/infrastructure -- --environment development|production --region us-east-1 [--profile NAME]");
    return;
  }
  if (!["development", "production"].includes(values.environment)) {
    throw new Error("Select --environment development or production explicitly.");
  }
  const region = values.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Provide --region or set AWS_REGION.");
  const stackName = `BdrClientPortal-${values.environment}`;
  const commonArgs = ["--region", region, "--no-cli-pager"];
  if (values.profile) commonArgs.push("--profile", values.profile);

  function aws(args) {
    const result = spawnSync("aws", [...args, ...commonArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "AWS CLI command failed.");
    }
    return result.stdout;
  }

  const { Stacks } = JSON.parse(aws([
    "cloudformation", "describe-stacks", "--stack-name", stackName, "--output", "json",
  ]));
  const stack = Stacks?.[0];
  if (!stack || stack.StackName !== stackName) throw new Error("Expected stack was not returned.");
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus)) {
    throw new Error(`Deploy ${stackName} successfully before applying branding (${stack.StackStatus}).`);
  }
  function output(name) {
    const value = stack.Outputs?.find((entry) => entry.OutputKey === name)?.OutputValue;
    if (!value) throw new Error(`Missing ${name} output in ${stackName}.`);
    return value;
  }
  const poolId = output("ClientUserPoolId");
  const clientId = output("ClientAppClientId");
  const cssPath = fileURLToPath(new URL("../branding/client-login.css", import.meta.url));
  const logoPath = fileURLToPath(new URL("../../../apps/web/public/bdr_logo_name.png", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  const logo = readFileSync(logoPath);
  if (Buffer.byteLength(css) > 3 * 1024 || logo.length > 100 * 1024) {
    throw new Error("Cognito branding requires CSS at most 3 KB and a logo at most 100 KB.");
  }
  console.log(`Applying customer login branding to ${stackName} (${poolId}, ${clientId}).`);
  aws([
    "cognito-idp", "set-ui-customization",
    "--user-pool-id", poolId,
    "--client-id", clientId,
    "--css", css,
    "--image-file", `fileb://${logoPath}`,
    "--output", "json",
  ]);
  console.log("BDR customer login branding applied. Allow up to one minute for it to appear.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Client login branding failed.");
  process.exitCode = 1;
}
