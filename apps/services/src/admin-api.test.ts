import { describe, expect, it, vi } from "vitest";

import { authenticationRequired } from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

import { createAdminApiHandler } from "./admin-api";
import type { PortalAdminOperations } from "./admin/operations";
import type { PublicationOperations } from "./admin/publication";

function event(method: string, rawPath: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: { requestId: "request", http: { method } },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function operations(overrides: Partial<PortalAdminOperations> = {}): PortalAdminOperations {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return vi.fn(async () => ({ items: [] }));
    },
  }) as PortalAdminOperations;
}

function publication(overrides: Partial<PublicationOperations> = {}): PublicationOperations {
  return new Proxy(overrides, { get(target, property) { if (property in target) return target[property as keyof typeof target]; return vi.fn(); } }) as PublicationOperations;
}

const active = {
  token: {}, session: {}, identity: { sub: "admin-sub" }, profile: { adminId: "admin_1234567890123456" },
} as never;

describe("admin API Phase 5 routes", () => {
  it("keeps health public and authenticates every admin resource route", async () => {
    const auth = { establish: vi.fn(), logout: vi.fn(), authenticate: vi.fn(async () => authenticationRequired()) };
    const handler = createAdminApiHandler({ auth, operations: operations(), publication: publication() });
    await expect(handler(event("GET", "/health"))).resolves.toMatchObject({ statusCode: 200 });
    await expect(handler(event("GET", "/admin/organizations"))).resolves.toMatchObject({ statusCode: 401 });
    expect(auth.authenticate).toHaveBeenCalledOnce();
  });

  it("logs safe AWS failure metadata without changing the generic 500 response", async () => {
    const failure = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      $metadata: { requestId: "aws-request", httpStatusCode: 400 },
      CancellationReasons: [{ Code: "ConditionalCheckFailed", Message: "condition failed" }],
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createAdminApiHandler({
      auth: { establish: vi.fn(async () => { throw failure; }), logout: vi.fn(), authenticate: vi.fn() },
      operations: operations(),
      publication: publication(),
    });

    const response = await handler(event("POST", "/admin/auth/sessions"));

    expect(response).toMatchObject({ statusCode: 500 });
    expect(response.body).toBe(JSON.stringify({ error: "internal_error" }));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("TransactionCanceledException"));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("aws-request"));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("ConditionalCheckFailed"));
    errorLog.mockRestore();
  });

  it("creates a project only through an organization-scoped route", async () => {
    const createProject = vi.fn(async () => ({ projectId: "project_1234567890123456" }));
    const handler = createAdminApiHandler({
      auth: { establish: vi.fn(), logout: vi.fn(), authenticate: vi.fn(async () => active) },
      operations: operations({ createProject: createProject as never }),
      publication: publication(),
    });
    const response = await handler(event(
      "POST",
      "/admin/organizations/org_1234567890123456/projects",
      { displayName: "Main Building", address: "1 Main St", timeZone: "America/New_York" },
      { "idempotency-key": "request_1234567890123456" },
    ));
    expect(response.statusCode).toBe(201);
    expect(createProject).toHaveBeenCalledWith(
      "org_1234567890123456",
      expect.objectContaining({ timeZone: "America/New_York", idempotencyKey: "request_1234567890123456" }),
      expect.objectContaining({ requestId: "request" }),
    );
  });

  it("serves the OpenAPI contract only after administrator authentication", async () => {
    const authenticate = vi.fn(async () => active);
    const handler = createAdminApiHandler({
      auth: { establish: vi.fn(), logout: vi.fn(), authenticate },
      operations: operations(),
      publication: publication(),
    });
    const response = await handler(event("GET", "/admin/openapi.json"));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "{}")).toMatchObject({ openapi: "3.1.0" });
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("rejects PUBLISHED through the draft report-status route", async () => {
    const updateReportStatus = vi.fn();
    const handler = createAdminApiHandler({
      auth: { establish: vi.fn(), logout: vi.fn(), authenticate: vi.fn(async () => active) },
      operations: operations({ updateReportStatus: updateReportStatus as never }),
      publication: publication(),
    });
    const response = await handler(event(
      "PATCH",
      "/admin/organizations/org_1234567890123456/projects/project_1234567890123456/inspections/inspection_1234567890123456/reports/ASSESSMENT",
      { expectedRevision: "rev_1234567890123456", deliveryStatus: "PUBLISHED" },
    ));
    expect(response.statusCode).toBe(400);
    expect(updateReportStatus).not.toHaveBeenCalled();
  });

  it("creates upload sessions only through the organization-scoped Phase 6 route", async () => {
    const createUploadSession = vi.fn(async () => ({ uploadSession: { uploadSessionId: "upload_1234567890123456" } }));
    const handler = createAdminApiHandler({
      auth: { establish: vi.fn(), logout: vi.fn(), authenticate: vi.fn(async () => active) },
      operations: operations(),
      publication: publication({ createUploadSession: createUploadSession as never }),
    });
    const target = {
      kind: "INSPECTION_REPORT",
      organizationId: "org_1234567890123456",
      projectId: "project_1234567890123456",
      inspectionId: "inspection_1234567890123456",
      reportType: "ASSESSMENT",
    };
    const response = await handler(event(
      "POST",
      "/admin/organizations/org_1234567890123456/upload-sessions",
      { target, sizeBytes: 1024, sha256: "a".repeat(64), contentType: "application/pdf", originalFilename: "assessment.pdf" },
      { "idempotency-key": "upload-request-1" },
    ));
    expect(response.statusCode).toBe(201);
    expect(createUploadSession).toHaveBeenCalledWith(
      "org_1234567890123456",
      expect.objectContaining({ target }),
      "upload-request-1",
      expect.objectContaining({ requestId: "request" }),
    );
  });
});
