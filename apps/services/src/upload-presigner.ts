import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});
const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);

type Request = Readonly<{ uploadKey: string; sizeBytes: number; sha256: string }>;

export async function handler(request: Request) {
  const bucket = process.env.UPLOAD_BUCKET_NAME;
  if (!bucket) throw new Error("Missing UPLOAD_BUCKET_NAME");
  if (!/^uploads\/[A-Za-z0-9_-]+\/source\.pdf$/.test(request.uploadKey)) throw new Error("Invalid upload key");
  if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes <= 0 || request.sizeBytes > MAX_BYTES) throw new Error("Invalid upload size");
  if (!/^[a-f0-9]{64}$/.test(request.sha256)) throw new Error("Invalid upload checksum");
  const checksum = Buffer.from(request.sha256, "hex").toString("base64");
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: request.uploadKey,
    ContentType: "application/pdf",
    ContentLength: request.sizeBytes,
    ChecksumSHA256: checksum,
    IfNoneMatch: "*",
  });
  return {
    uploadUrl: await getSignedUrl(s3, command, {
      expiresIn: 15 * 60,
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
    }),
    requiredHeaders: {
      "content-type": "application/pdf",
      "content-length": String(request.sizeBytes),
      "x-amz-checksum-sha256": checksum,
      "if-none-match": "*",
    },
  };
}
