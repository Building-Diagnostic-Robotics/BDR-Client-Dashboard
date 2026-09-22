# BDR Inspections Dashboard Login and Invitations

## 1. Deploy the matching AWS stack

Deploy the existing CDK stack with its usual environment, origin, and Cognito domain context. This updates the client invitation email and selects classic hosted login without replacing the user pool. The invitation links to that environment's `/projects` page. Existing emails are not changed; future invitations and resends use the new template.

## 2. Apply development login branding

Run from the repository root with AWS credentials for the intended account:

```bash
npm run brand-client-login --workspace @bdr/infrastructure -- \
  --environment development \
  --region us-east-1
```

## 3. Apply production login branding

```bash
npm run brand-client-login --workspace @bdr/infrastructure -- \
  --environment production \
  --region us-east-1
```

Optionally append `--profile YOUR_AWS_PROFILE`. The command reads `ClientUserPoolId` and `ClientAppClientId` from the matching stack and applies both CSS and the cropped login logo. It requires `cloudformation:DescribeStacks` and `cognito-idp:SetUICustomization` for the intended resources. It does not change administrator login branding.

## 4. Publish the dashboard frontend

Deploy the updated frontend through the existing Netlify project to display the BDR Inspections Dashboard name.

## Branding and copy sources

- Login colors: `packages/infrastructure/branding/client-login.css`.
- Login logo: `apps/web/public/bdr_logo_name_cropped.png`. The dashboard retains its original logo.
- Invitation subject and HTML: client `userInvitation` in `packages/infrastructure/src/portal-stack.ts`.

Reapply the branding command whenever CSS or logo changes. Branding is managed by this command, not CDK. Cognito's hosted page controls layout and wording; only its supported CSS and logo are customized. The current email sender and seven-day temporary-password validity remain unchanged. See [AWS hosted login customization](https://docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html).

The input CSS includes an experimental 16px bottom margin to add space before the Password label and below the password input. Cognito acceptance and the resulting spacing require a visual check after applying branding. Header padding remains unchanged and no fixed container height is introduced. CSS/logo-only changes require the branding command, not an AWS stack or Netlify redeployment.

## Diagnose a callback authentication failure

Deploy the AWS stack containing the callback diagnostics, then start a fresh login from the dashboard `/projects` page in a private browser window. Use one tab; do not reopen an old Cognito login or refresh a callback URL.

If the callback returns `authentication_required`, record the UTC time and the response's `x-request-id` in the browser Network panel. Retrieve the corresponding safe reason code:

```bash
aws logs tail /aws/lambda/bdr-portal-production-client-bff \
  --since 15m \
  --region us-east-1 \
  --format short \
  --filter-pattern '"client_login_rejected"'
```

- `login_cookie_missing` / `login_cookie_mismatch`: inspect cookie delivery and overlapping or stale login attempts.
- `login_transaction_missing` / `login_transaction_state_mismatch` / `login_transaction_consumed` / `login_transaction_expired`: inspect the one-use login transaction and its ten-minute lifetime.
- `pkce_decryption` / `code_exchange` / `token_response_incomplete` / `token_verification`: isolate the indicated token-processing step before changing authentication behavior.
- `cognito_authorization_error`: Cognito returned an OAuth error rather than a successful callback.

Share only the reason code, request ID, time, and failing URL path without its query string. Do not share authorization codes, state values, cookies, passwords, or tokens. These diagnostics identify a failure stage; they do not change authentication policy or fix the underlying failure.
