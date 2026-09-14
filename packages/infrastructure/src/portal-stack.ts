import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

import {
  validatePortalEnvironmentConfig,
  type PortalEnvironmentConfig,
} from "./config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceEntry = path.resolve(dirname, "../../../apps/services/src/health.ts");
const clientBffEntry = path.resolve(dirname, "../../../apps/services/src/client-bff.ts");
const adminApiEntry = path.resolve(dirname, "../../../apps/services/src/admin-api.ts");
const uploadPresignerEntry = path.resolve(dirname, "../../../apps/services/src/upload-presigner.ts");
const publisherEntry = path.resolve(dirname, "../../../apps/services/src/publisher.ts");
const artifactSignerEntry = path.resolve(dirname, "../../../apps/services/src/artifact-signer.ts");

type PortalStackProps = StackProps & PortalEnvironmentConfig;

type Tables = Readonly<{
  identity: dynamodb.Table;
  tenantData: dynamodb.Table;
  adminControl: dynamodb.Table;
  session: dynamodb.Table;
  audit: dynamodb.Table;
}>;

type Buckets = Readonly<{
  upload: s3.Bucket;
  published: s3.Bucket;
  auditArchive: s3.Bucket;
}>;

type Keys = Readonly<{
  application: kms.Key;
  upload: kms.Key;
  published: kms.Key;
  auditArchive: kms.Key;
}>;

export class PortalStack extends Stack {
  constructor(scope: Construct, id: string, props: PortalStackProps) {
    super(scope, id, props);

    const config = validatePortalEnvironmentConfig(props);
    const resourcePrefix = `bdr-portal-${config.deploymentEnvironment}`;
    Tags.of(this).add("Application", "bdr-client-dashboard");
    Tags.of(this).add("Environment", config.deploymentEnvironment);

    const keys = this.createKeys(resourcePrefix);
    const tables = this.createTables(resourcePrefix, keys.application);
    const buckets = this.createBuckets(resourcePrefix, config.portalOrigin, keys);
    const identity = this.createIdentity(config, resourcePrefix, keys.application);
    const clientAuthDomain = identity.clientDomain.baseUrl();
    const adminAuthDomain = identity.adminDomain.baseUrl();
    const functions = this.createFunctions(resourcePrefix, tables, buckets, keys);
    const apis = this.createApis(resourcePrefix, functions, identity.adminUserPool, identity.adminClient);

    functions.clientBff.addEnvironment("CLIENT_USER_POOL_ID", identity.clientUserPool.userPoolId);
    functions.clientBff.addEnvironment("CLIENT_APP_CLIENT_ID", identity.clientClient.userPoolClientId);
    functions.clientBff.addEnvironment("CLIENT_APP_SECRET_ARN", identity.clientSecret.secretArn);
    functions.clientBff.addEnvironment("PORTAL_ORIGIN", config.portalOrigin);
    functions.clientBff.addEnvironment(
      "CLIENT_ISSUER",
      `https://cognito-idp.${this.region}.amazonaws.com/${identity.clientUserPool.userPoolId}`,
    );
    functions.clientBff.addEnvironment("CLIENT_AUTH_DOMAIN", clientAuthDomain);
    functions.clientBff.addEnvironment("CLIENT_CALLBACK_URL", `${config.portalOrigin}/bff/auth/callback`);
    functions.clientBff.addEnvironment("CLIENT_LOGOUT_URL", `${config.portalOrigin}/logged-out`);
    functions.clientBff.addEnvironment("APPLICATION_KEY_ARN", keys.application.keyArn);
    functions.clientBff.addEnvironment("ARTIFACT_SIGNER_FUNCTION_NAME", functions.artifactSigner.functionName);
    identity.clientSecret.grantRead(functions.clientBff);
    keys.application.grantEncryptDecrypt(functions.clientBff);
    keys.application.grantEncryptDecrypt(functions.adminApi);
    keys.application.grantDecrypt(functions.auditExporter);

    functions.adminApi.addEnvironment(
      "ADMIN_ISSUER",
      `https://cognito-idp.${this.region}.amazonaws.com/${identity.adminUserPool.userPoolId}`,
    );
    functions.adminApi.addEnvironment("UPLOAD_PRESIGNER_FUNCTION_NAME", functions.uploadPresigner.functionName);
    functions.adminApi.addEnvironment("PUBLISHER_FUNCTION_NAME", functions.publisher.functionName);
    functions.adminApi.addEnvironment("MAX_UPLOAD_BYTES", String(100 * 1024 * 1024));
    functions.adminApi.addEnvironment("ADMIN_APP_CLIENT_ID", identity.adminClient.userPoolClientId);
    functions.adminApi.addEnvironment("ADMIN_AUTH_DOMAIN", adminAuthDomain);
    functions.adminApi.addEnvironment("ADMIN_CLI_LOGOUT_URL", config.adminCliLogoutUrl);
    functions.adminApi.addEnvironment("CLIENT_USER_POOL_ID", identity.clientUserPool.userPoolId);
    functions.adminApi.addEnvironment(
      "CLIENT_ISSUER",
      `https://cognito-idp.${this.region}.amazonaws.com/${identity.clientUserPool.userPoolId}`,
    );
    functions.adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUserGlobalSignOut",
        ],
        resources: [identity.clientUserPool.userPoolArn],
      }),
    );

    new CfnOutput(this, "ClientBffApiUrl", { value: apis.client.apiEndpoint });
    new CfnOutput(this, "AdminApiUrl", { value: apis.admin.apiEndpoint });
    new CfnOutput(this, "ClientUserPoolId", { value: identity.clientUserPool.userPoolId });
    new CfnOutput(this, "ClientAppClientId", { value: identity.clientClient.userPoolClientId });
    new CfnOutput(this, "AdminUserPoolId", { value: identity.adminUserPool.userPoolId });
    new CfnOutput(this, "AdminCliClientId", { value: identity.adminClient.userPoolClientId });
    new CfnOutput(this, "AdminAuthDomain", { value: adminAuthDomain });
    new CfnOutput(this, "AdminCliCallbackUrl", { value: config.adminCliCallbackUrl });
    new CfnOutput(this, "AdminCliLogoutUrl", { value: config.adminCliLogoutUrl });
  }

  private createKeys(prefix: string): Keys {
    const createKey = (id: string, alias: string) => {
      const key = new kms.Key(this, id, {
        alias: `alias/${prefix}-${alias}`,
        enableKeyRotation: true,
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        pendingWindow: Duration.days(30),
      });
      return key;
    };

    return {
      application: createKey("ApplicationKey", "application"),
      upload: createKey("UploadKey", "upload"),
      published: createKey("PublishedKey", "published"),
      auditArchive: createKey("AuditArchiveKey", "audit-archive"),
    };
  }

  private createTables(prefix: string, encryptionKey: kms.IKey): Tables {
    const createTable = (id: string, name: string, ttlAttribute?: string) => {
      const table = new dynamodb.Table(this, id, {
        tableName: `${prefix}-${name}`,
        partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
        encryptionKey,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        ...(ttlAttribute ? { timeToLiveAttribute: ttlAttribute } : {}),
      });
      return table;
    };

    return {
      identity: createTable("IdentityTable", "identity"),
      tenantData: createTable("TenantDataTable", "tenant-data", "ttlExpiresAt"),
      adminControl: createTable("AdminControlTable", "admin-control", "ttlExpiresAt"),
      session: createTable("SessionTable", "session", "ttlExpiresAt"),
      audit: createTable("AuditTable", "audit", "ttlExpiresAt"),
    };
  }

  private createBuckets(prefix: string, portalOrigin: string, keys: Keys): Buckets {
    const common = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      autoDeleteObjects: false,
    } as const;

    const upload = new s3.Bucket(this, "UploadBucket", {
      ...common,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: keys.upload,
      lifecycleRules: [
        {
          id: "ExpireUploadObjects",
          enabled: true,
          expiration: Duration.days(7),
          noncurrentVersionExpiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const published = new s3.Bucket(this, "PublishedBucket", {
      ...common,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: keys.published,
      cors: [
        {
          allowedOrigins: [portalOrigin],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ["Range"],
          exposedHeaders: [
            "Accept-Ranges",
            "Content-Length",
            "Content-Range",
            "Content-Type",
            "ETag",
          ],
          maxAge: 300,
        },
      ],
    });
    published.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DenyStalePresignedRequests",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:GetObject"],
        resources: [published.arnForObjects("*")],
        conditions: { NumericGreaterThan: { "s3:signatureAge": "300000" } },
      }),
    );

    const auditArchive = new s3.Bucket(this, "AuditArchiveBucket", {
      ...common,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: keys.auditArchive,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(Duration.days(365 * 3)),
    });

    return { upload, published, auditArchive };
  }

  private createIdentity(config: PortalEnvironmentConfig, prefix: string, secretKey: kms.IKey) {
    const passwordPolicy: cognito.PasswordPolicy = {
      minLength: 12,
      requireDigits: true,
      requireLowercase: true,
      requireSymbols: true,
      requireUppercase: true,
      tempPasswordValidity: Duration.days(7),
    };

    const clientUserPool = new cognito.UserPool(this, "ClientUserPool", {
      userPoolName: `${prefix}-clients`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    const clientDomain = clientUserPool.addDomain("ClientManagedLoginDomain", {
      cognitoDomain: { domainPrefix: config.clientAuthDomainPrefix },
    });
    const clientClient = clientUserPool.addClient("ClientBffAppClient", {
      userPoolClientName: `${prefix}-client-bff`,
      generateSecret: true,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: false, userPassword: false, adminUserPassword: false },
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(7),
      enableTokenRevocation: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${config.portalOrigin}/bff/auth/callback`],
        logoutUrls: [`${config.portalOrigin}/logged-out`],
      },
    });
    const clientSecret = new secretsmanager.Secret(this, "ClientAppSecret", {
      description: "Cognito confidential client secret used only by the Client BFF",
      encryptionKey: secretKey,
      secretStringValue: clientClient.userPoolClientSecret,
    });
    clientSecret.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);

    const adminUserPool = new cognito.UserPool(this, "AdminUserPool", {
      userPoolName: `${prefix}-admins`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy,
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    const adminDomain = adminUserPool.addDomain("AdminManagedLoginDomain", {
      cognitoDomain: { domainPrefix: config.adminAuthDomainPrefix },
    });
    const adminClient = adminUserPool.addClient("AdminCliAppClient", {
      userPoolClientName: `${prefix}-admin-cli`,
      generateSecret: false,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.hours(8),
      enableTokenRevocation: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.COGNITO_ADMIN,
        ],
        callbackUrls: [config.adminCliCallbackUrl],
        logoutUrls: [config.adminCliLogoutUrl],
      },
    });
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: adminUserPool.userPoolId,
      groupName: "bdr-admins",
      description: "BDR portal administrators; database role and session checks are also required",
    });

    return {
      clientUserPool,
      clientClient,
      clientSecret,
      clientDomain,
      adminUserPool,
      adminClient,
      adminDomain,
    };
  }

  private createFunctions(prefix: string, tables: Tables, buckets: Buckets, keys: Keys) {
    const createFunction = (
      id: string,
      serviceName: string,
      options: { timeout?: Duration; memorySize?: number; entry?: string } = {},
    ) => {
      const logGroup = new logs.LogGroup(this, `${id}Logs`, {
        logGroupName: `/aws/lambda/${prefix}-${serviceName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      });
      return new nodeLambda.NodejsFunction(this, id, {
        functionName: `${prefix}-${serviceName}`,
        entry: options.entry ?? serviceEntry,
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        tracing: lambda.Tracing.ACTIVE,
        timeout: options.timeout ?? Duration.seconds(10),
        memorySize: options.memorySize ?? 256,
        logGroup,
        bundling: { minify: true, sourceMap: true, target: "node22" },
        environment: {
          SERVICE_NAME: serviceName,
          IDENTITY_TABLE_NAME: tables.identity.tableName,
          TENANT_DATA_TABLE_NAME: tables.tenantData.tableName,
          ADMIN_CONTROL_TABLE_NAME: tables.adminControl.tableName,
          SESSION_TABLE_NAME: tables.session.tableName,
          AUDIT_TABLE_NAME: tables.audit.tableName,
          UPLOAD_BUCKET_NAME: buckets.upload.bucketName,
          PUBLISHED_BUCKET_NAME: buckets.published.bucketName,
        },
      });
    };

    const clientBff = createFunction("ClientBffFunction", "client-bff", { entry: clientBffEntry });
    const adminApi = createFunction("AdminApiFunction", "admin-api", { entry: adminApiEntry });
    const artifactSigner = createFunction("ArtifactSignerFunction", "artifact-signer", { entry: artifactSignerEntry });
    const uploadPresigner = createFunction("UploadPresignerFunction", "upload-presigner", { entry: uploadPresignerEntry });
    const publisher = createFunction("PublisherFunction", "publisher", {
      entry: publisherEntry,
      timeout: Duration.minutes(15),
      memorySize: 1024,
    });
    uploadPresigner.addEnvironment("MAX_UPLOAD_BYTES", String(100 * 1024 * 1024));
    publisher.addEnvironment("MAX_UPLOAD_BYTES", String(100 * 1024 * 1024));
    const auditExporter = createFunction("AuditExporterFunction", "audit-exporter", {
      timeout: Duration.minutes(15),
      memorySize: 512,
    });

    this.addDynamoPolicy(clientBff, [tables.identity, tables.tenantData], [
      "GetItem",
      "Query",
      "UpdateItem",
    ]);
    this.addDynamoPolicy(clientBff, [tables.adminControl], ["GetItem", "UpdateItem"]);
    this.addDynamoPolicy(clientBff, [tables.session], [
      "GetItem",
      "PutItem",
      "Query",
      "UpdateItem",
    ]);
    this.addDynamoPolicy(clientBff, [tables.audit], ["PutItem"]);
    this.addDynamoPolicy(
      clientBff,
      [tables.identity, tables.tenantData, tables.adminControl, tables.session, tables.audit],
      ["TransactWriteItems"],
    );
    this.addDynamoPolicy(clientBff, [tables.identity, tables.tenantData], ["ConditionCheckItem"]);
    clientBff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [artifactSigner.functionArn],
      }),
    );

    this.addDynamoPolicy(
      adminApi,
      [tables.identity, tables.tenantData, tables.adminControl, tables.session],
      ["GetItem", "PutItem", "Query", "UpdateItem"],
    );
    this.addDynamoPolicy(adminApi, [tables.audit], ["GetItem", "PutItem", "Query"]);
    this.addDynamoPolicy(
      adminApi,
      [tables.identity, tables.tenantData, tables.adminControl, tables.session, tables.audit],
      ["TransactWriteItems"],
    );
    this.addDynamoPolicy(adminApi, [tables.identity, tables.tenantData], ["ConditionCheckItem"]);
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [uploadPresigner.functionArn, publisher.functionArn],
      }),
    );

    artifactSigner.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [buckets.published.arnForObjects("versions/*")],
      }),
    );
    keys.published.grantDecrypt(artifactSigner);

    uploadPresigner.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [buckets.upload.arnForObjects("uploads/*")],
      }),
    );
    keys.upload.grantEncrypt(uploadPresigner);

    publisher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [buckets.upload.arnForObjects("uploads/*")],
      }),
    );
    publisher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
        resources: [buckets.published.arnForObjects("versions/*")],
      }),
    );
    keys.upload.grantDecrypt(publisher);
    keys.published.grantEncryptDecrypt(publisher);

    this.addDynamoPolicy(auditExporter, [tables.audit], ["DescribeTable", "Scan"]);
    buckets.auditArchive.grantPut(auditExporter, "exports/*");
    keys.auditArchive.grantEncrypt(auditExporter);

    return { clientBff, adminApi, artifactSigner, uploadPresigner, publisher, auditExporter };
  }

  private addDynamoPolicy(
    target: lambda.Function,
    tables: readonly dynamodb.Table[],
    actions: readonly string[],
  ): void {
    target.addToRolePolicy(
      new iam.PolicyStatement({
        actions: actions.map((action) => `dynamodb:${action}`),
        resources: tables.map((table) => table.tableArn),
      }),
    );
  }

  private createApis(
    prefix: string,
    functions: { clientBff: lambda.IFunction; adminApi: lambda.IFunction },
    adminUserPool: cognito.IUserPool,
    adminClient: cognito.IUserPoolClient,
  ) {
    const clientIntegration = new integrations.HttpLambdaIntegration(
      "ClientBffIntegration",
      functions.clientBff,
    );
    const client = new apigwv2.HttpApi(this, "ClientBffApi", {
      apiName: `${prefix}-client-bff`,
      description: "Same-origin Client BFF target; browser tokens are not accepted",
      defaultIntegration: clientIntegration,
      createDefaultStage: true,
    });
    this.setThrottling(client, 20, 40);

    const adminIntegration = new integrations.HttpLambdaIntegration(
      "AdminApiIntegration",
      functions.adminApi,
    );
    const adminAuthorizer = new authorizers.HttpJwtAuthorizer(
      "AdminCognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${adminUserPool.userPoolId}`,
      { jwtAudience: [adminClient.userPoolClientId] },
    );
    const admin = new apigwv2.HttpApi(this, "AdminApi", {
      apiName: `${prefix}-admin-api`,
      description: "Portal administration API; database session and role checks remain mandatory",
      defaultIntegration: adminIntegration,
      defaultAuthorizer: adminAuthorizer,
      defaultAuthorizationScopes: ["aws.cognito.signin.user.admin"],
      createDefaultStage: true,
    });
    admin.addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: new apigwv2.HttpNoneAuthorizer(),
      authorizationScopes: [],
    });
    this.setThrottling(admin, 10, 20);

    return { client, admin };
  }

  private setThrottling(api: apigwv2.HttpApi, rateLimit: number, burstLimit: number): void {
    const stage = api.defaultStage?.node.defaultChild;
    if (!(stage instanceof apigwv2.CfnStage)) {
      throw new Error("HTTP API default stage was not created");
    }
    stage.defaultRouteSettings = {
      throttlingRateLimit: rateLimit,
      throttlingBurstLimit: burstLimit,
    };
  }

}
