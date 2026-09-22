# Administrator Break-Glass Recovery

Use this procedure only when the sole active portal administrator cannot complete TOTP or when normal administrator recovery is unavailable. It is an incident procedure, not a routine login reset.

## Preconditions

- Use a named, MFA-protected AWS administrative identity with the required Cognito and DynamoDB permissions.
- Open an incident/change record before making changes.
- Do not create a shared administrator account or retain a TOTP seed as a recovery mechanism.

## Procedure

1. Confirm that normal administrator recovery cannot be completed by another active portal administrator.
2. Disable or block the affected Portal Admin Cognito identity before resetting its credentials. Record the subject, `adminId`, operator identity, and time in the incident record.
3. Revoke the affected administrator's portal sessions and Cognito tokens. The user must remain unable to access `/admin/*` during recovery.
4. Remove the old software-token MFA association through the approved Cognito recovery process. Do not mark `totpEnrolled` true in the portal profile until Cognito confirms a new software-token enrollment.
5. Restore or create the administrator identity using the first-admin bootstrap identity rules: an explicit canonical issuer/sub mapping to the existing or newly approved `adminId`, an active `BDR_ADMIN` profile, and `totpEnrolled=true` only after enrollment completes.
6. Require a new password and new TOTP enrollment. Verify a fresh CLI login, then create an audit/incident record identifying the recovery and the AWS operator.

## Verification and follow-up

- Confirm old sessions and the old MFA association cannot authorize the Admin API.
- Confirm the recovered administrator can authenticate only after the new TOTP check passes.
- Review CloudTrail and portal audit events for the recovery window.
- Record the root cause and corrective action. If ReportGen later becomes an administration identity provider, extend this runbook before enabling that path.

The current portal does not expose a routine MFA-reset endpoint. Do not perform unreviewed direct edits to portal identity, session, guard, or audit records; changes must preserve the last-administrator protection and append-only audit history.
