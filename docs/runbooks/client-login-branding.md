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

Optionally append `--profile YOUR_AWS_PROFILE`. The command reads `ClientUserPoolId` and `ClientAppClientId` from the matching stack and applies both CSS and the existing dashboard logo. It requires `cloudformation:DescribeStacks` and `cognito-idp:SetUICustomization` for the intended resources. It does not change administrator login branding.

## 4. Publish the dashboard frontend

Deploy the updated frontend through the existing Netlify project to display the BDR Inspections Dashboard name.

## Branding and copy sources

- Login colors: `packages/infrastructure/branding/client-login.css`.
- Logo: `apps/web/public/bdr_logo_name.png`.
- Invitation subject and HTML: client `userInvitation` in `packages/infrastructure/src/portal-stack.ts`.

Reapply the branding command whenever CSS or logo changes. Branding is managed by this command, not CDK. Cognito's hosted page controls layout and wording; only its supported CSS and logo are customized. The current email sender and seven-day temporary-password validity remain unchanged. See [AWS hosted login customization](https://docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html).
