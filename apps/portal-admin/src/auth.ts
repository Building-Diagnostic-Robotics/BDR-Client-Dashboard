import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

export type CliAuthConfig = Readonly<{
  authDomain: string;
  clientId: string;
  callbackUrl: string;
}>;

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function authorizationRequest(config: CliAuthConfig, state: string, verifier: string): URL {
  const url = new URL("/oauth2/authorize", config.authDomain);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email aws.cognito.signin.user.admin",
    redirect_uri: config.callbackUrl,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url;
}

export function openUrl(url: string): void {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function callback(callbackUrl: string, expectedState: string): Promise<string> {
  const expected = new URL(callbackUrl);
  if (expected.hostname !== "127.0.0.1" && expected.hostname !== "localhost") {
    throw new Error("CLI callback must use a loopback host");
  }
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", expected.origin);
      if (url.pathname !== expected.pathname) {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || state !== expectedState) {
        response.writeHead(400, { "content-type": "text/plain" }).end("Login failed. Return to the terminal.");
        server.close();
        reject(new Error("Cognito callback was missing a valid code or state"));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("BDR Portal login complete. You can close this window.");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(Number(expected.port), expected.hostname);
    setTimeout(() => {
      server.close();
      reject(new Error("Cognito login timed out"));
    }, 5 * 60 * 1000).unref();
  });
}

export async function login(config: CliAuthConfig): Promise<{ accessToken: string; refreshToken?: string }> {
  const state = token();
  const verifier = token(48);
  const codePromise = callback(config.callbackUrl, state);
  const url = authorizationRequest(config, state, verifier);
  openUrl(url.toString());
  process.stderr.write(`Opening secure administrator login:\n${url.toString()}\n`);
  const code = await codePromise;
  const response = await fetch(new URL("/oauth2/token", config.authDomain), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, redirect_uri: config.callbackUrl, code, code_verifier: verifier }),
  });
  if (!response.ok) throw new Error(`Cognito token exchange failed with ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("access_token" in payload) || typeof payload.access_token !== "string") throw new Error("Cognito returned no access token");
  return {
    accessToken: payload.access_token,
    ...("refresh_token" in payload && typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
  };
}

export async function revokeToken(config: CliAuthConfig, refreshToken: string): Promise<void> {
  const response = await fetch(new URL("/oauth2/revoke", config.authDomain), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken, client_id: config.clientId }),
  });
  if (!response.ok) throw new Error(`Cognito token revocation failed with ${response.status}`);
}
