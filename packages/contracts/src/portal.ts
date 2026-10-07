import { z } from "zod";

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

export type PortalReportType = z.infer<typeof portalReportTypeSchema>;
export type PortalReportDeliveryStatus = z.infer<typeof portalReportDeliveryStatusSchema>;
export type PortalPendingReportStatus = z.infer<typeof portalPendingReportStatusSchema>;
export type PortalReport = z.infer<typeof portalReportSchema>;
export type PortalInspectionSummary = z.infer<typeof portalInspectionSummarySchema>;
export type PortalInspection = z.infer<typeof portalInspectionSchema>;
export type PortalBuildingSummary = z.infer<typeof portalBuildingSummarySchema>;
export type PortalAdminBuildingSummary = z.infer<typeof portalAdminBuildingSummarySchema>;
export type PortalBuildingDetail = z.infer<typeof portalBuildingDetailSchema>;
export type PortalBuildingIdResponse = z.infer<typeof portalBuildingIdResponseSchema>;
export type PortalInspectionCandidate = z.infer<typeof portalInspectionCandidateSchema>;
