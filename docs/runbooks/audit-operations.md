# Audit Operations

The portal writes append-only audit records to the Audit DynamoDB table. New records receive a `ttlExpiresAt` value six calendar months after `occurredAt`. DynamoDB TTL is retention cleanup only; no authorization decision depends on it.

## Monthly export

EventBridge invokes the audit exporter on the first day of every month at 06:00 UTC. The exporter strongly reads every Audit-table page, sorts records by `PK` and `SK`, and writes newline-delimited JSON to:

```text
exports/YYYY/MM/DD/{eventBridgeEventId}.ndjson
```

The destination audit-archive bucket has Block Public Access, KMS encryption, versioning, and default 184-day S3 Object Lock governance retention. S3 Object Lock accepts whole days rather than calendar months, so 184 days prevents an export from expiring before six calendar months have passed. The exporter can scan the Audit table and write only under `exports/`; it cannot read archived exports. A repeated EventBridge delivery uses the same object key and completes without replacing the locked object.

The initial export limit is 128 MiB. If an export reaches that size, the job fails closed and raises the audit-export alarm. Replace the full-table NDJSON exporter with a bounded incremental or native DynamoDB export workflow before increasing the limit.

## CloudTrail evidence

The security activity trail records:

- write and delete data events under the published bucket's `versions/` prefix;
- write data events against the Audit table.

Client PDF reads are excluded. CloudTrail writes its log files under `cloudtrail/` in the locked audit-archive bucket and also sends one month of events to the environment's security activity CloudWatch log group.

## Alarms

All operational alarms publish to the stack output `OperationalAlarmTopicArn`. After each environment is deployed, subscribe the appropriate monitored email or incident destination to that SNS topic and confirm the subscription. Until a subscription is confirmed, alarms exist but nobody receives notifications.

The alarm set covers API 5xx responses, application Lambda errors, publication failures, audit-export failures, Lambda and DynamoDB throttling, EventBridge delivery failures, and direct `UpdateItem`, `DeleteItem`, or `BatchWriteItem` attempts against the Audit table.

When an audit-export alarm fires:

1. Inspect the `audit-exporter` Lambda log group using the failing request ID.
2. Correct the AWS service, permission, size-limit, or data error without editing existing audit records or archived objects.
3. Invoke the exporter again with a new unique event ID and a valid ISO timestamp.
4. Confirm a new object exists under `exports/` and the alarm returns to `OK`.

When the forbidden-audit-mutation alarm fires, preserve the CloudTrail event, identify and disable the calling identity if it was not an approved recovery action, and record the investigation outside the mutable application tables.
