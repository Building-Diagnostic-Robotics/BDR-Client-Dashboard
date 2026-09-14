import { z } from "zod";

export const opaqueIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "IDs must be opaque URL-safe values");

export const organizationStatusSchema = z.enum(["ACTIVE", "SUSPENDED"]);
export const userStatusSchema = z.enum(["INVITED", "ACTIVE", "REVOKED"]);
export const lifecycleStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export const inspectionPublicationStatusSchema = z.enum(["DRAFT", "PUBLISHED"]);
export const reportTypeSchema = z.enum([
  "ASSESSMENT",
  "EVIDENCE",
  "ROOF_TAKEOFF",
  "CAPITAL_PLANNING",
]);
export const reportDeliveryStatusSchema = z.enum([
  "NOT_INCLUDED",
  "NOT_APPLICABLE",
  "EXPECTED",
  "PUBLISHED",
]);
export const organizationDocumentTypeSchema = z.literal("HOW_TO_READ");
export const organizationDocumentStatusSchema = z.enum(["DRAFT", "PUBLISHED"]);
export const integrityStatusSchema = z.literal("VERIFIED");

export const ianaTimeZoneSchema = z.string().refine(
  (value) => {
    if (!value.includes("/")) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  },
  { message: "Expected a valid IANA timezone" },
);

export const organizationSchema = z.object({
  organizationId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(200),
  status: organizationStatusSchema,
});

export const clientUserSchema = z.object({
  organizationId: opaqueIdSchema,
  userId: opaqueIdSchema,
  email: z.email(),
  normalizedEmail: z.email(),
  status: userStatusSchema,
  currentIssuer: z.url(),
  currentSub: z.string().min(1).max(2048),
  cognitoUsername: z.string().min(1).max(128),
});

const archiveMetadataFields = {
  archivedAt: z.iso.datetime().nullable(),
  archivedByAdminId: opaqueIdSchema.nullable(),
  archiveReason: z.string().trim().min(1).max(1000).nullable(),
} as const;

function validateArchiveMetadata(
  value: {
    lifecycleStatus: "ACTIVE" | "ARCHIVED";
    archivedAt: string | null;
    archivedByAdminId: string | null;
    archiveReason: string | null;
  },
  context: z.core.$RefinementCtx,
): void {
  const fields = [value.archivedAt, value.archivedByAdminId, value.archiveReason];
  const complete = fields.every((field) => field !== null);
  const empty = fields.every((field) => field === null);
  if (value.lifecycleStatus === "ARCHIVED" && !complete) {
    context.addIssue({
      code: "custom",
      path: ["lifecycleStatus"],
      message: "Archived records require complete archive metadata",
    });
  }
  if (value.lifecycleStatus === "ACTIVE" && !empty) {
    context.addIssue({
      code: "custom",
      path: ["lifecycleStatus"],
      message: "Active records cannot retain archive metadata",
    });
  }
}

export const projectSchema = z
  .object({
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    displayName: z.string().trim().min(1).max(200),
    address: z.string().trim().min(1).max(500),
    timeZone: ianaTimeZoneSchema,
    lifecycleStatus: lifecycleStatusSchema,
    ...archiveMetadataFields,
  })
  .superRefine(validateArchiveMetadata);

export const inspectionSchema = z
  .object({
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    inspectionId: opaqueIdSchema,
    scannedAt: z.iso.datetime({ offset: true }),
    scanTimeZone: ianaTimeZoneSchema,
    lifecycleStatus: lifecycleStatusSchema,
    publicationStatus: inspectionPublicationStatusSchema,
    ...archiveMetadataFields,
  })
  .superRefine(validateArchiveMetadata);

export const reportSchema = z
  .object({
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    inspectionId: opaqueIdSchema,
    reportId: opaqueIdSchema,
    reportType: reportTypeSchema,
    deliveryStatus: reportDeliveryStatusSchema,
    currentVersionId: opaqueIdSchema.nullable(),
  })
  .superRefine((report, context) => {
    const hasVersion = report.currentVersionId !== null;
    if (report.deliveryStatus === "PUBLISHED" && !hasVersion) {
      context.addIssue({
        code: "custom",
        path: ["currentVersionId"],
        message: "Published reports require a current version",
      });
    }
    if (report.deliveryStatus !== "PUBLISHED" && hasVersion) {
      context.addIssue({
        code: "custom",
        path: ["currentVersionId"],
        message: "Unpublished reports cannot expose a current version",
      });
    }
  });

const immutablePdfVersionFields = {
  organizationId: opaqueIdSchema,
  s3Key: z.string().regex(/^versions\/[A-Za-z0-9_-]+\.pdf$/),
  s3VersionId: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  contentType: z.literal("application/pdf"),
  integrityStatus: integrityStatusSchema,
  publishedAt: z.iso.datetime({ offset: true }),
  publishedByAdminId: opaqueIdSchema,
} as const;

export const reportVersionSchema = z.object({
  ...immutablePdfVersionFields,
  projectId: opaqueIdSchema,
  inspectionId: opaqueIdSchema,
  reportType: reportTypeSchema,
  reportVersionId: opaqueIdSchema,
});

export const organizationDocumentSchema = z
  .object({
    organizationId: opaqueIdSchema,
    organizationDocumentId: opaqueIdSchema,
    documentType: organizationDocumentTypeSchema,
    status: organizationDocumentStatusSchema,
    currentVersionId: opaqueIdSchema.nullable(),
  })
  .superRefine((document, context) => {
    const hasVersion = document.currentVersionId !== null;
    if (document.status === "PUBLISHED" && !hasVersion) {
      context.addIssue({
        code: "custom",
        path: ["currentVersionId"],
        message: "Published documents require a current version",
      });
    }
    if (document.status === "DRAFT" && hasVersion) {
      context.addIssue({
        code: "custom",
        path: ["currentVersionId"],
        message: "Draft documents cannot expose a current version",
      });
    }
  });

export const documentVersionSchema = z.object({
  ...immutablePdfVersionFields,
  documentType: organizationDocumentTypeSchema,
  documentVersionId: opaqueIdSchema,
});

export type Organization = z.infer<typeof organizationSchema>;
export type ClientUser = z.infer<typeof clientUserSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Inspection = z.infer<typeof inspectionSchema>;
export type Report = z.infer<typeof reportSchema>;
export type ReportVersion = z.infer<typeof reportVersionSchema>;
export type OrganizationDocument = z.infer<typeof organizationDocumentSchema>;
export type DocumentVersion = z.infer<typeof documentVersionSchema>;
export type ReportType = z.infer<typeof reportTypeSchema>;
export type ReportDeliveryStatus = z.infer<typeof reportDeliveryStatusSchema>;
