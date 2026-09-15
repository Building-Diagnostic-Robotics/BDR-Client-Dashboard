import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handler } from "./audit-exporter";

const context = { awsRequestId: "request_0123456789abcdef" } as Context;

describe("audit exporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AUDIT_TABLE_NAME;
    delete process.env.AUDIT_ARCHIVE_BUCKET_NAME;
    delete process.env.MAX_AUDIT_EXPORT_BYTES;
  });

  it("exports every scan page as sorted immutable NDJSON", async () => {
    process.env.AUDIT_TABLE_NAME = "audit";
    process.env.AUDIT_ARCHIVE_BUCKET_NAME = "archive";

    const scan = vi
      .spyOn(DynamoDBDocumentClient.prototype, "send")
      .mockResolvedValueOnce({
        Items: [{ PK: "SYSTEM", SK: "EVENT#2", action: "SECOND" }],
        LastEvaluatedKey: { PK: "SYSTEM", SK: "EVENT#2" },
      } as never)
      .mockResolvedValueOnce({
        Items: [{ PK: "ORG#one", SK: "EVENT#1", action: "FIRST" }],
      } as never);
    const put = vi
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValue({ VersionId: "object-version" } as never);

    const result = await handler(
      { id: "event_0123456789abcdef", time: "2026-09-15T06:00:00.000Z" },
      context,
    );

    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls[0]?.[0]).toBeInstanceOf(ScanCommand);
    expect(put).toHaveBeenCalledTimes(1);
    const command = put.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    if (!(command instanceof PutObjectCommand)) throw new Error("Expected S3 put");
    expect(command.input).toMatchObject({
      Bucket: "archive",
      Key: "exports/2026/09/15/event_0123456789abcdef.ndjson",
      ContentType: "application/x-ndjson",
      CacheControl: "private, no-store",
      IfNoneMatch: "*",
      Metadata: { recordCount: "2", pageCount: "2" },
    });
    expect(Buffer.from(command.input.Body as Uint8Array).toString("utf8")).toBe(
      '{"PK":"ORG#one","SK":"EVENT#1","action":"FIRST"}\n' +
        '{"PK":"SYSTEM","SK":"EVENT#2","action":"SECOND"}\n',
    );
    expect(result).toMatchObject({ status: "SUCCEEDED", recordCount: 2 });
  });

  it("treats an EventBridge retry for an existing immutable key as complete", async () => {
    process.env.AUDIT_TABLE_NAME = "audit";
    process.env.AUDIT_ARCHIVE_BUCKET_NAME = "archive";
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({} as never);
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(
      Object.assign(new Error("exists"), { name: "PreconditionFailed" }),
    );

    await expect(
      handler(
        { id: "event_0123456789abcdef", time: "2026-09-15T06:00:00.000Z" },
        context,
      ),
    ).resolves.toEqual({
      status: "ALREADY_EXPORTED",
      key: "exports/2026/09/15/event_0123456789abcdef.ndjson",
    });
  });
});
