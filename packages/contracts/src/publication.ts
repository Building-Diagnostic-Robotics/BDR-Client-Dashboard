import { z } from "zod";

import {
  opaqueIdSchema,
  organizationDocumentTypeSchema,
  reportDeliveryStatusSchema,
  reportTypeSchema,
} from "./models";

export const uploadStateSchema = z.enum([
  "UPLOADING",
  "READY",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
]);

export const uploadTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("INSPECTION_REPORT"),
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    inspectionId: opaqueIdSchema,
    reportType: reportTypeSchema,
  }),
  z.object({
    kind: z.literal("ORGANIZATION_DOCUMENT"),
    organizationId: opaqueIdSchema,
    documentType: organizationDocumentTypeSchema,
  }),
]);

export const createUploadSessionRequestSchema = z.object({
  target: uploadTargetSchema,
  sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.literal("application/pdf"),
  originalFilename: z.string().trim().min(1).max(255),
});

export const uploadSessionSchema = z.object({
  uploadSessionId: opaqueIdSchema,
  target: uploadTargetSchema,
  state: uploadStateSchema,
  uploadKey: z.string().regex(/^uploads\/[A-Za-z0-9_-]+\/source\.pdf$/),
  originalFilename: z.string().min(1).max(255),
  declaredSizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  declaredSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.literal("application/pdf"),
  sourceS3VersionId: z.string().min(1).max(1024).nullable(),
  artifactVersionId: opaqueIdSchema,
  publishedKey: z.string().regex(/^versions\/[A-Za-z0-9_-]+\.pdf$/),
  destinationS3VersionId: z.string().min(1).max(1024).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  absoluteExpiresAt: z.iso.datetime({ offset: true }),
  ttlExpiresAt: z.number().int().nonnegative().nullable(),
  createdByAdminId: opaqueIdSchema,
  revision: opaqueIdSchema,
  failureReason: z.string().max(1000).nullable(),
});

export const uploadSessionResponseSchema = z.object({
  uploadSession: uploadSessionSchema,
  uploadUrl: z.url().nullable(),
  requiredHeaders: z.record(z.string(), z.string()),
});
export const uploadSessionLocatorSchema = z.object({ target: uploadTargetSchema }).strict();

export const publishArtifactRequestSchema = z.object({
  uploadSessionId: opaqueIdSchema,
  expectedRevision: opaqueIdSchema,
  approvalConfirmed: z.literal(true),
  approvalStatementVersion: z.literal("bdr-approval-v1"),
});

export const publishReportRequestSchema = publishArtifactRequestSchema.extend({
  confirmedProjectId: opaqueIdSchema,
});

export const reportClassificationSchema = z
  .object({
    reportType: reportTypeSchema,
    deliveryStatus: reportDeliveryStatusSchema,
    uploadSessionId: opaqueIdSchema.nullable(),
  })
  .superRefine((classification, context) => {
    const hasUpload = classification.uploadSessionId !== null;
    if (classification.deliveryStatus === "PUBLISHED" && !hasUpload) {
      context.addIssue({
        code: "custom",
        path: ["uploadSessionId"],
        message: "Published classifications require a ready upload session",
      });
    }
    if (classification.deliveryStatus !== "PUBLISHED" && hasUpload) {
      context.addIssue({
        code: "custom",
        path: ["uploadSessionId"],
        message: "Only published classifications may reference an upload session",
      });
    }
  });

export const publishInspectionRequestSchema = z.object({
  expectedRevision: z.string().min(1).max(256),
  approvalConfirmed: z.literal(true),
  approvalStatementVersion: z.literal("bdr-approval-v1"),
  confirmedProjectId: opaqueIdSchema,
  classifications: z.array(reportClassificationSchema).length(4),
});

export const artifactAccessRequestSchema = z.object({
  disposition: z.enum(["VIEW", "DOWNLOAD"]),
});

export type UploadState = z.infer<typeof uploadStateSchema>;
export type UploadSession = z.infer<typeof uploadSessionSchema>;
export type UploadSessionResponse = z.infer<typeof uploadSessionResponseSchema>;
export type UploadSessionLocator = z.infer<typeof uploadSessionLocatorSchema>;
export type UploadTarget = z.infer<typeof uploadTargetSchema>;
export type CreateUploadSessionRequest = z.infer<
  typeof createUploadSessionRequestSchema
>;
export type PublishInspectionRequest = z.infer<
  typeof publishInspectionRequestSchema
>;
export type PublishArtifactRequest = z.infer<typeof publishArtifactRequestSchema>;
export type PublishReportRequest = z.infer<typeof publishReportRequestSchema>;
