import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { PortalStack } from "./portal-stack";

function template(): Template {
  const app = new App();
  const stack = new PortalStack(app, "TestPortal", {
    deploymentEnvironment: "development",
    portalOrigin: "http://localhost:3000",
    clientAuthDomainPrefix: "bdr-client-development-test",
    adminAuthDomainPrefix: "bdr-admin-development-test",
    adminCliCallbackUrl: "http://127.0.0.1:8765/callback",
    adminCliLogoutUrl: "http://127.0.0.1:8765/logout",
    env: { account: "111111111111", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("portal infrastructure", () => {
  it("creates five protected on-demand tables without secondary indexes", () => {
    const rendered = template();
    rendered.resourceCountIs("AWS::DynamoDB::Table", 5);
    rendered.allResourcesProperties(
      "AWS::DynamoDB::Table",
      Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: "KMS" }),
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
      }),
    );

    const tables = rendered.findResources("AWS::DynamoDB::Table");
    for (const table of Object.values(tables)) {
      expect(table.Properties).not.toHaveProperty("GlobalSecondaryIndexes");
      expect(table.Properties).not.toHaveProperty("LocalSecondaryIndexes");
      expect(table.DeletionPolicy).toBe("RetainExceptOnCreate");
      expect(table.UpdateReplacePolicy).toBe("Retain");
    }
  });

  it("creates private versioned upload, published, and locked audit buckets", () => {
    const rendered = template();
    rendered.resourceCountIs("AWS::S3::Bucket", 3);
    rendered.allResourcesProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        BucketEncryption: Match.anyValue(),
        OwnershipControls: {
          Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    rendered.hasResourceProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        ObjectLockEnabled: true,
        ObjectLockConfiguration: Match.objectLike({
          ObjectLockEnabled: "Enabled",
          Rule: Match.anyValue(),
        }),
      }),
    );

    const policies = rendered.findResources("AWS::S3::BucketPolicy");
    expect(JSON.stringify(policies)).toContain("s3:signatureAge");
    expect(JSON.stringify(policies)).toContain("300000");
  });

  it("cleans resources from a failed initial create but retains established data", () => {
    const rendered = template();
    for (const resourceType of [
      "AWS::KMS::Key",
      "AWS::DynamoDB::Table",
      "AWS::S3::Bucket",
      "AWS::Cognito::UserPool",
      "AWS::SecretsManager::Secret",
      "AWS::Logs::LogGroup",
    ]) {
      const resources = Object.values(rendered.findResources(resourceType));
      expect(resources.length).toBeGreaterThan(0);
      for (const resource of resources) {
        expect(resource.DeletionPolicy).toBe("RetainExceptOnCreate");
        expect(resource.UpdateReplacePolicy).toBe("Retain");
      }
    }
  });

  it("separates client and TOTP-required administrator identity", () => {
    const rendered = template();
    rendered.resourceCountIs("AWS::Cognito::UserPool", 2);
    rendered.resourceCountIs("AWS::Cognito::UserPoolClient", 2);
    rendered.resourceCountIs("AWS::Cognito::UserPoolDomain", 2);
    rendered.resourceCountIs("AWS::Cognito::UserPoolGroup", 1);
    rendered.hasResourceProperties("AWS::Cognito::UserPool", {
      MfaConfiguration: "ON",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
    });
    rendered.hasResourceProperties(
      "AWS::Cognito::UserPoolClient",
      Match.objectLike({ GenerateSecret: true, EnableTokenRevocation: true }),
    );
    rendered.hasResourceProperties(
      "AWS::Cognito::UserPoolClient",
      Match.objectLike({
        GenerateSecret: false,
        EnableTokenRevocation: true,
        AllowedOAuthScopes: Match.arrayWith(["aws.cognito.signin.user.admin"]),
      }),
    );
    rendered.resourceCountIs("AWS::SecretsManager::Secret", 1);
    const adminAuthDomainOutput = rendered.toJSON().Outputs?.AdminAuthDomain?.Value;
    expect(JSON.stringify(adminAuthDomainOutput)).toContain("https://");
    expect(JSON.stringify(adminAuthDomainOutput)).toContain(
      ".auth.us-east-1.amazoncognito.com",
    );
  });

  it("creates only BFF and Admin HTTP APIs with fail-closed service roles", () => {
    const rendered = template();
    rendered.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
    rendered.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    rendered.resourceCountIs("AWS::KMS::Key", 4);
    rendered.hasResourceProperties(
      "AWS::ApiGatewayV2::Route",
      Match.objectLike({
        AuthorizationType: "JWT",
        AuthorizationScopes: ["aws.cognito.signin.user.admin"],
        RouteKey: "$default",
      }),
    );
    const routes = rendered.findResources("AWS::ApiGatewayV2::Route");
    const healthRoute = Object.values(routes).find(
      (resource) => resource.Properties?.RouteKey === "GET /health",
    );
    expect(healthRoute?.Properties).toMatchObject({ AuthorizationType: "NONE" });
    expect(healthRoute?.Properties).not.toHaveProperty("AuthorizationScopes");

    for (const serviceName of [
      "client-bff",
      "admin-api",
      "artifact-signer",
      "upload-presigner",
      "publisher",
      "audit-exporter",
    ]) {
      rendered.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: `bdr-portal-development-${serviceName}`,
      });
    }
    rendered.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        FunctionName: "bdr-portal-development-client-bff",
        Environment: {
          Variables: Match.objectLike({
            APPLICATION_KEY_ARN: Match.anyValue(),
            CLIENT_AUTH_DOMAIN: Match.anyValue(),
            CLIENT_ISSUER: Match.anyValue(),
          }),
        },
      }),
    );
    rendered.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        FunctionName: "bdr-portal-development-admin-api",
        Environment: {
          Variables: Match.objectLike({
            ADMIN_AUTH_DOMAIN: Match.anyValue(),
            ADMIN_ISSUER: Match.anyValue(),
            CLIENT_USER_POOL_ID: Match.anyValue(),
            CLIENT_ISSUER: Match.anyValue(),
          }),
        },
      }),
    );

    const lambdaFunctions = Object.values(rendered.findResources("AWS::Lambda::Function"));
    for (const functionName of ["client-bff", "admin-api"]) {
      const lambda = lambdaFunctions.find(
        (resource) =>
          resource.Properties?.FunctionName === `bdr-portal-development-${functionName}`,
      );
      const variableName = functionName === "client-bff" ? "CLIENT_AUTH_DOMAIN" : "ADMIN_AUTH_DOMAIN";
      const authDomain = lambda?.Properties?.Environment?.Variables?.[variableName];
      expect(JSON.stringify(authDomain)).toContain("https://");
      expect(JSON.stringify(authDomain)).toContain(".auth.us-east-1.amazoncognito.com");
    }

    const templateJson = JSON.stringify(rendered.toJSON());
    expect(templateJson).toContain("dynamodb:GetItem");
    expect(templateJson).toContain("dynamodb:TransactWriteItems");
    expect(templateJson).toContain("cognito-idp:AdminCreateUser");
    expect(templateJson).toContain("s3:GetObjectVersion");
    expect(templateJson).not.toContain("dynamodb:DeleteItem");
    expect(templateJson).not.toContain("s3:DeleteObject");

    const iamPolicies = Object.values(rendered.findResources("AWS::IAM::Policy"));
    const adminPolicy = iamPolicies.find((resource) =>
      JSON.stringify(resource.Properties?.Roles).includes("AdminApiFunctionServiceRole"),
    );
    const clientBffPolicy = iamPolicies.find((resource) =>
      JSON.stringify(resource.Properties?.Roles).includes("ClientBffFunctionServiceRole"),
    );
    const auditExporterPolicy = iamPolicies.find((resource) =>
      JSON.stringify(resource.Properties?.Roles).includes("AuditExporterFunctionServiceRole"),
    );
    expect(JSON.stringify(adminPolicy?.Properties?.PolicyDocument)).toContain(
      "dynamodb:ConditionCheckItem",
    );
    expect(JSON.stringify(clientBffPolicy?.Properties?.PolicyDocument)).toContain(
      "dynamodb:ConditionCheckItem",
    );
    const clientBffStatements = clientBffPolicy?.Properties?.PolicyDocument?.Statement as Array<{
      Action?: string | string[];
      Resource?: unknown;
    }>;
    const clientUpdateResources = clientBffStatements
      .filter((statement) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return actions.includes("dynamodb:UpdateItem");
      })
      .map((statement) => statement.Resource);
    const clientUpdateResourcesJson = JSON.stringify(clientUpdateResources);
    expect(clientUpdateResourcesJson).toContain("IdentityTable");
    expect(clientUpdateResourcesJson).toContain("TenantDataTable");
    expect(clientUpdateResourcesJson).toContain("AdminControlTable");
    expect(JSON.stringify(adminPolicy?.Properties?.PolicyDocument)).toContain("kms:Decrypt");
    expect(JSON.stringify(adminPolicy?.Properties?.PolicyDocument)).toContain("kms:GenerateDataKey*");
    expect(JSON.stringify(auditExporterPolicy?.Properties?.PolicyDocument)).toContain("kms:Decrypt");
  });

  it("allows only the exact portal origin to make PDF range requests", () => {
    template().hasResourceProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        CorsConfiguration: {
          CorsRules: [
            Match.objectLike({
              AllowedHeaders: ["Range"],
              AllowedMethods: ["GET", "HEAD"],
              AllowedOrigins: ["http://localhost:3000"],
            }),
          ],
        },
      }),
    );
  });
});
