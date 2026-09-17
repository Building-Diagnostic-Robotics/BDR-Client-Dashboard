type Environment = Readonly<Record<string, string | undefined>>;

const productionPortalOrigin = "https://bdrdashboard.netlify.app";
const productionAuthOrigin = "https://bdr-client-prod-767397717805.auth.us-east-1.amazoncognito.com";

export function liveBaseURL(environment: Environment): string {
  for (const key of [
    "PORTAL_E2E_BASE_URL", "PORTAL_E2E_AUTH_ORIGIN",
    "PORTAL_E2E_CLIENT_EMAIL", "PORTAL_E2E_CLIENT_PASSWORD",
    "PORTAL_E2E_OTHER_EMAIL", "PORTAL_E2E_OTHER_PASSWORD",
  ]) {
    if (!environment[key]) throw new Error(`Configure ${key} in .env.e2e.local before running live tests.`);
  }
  const target = environment.PORTAL_E2E_ENVIRONMENT;
  if (target !== "development" && target !== "production") {
    throw new Error("Select PORTAL_E2E_ENVIRONMENT=development or production explicitly.");
  }
  const portal = new URL(environment.PORTAL_E2E_BASE_URL!);
  const auth = new URL(environment.PORTAL_E2E_AUTH_ORIGIN!);
  const loopback = ["localhost", "127.0.0.1"].includes(portal.hostname);
  if ((portal.protocol !== "https:" && !(target === "development" && portal.protocol === "http:" && loopback)) ||
    portal.pathname !== "/" || portal.search || portal.hash || portal.username || portal.password) {
    throw new Error("PORTAL_E2E_BASE_URL must be a dashboard origin without a path, query, or credentials.");
  }
  if (auth.protocol !== "https:" || auth.pathname !== "/" || auth.search || auth.hash || auth.username || auth.password) {
    throw new Error("PORTAL_E2E_AUTH_ORIGIN must be a client Cognito origin without a path, query, or credentials.");
  }
  if (environment.PORTAL_E2E_CLIENT_EMAIL!.trim().toLowerCase() === environment.PORTAL_E2E_OTHER_EMAIL!.trim().toLowerCase()) {
    throw new Error("Use two separate test client accounts in different organizations.");
  }
  if (target === "production") {
    if (environment.PORTAL_E2E_ALLOW_PRODUCTION !== "true") {
      throw new Error("Production tests require explicit PORTAL_E2E_ALLOW_PRODUCTION=true for dedicated test accounts.");
    }
    if (portal.origin !== productionPortalOrigin || auth.origin !== productionAuthOrigin) {
      throw new Error("Production tests must use the configured production dashboard and production client Cognito origins.");
    }
    const first = environment.PORTAL_E2E_CLIENT_ORGANIZATION?.trim();
    const other = environment.PORTAL_E2E_OTHER_ORGANIZATION?.trim();
    if (!first || !other || first === other) {
      throw new Error("Configure distinct PORTAL_E2E_CLIENT_ORGANIZATION and PORTAL_E2E_OTHER_ORGANIZATION display names for your two test organizations.");
    }
  } else if (portal.origin === productionPortalOrigin || auth.origin === productionAuthOrigin) {
    throw new Error("Development tests cannot use production dashboard or client Cognito origins.");
  }
  return portal.origin;
}
