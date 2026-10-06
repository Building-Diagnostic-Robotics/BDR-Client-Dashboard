# Cognito email uniqueness

Client and administrator email addresses are normalized to lowercase and must belong to only one Cognito user pool in an environment.

Disabled, revoked, and invited users continue to own their email address while their Cognito user exists. Delete the Cognito user before reusing that email in the other pool.

Application-managed client invitations, client email replacements, and administrator creation reject an email found in the opposite pool. Direct AWS changes and simultaneous requests can bypass or race those checks, so run this read-only audit after manual identity changes and before deployment verification.

## Development audit

```bash
npm run audit-email-overlap --workspace @bdr/infrastructure -- \
  --environment development \
  --region us-east-1
```

## Production audit

```bash
npm run audit-email-overlap --workspace @bdr/infrastructure -- \
  --environment production \
  --region us-east-1
```

## Explicit pool audit

```bash
npm run audit-email-overlap --workspace @bdr/infrastructure -- \
  --client-pool-id CLIENT_USER_POOL_ID \
  --admin-pool-id ADMIN_USER_POOL_ID \
  --region us-east-1
```

The command exits with status `0` when no overlap exists and status `2` when one or more normalized emails appear in both pools. It never modifies Cognito.
