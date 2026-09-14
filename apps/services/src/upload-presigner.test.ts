import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler } from "./upload-presigner";

describe("upload presigner", () => {
  beforeEach(() => {
    process.env.UPLOAD_BUCKET_NAME = "upload-bucket";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "test-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.AWS_SESSION_TOKEN = "test-session-token";
  });

  afterEach(() => {
    delete process.env.UPLOAD_BUCKET_NAME;
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  });

  it("returns the checksum as a required signed header", async () => {
    const checksum = Buffer.from("a".repeat(64), "hex").toString("base64");
    const result = await handler({
      uploadKey: "uploads/upload_0123456789abcdef/source.pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
    });

    const url = new URL(result.uploadUrl);
    expect(result.requiredHeaders["x-amz-checksum-sha256"]).toBe(checksum);
    expect(url.searchParams.get("x-amz-checksum-sha256")).toBeNull();
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain(
      "x-amz-checksum-sha256",
    );
  });
});
