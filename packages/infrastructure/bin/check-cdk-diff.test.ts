import { describe, expect, it } from "vitest";
import { inspectCdkDiff } from "./check-cdk-diff";

describe("inspectCdkDiff", () => {
  it("passes when there are only routine Lambda or API Gateway updates", () => {
    const routineDiff = `
Stack BdrClientPortal-production
Resources
[~] AWS::Lambda::Function ClientBffFunction ClientBffFunction12345678
 └─ [~] Environment
     └─ [~] .Variables:
         └─ [~] .BUILD_VERSION: "v1.0" -> "v1.1"
[~] AWS::ApiGatewayV2::Api PortalClientApi PortalClientApi12345678
    `;

    const result = inspectCdkDiff(routineDiff);
    expect(result.hasDestructiveChanges).toBe(false);
    expect(result.destructiveResources).toHaveLength(0);
    expect(result.summary).toContain("No destructive changes detected");
  });

  it("detects destructive DynamoDB table replacement", () => {
    const destructiveDiff = `
Stack BdrClientPortal-production
Resources
[~] AWS::DynamoDB::Table TenantDataTable TenantDataTable12345678 (requires replacement)
    `;

    const result = inspectCdkDiff(destructiveDiff);
    expect(result.hasDestructiveChanges).toBe(true);
    expect(result.destructiveResources).toHaveLength(1);
    expect(result.destructiveResources[0]?.type).toBe("AWS::DynamoDB::Table");
    expect(result.destructiveResources[0]?.changeType).toBe("REPLACEMENT");
  });

  it("detects Cognito User Pool deletion", () => {
    const destructiveDiff = `
Stack BdrClientPortal-production
Resources
[-] AWS::Cognito::UserPool ClientUserPool ClientUserPool12345678 destroy
    `;

    const result = inspectCdkDiff(destructiveDiff);
    expect(result.hasDestructiveChanges).toBe(true);
    expect(result.destructiveResources).toHaveLength(1);
    expect(result.destructiveResources[0]?.type).toBe("AWS::Cognito::UserPool");
    expect(result.destructiveResources[0]?.changeType).toBe("DELETION");
  });

  it("detects S3 Bucket and KMS key replacements", () => {
    const destructiveDiff = `
[~] AWS::S3::Bucket UploadBucket (requires replacement)
[-] AWS::KMS::Key ApplicationKey
    `;

    const result = inspectCdkDiff(destructiveDiff);
    expect(result.hasDestructiveChanges).toBe(true);
    expect(result.destructiveResources).toHaveLength(2);
  });
});
