#!/usr/bin/env node
import { buildRequest } from "./commands";
import { PortalAdminClient } from "./client";
import { login, openUrl, revokeToken } from "./auth";
import { publishHowToRead, publishInspection, publishReport, uploadPdf } from "./workflows";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const workflow = argv[0] === "uploads" && argv[1] === "put"
    ? "upload"
    : argv[0] === "inspections" && argv[1] === "publish"
      ? "inspection"
      : argv[0] === "reports" && argv[1] === "publish"
        ? "report"
        : argv[0] === "how-to-read" && (argv[1] === "publish" || argv[1] === "replace")
          ? "document"
          : null;
  const request = workflow ? null : buildRequest(argv);
  const authConfig = {
    authDomain: requiredEnvironment("PORTAL_ADMIN_AUTH_DOMAIN"),
    clientId: requiredEnvironment("PORTAL_ADMIN_CLIENT_ID"),
    callbackUrl: requiredEnvironment("PORTAL_ADMIN_CALLBACK_URL"),
  };
  const tokens = await login(authConfig);
  const client = new PortalAdminClient(requiredEnvironment("PORTAL_ADMIN_API_URL"), tokens.accessToken);
  await client.establish();
  const result = workflow === "upload"
    ? await uploadPdf(client, argv.slice(2))
    : workflow === "inspection"
      ? await publishInspection(client, argv.slice(2))
      : workflow === "report"
        ? await publishReport(client, argv.slice(2))
        : workflow === "document"
          ? await publishHowToRead(client, argv.slice(2), argv[1] === "replace")
          : await client.execute(request!);
  if (request?.path === "/admin/auth/session" && result && typeof result === "object" && "logoutUrl" in result && typeof result.logoutUrl === "string") {
    if (tokens.refreshToken) {
      try { await revokeToken(authConfig, tokens.refreshToken); } catch (error) { process.stderr.write(`Warning: ${error instanceof Error ? error.message : String(error)}\n`); }
    }
    openUrl(result.logoutUrl);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
