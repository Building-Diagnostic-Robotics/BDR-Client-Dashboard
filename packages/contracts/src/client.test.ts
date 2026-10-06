import { describe, expect, it } from "vitest";

import {
  clientInspectionSchema,
  clientMeResponseSchema,
  clientProjectSchema,
  clientProjectListResponseSchema,
  clientProjectSummarySchema,
  clientReportMetadataSchema,
  passwordResetConfirmResponseSchema,
  passwordResetConfirmSchema,
  passwordResetRequestResponseSchema,
  passwordResetRequestSchema,
} from "./client";


describe("client response contracts", () => {
  it("rejects internal organization and user identifiers", () => {
    expect(clientMeResponseSchema.safeParse({
      userId: "user_0123456789abcdef",
      organization: {
        organizationId: "org_0123456789abcdef",
        displayName: "Midland Holdings",
        status: "ACTIVE",
      },
    }).success).toBe(false);
  });

  it("rejects lifecycle and ownership fields in project and inspection responses", () => {
    expect(clientProjectSchema.safeParse({
      organizationId: "org_0123456789abcdef",
      projectId: "project_0123456789abcdef",
      displayName: "Midland Business Park",
      address: "4300 West Loop, Fort Worth, TX",
      timeZone: "America/Chicago",
      lifecycleStatus: "ACTIVE",
    }).success).toBe(false);

    expect(clientInspectionSchema.safeParse({
      projectId: "project_0123456789abcdef",
      inspectionId: "inspection_0123456789abcdef",
      scannedAt: "2026-09-04T14:30:00.000Z",
      scanTimeZone: "America/Chicago",
      publicationStatus: "PUBLISHED",
    }).success).toBe(false);
  });

  it("rejects report and version identifiers in report metadata", () => {
    expect(clientReportMetadataSchema.safeParse({
      reportId: "report_0123456789abcdef",
      reportType: "ASSESSMENT",
      deliveryStatus: "PUBLISHED",
      currentVersionId: "version_0123456789abcdef",
      publishedAt: "2026-09-07T15:00:00.000Z",
    }).success).toBe(false);
  });

  it("keeps project detail and project-list summary response shapes distinct", () => {
    const project = {
      projectId: "project_0123456789abcdef",
      displayName: "Midland Business Park",
      address: "4300 West Loop, Fort Worth, TX",
      timeZone: "America/Chicago",
    };
    const summary = {
      ...project,
      latestInspection: {
        scannedAt: "2026-09-04T14:30:00.000Z",
        scanTimeZone: "America/Chicago",
        overallStatus: "PUBLISHED",
      },
      latestReportUpdate: {
        publishedAt: "2026-09-07T15:00:00.000Z",
        scanTimeZone: "America/Chicago",
      },
    };
    expect(clientProjectSchema.safeParse(project).success).toBe(true);
    expect(clientProjectSchema.safeParse(summary).success).toBe(false);
    expect(clientProjectSummarySchema.safeParse(summary).success).toBe(true);
    expect(clientProjectListResponseSchema.safeParse({ items: [summary] }).success).toBe(true);
    expect(clientProjectListResponseSchema.safeParse({ items: [project] }).success).toBe(false);
  });

  it("validates password reset request contracts", () => {
    expect(passwordResetRequestSchema.safeParse({ email: "user@example.com" }).success).toBe(true);
    expect(passwordResetRequestSchema.safeParse({ email: "invalid-email" }).success).toBe(false);
    expect(passwordResetRequestSchema.safeParse({ email: "user@example.com", extra: true }).success).toBe(false);
    expect(passwordResetRequestResponseSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(passwordResetRequestResponseSchema.safeParse({ accepted: false }).success).toBe(false);
  });

  it("validates password reset confirm contracts", () => {
    expect(passwordResetConfirmSchema.safeParse({
      email: "user@example.com",
      confirmationCode: "123456",
      newPassword: "ValidPassword123!",
    }).success).toBe(true);
    expect(passwordResetConfirmSchema.safeParse({
      email: "invalid-email",
      confirmationCode: "123456",
      newPassword: "ValidPassword123!",
    }).success).toBe(false);
    expect(passwordResetConfirmSchema.safeParse({
      email: "user@example.com",
      confirmationCode: "",
      newPassword: "ValidPassword123!",
    }).success).toBe(false);
    expect(passwordResetConfirmSchema.safeParse({
      email: "user@example.com",
      confirmationCode: "123456",
      newPassword: "",
    }).success).toBe(false);
    expect(passwordResetConfirmResponseSchema.safeParse({ reset: true }).success).toBe(true);
    expect(passwordResetConfirmResponseSchema.safeParse({ reset: false }).success).toBe(false);
  });
});

