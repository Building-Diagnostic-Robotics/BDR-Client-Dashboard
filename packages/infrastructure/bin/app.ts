#!/usr/bin/env node
import { App } from "aws-cdk-lib";

import { PortalStack } from "../src/portal-stack";

const app = new App();
const deploymentEnvironment = app.node.tryGetContext("environment") ?? "development";
if (deploymentEnvironment !== "development" && deploymentEnvironment !== "production") {
  throw new Error("CDK context 'environment' must be development or production");
}

const portalOrigin =
  app.node.tryGetContext("portalOrigin") ??
  (deploymentEnvironment === "development" ? "http://localhost:3000" : undefined);
if (!portalOrigin) {
  throw new Error("CDK context 'portalOrigin' is required for production");
}

new PortalStack(app, `BdrClientPortal-${deploymentEnvironment}`, {
  deploymentEnvironment,
  portalOrigin,
  adminCliCallbackUrl:
    app.node.tryGetContext("adminCliCallbackUrl") ?? "http://127.0.0.1:8765/callback",
  adminCliLogoutUrl:
    app.node.tryGetContext("adminCliLogoutUrl") ?? "http://127.0.0.1:8765/logout",
  clientAuthDomainPrefix:
    app.node.tryGetContext("clientAuthDomainPrefix") ??
    `bdr-client-dashboard-${deploymentEnvironment}-replace-before-deploy`,
  adminAuthDomainPrefix:
    app.node.tryGetContext("adminAuthDomainPrefix") ??
    `bdr-admin-dashboard-${deploymentEnvironment}-replace-before-deploy`,
  env: {
    ...(process.env.CDK_DEFAULT_ACCOUNT
      ? { account: process.env.CDK_DEFAULT_ACCOUNT }
      : {}),
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "BDR client portal identity, data, API, and private document infrastructure",
});
