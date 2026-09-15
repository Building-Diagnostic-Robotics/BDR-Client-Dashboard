import { createHash } from "node:crypto";

import type { ReportType } from "@bdr/contracts";

export type DynamoKey = Readonly<{ PK: string; SK: string }>;

const safeSegment = /^[A-Za-z0-9_.:@+-]+$/;

function segment(value: string, label: string): string {
  if (!value || !safeSegment.test(value) || value.includes("#")) {
    throw new TypeError(`${label} is not a safe key segment`);
  }
  return value;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function issuerHash(issuer: string): string {
  return sha256(new URL(issuer).toString());
}

export const identityKeys = {
  subject(issuer: string, sub: string): DynamoKey {
    return {
      PK: `SUBJECT#${issuerHash(issuer)}#${segment(sub, "subject")}`,
      SK: "PROFILE",
    };
  },
  adminProfile(adminId: string): DynamoKey {
    return { PK: `ADMIN#${segment(adminId, "adminId")}`, SK: "PROFILE" };
  },
  adminGuard(): DynamoKey {
    return { PK: "ADMIN_GUARD", SK: "ACTIVE_COUNT" };
  },
  emailReservation(normalizedEmail: string): DynamoKey {
    return { PK: `EMAIL#${sha256(normalizedEmail)}`, SK: "RESERVATION" };
  },
};

function organizationPk(organizationId: string): string {
  return `ORG#${segment(organizationId, "organizationId")}`;
}

export const tenantKeys = {
  organization(organizationId: string): DynamoKey {
    return { PK: organizationPk(organizationId), SK: "META" };
  },
  user(organizationId: string, userId: string): DynamoKey {
    return { PK: organizationPk(organizationId), SK: `USER#${segment(userId, "userId")}` };
  },
  project(organizationId: string, projectId: string): DynamoKey {
    return { PK: organizationPk(organizationId), SK: `PROJECT#${segment(projectId, "projectId")}` };
  },
  inspection(organizationId: string, projectId: string, inspectionId: string): DynamoKey {
    return {
      PK: organizationPk(organizationId),
      SK: `INSPECTION#${segment(projectId, "projectId")}#${segment(inspectionId, "inspectionId")}`,
    };
  },
  report(
    organizationId: string,
    projectId: string,
    inspectionId: string,
    reportType: ReportType,
  ): DynamoKey {
    return {
      PK: organizationPk(organizationId),
      SK: `REPORT#${segment(projectId, "projectId")}#${segment(inspectionId, "inspectionId")}#${reportType}`,
    };
  },
  reportVersion(
    organizationId: string,
    projectId: string,
    inspectionId: string,
    reportType: ReportType,
    reportVersionId: string,
  ): DynamoKey {
    return {
      PK: organizationPk(organizationId),
      SK: `VERSION#${segment(projectId, "projectId")}#${segment(inspectionId, "inspectionId")}#${reportType}#${segment(reportVersionId, "reportVersionId")}`,
    };
  },
  reportUpload(
    organizationId: string,
    projectId: string,
    inspectionId: string,
    uploadSessionId: string,
  ): DynamoKey {
    return {
      PK: organizationPk(organizationId),
      SK: `REPORT_UPLOAD#${segment(projectId, "projectId")}#${segment(inspectionId, "inspectionId")}#${segment(uploadSessionId, "uploadSessionId")}`,
    };
  },
  organizationDocument(organizationId: string): DynamoKey {
    return { PK: organizationPk(organizationId), SK: "DOCUMENT#HOW_TO_READ" };
  },
  documentVersion(organizationId: string, documentVersionId: string): DynamoKey {
    return {
      PK: organizationPk(organizationId),
      SK: `DOCUMENT_VERSION#HOW_TO_READ#${segment(documentVersionId, "documentVersionId")}`,
    };
  },
  documentUpload(organizationId: string, uploadSessionId: string): DynamoKey {
    return {
      PK: organizationPk(organizationId),
      SK: `DOCUMENT_UPLOAD#HOW_TO_READ#${segment(uploadSessionId, "uploadSessionId")}`,
    };
  },
};

export const adminControlKeys = {
  organizationDirectory(organizationId: string): DynamoKey {
    return {
      PK: "DIRECTORY#ORGANIZATIONS",
      SK: `ORG#${segment(organizationId, "organizationId")}`,
    };
  },
  idempotency(operationType: string, idempotencyKey: string): DynamoKey {
    return {
      PK: `IDEMPOTENCY#${segment(operationType, "operationType")}`,
      SK: segment(idempotencyKey, "idempotencyKey"),
    };
  },
  invitation(organizationId: string, invitationId: string): DynamoKey {
    return {
      PK: organizationPk(organizationId),
      SK: `INVITATION#${segment(invitationId, "invitationId")}`,
    };
  },
  migrationApproval(migrationId: string, adminId: string): DynamoKey {
    return {
      PK: `MIGRATION#${segment(migrationId, "migrationId")}`,
      SK: `APPROVAL#${segment(adminId, "adminId")}`,
    };
  },
  sourceScan(sourceScanId: string): DynamoKey {
    return { PK: "SOURCE#REPORTGEN", SK: `SCAN#${segment(sourceScanId, "sourceScanId")}` };
  },
};

export const sessionKeys = {
  clientLogin(state: string): DynamoKey {
    return { PK: `LOGIN#${sha256(state)}`, SK: "TRANSACTION" };
  },
  clientSession(sessionId: string): DynamoKey {
    return { PK: `SESSION#${sha256(sessionId)}`, SK: "SESSION" };
  },
  clientSubjectPointer(issuer: string, sub: string, sessionId: string): DynamoKey {
    return {
      PK: `SUBJECT#${issuerHash(issuer)}#${segment(sub, "subject")}`,
      SK: `SESSION#${sha256(sessionId)}`,
    };
  },
  adminSession(originJti: string): DynamoKey {
    return { PK: `ADMIN_SESSION#${sha256(originJti)}`, SK: "SESSION" };
  },
  adminPointer(adminId: string, originJti: string): DynamoKey {
    return {
      PK: `ADMIN#${segment(adminId, "adminId")}`,
      SK: `SESSION#${sha256(originJti)}`,
    };
  },
};

export const auditKeys = {
  organization(organizationId: string, occurredAt: string, eventId: string): DynamoKey {
    return {
      PK: organizationPk(organizationId),
      SK: `EVENT#${segment(occurredAt, "occurredAt")}#${segment(eventId, "eventId")}`,
    };
  },
  system(occurredAt: string, eventId: string): DynamoKey {
    return {
      PK: "SYSTEM",
      SK: `EVENT#${segment(occurredAt, "occurredAt")}#${segment(eventId, "eventId")}`,
    };
  },
};

export function auditExpiresAt(occurredAt: string): number {
  const occurred = new Date(occurredAt);
  if (Number.isNaN(occurred.getTime())) {
    throw new TypeError("occurredAt must be a valid timestamp");
  }
  const dayOfMonth = occurred.getUTCDate();
  occurred.setUTCDate(1);
  occurred.setUTCMonth(occurred.getUTCMonth() + 6);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(occurred.getUTCFullYear(), occurred.getUTCMonth() + 1, 0),
  ).getUTCDate();
  occurred.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return Math.ceil(occurred.getTime() / 1000);
}

export function publishedArtifactKey(artifactVersionId: string): string {
  return `versions/${segment(artifactVersionId, "artifactVersionId")}.pdf`;
}
