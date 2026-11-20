import { z } from "./zod";

import { opaqueIdSchema } from "./models";

export const portalReportTypeSchema = z.enum([
  "ASSESSMENT",
  "EVIDENCE",
  "ROOF_TAKEOFF",
  "AS_BUILT",
  "CAPITAL_PLANNING",
]);

export const portalReportDeliveryStatusSchema = z.enum([
  "AVAILABLE",
  "IN_PREPARATION",
  "NOT_INCLUDED",
]);

export const portalPendingReportStatusSchema = z.enum([
  "IN_PREPARATION",
  "NOT_INCLUDED",
]);

export const portalReportSchema = z.object({
  reportType: portalReportTypeSchema,
  deliveryStatus: portalReportDeliveryStatusSchema,
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  filename: z.string().trim().min(1).max(240).nullable(),
  pendingReview: z.object({
    sourceKey: z.string(),
    generatedAt: z.string().nullable(),
  }).nullable().optional(),
}).strict();

export const portalInspectionSummarySchema = z.object({
  inspectionId: opaqueIdSchema,
  scannedAt: z.iso.datetime({ offset: true }).nullable(),
  uploadCompletedAt: z.iso.datetime({ offset: true }).nullable(),
  timeZone: z.string().trim().min(1).max(100).nullable(),
  availableReportTypes: z.array(portalReportTypeSchema),
  latestReportUpdate: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const portalInspectionSchema = portalInspectionSummarySchema.extend({
  reports: z.array(portalReportSchema).length(5),
}).strict();

export const portalBuildingSummarySchema = z.object({
  buildingId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500),
  engineerNames: z.string().trim().max(500),
  revision: opaqueIdSchema.nullable(),
  latestInspection: portalInspectionSummarySchema.nullable(),
  inspectionCount: z.number().int().nonnegative(),
  provisional: z.boolean(),
}).strict();

export const portalAdminBuildingSummarySchema = portalBuildingSummarySchema.extend({
  buildingPrefix: z.string().trim().min(1).max(1000),
  scanTime: z.iso.datetime({ offset: true }).nullable(),
  uploadTime: z.iso.datetime({ offset: true }).nullable(),
  timeZone: z.string().trim().min(1).max(100).nullable(),
  readyReports: z.array(portalReportTypeSchema),
  latestReportUpdate: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const portalBuildingListResponseSchema = z.discriminatedUnion("admin", [
  z.object({
    items: z.array(portalBuildingSummarySchema),
    admin: z.literal(false),
  }).strict(),
  z.object({
    items: z.array(portalAdminBuildingSummarySchema),
    admin: z.literal(true),
  }).strict(),
]);

export const portalAdminClientSchema = z.object({
  organizationId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(200),
  clientPrefixes: z.array(z.string().trim().min(1).max(240).regex(/^[^/\\]+$/).refine((value) => value !== "." && value !== "..")).min(1),
}).strict();
export const portalAdminClientListSchema = z.object({ items: z.array(portalAdminClientSchema) }).strict();
export const portalAdminBuildingListSchema = z.object({ items: z.array(portalAdminBuildingSummarySchema), admin: z.literal(true) }).strict();
export const portalAdminBuildingCountSchema = z.object({ count: z.number().int().nonnegative() }).strict();
export const portalAdminReviewRowSchema = z.object({
  organizationId: opaqueIdSchema,
  clientName: z.string().min(1),
  prefix: z.string().min(1).max(1000),
  name: z.string().min(1),
  reportType: portalReportTypeSchema,
  reportKey: portalReportTypeSchema.or(z.literal("CAPITAL_PLAN")),
  artifactKey: z.string().min(1).nullable(),
  generatedAt: z.string().nullable(),
}).strict().refine((row) => (row.reportKey === "CAPITAL_PLAN" ? "CAPITAL_PLANNING" : row.reportKey) === row.reportType, "Review report key must match its canonical type");
export const portalAdminReviewResponseSchema = z.object({
  items: z.array(portalAdminReviewRowSchema),
  complete: z.boolean(),
  failures: z.array(z.object({
    organizationId: opaqueIdSchema,
    clientName: z.string().min(1),
    prefix: z.string().nullable(),
  }).strict()),
}).strict().refine((value) => value.complete === (value.failures.length === 0), "Review completeness must match failures");
export const portalFileResponseSchema = z.object({ url: z.url() }).strict();
export const portalMutationResponseSchema = z.object({ ok: z.literal(true) }).strict();

export const portalBuildingDetailSchema = portalBuildingSummarySchema.extend({
  latestInspection: portalInspectionSchema.nullable(),
  inspections: z.array(portalInspectionSchema),
}).strict();

export const portalBuildingIdResponseSchema = z.object({
  buildingId: opaqueIdSchema,
}).strict();

export const updatePortalBuildingRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500),
  engineerNames: z.string().trim().max(500),
  expectedRevision: opaqueIdSchema.nullable(),
}).strict();

export const portalInspectionCandidateSectionSchema = z.object({
  sectionId: z.string().trim().min(1).max(240),
  scannedAt: z.iso.datetime({ offset: true }).nullable(),
  uploadCompletedAt: z.iso.datetime({ offset: true }),
  completionTag: z.string().trim().min(1).max(100),
  eligible: z.boolean(),
}).strict();

export const portalInspectionCandidateSchema = z.object({
  sourceId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500),
  sections: z.array(portalInspectionCandidateSectionSchema),
  assigned: z.boolean(),
}).strict();

export const portalInspectionCandidateListSchema = z.object({
  items: z.array(portalInspectionCandidateSchema),
}).strict();

export const attachPortalInspectionRequestSchema = z.object({
  sourceId: opaqueIdSchema,
  includedSectionIds: z.array(z.string().trim().min(1).max(240)).min(1).max(100),
  expectedRevision: opaqueIdSchema.nullable(),
}).strict();

export const updatePortalInspectionRequestSchema = z.object({
  reportStatuses: z.record(portalReportTypeSchema, portalPendingReportStatusSchema),
  expectedRevision: opaqueIdSchema,
}).strict();

export const portalAsBuiltUploadRequestSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  contentType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
}).strict();

export const portalAsBuiltUploadResponseSchema = z.object({
  uploadId: opaqueIdSchema,
  url: z.url(),
  key: z.string().min(1),
}).strict();

export const publishPortalAsBuiltRequestSchema = z.object({
  uploadId: opaqueIdSchema,
  key: z.string().min(1),
  filename: z.string().trim().min(1).max(240),
  contentType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
  expectedRevision: opaqueIdSchema,
}).strict();

export function maxReportSizeBytes(reportType: PortalReportType): number {
  if (reportType === "EVIDENCE") return 300 * 1024 * 1024;
  if (reportType === "AS_BUILT") return 50 * 1024 * 1024;
  return 100 * 1024 * 1024;
}

export const portalReportUploadRequestSchema = z.object({
  reportType: portalReportTypeSchema,
  filename: z.string().trim().min(1).max(240),
  contentType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  sizeBytes: z.number().int().positive().max(300 * 1024 * 1024),
}).strict().superRefine((data, ctx) => {
  if (data.sizeBytes > maxReportSizeBytes(data.reportType)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `File exceeds maximum size for ${data.reportType}`,
      path: ["sizeBytes"],
    });
  }
  if (data.reportType !== "AS_BUILT" && data.contentType !== "application/pdf") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only PDF format is permitted for this report category",
      path: ["contentType"],
    });
  }
});

export const portalReportUploadResponseSchema = z.object({
  uploadId: opaqueIdSchema,
  url: z.string().url(),
  key: z.string().min(1),
}).strict();

export const publishPortalReportRequestSchema = z.object({
  reportType: portalReportTypeSchema,
  uploadId: opaqueIdSchema,
  key: z.string().min(1),
  filename: z.string().trim().min(1).max(240),
  contentType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  sizeBytes: z.number().int().positive().max(300 * 1024 * 1024),
  expectedRevision: opaqueIdSchema,
}).strict().superRefine((data, ctx) => {
  if (data.sizeBytes > maxReportSizeBytes(data.reportType)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `File exceeds maximum size for ${data.reportType}`,
      path: ["sizeBytes"],
    });
  }
  if (data.reportType !== "AS_BUILT" && data.contentType !== "application/pdf") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only PDF format is permitted for this report category",
      path: ["contentType"],
    });
  }
});

export const portalReportActionRequestSchema = z.object({
  buildingId: opaqueIdSchema,
  inspectionId: opaqueIdSchema,
  reportType: portalReportTypeSchema,
  clientPrefix: z.string().trim().min(1).optional(),
}).strict();

export const portalReportPreviewResponseSchema = z.object({
  url: z.string().url(),
}).strict();

export type PortalReportType = z.infer<typeof portalReportTypeSchema>;
export type PortalReportDeliveryStatus = z.infer<typeof portalReportDeliveryStatusSchema>;
export type PortalPendingReportStatus = z.infer<typeof portalPendingReportStatusSchema>;
export type PortalReport = z.infer<typeof portalReportSchema>;
export type PortalReportUploadRequest = z.infer<typeof portalReportUploadRequestSchema>;
export type PortalReportUploadResponse = z.infer<typeof portalReportUploadResponseSchema>;
export type PublishPortalReportRequest = z.infer<typeof publishPortalReportRequestSchema>;
export type PortalReportActionRequest = z.infer<typeof portalReportActionRequestSchema>;
export type PortalReportPreviewResponse = z.infer<typeof portalReportPreviewResponseSchema>;
export type PortalInspectionSummary = z.infer<typeof portalInspectionSummarySchema>;
export type PortalInspection = z.infer<typeof portalInspectionSchema>;
export type PortalBuildingSummary = z.infer<typeof portalBuildingSummarySchema>;
export type PortalAdminBuildingSummary = z.infer<typeof portalAdminBuildingSummarySchema>;
export type PortalBuildingDetail = z.infer<typeof portalBuildingDetailSchema>;
export type PortalBuildingIdResponse = z.infer<typeof portalBuildingIdResponseSchema>;
export type PortalInspectionCandidate = z.infer<typeof portalInspectionCandidateSchema>;
export type PortalAdminClient = z.infer<typeof portalAdminClientSchema>;
export type PortalAdminReviewRow = z.infer<typeof portalAdminReviewRowSchema>;
export type PortalAdminReviewResponse = z.infer<typeof portalAdminReviewResponseSchema>;
