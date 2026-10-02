import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { readJsonObject, writeJsonObject } from "./json-state";

function clientWith(send: ReturnType<typeof vi.fn>): S3Client {
  return { send } as unknown as S3Client;
}

describe("versioned S3 JSON state", () => {
  it("uses the ETag from an existing object as the write precondition", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        ETag: "\"etag-1\"",
        Body: { transformToString: vi.fn().mockResolvedValue('{"released":false}') },
      })
      .mockResolvedValueOnce({});
    const client = clientWith(send);

    const snapshot = await readJsonObject(client, "bucket", "status.json");
    await writeJsonObject(client, "bucket", "status.json", snapshot.value, snapshot.eTag);

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect((send.mock.calls[1]?.[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "bucket",
      Key: "status.json",
      IfMatch: "\"etag-1\"",
    });
    expect((send.mock.calls[1]?.[0] as PutObjectCommand).input.IfNoneMatch).toBeUndefined();
  });

  it("requires the object to remain absent when creating new JSON state", async () => {
    const missing = Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const send = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce({});
    const client = clientWith(send);

    const snapshot = await readJsonObject(client, "bucket", "org_links.json");
    await writeJsonObject(client, "bucket", "org_links.json", { organizations: [] }, snapshot.eTag);

    expect(snapshot).toEqual({ value: {}, eTag: null });
    expect((send.mock.calls[1]?.[0] as PutObjectCommand).input).toMatchObject({
      IfNoneMatch: "*",
    });
    expect((send.mock.calls[1]?.[0] as PutObjectCommand).input.IfMatch).toBeUndefined();
  });

  it("surfaces a conflicting write without retrying", async () => {
    const preconditionFailed = Object.assign(new Error("precondition failed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    });
    const send = vi.fn().mockRejectedValueOnce(preconditionFailed);

    await expect(writeJsonObject(
      clientWith(send),
      "bucket",
      "status.json",
      { released: true },
      "\"stale-etag\"",
    )).rejects.toMatchObject({
      name: "DomainError",
      code: "CONFLICT",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("propagates transient S3 read failures instead of treating them as empty state", async () => {
    const unavailable = Object.assign(new Error("unavailable"), {
      name: "ServiceUnavailable",
      $metadata: { httpStatusCode: 503 },
    });
    const send = vi.fn().mockRejectedValueOnce(unavailable);

    await expect(readJsonObject(clientWith(send), "bucket", "org_links.json"))
      .rejects.toBe(unavailable);
  });

  it("rejects malformed JSON and existing objects without an ETag", async () => {
    const malformed = vi.fn().mockResolvedValueOnce({
      ETag: "\"etag-1\"",
      Body: { transformToString: vi.fn().mockResolvedValue("not-json") },
    });
    await expect(readJsonObject(clientWith(malformed), "bucket", "status.json"))
      .rejects.toBeInstanceOf(SyntaxError);

    const noETag = vi.fn().mockResolvedValueOnce({
      Body: { transformToString: vi.fn().mockResolvedValue("{}") },
    });
    await expect(readJsonObject(clientWith(noETag), "bucket", "status.json"))
      .rejects.toThrow("did not include an ETag");
  });
});
