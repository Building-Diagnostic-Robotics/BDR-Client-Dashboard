import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { conflict } from "@bdr/domain";

export type JsonObjectSnapshot = {
  value: Record<string, unknown>;
  eTag: string | null;
};

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== "object" || !("httpStatusCode" in metadata)) return undefined;
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error
    ? error.name
    : error && typeof error === "object" && "name" in error && typeof error.name === "string"
      ? error.name
      : undefined;
}

export function isMissingS3Object(error: unknown): boolean {
  const name = errorName(error);
  return name === "NoSuchKey" || name === "NotFound" || httpStatus(error) === 404;
}

export function isS3PreconditionFailure(error: unknown): boolean {
  return errorName(error) === "PreconditionFailed" || httpStatus(error) === 412;
}

export async function readJsonObject(
  client: S3Client,
  bucketName: string,
  key: string,
): Promise<JsonObjectSnapshot> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    if (!response.ETag) {
      throw new Error(`S3 object ${key} did not include an ETag`);
    }
    const text = await response.Body?.transformToString();
    const value = JSON.parse(text ?? "") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`S3 object ${key} must contain a JSON object`);
    }
    return { value: value as Record<string, unknown>, eTag: response.ETag };
  } catch (error) {
    if (isMissingS3Object(error)) return { value: {}, eTag: null };
    throw error;
  }
}

export async function writeJsonObject(
  client: S3Client,
  bucketName: string,
  key: string,
  value: Record<string, unknown>,
  expectedETag: string | null,
): Promise<void> {
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json",
      ...(expectedETag === null
        ? { IfNoneMatch: "*" }
        : { IfMatch: expectedETag }),
    }));
  } catch (error) {
    if (isS3PreconditionFailure(error)) {
      conflict("This resource changed while you were editing it. Reload and review the latest version before trying again.");
    }
    throw error;
  }
}
