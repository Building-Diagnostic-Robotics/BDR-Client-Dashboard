# Audit and Monitoring Operations

## What the portal records

The portal writes application audit events for privileged actions, publication, archive/restore, invitation, session, and identity operations. Audit items expire from DynamoDB after six months. Expiry is retention cleanup, not an authorization control.

On the first day of every month at 06:00 UTC, EventBridge invokes the audit exporter. It writes a sorted, immutable NDJSON export to the audit archive bucket. The archive bucket uses KMS encryption, S3 versioning, and Object Lock governance retention for 184 days.

CloudTrail separately records published-object writes/deletes and audit-table writes. CloudWatch alarms cover Lambda failures/throttles, API 5xx responses, DynamoDB throttles, audit export failures, EventBridge delivery failures, and forbidden audit mutations.

## Subscribe to alarms

After deployment, retrieve the alarm topic for the intended environment:

```bash
export AWS_REGION="us-east-1"
export PORTAL_STACK="BdrClientPortal-production"
export ALARM_TOPIC_ARN="$(aws cloudformation describe-stacks \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='OperationalAlarmTopicArn'].OutputValue | [0]" --output text)"
```

Subscribe a monitored mailbox or approved incident channel through the AWS console or SNS CLI. Confirm the subscription from the delivered message before relying on it.

## Monthly review

After the scheduled export completes:

1. Check that the `AuditExporterErrors` and `AuditExportDeliveryFailures` alarms are OK.
2. Review the audit-export Lambda logs for `AUDIT_EXPORT_SUCCEEDED` and retain the export key in the monthly operations record.
3. Confirm the archive object exists under `exports/YYYY/MM/DD/` and has the expected Object Lock retention.
4. Review any `ForbiddenAuditMutations` alarm immediately. An audit event must never be updated, deleted, or batch-overwritten by an application role.

## Alarm response

- For publication or upload errors, preserve the request ID and operation IDs, then check the Admin API, publisher, and upload-presigner Lambda logs. Do not retry a publish blindly; inspect the upload session state first.
- For authentication or authorization errors, preserve the request ID, timestamp, and route only. Do not collect access tokens, authorization codes, passwords, session cookies, or complete presigned URLs in tickets.
- For an audit-export failure, do not delete the prior archive object. Investigate the scheduled event, exporter log, and archive permissions. EventBridge retries delivery twice within two hours; an object-key collision caused by a retry is handled as already exported.
- For a CloudTrail or audit-integrity alert, treat the event as a security incident. Restrict further privileged changes until the responsible operator confirms the source and scope.

## Recovery assumptions

DynamoDB point-in-time recovery and S3 versioning are enabled. V1 has no multi-region failover or contractual availability SLA. The operational recovery target is one business day, with a one-hour data-loss objective. Run a documented restoration exercise before relying on either target and after any material infrastructure change.
