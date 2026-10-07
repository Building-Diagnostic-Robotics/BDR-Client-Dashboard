import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, expect, it, vi } from "vitest";

import { signedArtifactRead } from "./buildings";

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(["VIEW", "DOWNLOAD"] as const)("signs %s access with a friendly UTF-8 name and five-minute private access", async (disposition) => {
  vi.stubEnv("DATA_BUCKET_NAME", "reports");
  vi.mocked(getSignedUrl).mockResolvedValueOnce("https://reports.example.com/signed");
  await expect(signedArtifactRead("approved/object.pdf", disposition, "École - Roof Assessment.pdf", "application/pdf"))
    .resolves.toEqual({ url: "https://reports.example.com/signed", expiresInSeconds: 300 });
  const command = vi.mocked(getSignedUrl).mock.calls[0]?.[1];
  expect(command).toBeInstanceOf(GetObjectCommand);
  if (!(command instanceof GetObjectCommand)) throw new Error("Expected artifact GET");
  expect(command.input).toMatchObject({
    Bucket: "reports", Key: "approved/object.pdf", ResponseContentType: "application/pdf",
    ResponseCacheControl: "private, no-store",
  });
  expect(command.input.ResponseContentDisposition).toContain(disposition === "VIEW" ? "inline;" : "attachment;");
  expect(command.input.ResponseContentDisposition).toContain("filename*=UTF-8''%C3%89cole%20-%20Roof%20Assessment.pdf");
  expect(vi.mocked(getSignedUrl).mock.calls[0]?.[2]).toEqual({ expiresIn: 300 });
});
