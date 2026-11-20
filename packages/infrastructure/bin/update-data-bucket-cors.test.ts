import { describe, expect, it } from "vitest";
import {
  buildUpdatedCorsRules,
  DASHBOARD_CORS_RULE_ID,
  DEFAULT_ALLOWED_ORIGINS,
  type S3CorsRule,
} from "./update-data-bucket-cors";

describe("buildUpdatedCorsRules", () => {
  const mockReportGenRule: S3CorsRule = {
    AllowedHeaders: ["*"],
    AllowedMethods: ["GET", "HEAD", "PUT"],
    AllowedOrigins: ["https://d33mjy96xin247.cloudfront.net", "http://localhost:5173"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  };

  const existingReadRule: S3CorsRule = {
    ID: DASHBOARD_CORS_RULE_ID,
    AllowedHeaders: ["Range"],
    AllowedMethods: ["GET", "HEAD"],
    AllowedOrigins: ["https://bdrdashboard.netlify.app"],
    ExposeHeaders: ["Content-Length", "Content-Type", "Content-Disposition", "ETag"],
    MaxAgeSeconds: 300,
  };

  it("preserves external rules and updates existing dashboard rule to include PUT, AllowedHeaders, and localhost", () => {
    const currentRules: S3CorsRule[] = [mockReportGenRule, existingReadRule];

    const result = buildUpdatedCorsRules(currentRules);

    expect(result).toHaveLength(2);

    // Rule 0: ReportGen rule preserved untouched
    expect(result[0]).toEqual(mockReportGenRule);

    // Rule 1: Updated Dashboard rule
    const dashboardRule = result.find((r) => r.ID === DASHBOARD_CORS_RULE_ID);
    expect(dashboardRule).toBeDefined();
    expect(dashboardRule?.AllowedMethods).toEqual(["GET", "HEAD", "PUT"]);
    expect(dashboardRule?.AllowedHeaders).toEqual(["*"]);
    expect(dashboardRule?.ExposeHeaders).toContain("ETag");
    expect(dashboardRule?.ExposeHeaders).toContain("Content-Type");
    expect(dashboardRule?.MaxAgeSeconds).toBe(3600);

    // Allowed origins should include production and localhost
    expect(dashboardRule?.AllowedOrigins).toEqual(
      expect.arrayContaining([
        "https://bdrdashboard.netlify.app",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ]),
    );
  });

  it("creates a new dashboard rule when no prior dashboard rule exists", () => {
    const currentRules: S3CorsRule[] = [mockReportGenRule];

    const result = buildUpdatedCorsRules(currentRules);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(mockReportGenRule);

    const dashboardRule = result[1];
    expect(dashboardRule?.ID).toBe(DASHBOARD_CORS_RULE_ID);
    expect(dashboardRule?.AllowedMethods).toEqual(["GET", "HEAD", "PUT"]);
    expect(dashboardRule?.AllowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it("supports passing additional origins without duplication", () => {
    const currentRules: S3CorsRule[] = [existingReadRule];
    const customOrigin = "https://deploy-preview-42.netlify.app";

    const result = buildUpdatedCorsRules(currentRules, [customOrigin, "https://bdrdashboard.netlify.app"]);

    expect(result).toHaveLength(1);
    const dashboardRule = result[0];
    expect(dashboardRule?.AllowedOrigins).toContain(customOrigin);
    expect(dashboardRule?.AllowedOrigins).toContain("https://bdrdashboard.netlify.app");
    // Ensure no duplicates
    const unique = new Set(dashboardRule?.AllowedOrigins);
    expect(unique.size).toBe(dashboardRule?.AllowedOrigins.length);
  });
});
