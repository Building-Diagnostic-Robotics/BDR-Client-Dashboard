# Bootstrap the First Portal Administrator

Use this procedure once per environment. It is deliberately outside the Portal Admin API because an unauthenticated bootstrap endpoint would become a permanent privilege-escalation risk.

## Preconditions

- Use a named AWS administrative identity with MFA and select the intended portal environment explicitly.
- Read `AdminUserPoolId`, `AdminCliClientId`, and the Identity table name from the same CDK stack. Stop if their environment tags differ.
- Choose a new opaque `adminId`; do not derive it from an email address.

## Create and verify the Cognito administrator

1. Create the administrator in the portal administrator user pool with their individual BDR email address.
2. Add that Cognito username to `bdr-admins`.
3. Have the administrator run any `portal-admin` command and complete the Managed Login password-change and authenticator-app TOTP enrollment. The final API call will return access denied until the database mapping is installed; this is expected during bootstrap.
4. Use Cognito `AdminGetUser` to obtain the immutable `sub`. Confirm `UserMFASettingList` contains `SOFTWARE_TOKEN_MFA`. Stop if TOTP is not enrolled.

## Install the application authorization records

Write the following three Identity-table items in one DynamoDB `TransactWriteItems` request. Every `Put` must use `attribute_not_exists(PK) AND attribute_not_exists(SK)`:

```text
PK=SUBJECT#{sha256(full Cognito issuer URL)}#{sub}  SK=PROFILE
  issuer={full Cognito issuer URL}
  sub={sub}
  adminId={adminId}

PK=ADMIN#{adminId}  SK=PROFILE
  adminId={adminId}
  status=ACTIVE
  role=BDR_ADMIN
  totpEnrolled=true

PK=ADMIN_GUARD  SK=ACTIVE_COUNT
  activeAdminCount=1
```

Append an immutable `FIRST_ADMIN_BOOTSTRAPPED` event to the Audit table in the same transaction. Record the AWS operator principal, environment, administrator `sub`, `adminId`, timestamp, and change/incident reference. Do not record tokens, passwords, or the TOTP seed.

## Verify and close

1. Run `portal-admin organizations list` and confirm the Admin API creates an AdminSession and returns successfully.
2. Confirm a Cognito user outside `bdr-admins` and an unmapped user both receive access denied.
3. Retain the transaction request and CloudTrail evidence with the bootstrap record.

Never rerun this procedure to overwrite an existing guard or profile. Later administrator creation must preserve the active-administrator count transactionally.
