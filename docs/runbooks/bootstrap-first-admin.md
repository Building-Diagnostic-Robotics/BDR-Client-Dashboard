# First Portal Administrator Bootstrap

Use this procedure once per environment, after the portal stack has deployed. There is intentionally no unauthenticated bootstrap API. The operator must have an MFA-protected AWS administrative identity and permission to administer the environment's Cognito pool and DynamoDB tables.

Do not use a shared account, do not record a TOTP seed, and do not put an email address, token, or generated transaction file in Git.

## Retrieve stack resources

```bash
export AWS_REGION="us-east-1"
export PORTAL_STACK="BdrClientPortal-production"
export ADMIN_EMAIL="administrator@example.com"

export ADMIN_POOL_ID="$(aws cloudformation describe-stacks \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminUserPoolId'].OutputValue | [0]" --output text)"
export ADMIN_API_URL="$(aws cloudformation describe-stacks \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminApiUrl'].OutputValue | [0]" --output text)"
export ADMIN_AUTH_DOMAIN="$(aws cloudformation describe-stacks \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminAuthDomain'].OutputValue | [0]" --output text)"
export ADMIN_CLIENT_ID="$(aws cloudformation describe-stacks \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminCliClientId'].OutputValue | [0]" --output text)"
export IDENTITY_TABLE="$(aws cloudformation describe-stack-resources \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --logical-resource-id IdentityTable \
  --query "StackResources[0].PhysicalResourceId" --output text)"
export AUDIT_TABLE="$(aws cloudformation describe-stack-resources \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --logical-resource-id AuditTable \
  --query "StackResources[0].PhysicalResourceId" --output text)"
```

Confirm the intended AWS account before continuing:

```bash
aws sts get-caller-identity
```

## Create and enroll the administrator

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$ADMIN_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL \
  --region "$AWS_REGION"

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$ADMIN_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --group-name bdr-admins \
  --region "$AWS_REGION"
```

Configure the CLI and run a harmless command. The first attempt is expected to fail with access denied after the password change and TOTP enrollment, because the portal profile records do not exist yet.

```bash
export PORTAL_ADMIN_API_URL="$ADMIN_API_URL"
export PORTAL_ADMIN_AUTH_DOMAIN="$ADMIN_AUTH_DOMAIN"
export PORTAL_ADMIN_CLIENT_ID="$ADMIN_CLIENT_ID"
export PORTAL_ADMIN_CALLBACK_URL="http://127.0.0.1:8765/callback"

npm run cli --workspace @bdr/portal-admin -- organizations list
```

Verify that Cognito now shows software-token MFA, then retrieve the immutable Cognito subject:

```bash
aws cognito-idp admin-get-user \
  --user-pool-id "$ADMIN_POOL_ID" --username "$ADMIN_EMAIL" --region "$AWS_REGION" \
  --query "{status:UserStatus,mfa:UserMFASettingList}"

export ADMIN_SUB="$(aws cognito-idp admin-get-user \
  --user-pool-id "$ADMIN_POOL_ID" --username "$ADMIN_EMAIL" --region "$AWS_REGION" \
  --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)"
```

The MFA result must include `SOFTWARE_TOKEN_MFA`. Stop if it does not.

## Create the authorization records

Create a conditional DynamoDB transaction. Every `Put` must retain `attribute_not_exists(PK) AND attribute_not_exists(SK)` so this procedure cannot overwrite an existing administrator.

```bash
export ADMIN_ID="admin_$(openssl rand -hex 16)"
export ISSUER="https://cognito-idp.${AWS_REGION}.amazonaws.com/${ADMIN_POOL_ID}"
export OPERATOR_ARN="$(aws sts get-caller-identity --query Arn --output text)"
```

Generate the reviewed transaction. It creates the subject mapping, active admin profile, guard record, and audit event in one write. Do not substitute an email address for the subject key.

```bash
node <<'NODE'
const { createHash, randomUUID } = require("node:crypto");
const { writeFileSync } = require("node:fs");

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const string = (value) => ({ S: value });
const number = (value) => ({ N: String(value) });
const map = (value) => ({
  M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, string(item)])),
});
const issuer = new URL(required("ISSUER")).toString();
const now = new Date();
const occurredAt = now.toISOString();
const expiry = new Date(now);
expiry.setUTCMonth(expiry.getUTCMonth() + 6);
const eventId = `audit_${randomUUID()}`;
const adminId = required("ADMIN_ID");
const sub = required("ADMIN_SUB");
const subjectKey = `SUBJECT#${createHash("sha256").update(issuer).digest("hex")}#${sub}`;
const condition = "attribute_not_exists(PK) AND attribute_not_exists(SK)";

writeFileSync("/tmp/bdr-first-admin-transaction.json", JSON.stringify({
  TransactItems: [
    { Put: { TableName: required("IDENTITY_TABLE"), Item: {
      PK: string(subjectKey), SK: string("PROFILE"), issuer: string(issuer), sub: string(sub), adminId: string(adminId),
    }, ConditionExpression: condition } },
    { Put: { TableName: required("IDENTITY_TABLE"), Item: {
      PK: string(`ADMIN#${adminId}`), SK: string("PROFILE"), adminId: string(adminId),
      status: string("ACTIVE"), role: string("BDR_ADMIN"), totpEnrolled: { BOOL: true },
    }, ConditionExpression: condition } },
    { Put: { TableName: required("IDENTITY_TABLE"), Item: {
      PK: string("ADMIN_GUARD"), SK: string("ACTIVE_COUNT"), activeAdminCount: number(1),
    }, ConditionExpression: condition } },
    { Put: { TableName: required("AUDIT_TABLE"), Item: {
      PK: string("SYSTEM"), SK: string(`EVENT#${occurredAt}#${eventId}`), eventId: string(eventId),
      occurredAt: string(occurredAt), ttlExpiresAt: number(Math.ceil(expiry.getTime() / 1000)),
      action: string("FIRST_ADMIN_BOOTSTRAPPED"), actorId: string(adminId), actorSub: string(sub),
      requestId: string(`bootstrap_${randomUUID()}`),
      target: map({ adminId, email: required("ADMIN_EMAIL") }),
      details: map({ operatorArn: required("OPERATOR_ARN"), changeReference: "first-admin-bootstrap" }),
    }, ConditionExpression: condition } },
  ],
}));
NODE
```

Execute the transaction:

```bash
aws dynamodb transact-write-items \
  --transact-items file:///tmp/bdr-first-admin-transaction.json \
  --region "$AWS_REGION"
```

## Verify and clean up

```bash
npm run cli --workspace @bdr/portal-admin -- organizations list
```

The command must succeed. Record the bootstrap in the change record, then securely remove the temporary transaction file. It contains identifiers and audit metadata, not passwords or TOTP secrets.

If a record already exists or the transaction fails, stop and investigate. Do not edit existing identity, guard, or audit records to force this procedure through.
