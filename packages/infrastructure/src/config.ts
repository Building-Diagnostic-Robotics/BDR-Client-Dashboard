export type DeploymentEnvironment = "development" | "production";

export type PortalEnvironmentConfig = Readonly<{
  deploymentEnvironment: DeploymentEnvironment;
  portalOrigin: string;
  clientAuthDomainPrefix: string;
  adminAuthDomainPrefix: string;
  adminCliCallbackUrl: string;
  adminCliLogoutUrl: string;
}>;

function origin(value: string, label: string, environment: DeploymentEnvironment): string {
  const parsed = new URL(value);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError(`${label} must contain only an origin`);
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(environment === "development" && isLocal)) {
    throw new TypeError(`${label} must use HTTPS outside local development`);
  }
  return parsed.origin;
}

function redirectUrl(value: string, label: string): string {
  const parsed = new URL(value);
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  // CLI OAuth redirects terminate on the operator's loopback HTTP listener,
  // including when that CLI authenticates against production.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new TypeError(`${label} must use HTTPS or loopback HTTP`);
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError(`${label} cannot contain query parameters or a fragment`);
  }
  return parsed.toString();
}

function domainPrefix(value: string, label: string): string {
  if (!/^[a-z0-9-]{1,63}$/.test(value) || value.startsWith("-") || value.endsWith("-")) {
    throw new TypeError(`${label} must be a valid Cognito domain prefix`);
  }
  return value;
}

export function validatePortalEnvironmentConfig(
  config: PortalEnvironmentConfig,
): PortalEnvironmentConfig {
  return {
    ...config,
    portalOrigin: origin(config.portalOrigin, "portalOrigin", config.deploymentEnvironment),
    adminCliCallbackUrl: redirectUrl(
      config.adminCliCallbackUrl,
      "adminCliCallbackUrl",
    ),
    adminCliLogoutUrl: redirectUrl(
      config.adminCliLogoutUrl,
      "adminCliLogoutUrl",
    ),
    clientAuthDomainPrefix: domainPrefix(
      config.clientAuthDomainPrefix,
      "clientAuthDomainPrefix",
    ),
    adminAuthDomainPrefix: domainPrefix(
      config.adminAuthDomainPrefix,
      "adminAuthDomainPrefix",
    ),
  };
}
