import { z } from "zod";

import { opaqueIdSchema, userStatusSchema } from "./models";

export const isoInstantSchema = z.iso.datetime();

export const clientIdentitySchema = z.object({
  issuer: z.url(),
  sub: z.string().min(1).max(2048),
  userId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  status: userStatusSchema,
  invitationId: opaqueIdSchema.nullable().optional(),
});

export const adminIdentitySchema = z.object({
  issuer: z.url(),
  sub: z.string().min(1).max(2048),
  adminId: opaqueIdSchema,
});

export const adminProfileSchema = z.object({
  adminId: opaqueIdSchema,
  status: z.enum(["ACTIVE", "DISABLED"]),
  role: z.literal("BDR_ADMIN"),
  totpEnrolled: z.boolean(),
});

export const clientSessionSchema = z.object({
  sessionIdHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuer: z.url(),
  sub: z.string().min(1).max(2048),
  accessTokenCiphertext: z.string().min(1),
  refreshTokenCiphertext: z.string().min(1),
  accessTokenExpiresAt: isoInstantSchema,
  csrfTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  absoluteExpiresAt: isoInstantSchema,
  ttlExpiresAt: z.number().int().nonnegative(),
  revokedAt: isoInstantSchema.nullable(),
});

export const oauthLoginTransactionSchema = z.object({
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  pkceVerifierCiphertext: z.string().min(1),
  nonce: z.string().min(32).max(256),
  returnTo: z.string().startsWith("/"),
  absoluteExpiresAt: isoInstantSchema,
  ttlExpiresAt: z.number().int().nonnegative(),
  consumedAt: isoInstantSchema.nullable(),
});

export const adminSessionSchema = z.object({
  originJtiHash: z.string().regex(/^[a-f0-9]{64}$/),
  adminId: opaqueIdSchema,
  absoluteExpiresAt: isoInstantSchema,
  ttlExpiresAt: z.number().int().nonnegative(),
  revokedAt: isoInstantSchema.nullable(),
});

export const verifiedAdminTokenSchema = z.object({
  issuer: z.url(),
  sub: z.string().min(1).max(2048),
  clientId: z.string().min(1).max(128),
  originJti: z.string().min(1).max(2048),
  tokenUse: z.literal("access"),
  groups: z.array(z.string()),
  scopes: z.array(z.string()),
  expiresAt: isoInstantSchema,
});

export const invitationStatusSchema = z.enum([
  "PENDING",
  "ACCEPTED",
  "EXPIRED",
  "CANCELLED",
  "DELIVERY_FAILED",
]);

export const invitationSchema = z.object({
  invitationId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  email: z.email(),
  normalizedEmail: z.email(),
  status: invitationStatusSchema,
  absoluteExpiresAt: isoInstantSchema,
  ttlExpiresAt: z.number().int().nonnegative().nullable(),
  acceptedAt: isoInstantSchema.nullable(),
});

export const adminInvitationSchema = invitationSchema.extend({
  userId: opaqueIdSchema,
  cognitoUsername: z.string().min(1).max(128),
  issuer: z.url(),
  sub: z.string().min(1).max(2048).nullable(),
  revision: opaqueIdSchema,
});

export type ClientIdentity = z.infer<typeof clientIdentitySchema>;
export type AdminIdentity = z.infer<typeof adminIdentitySchema>;
export type AdminProfile = z.infer<typeof adminProfileSchema>;
export type ClientSession = z.infer<typeof clientSessionSchema>;
export type OAuthLoginTransaction = z.infer<typeof oauthLoginTransactionSchema>;
export type AdminSession = z.infer<typeof adminSessionSchema>;
export type VerifiedAdminToken = z.infer<typeof verifiedAdminTokenSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type AdminInvitation = z.infer<typeof adminInvitationSchema>;
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;
