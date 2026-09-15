import { createHash } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import type { Context } from "aws-lambda";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

const DEFAULT_MAX_EXPORT_BYTES = 128 * 1024 * 1024;

type ScheduledEvent = Readonly<{
  id?: string;
  time?: string;
}>;

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error("Audit export invocation has an invalid identifier");
  }
  return value;
}

function exportTimestamp(value: string | undefined): Date {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error("Audit export invocation has an invalid timestamp");
  }
  return date;
}

function objectKey(date: Date, invocationId: string): string {
  const [year, month, dateOfMonth] = date.toISOString().slice(0, 10).split("-");
  return `exports/${year}/${month}/${dateOfMonth}/${invocationId}.ndjson`;
}

function alreadyExported(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["PreconditionFailed", "ConditionalRequestConflict"].includes(error.name)
  );
}

export async function handler(event: ScheduledEvent, context: Context) {
  const tableName = required(process.env.AUDIT_TABLE_NAME, "AUDIT_TABLE_NAME");
  const bucketName = required(
    process.env.AUDIT_ARCHIVE_BUCKET_NAME,
    "AUDIT_ARCHIVE_BUCKET_NAME",
  );
  const maximumBytes = Number(
    process.env.MAX_AUDIT_EXPORT_BYTES ?? DEFAULT_MAX_EXPORT_BYTES,
  );
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("MAX_AUDIT_EXPORT_BYTES must be a positive integer");
  }

  const invocationId = safeIdentifier(event.id ?? context.awsRequestId);
  const key = objectKey(exportTimestamp(event.time), invocationId);
  const records: Record<string, NativeAttributeValue>[] = [];
  let lastEvaluatedKey: Record<string, NativeAttributeValue> | undefined;
  let pageCount = 0;

  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    records.push(...(page.Items ?? []));
    lastEvaluatedKey = page.LastEvaluatedKey;
    pageCount += 1;
  } while (lastEvaluatedKey);

  records.sort((left, right) => {
    const leftKey = `${String(left.PK ?? "")}\0${String(left.SK ?? "")}`;
    const rightKey = `${String(right.PK ?? "")}\0${String(right.SK ?? "")}`;
    return leftKey.localeCompare(rightKey);
  });

  const body = Buffer.from(
    records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length > 0 ? "\n" : ""),
    "utf8",
  );
  if (body.byteLength > maximumBytes) {
    throw new Error(
      `Audit export is ${body.byteLength} bytes and exceeds the configured maximum`,
    );
  }

  const checksum = createHash("sha256").update(body).digest("base64");
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: "application/x-ndjson",
        CacheControl: "private, no-store",
        ChecksumSHA256: checksum,
        IfNoneMatch: "*",
        Metadata: {
          recordCount: String(records.length),
          pageCount: String(pageCount),
        },
      }),
    );
  } catch (error) {
    if (!alreadyExported(error)) throw error;
    console.info(
      JSON.stringify({
        event: "AUDIT_EXPORT_ALREADY_EXISTS",
        key,
        invocationId,
      }),
    );
    return { status: "ALREADY_EXPORTED" as const, key };
  }

  console.info(
    JSON.stringify({
      event: "AUDIT_EXPORT_SUCCEEDED",
      key,
      recordCount: records.length,
      pageCount,
      bytes: body.byteLength,
      checksumSha256: checksum,
    }),
  );
  return {
    status: "SUCCEEDED" as const,
    key,
    recordCount: records.length,
    checksumSha256: checksum,
  };
}
