import { z } from "zod";

import { ianaTimeZoneSchema, opaqueIdSchema, reportDeliveryStatusSchema } from "./models";

export const revisionSchema = opaqueIdSchema;
export const idempotencyKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const createOrganizationRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
}).strict();
export const updateOrganizationRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  expectedRevision: revisionSchema,
}).strict();
export const createInvitationRequestSchema = z.object({ email: z.email() }).strict();
export const replaceIdentityRequestSchema = z.object({
  email: z.email(),
  expectedRevision: revisionSchema,
  confirmedUserId: opaqueIdSchema,
}).strict();
export const revisionRequestSchema = z.object({ expectedRevision: revisionSchema }).strict();

export const createProjectRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500),
  timeZone: ianaTimeZoneSchema,
}).strict();
export const updateProjectRequestSchema = createProjectRequestSchema.extend({
  expectedRevision: revisionSchema,
}).strict();
export const createInspectionRequestSchema = z.object({
  scannedAt: z.iso.datetime({ offset: true }),
}).strict();
export const updateInspectionRequestSchema = createInspectionRequestSchema.extend({
  expectedRevision: revisionSchema,
}).strict();
export const archiveRequestSchema = z.object({
  expectedRevision: revisionSchema,
  reason: z.string().trim().min(1).max(1000),
}).strict();
export const reportDraftStatusSchema = reportDeliveryStatusSchema.exclude(["PUBLISHED"]);
export const updateReportStatusRequestSchema = z.object({
  expectedRevision: revisionSchema,
  deliveryStatus: reportDraftStatusSchema,
}).strict();
export const withdrawReportRequestSchema = updateReportStatusRequestSchema.extend({
  reason: z.string().trim().min(1).max(1000),
}).strict();

export const archivePreviewSchema = z.object({
  revision: revisionSchema,
  activeInspectionCount: z.number().int().nonnegative(),
  publishedInspectionCount: z.number().int().nonnegative(),
  publishedReportCount: z.number().int().nonnegative(),
});

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  nextToken: z.string().min(1).max(4096).optional(),
});

export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;
export type ReplaceIdentityRequest = z.infer<typeof replaceIdentityRequestSchema>;
export type RevisionRequest = z.infer<typeof revisionRequestSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type CreateInspectionRequest = z.infer<typeof createInspectionRequestSchema>;
export type UpdateInspectionRequest = z.infer<typeof updateInspectionRequestSchema>;
export type ArchiveRequest = z.infer<typeof archiveRequestSchema>;
export type UpdateReportStatusRequest = z.infer<typeof updateReportStatusRequestSchema>;
export type WithdrawReportRequest = z.infer<typeof withdrawReportRequestSchema>;
export type ArchivePreview = z.infer<typeof archivePreviewSchema>;
