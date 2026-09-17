import { describe, expect, it } from "vitest";
import { liveBaseURL } from "./live-config";

const production = {
  PORTAL_E2E_ENVIRONMENT: "production",
  PORTAL_E2E_ALLOW_PRODUCTION: "true",
  PORTAL_E2E_BASE_URL: "https://bdrdashboard.netlify.app",
  PORTAL_E2E_AUTH_ORIGIN: "https://bdr-client-prod-767397717805.auth.us-east-1.amazoncognito.com",
  PORTAL_E2E_CLIENT_EMAIL: "first-test@example.com",
  PORTAL_E2E_CLIENT_PASSWORD: "dummy-first-password",
  PORTAL_E2E_CLIENT_ORGANIZATION: "First Test Organization",
  PORTAL_E2E_OTHER_EMAIL: "second-test@example.com",
  PORTAL_E2E_OTHER_PASSWORD: "dummy-second-password",
  PORTAL_E2E_OTHER_ORGANIZATION: "Second Test Organization",
};

describe("live browser test target safeguards", () => {
  it("allows explicit production configuration for two test organizations", () => {
    expect(liveBaseURL(production)).toBe("https://bdrdashboard.netlify.app");
  });

  it.each([undefined, "false"])("requires production opt-in (%s)", (value) => {
    expect(() => liveBaseURL({ ...production, PORTAL_E2E_ALLOW_PRODUCTION: value })).toThrow(/ALLOW_PRODUCTION/);
  });

  it.each([
    { PORTAL_E2E_BASE_URL: "https://other-site.netlify.app" },
    { PORTAL_E2E_AUTH_ORIGIN: "https://bdr-admin-prod-767397717805.auth.us-east-1.amazoncognito.com" },
    { PORTAL_E2E_AUTH_ORIGIN: "https://development.auth.us-east-1.amazoncognito.com" },
  ])("rejects a mismatched production dashboard or auth origin", (override) => {
    expect(() => liveBaseURL({ ...production, ...override })).toThrow(/production.*origins/);
  });

  it.each([
    { PORTAL_E2E_CLIENT_ORGANIZATION: "" },
    { PORTAL_E2E_OTHER_ORGANIZATION: "First Test Organization" },
    { PORTAL_E2E_OTHER_EMAIL: " FIRST-TEST@example.com " },
    { PORTAL_E2E_CLIENT_PASSWORD: "" },
  ])("rejects incomplete or non-distinct test account configuration", (override) => {
    expect(() => liveBaseURL({ ...production, ...override })).toThrow();
  });

  it.each([
    { PORTAL_E2E_BASE_URL: production.PORTAL_E2E_BASE_URL, PORTAL_E2E_AUTH_ORIGIN: "https://development.auth.us-east-1.amazoncognito.com" },
    { PORTAL_E2E_BASE_URL: "http://localhost:3000", PORTAL_E2E_AUTH_ORIGIN: production.PORTAL_E2E_AUTH_ORIGIN },
  ])("prevents labeling a production origin as development", (origins) => {
    expect(() => liveBaseURL({ ...production, ...origins, PORTAL_E2E_ENVIRONMENT: "development" })).toThrow(/Development tests cannot/);
  });

  it("retains local development testing with its own client Cognito origin", () => {
    expect(liveBaseURL({
      ...production, PORTAL_E2E_ENVIRONMENT: "development",
      PORTAL_E2E_BASE_URL: "http://localhost:3000",
      PORTAL_E2E_AUTH_ORIGIN: "https://development.auth.us-east-1.amazoncognito.com",
    })).toBe("http://localhost:3000");
  });

  it.each([
    "https://bdrdashboard.netlify.app/projects",
    "https://bdrdashboard.netlify.app/?code=private-code",
    "https://user:password@bdrdashboard.netlify.app",
    "http://bdrdashboard.netlify.app",
  ])("rejects a non-origin dashboard URL", (url) => {
    expect(() => liveBaseURL({ ...production, PORTAL_E2E_BASE_URL: url })).toThrow(/dashboard origin/);
  });
});
