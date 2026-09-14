import {
  archiveRequestSchema,
  adminApiOpenApi,
  createInspectionRequestSchema,
  createInvitationRequestSchema,
  createOrganizationRequestSchema,
  createProjectRequestSchema,
  createUploadSessionRequestSchema,
  idempotencyKeySchema,
  listQuerySchema,
  replaceIdentityRequestSchema,
  reportTypeSchema,
  publishArtifactRequestSchema,
  publishInspectionRequestSchema,
  publishReportRequestSchema,
  revisionRequestSchema,
  updateInspectionRequestSchema,
  updateOrganizationRequestSchema,
  updateProjectRequestSchema,
  updateReportStatusRequestSchema,
  withdrawReportRequestSchema,
  uploadSessionLocatorSchema,
} from "@bdr/contracts";
import { DomainError } from "@bdr/domain";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { ZodError, type ZodType } from "zod";

import { AdminAuthService } from "./auth/admin";
import { CognitoAdminVerifier, DynamoAdminAuthStore, adminRuntimeConfig } from "./auth/aws-admin";
import { AwsPortalAdminOperations, type PortalAdminOperations } from "./admin/operations";
import { AwsPublicationOperations, type PublicationOperations } from "./admin/publication";
import { json, requestId } from "./shared/http";

type Dependencies = Readonly<{
  auth: Pick<AdminAuthService, "establish" | "authenticate" | "logout">;
  operations: PortalAdminOperations;
  publication: PublicationOperations;
}>;
type HttpHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

function operationalErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const awsError = error as Error & {
    $metadata?: { requestId?: string; httpStatusCode?: number };
    CancellationReasons?: Array<{ Code?: string; Message?: string }>;
  };
  return {
    name: error.name,
    message: error.message.slice(0, 1000),
    ...(awsError.$metadata?.requestId ? { awsRequestId: awsError.$metadata.requestId } : {}),
    ...(awsError.$metadata?.httpStatusCode
      ? { awsHttpStatusCode: awsError.$metadata.httpStatusCode }
      : {}),
    ...(awsError.CancellationReasons
      ? {
          cancellationReasons: awsError.CancellationReasons.map((reason) => ({
            code: reason.Code,
            message: reason.Message,
          })),
        }
      : {}),
  };
}

function errorResponse(error: unknown, event: APIGatewayProxyEventV2): APIGatewayProxyStructuredResultV2 {
  if (error instanceof ZodError) return json(400, { error: "invalid_request", issues: error.issues });
  if (error instanceof SyntaxError) return json(400, { error: "invalid_json" });
  if (error instanceof DomainError) {
    const statusCodes = { AUTHENTICATION_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INVALID_STATE: 400 } as const;
    const statusCode = statusCodes[error.code];
    const names = { 400: "invalid_request", 401: "authentication_required", 403: "access_denied", 404: "not_found", 409: "conflict" } as const;
    return json(statusCode, { error: names[statusCode], message: error.message });
  }
  console.error(JSON.stringify({
    requestId: requestId(event),
    error: "admin_api_failure",
    cause: operationalErrorDetails(error),
  }));
  return json(500, { error: "internal_error" });
}

function body<T>(event: APIGatewayProxyEventV2, schema: ZodType<T>): T {
  if (!event.body) return schema.parse(undefined);
  return schema.parse(JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body));
}

function idempotencyKey(event: APIGatewayProxyEventV2): string {
  return idempotencyKeySchema.parse(event.headers["idempotency-key"] ?? event.headers["Idempotency-Key"]);
}

function listInput(event: APIGatewayProxyEventV2) {
  return listQuerySchema.parse(event.queryStringParameters ?? {});
}

function match(path: string, pattern: RegExp): Array<string | undefined> | null {
  const result = pattern.exec(path);
  return result ? result.slice(1).map((value) => value === undefined ? undefined : decodeURIComponent(value)) : null;
}

export function createAdminApiHandler(dependencies: Dependencies): HttpHandler {
  return async (event) => {
    try {
      const method = event.requestContext.http.method;
      const path = event.rawPath;
      if (method === "GET" && path === "/health") return json(200, { status: "ok" });
      if (method === "POST" && path === "/admin/auth/sessions") {
        const active = await dependencies.auth.establish(event, requestId(event));
        return json(201, { absoluteExpiresAt: active.session.absoluteExpiresAt });
      }
      if (method === "DELETE" && path === "/admin/auth/session") {
        const logoutUrl = await dependencies.auth.logout(event, requestId(event));
        return json(200, { logoutUrl });
      }
      if (!path.startsWith("/admin/")) return json(404, { error: "not_found" });

      const active = await dependencies.auth.authenticate(event);
      const context = { active, requestId: requestId(event) };
      const operations = dependencies.operations;
      const publication = dependencies.publication;
      let ids: Array<string | undefined> | null;

      if (path === "/admin/openapi.json" && method === "GET") return json(200, adminApiOpenApi);

      if (path === "/admin/organizations" && method === "GET") return json(200, await operations.listOrganizations(listInput(event)));
      if (path === "/admin/organizations" && method === "POST") return json(201, await operations.createOrganization({ ...body(event, createOrganizationRequestSchema), idempotencyKey: idempotencyKey(event) }, context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)$/);
      if (ids && method === "GET") return json(200, await operations.getOrganization(ids[0]!));
      if (ids && method === "PATCH") return json(200, await operations.updateOrganization(ids[0]!, body(event, updateOrganizationRequestSchema), context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)\/users$/);
      if (ids && method === "GET") return json(200, await operations.listUsers(ids[0]!, listInput(event)));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/users\/([^/]+)\/revoke$/);
      if (ids && method === "POST") return json(200, await operations.revokeUser(ids[0]!, ids[1]!, body(event, revisionRequestSchema), context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/users\/([^/]+)\/replace-identity$/);
      if (ids && method === "POST") return json(201, await operations.replaceIdentity(ids[0]!, ids[1]!, { ...body(event, replaceIdentityRequestSchema), idempotencyKey: idempotencyKey(event) }, context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)\/invitations$/);
      if (ids && method === "GET") return json(200, await operations.listInvitations(ids[0]!, listInput(event)));
      if (ids && method === "POST") return json(201, await operations.createInvitation(ids[0]!, { ...body(event, createInvitationRequestSchema), idempotencyKey: idempotencyKey(event) }, context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/invitations\/([^/]+)\/(resend|cancel)$/);
      if (ids && method === "POST" && ids[2] === "resend") return json(200, await operations.resendInvitation(ids[0]!, ids[1]!, context));
      if (ids && method === "POST" && ids[2] === "cancel") return json(200, await operations.cancelInvitation(ids[0]!, ids[1]!, body(event, revisionRequestSchema), context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects$/);
      if (ids && method === "GET") return json(200, await operations.listProjects(ids[0]!, listInput(event)));
      if (ids && method === "POST") return json(201, await operations.createProject(ids[0]!, { ...body(event, createProjectRequestSchema), idempotencyKey: idempotencyKey(event) }, context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)$/);
      if (ids && method === "GET") return json(200, await operations.getProject(ids[0]!, ids[1]!));
      if (ids && method === "PATCH") return json(200, await operations.updateProject(ids[0]!, ids[1]!, body(event, updateProjectRequestSchema), context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/(archive-preview|archive|restore-preview|restore)$/);
      if (ids && method === "POST" && (ids[2] === "archive-preview" || ids[2] === "restore-preview")) return json(200, await operations.previewProject(ids[0]!, ids[1]!));
      if (ids && method === "POST" && ids[2] === "archive") return json(200, await operations.archiveProject(ids[0]!, ids[1]!, body(event, archiveRequestSchema), context));
      if (ids && method === "POST" && ids[2] === "restore") return json(200, await operations.restoreProject(ids[0]!, ids[1]!, body(event, revisionRequestSchema), context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/inspections$/);
      if (ids && method === "GET") return json(200, await operations.listInspections(ids[0]!, ids[1]!, listInput(event)));
      if (ids && method === "POST") return json(201, await operations.createInspection(ids[0]!, ids[1]!, { ...body(event, createInspectionRequestSchema), idempotencyKey: idempotencyKey(event) }, context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/inspections\/([^/]+)$/);
      if (ids && method === "GET") return json(200, await operations.getInspection(ids[0]!, ids[1]!, ids[2]!));
      if (ids && method === "PATCH") return json(200, await operations.updateInspection(ids[0]!, ids[1]!, ids[2]!, body(event, updateInspectionRequestSchema), context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/inspections\/([^/]+)\/(archive-preview|archive|restore-preview|restore)$/);
      if (ids && method === "POST" && (ids[3] === "archive-preview" || ids[3] === "restore-preview")) return json(200, await operations.previewInspection(ids[0]!, ids[1]!, ids[2]!));
      if (ids && method === "POST" && ids[3] === "archive") return json(200, await operations.archiveInspection(ids[0]!, ids[1]!, ids[2]!, body(event, archiveRequestSchema), context));
      if (ids && method === "POST" && ids[3] === "restore") return json(200, await operations.restoreInspection(ids[0]!, ids[1]!, ids[2]!, body(event, revisionRequestSchema), context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/inspections\/([^/]+)\/reports$/);
      if (ids && method === "GET") return json(200, { items: await operations.listReports(ids[0]!, ids[1]!, ids[2]!) });
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/inspections\/([^/]+)\/reports\/([^/]+)(?:\/(withdraw))?$/);
      if (ids && method === "PATCH" && !ids[4]) return json(200, await operations.updateReportStatus(ids[0]!, ids[1]!, ids[2]!, reportTypeSchema.parse(ids[3]), body(event, updateReportStatusRequestSchema), context));
      if (ids && method === "POST" && ids[4] === "withdraw") return json(200, await operations.withdrawReport(ids[0]!, ids[1]!, ids[2]!, reportTypeSchema.parse(ids[3]), body(event, withdrawReportRequestSchema), context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)\/documents\/how-to-read$/);
      if (ids && method === "GET") return json(200, await operations.getHowToRead(ids[0]!));
      if (ids && method === "PUT") return json(201, await operations.initializeHowToRead(ids[0]!, { idempotencyKey: idempotencyKey(event) }, context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)\/upload-sessions$/);
      if (ids && method === "POST") return json(201, await publication.createUploadSession(ids[0]!, body(event, createUploadSessionRequestSchema), idempotencyKey(event), context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/upload-sessions\/([^/]+)\/(status|complete|upload-url)$/);
      if (ids && method === "POST" && ids[2] === "status") return json(200, await publication.getUploadSession(ids[0]!, ids[1]!, body(event, uploadSessionLocatorSchema)));
      if (ids && method === "POST" && ids[2] === "complete") return json(200, await publication.completeUpload(ids[0]!, ids[1]!, body(event, uploadSessionLocatorSchema), context));
      if (ids && method === "POST" && ids[2] === "upload-url") return json(200, await publication.refreshUploadUrl(ids[0]!, ids[1]!, body(event, uploadSessionLocatorSchema), context));

      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/inspections\/([^/]+)\/publish$/);
      if (ids && method === "POST") return json(200, await publication.publishInspection(ids[0]!, ids[1]!, ids[2]!, body(event, publishInspectionRequestSchema), context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/inspections\/([^/]+)\/reports\/([^/]+)\/publish$/);
      if (ids && method === "POST") return json(200, await publication.publishReport(ids[0]!, ids[1]!, ids[2]!, ids[3]!, body(event, publishReportRequestSchema), context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/projects\/([^/]+)\/inspections\/([^/]+)\/reports\/([^/]+)\/versions$/);
      if (ids && method === "GET") return json(200, { items: await publication.reportHistory(ids[0]!, ids[1]!, ids[2]!, ids[3]!) });
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/documents\/how-to-read\/(publish|replace)$/);
      if (ids && method === "POST") return json(200, await publication.publishDocument(ids[0]!, body(event, publishArtifactRequestSchema), ids[1] === "replace", context));
      ids = match(path, /^\/admin\/organizations\/([^/]+)\/documents\/how-to-read\/versions$/);
      if (ids && method === "GET") return json(200, { items: await publication.documentHistory(ids[0]!) });

      return json(404, { error: "not_found" });
    } catch (error) {
      return errorResponse(error, event);
    }
  };
}

let runtimeHandler: HttpHandler | undefined;

export const handler: HttpHandler = async (event) => {
  if (!runtimeHandler) {
    const config = adminRuntimeConfig();
    const auth = new AdminAuthService(config, new DynamoAdminAuthStore(config), new CognitoAdminVerifier());
    const operations = new AwsPortalAdminOperations({
      tables: { identity: config.identityTableName, tenantData: config.tenantDataTableName, adminControl: config.adminControlTableName, session: config.sessionTableName, audit: config.auditTableName },
      clientUserPoolId: config.clientUserPoolId,
      clientIssuer: config.clientIssuer,
    });
    const publication = new AwsPublicationOperations({
      tenantDataTableName: config.tenantDataTableName,
      auditTableName: config.auditTableName,
      uploadPresignerFunctionName: config.uploadPresignerFunctionName,
      publisherFunctionName: config.publisherFunctionName,
      maxUploadBytes: config.maxUploadBytes,
    });
    runtimeHandler = createAdminApiHandler({ auth, operations, publication });
  }
  return runtimeHandler(event);
};
