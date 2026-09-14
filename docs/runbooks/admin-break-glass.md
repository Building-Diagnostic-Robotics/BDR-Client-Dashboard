# Sole-Administrator TOTP Recovery

Use this procedure only when the sole active portal administrator cannot complete TOTP authentication. Routine recovery must be performed by another active portal administrator once one exists.

## Preconditions

- Use a named AWS administrative identity protected by its own phishing-resistant MFA. Never use a shared AWS or portal account.
- Open an incident record before changing Cognito or DynamoDB. Record the operator, UTC start time, environment, affected `adminId`, Cognito username, reason, and approved scope.
- Confirm the affected administrator is blocked from privileged portal access. Do not copy, escrow, or recover the old TOTP seed.
- Export the affected administrator profile and session-pointer records to the incident record before mutation. Do not include access tokens, refresh tokens, passwords, or TOTP secrets.

## Recovery

1. Resolve the environment-specific `AdminUserPoolId`, Identity table, Session table, and Audit table from the deployed CDK stack outputs and resource tags. Stop if any resource belongs to a different environment.
2. Strongly read `PK=ADMIN#{adminId}, SK=PROFILE`. Require `role=BDR_ADMIN`. Set `totpEnrolled=false` before restoring Cognito access so the application continues to deny privileged sessions.
3. Strongly query the Session table at `PK=ADMIN#{adminId}`. For every pointer, set `revokedAt` on both the pointer and `PK=ADMIN_SESSION#{originJtiHash}, SK=SESSION`. Preserve the tombstones and their TTL fields. Re-read every item and verify the revocation timestamp.
4. Invoke Cognito `AdminUserGlobalSignOut` for the affected username. Disable the old software-token preference with `AdminSetUserMFAPreference`. Do not enable SMS or email MFA.
5. Have the affected administrator sign in through the normal CLI Managed Login flow. Cognito must require a new authenticator-app TOTP association and successful code verification.
6. Independently verify Cognito reports `SOFTWARE_TOKEN_MFA` for the user. Then set the matching immutable AdminProfile's `totpEnrolled=true`. Do not change its `adminId`, issuer mapping, role, or status during recovery.
7. Append a conditional, immutable `BREAK_GLASS_ADMIN_RECOVERY` event to the Audit table. Include the incident ID, operator AWS principal ARN, affected `adminId`, UTC timestamps, invalidated-session count, Cognito actions, verification result, and request/change reference. Never update an existing audit event.

## Validation and closure

- Confirm every old access token is rejected because its AdminSession remains revoked, even if its JWT signature and expiration are still valid.
- Complete a fresh CLI login and confirm exactly one new AdminSession is created after the new TOTP challenge.
- Confirm a non-admin token, a token outside `bdr-admins`, and the previous `origin_jti` remain denied.
- Attach CloudTrail evidence for the Cognito and DynamoDB changes to the incident record.
- Record the UTC completion time and corrective work. If any revocation or audit write cannot be verified, keep the administrator blocked and escalate the incident.

Test this runbook in the development environment before the first production onboarding and every six months. Production recovery must use actual stack outputs; never paste resource names from development.
