import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "./publisher";

describe("publisher", () => {
  beforeEach(() => {
    process.env.UPLOAD_BUCKET_NAME = "upload-bucket";
    process.env.PUBLISHED_BUCKET_NAME = "published-bucket";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.UPLOAD_BUCKET_NAME;
    delete process.env.PUBLISHED_BUCKET_NAME;
  });

  it("uses a conditional destination write and verifies its exact S3 version", async () => {
    const checksum = Buffer.from("a".repeat(64), "hex").toString("base64");
    const commands: string[] = [];
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      commands.push(command.constructor.name);
      if (command instanceof HeadObjectCommand) {
        return { VersionId: "published-version", ContentLength: 1024, ContentType: "application/pdf", ChecksumSHA256: checksum } as never;
      }
      if (command instanceof GetObjectCommand) return { Body: {} } as never;
      if (command instanceof PutObjectCommand) return { VersionId: "published-version" } as never;
      throw new Error("Unexpected S3 command");
    });

    await expect(handler({
      action: "COPY_AND_VERIFY",
      uploadKey: "uploads/upload_1234567890123456/source.pdf",
      sourceVersionId: "source-version",
      publishedKey: "versions/reportversion_1234567890123456.pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
    })).resolves.toMatchObject({ versionId: "published-version", sizeBytes: 1024 });

    const write = send.mock.calls.map(([command]) => command).find((command) => command instanceof PutObjectCommand);
    expect(write).toBeInstanceOf(PutObjectCommand);
    expect((write as PutObjectCommand).input).toMatchObject({
      Bucket: "published-bucket",
      Key: "versions/reportversion_1234567890123456.pdf",
      IfNoneMatch: "*",
      ChecksumSHA256: checksum,
    });
    expect(commands).toEqual(["GetObjectCommand", "PutObjectCommand", "HeadObjectCommand"]);
  });

  it("verifies the existing immutable destination after a conditional-write conflict", async () => {
    const checksum = Buffer.from("a".repeat(64), "hex").toString("base64");
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand) return { Body: {} } as never;
      if (command instanceof PutObjectCommand) {
        const error = new Error("destination exists");
        error.name = "PreconditionFailed";
        throw error;
      }
      if (command instanceof HeadObjectCommand) {
        return { VersionId: "published-version", ContentLength: 1024, ContentType: "application/pdf", ChecksumSHA256: checksum } as never;
      }
      throw new Error("Unexpected S3 command");
    });

    await expect(handler({
      action: "COPY_AND_VERIFY",
      uploadKey: "uploads/upload_1234567890123456/source.pdf",
      sourceVersionId: "source-version",
      publishedKey: "versions/reportversion_1234567890123456.pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
    })).resolves.toMatchObject({ versionId: "published-version", sizeBytes: 1024 });

    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "GetObjectCommand",
      "PutObjectCommand",
      "HeadObjectCommand",
    ]);
  });
});
