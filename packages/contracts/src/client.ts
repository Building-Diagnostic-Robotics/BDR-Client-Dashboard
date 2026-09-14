import { z } from "zod";

import {
  inspectionSchema,
  opaqueIdSchema,
  organizationSchema,
  projectSchema,
  reportSchema,
} from "./models";

export const clientMeResponseSchema = z.object({
  userId: opaqueIdSchema,
  organization: organizationSchema,
});

export const clientProjectListResponseSchema = z.object({
  items: z.array(projectSchema),
});

export const clientInspectionListResponseSchema = z.object({
  items: z.array(inspectionSchema),
});

export const clientReportMetadataSchema = reportSchema.extend({
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
});

export const clientReportListResponseSchema = z.object({
  items: z.array(clientReportMetadataSchema),
});

export const clientOrganizationDocumentMetadataSchema = z.object({
  available: z.literal(true),
  filename: z.string().min(1).max(120),
  publishedAt: z.iso.datetime({ offset: true }),
});

export const artifactAccessResponseSchema = z.object({
  url: z.url(),
  expiresInSeconds: z.number().int().positive().max(300),
});

export type ClientMeResponse = z.infer<typeof clientMeResponseSchema>;
export type ClientReportMetadata = z.infer<typeof clientReportMetadataSchema>;
export type ClientOrganizationDocumentMetadata = z.infer<
  typeof clientOrganizationDocumentMetadataSchema
>;
export type ArtifactAccessResponse = z.infer<typeof artifactAccessResponseSchema>;
