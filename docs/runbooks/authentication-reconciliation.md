# Authentication record reconciliation

This operator tool repairs individually reviewed authentication records. It does not migrate users between organizations, recreate accounts, send invitations, reset passwords, change MFA, or change the administrator guard count. Application changes and operator execution are separate steps.

## Prepared local requests

The local `tmp/auth-reconciliation/development.request.json` and `production.request.json` files specify the approved accounts and memberships from the investigation. They are ignored by Git and contain account identifiers. Review them locally; do not commit them. Preserve the development client's Easton Roofing ownership and production client's SIG Roofing ownership. The development request restores the existing administrator mapping. The production request removes only the two named unfinished administrator invitations, not an enrolled administrator.

A request contains `environment`, the expected AWS `accountId`, one client (`email`, immutable `sub`, `keepOrganizationId`, `keepUserId`, explicit `retire` membership IDs), optional `restoreAdministrator` (`email`, `sub`, existing `adminId`), and `deletePendingAdministrators` (`email`, `sub`). There are no email defaults in the command. Recreate missing local request files from the reviewed account report; do not guess identifiers.

## Operator sequence

Run the code checks first. Deploy the invitation ownership fixes to the selected environment before allowing more invitations. Stop invitation/onboarding activity for these specific accounts while applying the repair. Cognito has no atomic conditional delete: the tool checks state immediately before deleting by immutable UUID username, but an external password/MFA change can still race that final API call. Do not run onboarding for a deletion target concurrently.

From the repository root, preview development (AWS reads only):

```sh
npm run reconcile-authentication-state --workspace @bdr/infrastructure -- \
  --environment development --region us-east-1 \
  --request ../../tmp/auth-reconciliation/development.request.json \
  --snapshot ../../tmp/auth-reconciliation/development.snapshot.json
```

The npm workspace runs from `packages/infrastructure`, hence the `../../` paths. The snapshot is created exclusively with mode `0600`; an existing file is never overwritten. It contains selected identity/membership/Cognito metadata, not session tokens or passwords. Inspect the entire snapshot. Confirm the account, pools, tables, retained membership, retired rows, existing administrator profile, and unchanged guard count. Preview never writes AWS records.

Apply that exact reviewed snapshot:

```sh
npm run reconcile-authentication-state --workspace @bdr/infrastructure -- \
  --environment development --region us-east-1 \
  --snapshot ../../tmp/auth-reconciliation/development.snapshot.json --apply

npm run audit-authentication-state --workspace @bdr/infrastructure -- \
  --environment development --region us-east-1
```

Verify development client/admin sign-in and that a cross-organization invitation is rejected. Then preview production:

```sh
npm run reconcile-authentication-state --workspace @bdr/infrastructure -- \
  --environment production --region us-east-1 \
  --request ../../tmp/auth-reconciliation/production.request.json \
  --snapshot ../../tmp/auth-reconciliation/production.snapshot.json
```

Review the complete production snapshot independently. Both deletion targets must still be enabled, `FORCE_CHANGE_PASSWORD`, have no MFA, and have no identity mapping, email reservation, membership, or administrator enrollment. If either account has progressed, the tool stops. Do not bypass those checks.

```sh
npm run reconcile-authentication-state --workspace @bdr/infrastructure -- \
  --environment production --region us-east-1 \
  --snapshot ../../tmp/auth-reconciliation/production.snapshot.json --apply

npm run audit-authentication-state --workspace @bdr/infrastructure -- \
  --environment production --region us-east-1
```

Verify the retained production client can sign in to SIG Roofing, existing enrolled administrators can sign in, and the administrator count remains unchanged. Run the production browser suite yourself after deployment.

## Failure and retry

The identity/membership/email repair is one conditional DynamoDB transaction with an audit event and a durable checkpoint. It preserves the current identity, current membership, and sessions. Historical rows are retained as `REVOKED`. The reservation is aligned to the retained owner and its stale `invitationId` is removed. Development administrator repair adds only the existing `adminId` to its existing subject mapping.

Each unfinished Cognito administrator deletion has a separate intent checkpoint plus append-only intent/outcome audit events. There is no cross-service rollback: a failure may occur after the database repair or after a Cognito deletion. Retry the **same snapshot** after resolving a transient failure; the tool verifies completed state and does not delete again. Do not edit the snapshot or create a different operation after partial application. A missing Cognito user is accepted only with this operation's matching deletion checkpoint. If relevant state changed, stop and inspect the audit/checkpoints before planning a new repair.

The command uses the operator's AWS credentials, validates account/region/stack resources through CloudFormation and BFF configuration, and requires the corresponding read, conditional-write, audit-write and Cognito-delete IAM permissions. It grants no new Lambda permissions. Existing invitation email templates remain unchanged.

## Checks to run yourself

```sh
npm run typecheck --workspace @bdr/contracts
npm run typecheck --workspace @bdr/services
npm run test --workspace @bdr/services
npm run typecheck --workspace @bdr/infrastructure
npm run test --workspace @bdr/infrastructure
npm run typecheck --workspace @bdr/web
npm run typecheck:e2e
npm run test:e2e -- --project=chromium --project=webkit
```

The service suite includes targeted reconciliation, retained-access audit, client invitation ownership, and administrator invitation tests. No checks, AWS repairs, deletions, invitations, or deployments are run by implementing these files.
