# Controlled client organization transfer

This operator-only exception moves one confirmed client to an existing active organization. It preserves the Cognito account, immutable subject, and password. The client must sign in again. It sends no invitation and changes no buildings, reports, administrator accounts, or other client accounts. Ordinary invitations still cannot transfer users.

Implementation alone does not change AWS. No deployment is needed to run this local command. Execute tests and review the preview before applying it.

## Prepare and preview

Use the intended AWS CLI profile/session. The command exports its credentials into memory for SDK compatibility, discovers the selected stack, and checks account, region, pools, tables, initiating administrator, and client ownership. The initiating administrator must have canonical ACTIVE BDR_ADMIN access, completed TOTP, `bdr-admins` membership, and an active guard.

Copy [the request template](../examples/client-organization-transfer.example.json) into ignored `tmp/client-transfer/production.request.json`, then enter the verified account ID, client email/subject, current organization/user ID, destination organization ID, and initiating administrator email/subject. Use lower-case emails. Display names are shown in the preview for review; ownership uses IDs.

Run from the repository root. `npm --workspace` runs the script from `packages/infrastructure`, so paths below use `../../tmp/`:

```sh
npm run transfer-client-organization --workspace @bdr/infrastructure -- \
  --environment production --region us-east-1 \
  --request ../../tmp/client-transfer/production.request.json \
  --snapshot ../../tmp/client-transfer/production.snapshot.json
```

Preview reads AWS and creates an exclusive local snapshot with mode 0600. It contains selected identity/membership/org records and session metadata, never passwords or encrypted access/refresh tokens. Keep requests and snapshots private, outside Git. A previously created snapshot is never overwritten.

Review the full snapshot and printed source/destination names, email, account, resources, and initiating administrator. Preview requires one consistent ACTIVE source membership, matching immutable identity/email reservation, no destination membership, and only REVOKED historical memberships. Missing/contradictory records require separate reconciliation. It accepts legacy organization metadata without a revision; conditional checks still protect its reviewed attributes.

## Apply the reviewed snapshot

```sh
npm run transfer-client-organization --workspace @bdr/infrastructure -- \
  --environment production --region us-east-1 \
  --snapshot ../../tmp/client-transfer/production.snapshot.json --apply
```

The same AWS operator and resources must match the snapshot. The command:

1. Acquires a durable per-subject lock. An atomic conditional transaction revokes source identity/membership and records `DENIED` plus an audit event.
2. Runs existing paginated session revocation, Cognito global sign-out and temporary disablement. A projected scan also revokes orphan canonical sessions; all subject session records must be revoked before ownership changes.
3. Conditionally commits a new ACTIVE destination membership with a new organization-scoped user ID, changes the existing subject mapping/email reservation, clears old invitation linkage, and records `MOVED` plus an audit event. The source membership stays REVOKED; earlier historical memberships stay untouched.
4. Verifies destination ownership, re-enables the same Cognito user, and records `DONE` plus a completion audit. The admin guard count stays unchanged.

Each ownership transaction rechecks canonical administrator/guard state, both organizations, reviewed membership records, identity and email reservation as appropriate. No multi-service operation is atomic: a cleanup, condition, or AWS failure can leave access denied/disabled until recovery. The command does not roll back or delete records. S3 links already issued retain their existing expiry (currently five minutes); local-session revocation does not invalidate them.

## Retry and recovery

For an ordinary error, inspect the message and rerun the **same** `--snapshot ... --apply` command. Checkpoints are in the selected admin-control table, with `PK = CLIENT_TRANSFER#<hash>` and `SK = OP#<operationId>`; audits use that operation ID as request ID. Committed transactions with lost responses are recognized on retry. A retry after `MOVED` never signs out new destination sessions. A completed transfer is verified without repeating it.

Unexpected state drift stops the operation. Do not edit the snapshot, generate another transfer, manually re-enable the user, or use an invitation to bypass a conflict. Review the affected records first.

The lock has no expiry because overlapping Cognito calls cannot be fenced by DynamoDB. Normal returns/errors release it conditionally. A killed process or uncertain lock write/release can leave `SK = LOCK`. A later attempt prints its run ID. **First establish that the previous process is stopped on every machine**; only then explicitly recover that exact operation:

```sh
npm run transfer-client-organization --workspace @bdr/infrastructure -- \
  --environment production --region us-east-1 \
  --snapshot ../../tmp/client-transfer/production.snapshot.json --apply \
  --recover-lock REPORTED_RUN_ID
```

Recovery compares the prior run ID, operation ID, and snapshot digest. Never recover a live process's lock or add TTL to it. Normal concurrent attempts are rejected.

## Operator verification

Run the focused coverage and typechecks locally before apply:

```sh
npm run test --workspace @bdr/services -- src/operations/client-organization-transfer.test.ts src/auth/client-revocation.test.ts
npm run typecheck --workspace @bdr/services
npm run typecheck --workspace @bdr/infrastructure
```

After apply, run the read-only audit:

```sh
npm run audit-authentication-state --workspace @bdr/infrastructure -- \
  --environment production --region us-east-1
```

Confirm an old client session is rejected and a fresh login with the same password shows the destination organization's buildings only. Verify administrator login still works. Production browser suites and AWS execution remain operator-run.
