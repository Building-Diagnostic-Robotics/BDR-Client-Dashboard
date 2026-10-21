# Administrator and client security rollout

This patch changes authorization, not just the sign-in UI. Do not deploy it until the read-only compatibility report has been reviewed. No deployment, data repair, invitation, or validation command is executed by implementation.

## Checks to run locally

From the repository root:

```bash
npm run typecheck
npm run typecheck:e2e
npm run test --workspace @bdr/contracts
npm run test --workspace @bdr/domain
npm run test --workspace @bdr/services
npm run test --workspace @bdr/infrastructure
npm run build
npm run test:e2e -- --project=chromium --project=webkit
```

## Read-only compatibility report

Use operator AWS credentials for the selected environment. Resource discovery validates the stack account, region, pool, and tables. The report scans projected identity/membership/session metadata and reads Cognito users/groups; it never retrieves token ciphertext or changes records.

```bash
npm run audit-authentication-state --workspace @bdr/infrastructure -- \
  --environment development --region us-east-1
```

Repeat with `--environment production` before any production deployment. Keep the output private: it contains account and subject identifiers. DynamoDB reads are consistent per item/page; the report is not a point-in-time cross-service snapshot. Investigate changes or rerun if account administration occurs during the report.

Review all findings, particularly:

- Enabled Cognito administrators without canonical issuer/sub -> adminId mappings, ACTIVE BDR_ADMIN profiles, completed TOTP, and group membership.
- Missing/malformed or inconsistent ADMIN_GUARD active counts, orphaned profiles, and duplicate subject mappings.
- Pending/uncertain administrator creations and expired invitations.
- Revoked client memberships whose identities or browser sessions remain active, mismatched memberships, and missing user revisions.

A Cognito group membership or a legacy browser-only identity is not authorization to create a canonical administrator. No report finding is automatically repaired. Existing canonical administrators keep their adminId; extra legacy client-shaped fields on their subject record are ignored.

Any necessary repair must be prepared as a reviewed, conditional transaction with the real subject, verified Cognito enrollment, expected existing values, correct environment, and audit event. Creating a missing eligible administrator requires the subject mapping, profile, guard increment and audit entry together; do not overwrite an existing mapping or force a guard value. Never set `totpEnrolled: true` merely to make an account work. Verify actual Cognito software-token enrollment first.

## Deploy and verify

1. Confirm at least one existing operator administrator has a valid canonical mapping/profile, TOTP and group membership, and a matching guard. Keep working AWS operator access available independently of the dashboard.
2. Apply only reviewed compatibility repairs. Preserve existing identifiers and audit records; do not delete or recreate current administrator accounts.
3. Deploy development backend first (including Cognito scope/template/IAM changes), then frontend. Development still uses the shared ReportGen data bucket; do not perform report mutations against real client data.
4. Run the scenarios below with dedicated accounts. After development succeeds, repeat compatibility review and backend/frontend deployment for production.
5. Existing browser sessions made with an older hosted OAuth scope may require a fresh sign-in. Client login behavior and invitation branding are unchanged.

Administrator invitations now include the environment's `/bff/auth/admin/login` setup link and `/sign-in` dashboard link, username, temporary password and expiry instructions. The setup route starts state/nonce/PKCE-protected Cognito login; it is not a public registration endpoint. Only an authorized pending enrollment can activate a new administrator. Existing manually provisioned canonical administrators remain supported.

The invite endpoint returns INVITED only after Cognito accepts delivery and the delivery record is saved; this does not prove inbox delivery. ALREADY_ADMIN sends nothing. PENDING does not resend. The Organization tools checkbox permits a deliberate resend for a known pending subject still requiring a temporary-password change. A CREATING record without a checkpointed subject requires operator reconciliation, not a blind retry/delete. Resending replaces the temporary password. No credentials or TOTP seeds should be recorded in tickets, chat, logs, URLs or reconciliation files.

Verify with dedicated development users, then repeat appropriate smoke tests after production deployment:

- New administrator: invitation -> temporary password replacement -> hosted TOTP enrollment -> dashboard -> logout -> custom password/authenticator sign-in -> CLI login.
- Existing administrators: dashboard and CLI still work with their original identities. Missing group, disabled profile/account, missing mapping, missing TOTP or invalid guard denies access, including existing browser sessions.
- Repeating activation does not create another profile, increment the guard twice or duplicate ADMIN_ADDED. Unknown admin-pool users cannot self-register by visiting the callback.
- A dedicated client's existing session works before revocation and is denied immediately afterwards in another tab, after reload/Back, and on direct artifact access. Other organizations/users remain unaffected.
- Failed session/Cognito cleanup leaves access revoked and returns a conflict explaining that cleanup needs retry. Retry completes cleanup without reactivating the identity. No success message is displayed for an incomplete operation.
- Client email replacement checks the new email first and revokes the old account through the same lifecycle. Use only disposable accounts for destructive lifecycle tests.

The existing production Playwright suite covers client authentication; it does not by itself establish that live administrator onboarding/revocation is correct. Hosted MFA setup requires a real authenticator and explicit operator verification; local browser tests mock the handoff.

## Recovery

If an administrator cannot enter after deployment, stop further account mutations. Use the read-only report and operator credentials to inspect their canonical mapping/profile, guard, group and real MFA enrollment. Preserve the account/sub/adminId and repair only reviewed inconsistencies with conditional writes and audit history. Retest the existing administrator before continuing rollout. Do not restore permissive login-time identity creation, bypass MFA, or bulk-promote group members. Infrastructure rollback must not replace user pools or tables.
