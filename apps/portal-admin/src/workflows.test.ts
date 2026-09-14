import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadPdf } from "./workflows";

describe("Phase 6 upload workflow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hashes a PDF, performs one signed PUT, and completes the same upload session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bdr-upload-"));
    const file = join(directory, "assessment.pdf");
    await writeFile(file, "%PDF-1.7\nportal test\n");
    const target = {
      kind: "INSPECTION_REPORT" as const,
      organizationId: "org_0123456789abcdef",
      projectId: "project_0123456789abcdef",
      inspectionId: "inspection_0123456789abcdef",
      reportType: "ASSESSMENT" as const,
    };
    const initial = {
      uploadSessionId: "upload_0123456789abcdef",
      target,
      state: "UPLOADING" as const,
      uploadKey: "uploads/upload_0123456789abcdef/source.pdf",
      originalFilename: "assessment.pdf",
      declaredSizeBytes: 21,
      declaredSha256: "a".repeat(64),
      contentType: "application/pdf" as const,
      sourceS3VersionId: null,
      artifactVersionId: "reportversion_0123456789abcdef",
      publishedKey: "versions/reportversion_0123456789abcdef.pdf",
      destinationS3VersionId: null,
      createdAt: "2026-09-13T14:00:00.000Z",
      absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
      ttlExpiresAt: 1,
      createdByAdminId: "admin_0123456789abcdef",
      revision: "revision_0123456789abcdef",
      failureReason: null,
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ uploadSession: initial, uploadUrl: "https://upload.example.com/signed", requiredHeaders: { "content-type": "application/pdf" } })
      .mockResolvedValueOnce({ ...initial, state: "READY", sourceS3VersionId: "source-version", revision: "revision_1123456789abcdef" });
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", put);

    try {
      const result = await uploadPdf({ execute } as never, [
        "--organization", target.organizationId,
        "--project", target.projectId,
        "--inspection", target.inspectionId,
        "--type", target.reportType,
        "--file", file,
        "--idempotency-key", "upload-request-1",
      ]);
      expect(result.state).toBe("READY");
      expect(put).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
        path: `/admin/organizations/${target.organizationId}/upload-sessions/${initial.uploadSessionId}/complete`,
        body: { target },
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
