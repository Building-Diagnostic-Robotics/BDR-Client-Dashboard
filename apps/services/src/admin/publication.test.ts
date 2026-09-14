import { InvokeCommand } from "@aws-sdk/client-lambda";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { AwsPublicationOperations } from "./publication";

const organizationId = "org_0123456789abcdef";
const projectId = "project_0123456789abcdef";
const inspectionId = "inspection_0123456789abcdef";
const uploadSessionId = "upload_0123456789abcdef";
const artifactVersionId = "reportversion_0123456789abcdef";
const adminId = "admin_0123456789abcdef";

describe("Phase 6 publication", () => {
  it("copies and verifies the PDF before committing the visible report version", async () => {
    const sequence: string[] = [];
    let transaction: Array<Record<string, unknown>> = [];
    const items: Record<string, Record<string, unknown>> = {
      META: { organizationId, displayName: "Client", status: "ACTIVE", revision: "rev_org_0123456789" },
      [`PROJECT#${projectId}`]: { organizationId, projectId, displayName: "Building", address: "1 Main St", timeZone: "America/New_York", lifecycleStatus: "ACTIVE", archivedAt: null, archivedByAdminId: null, archiveReason: null, revision: "rev_project_123456" },
      [`INSPECTION#${projectId}#${inspectionId}`]: { organizationId, projectId, inspectionId, scannedAt: "2026-09-13T10:00:00-04:00", scanTimeZone: "America/New_York", lifecycleStatus: "ACTIVE", publicationStatus: "PUBLISHED", archivedAt: null, archivedByAdminId: null, archiveReason: null, revision: "rev_inspection_1234" },
      [`REPORT#${projectId}#${inspectionId}#ASSESSMENT`]: { organizationId, projectId, inspectionId, reportId: "report_0123456789abcdef", reportType: "ASSESSMENT", deliveryStatus: "EXPECTED", currentVersionId: null, revision: "rev_report_01234567" },
      [`REPORT_UPLOAD#${projectId}#${inspectionId}#${uploadSessionId}`]: {
        uploadSessionId,
        target: { kind: "INSPECTION_REPORT", organizationId, projectId, inspectionId, reportType: "ASSESSMENT" },
        state: "READY",
        uploadKey: `uploads/${uploadSessionId}/source.pdf`,
        originalFilename: "assessment.pdf",
        declaredSizeBytes: 1024,
        declaredSha256: "a".repeat(64),
        contentType: "application/pdf",
        sourceS3VersionId: "source-version",
        artifactVersionId,
        publishedKey: `versions/${artifactVersionId}.pdf`,
        destinationS3VersionId: null,
        createdAt: "2026-09-13T14:00:00.000Z",
        absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
        ttlExpiresAt: 1,
        createdByAdminId: adminId,
        revision: "rev_upload_01234567",
        failureReason: null,
      },
    };
    const dynamoSend = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: items[(command.input.Key as { SK: string }).SK] };
      if (command instanceof UpdateCommand) { sequence.push("reserve"); return {}; }
      if (command instanceof TransactWriteCommand) {
        sequence.push("commit");
        transaction = command.input.TransactItems as Array<Record<string, unknown>>;
        return {};
      }
      throw new Error("Unexpected DynamoDB command");
    });
    const lambdaSend = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(InvokeCommand);
      sequence.push("copy");
      return { Payload: Buffer.from(JSON.stringify({ versionId: "published-version", sizeBytes: 1024, sha256: "a".repeat(64), contentType: "application/pdf" })) };
    });
    const service = new AwsPublicationOperations(
      { tenantDataTableName: "tenant", auditTableName: "audit", uploadPresignerFunctionName: "presigner", publisherFunctionName: "publisher", maxUploadBytes: 100 * 1024 * 1024 },
      { dynamo: { send: dynamoSend } as never, lambda: { send: lambdaSend } as never },
    );

    const result = await service.publishReport(organizationId, projectId, inspectionId, "ASSESSMENT", {
      uploadSessionId,
      expectedRevision: "rev_report_01234567",
      confirmedProjectId: projectId,
      approvalConfirmed: true,
      approvalStatementVersion: "bdr-approval-v1",
    }, { active: { profile: { adminId }, identity: { sub: "admin-sub" } } as never, requestId: "request-id" });

    expect(sequence).toEqual(["reserve", "copy", "commit"]);
    expect(result).toMatchObject({ reportVersionId: artifactVersionId, s3VersionId: "published-version", integrityStatus: "VERIFIED" });
    expect(transaction).toHaveLength(4);
    expect(JSON.stringify(transaction)).toContain(`versions/${artifactVersionId}.pdf`);
    expect(JSON.stringify(transaction)).toContain("summaryDigest");
  });
});
