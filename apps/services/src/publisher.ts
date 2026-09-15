import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);

type VerifyRequest = Readonly<{ action: "VERIFY_UPLOAD"; uploadKey: string; sizeBytes: number; sha256: string }>;
type CopyRequest = Readonly<{ action: "COPY_AND_VERIFY"; uploadKey: string; sourceVersionId: string; publishedKey: string; sizeBytes: number; sha256: string }>;
type Request = VerifyRequest | CopyRequest;

function uploadKey(value: string): string {
  if (!/^uploads\/[A-Za-z0-9_-]+\/source\.pdf$/.test(value)) throw new Error("Invalid upload key");
  return value;
}

function publishedKey(value: string): string {
  if (!/^versions\/[A-Za-z0-9_-]+\.pdf$/.test(value)) throw new Error("Invalid published key");
  return value;
}

function expectedChecksum(hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("Invalid checksum");
  return Buffer.from(hex, "hex").toString("base64");
}

function missing(error: unknown): boolean {
  return error instanceof Error && ["NotFound", "NoSuchKey"].includes(error.name);
}

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && ["PreconditionFailed", "ConditionalRequestConflict"].includes(error.name);
}

function assertMetadata(head: { ContentLength?: number | undefined; ContentType?: string | undefined; ChecksumSHA256?: string | undefined; VersionId?: string | undefined }, request: { sizeBytes: number; sha256: string }) {
  if (!head.VersionId || head.ContentLength !== request.sizeBytes || head.ContentLength <= 0 || head.ContentLength > MAX_BYTES || head.ContentType !== "application/pdf" || head.ChecksumSHA256 !== expectedChecksum(request.sha256)) {
    throw new Error("Object metadata or checksum does not match the declared PDF");
  }
  return head.VersionId;
}

async function firstBytes(bucket: string, key: string, versionId: string): Promise<Uint8Array> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId, Range: "bytes=0-4", ChecksumMode: "ENABLED" }));
  if (!result.Body) throw new Error("Uploaded object has no body");
  return result.Body.transformToByteArray();
}

async function verifyUpload(bucket: string, request: VerifyRequest) {
  const key = uploadKey(request.uploadKey);
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }));
    const versionId = assertMetadata(head, request);
    const header = Buffer.from(await firstBytes(bucket, key, versionId)).toString("ascii");
    if (header !== "%PDF-") throw new Error("Uploaded object does not have a PDF header");
    return { status: "VERIFIED" as const, versionId, sizeBytes: head.ContentLength, sha256: request.sha256, contentType: "application/pdf" as const };
  } catch (error) {
    if (missing(error)) return { status: "MISSING" as const };
    throw error;
  }
}

async function verifyDestination(bucket: string, key: string, versionId: string | undefined, request: CopyRequest) {
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}), ChecksumMode: "ENABLED" }));
  return { versionId: assertMetadata(head, request), sizeBytes: head.ContentLength, sha256: request.sha256, contentType: "application/pdf" as const };
}

export async function handler(request: Request) {
  const uploadBucket = process.env.UPLOAD_BUCKET_NAME;
  const publishedBucket = process.env.PUBLISHED_BUCKET_NAME;
  if (!uploadBucket || !publishedBucket) throw new Error("Missing storage configuration");
  if (request.action === "VERIFY_UPLOAD") return verifyUpload(uploadBucket, request);

  const sourceKey = uploadKey(request.uploadKey);
  const destinationKey = publishedKey(request.publishedKey);
  const source = await s3.send(new GetObjectCommand({
    Bucket: uploadBucket,
    Key: sourceKey,
    VersionId: request.sourceVersionId,
    ChecksumMode: "ENABLED",
  }));
  if (!source.Body) throw new Error("Verified upload has no body");
  try {
    const written = await s3.send(new PutObjectCommand({
      Bucket: publishedBucket,
      Key: destinationKey,
      Body: source.Body,
      ContentLength: request.sizeBytes,
      ContentType: "application/pdf",
      CacheControl: "private, no-store",
      ContentDisposition: "inline",
      ChecksumSHA256: expectedChecksum(request.sha256),
      IfNoneMatch: "*",
    }));
    if (!written.VersionId) throw new Error("S3 publication returned no destination version");
    return verifyDestination(publishedBucket, destinationKey, written.VersionId, request);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    return verifyDestination(publishedBucket, destinationKey, undefined, request);
  }
}
