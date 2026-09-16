import { describe, expect, it } from "vitest";

import { validatePortalEnvironmentConfig } from "./config";

describe("portal environment configuration", () => {
  it("allows a loopback HTTP portal origin in development", () => {
    expect(
      validatePortalEnvironmentConfig({
        deploymentEnvironment: "development",
        portalOrigin: "http://localhost:3000",
        clientAuthDomainPrefix: "bdr-client-development",
        adminAuthDomainPrefix: "bdr-admin-development",
        adminCliCallbackUrl: "http://127.0.0.1:8765/callback",
        adminCliLogoutUrl: "http://127.0.0.1:8765/logout",
      }).portalOrigin,
    ).toBe("http://localhost:3000");
  });

  const productionConfig = {
    deploymentEnvironment: "production" as const,
    portalOrigin: "https://bdrdashboard.netlify.app",
    clientAuthDomainPrefix: "bdr-client-production",
    adminAuthDomainPrefix: "bdr-admin-production",
    adminCliCallbackUrl: "http://127.0.0.1:8765/callback",
    adminCliLogoutUrl: "https://bdrdashboard.netlify.app/logged-out",
  };

  it("allows the production CLI's loopback HTTP callback", () => {
    expect(validatePortalEnvironmentConfig(productionConfig)).toEqual(productionConfig);
  });

  it.each(["adminCliCallbackUrl", "adminCliLogoutUrl"] as const)(
    "rejects non-loopback HTTP for production %s",
    (field) => {
      expect(() => validatePortalEnvironmentConfig({
        ...productionConfig,
        [field]: "http://admin.example.com/callback",
      })).toThrow(/HTTPS/);
    },
  );

  it("still rejects a loopback HTTP portal origin in production", () => {
    expect(() => validatePortalEnvironmentConfig({
      ...productionConfig,
      portalOrigin: "http://localhost:3000",
    })).toThrow(/HTTPS/);
  });

  it("rejects non-HTTPS production origins", () => {
    expect(() =>
      validatePortalEnvironmentConfig({
        deploymentEnvironment: "production",
        portalOrigin: "http://portal.example.com",
        clientAuthDomainPrefix: "bdr-client-production",
        adminAuthDomainPrefix: "bdr-admin-production",
        adminCliCallbackUrl: "https://admin.example.com/callback",
        adminCliLogoutUrl: "https://admin.example.com/logout",
      }),
    ).toThrow(/HTTPS/);
  });

  it("rejects origins containing a path", () => {
    expect(() =>
      validatePortalEnvironmentConfig({
        deploymentEnvironment: "production",
        portalOrigin: "https://portal.example.com/app",
        clientAuthDomainPrefix: "bdr-client-production",
        adminAuthDomainPrefix: "bdr-admin-production",
        adminCliCallbackUrl: "https://admin.example.com/callback",
        adminCliLogoutUrl: "https://admin.example.com/logout",
      }),
    ).toThrow(/origin/);
  });
});
