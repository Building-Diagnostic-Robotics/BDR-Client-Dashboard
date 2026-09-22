import { z } from "zod";

import {
  ianaTimeZoneSchema,
  opaqueIdSchema,
  reportDeliveryStatusSchema,
  reportTypeSchema,
} from "./models";

export const clientSessionResponseSchema = z.object({
  authenticated: z.literal(true),
}).strict();

export const clientMeResponseSchema = z.object({
  organization: z.object({
    displayName: z.string().trim().min(1).max(200),
  }).strict(),
}).strict();

export const clientProjectInspectionSummarySchema = z.object({
  scannedAt: z.iso.datetime({ offset: true }),
  scanTimeZone: ianaTimeZoneSchema,
  /** Rolled-up delivery status across all reports in this inspection:
   *  PUBLISHED = at least one PUBLISHED, none EXPECTED
   *  EXPECTED  = at least one EXPECTED (some may be NOT_INCLUDED/NOT_APPLICABLE)
   *  NONE      = no PUBLISHED or EXPECTED reports (all NOT_INCLUDED / NOT_APPLICABLE)
   */
  overallStatus: z.enum(["PUBLISHED", "EXPECTED", "NONE"]),
}).strict();

export const clientProjectSchema = z.object({
  projectId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500),
  timeZone: ianaTimeZoneSchema,
}).strict();

export const clientProjectSummarySchema = clientProjectSchema.extend({
  latestInspection: clientProjectInspectionSummarySchema.nullable(),
  latestReportUpdate: z.object({
    publishedAt: z.iso.datetime({ offset: true }),
    scanTimeZone: ianaTimeZoneSchema,
  }).strict().nullable(),
}).strict();

export const clientProjectListResponseSchema = z.object({
  items: z.array(clientProjectSummarySchema),
}).strict();

export const clientInspectionSchema = z.object({
  inspectionId: opaqueIdSchema,
  scannedAt: z.iso.datetime({ offset: true }),
  scanTimeZone: ianaTimeZoneSchema,
}).strict();

export const clientInspectionListResponseSchema = z.object({
  items: z.array(clientInspectionSchema),
}).strict();

export const clientReportMetadataSchema = z.object({
  reportType: reportTypeSchema,
  deliveryStatus: reportDeliveryStatusSchema,
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const clientReportListResponseSchema = z.object({
  items: z.array(clientReportMetadataSchema),
}).strict();

export const clientOrganizationDocumentMetadataSchema = z.object({
  filename: z.string().min(1).max(120),
  publishedAt: z.iso.datetime({ offset: true }),
}).strict();

export const artifactAccessResponseSchema = z.object({
  url: z.url(),
  expiresInSeconds: z.number().int().positive().max(300),
}).strict();

export const clientLogoutResponseSchema = z.object({
  logoutUrl: z.url(),
}).strict();

export type ClientSessionResponse = z.infer<typeof clientSessionResponseSchema>;
export type ClientMeResponse = z.infer<typeof clientMeResponseSchema>;
export type ClientProjectInspectionSummary = z.infer<typeof clientProjectInspectionSummarySchema>;
export type ClientProject = z.infer<typeof clientProjectSchema>;
export type ClientProjectSummary = z.infer<typeof clientProjectSummarySchema>;
export type ClientProjectListResponse = z.infer<typeof clientProjectListResponseSchema>;
export type ClientInspection = z.infer<typeof clientInspectionSchema>;
export type ClientInspectionListResponse = z.infer<typeof clientInspectionListResponseSchema>;
export type ClientReportMetadata = z.infer<typeof clientReportMetadataSchema>;
export type ClientReportListResponse = z.infer<typeof clientReportListResponseSchema>;
export type ClientOrganizationDocumentMetadata = z.infer<
  typeof clientOrganizationDocumentMetadataSchema
>;
export type ArtifactAccessResponse = z.infer<typeof artifactAccessResponseSchema>;
export type ClientLogoutResponse = z.infer<typeof clientLogoutResponseSchema>;
