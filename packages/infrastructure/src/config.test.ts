import { describe, expect, it } from "vitest";

import { validatePortalEnvironmentConfig } from "./config";

describe("portal environment configuration", () => {
  it("allows loopback HTTP only in development", () => {
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
