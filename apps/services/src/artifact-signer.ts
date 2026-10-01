import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

type Request = Readonly<{
  key: string;
  versionId: string;
  disposition: "VIEW" | "DOWNLOAD";
  filename: string;
}>;

export async function handler(request: Request) {
  const dataBucket = process.env.DATA_BUCKET_NAME;
  const approved = /^[A-Za-z0-9_./-]+\/reportgen\/client_portal\/approved\/[A-Z_]+\/[a-f0-9]+\.pdf$/;
  if (dataBucket && approved.test(request.key)) {
    const mode = request.disposition === "DOWNLOAD" ? "attachment" : "inline";
    const command = new GetObjectCommand({
      Bucket: dataBucket,
      Key: request.key,
      ResponseContentType: "application/pdf",
      ResponseCacheControl: "private, no-store",
      ResponseContentDisposition: `${mode}; filename="${request.filename}"`,
    });
    return { url: await getSignedUrl(s3, command, { expiresIn: 5 * 60 }), expiresInSeconds: 300 };
  }
  const bucket = process.env.PUBLISHED_BUCKET_NAME;
  if (!bucket) throw new Error("Missing PUBLISHED_BUCKET_NAME");
  if (!/^versions\/[A-Za-z0-9_-]+\.pdf$/.test(request.key) || !request.versionId) throw new Error("Invalid artifact locator");
  if (!/^[A-Za-z0-9._-]{1,116}\.pdf$/.test(request.filename)) throw new Error("Invalid download filename");
  const mode = request.disposition === "DOWNLOAD" ? "attachment" : "inline";
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: request.key,
    VersionId: request.versionId,
    ResponseContentType: "application/pdf",
    ResponseCacheControl: "private, no-store",
    ResponseContentDisposition: `${mode}; filename="${request.filename}"`,
  });
  return { url: await getSignedUrl(s3, command, { expiresIn: 5 * 60 }), expiresInSeconds: 300 };
}
