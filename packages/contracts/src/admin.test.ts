import { describe, expect, it } from "vitest";

import { adminApiOpenApi, createProjectRequestSchema, updateReportStatusRequestSchema } from "./index";

describe("Phase 5 admin contracts", () => {
  it("requires an IANA timezone for projects", () => {
    expect(createProjectRequestSchema.safeParse({ displayName: "Building", address: "1 Main St", timeZone: "EST" }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ displayName: "Building", address: "1 Main St", timeZone: "America/New_York" }).success).toBe(true);
  });

  it("cannot publish a report through classification metadata", () => {
    expect(updateReportStatusRequestSchema.safeParse({ expectedRevision: "rev_1234567890123456", deliveryStatus: "PUBLISHED" }).success).toBe(false);
  });

  it("rejects browser-supplied tenant ownership fields", () => {
    expect(createProjectRequestSchema.safeParse({ displayName: "Building", address: "1 Main St", timeZone: "America/New_York", organizationId: "org_attacker_123456" }).success).toBe(false);
  });

  it("publishes organization-scoped user operations", () => {
    expect(adminApiOpenApi.paths).toHaveProperty("/admin/organizations/{organizationId}/users/{userId}/revoke");
    expect(adminApiOpenApi.paths).not.toHaveProperty("/admin/users/{userId}/revoke");
  });
});
