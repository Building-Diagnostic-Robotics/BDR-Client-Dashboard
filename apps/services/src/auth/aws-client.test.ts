import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { clientSessionSchema } from "@bdr/contracts";
import { sessionKeys, sha256 } from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClientBffHandler } from "../client-bff";
import { DynamoClientAuthStore, type ClientRuntimeConfig } from "./aws-client";
import { ClientAuthService } from "./client";

const session = clientSessionSchema.parse({
  sessionIdHash: sha256("session-secret"),
  issuer: "https://issuer.example.com/pool",
  sub: "client-subject",
  accessTokenCiphertext: "encrypted-access",
  refreshTokenCiphertext: "encrypted-refresh",
  accessTokenExpiresAt: "2026-09-13T15:00:00.000Z",
  csrfTokenHash: sha256("csrf-secret"),
  absoluteExpiresAt: "2026-09-13T22:00:00.000Z",
  ttlExpiresAt: 1,
  revokedAt: null,
  lastActivityAt: "2026-09-13T14:00:00.000Z",
});

const store = new DynamoClientAuthStore({ sessionTableName: "test-sessions" } as ClientRuntimeConfig);

afterEach(() => vi.restoreAllMocks());

describe("DynamoDB client sessions", () => {
  it("treats a legacy session without activity metadata as unauthenticated", async () => {
    const { lastActivityAt: _legacyMissingField, ...legacySession } = session;
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({ Item: legacySession } as never);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(store.getClientSession(sessionKeys.clientSession("session-secret"), { consistentRead: true }))
      .resolves.toBeNull();
    expect(warning).toHaveBeenCalledWith(JSON.stringify({ event: "invalid_client_session_record" }));
  });

  it("clears a legacy cookie and requires a fresh login rather than returning HTTP 400", async () => {
    const { lastActivityAt: _legacyMissingField, ...legacySession } = session;
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({ Item: legacySession } as never);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const auth = new ClientAuthService(store, {} as never, {} as never, () => new Date("2026-09-13T14:01:00.000Z"));
    const handler = createClientBffHandler({ service: auth, portalOrigin: "https://portal.example.com" });
    const event = {
      rawPath: "/bff/auth/session",
      headers: {},
      cookies: ["__Host-bdr_client_session=session-secret"],
      requestContext: { requestId: "request", http: { method: "GET" } },
    } as APIGatewayProxyEventV2;

    const response = await handler(event);
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("authentication_required");
    expect(response.cookies?.join("\n")).toContain("__Host-bdr_client_session=; Path=/; Max-Age=0");
  });

  it("keeps valid session records usable", async () => {
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({ Item: session } as never);
    await expect(store.getClientSession(sessionKeys.clientSession("session-secret"), { consistentRead: true }))
      .resolves.toEqual(session);
  });

  it("guards activity writes against expiry, revocation, idle sessions, and older requests", async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({} as never);
    const touched = await store.touchSessionActivity({
      rawSessionId: "session-secret",
      session,
      newLastActivityAt: "2026-09-13T14:20:00.000Z",
    });
    expect(touched).toBe(true);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    const input = (command as UpdateCommand).input;
    expect(input.ConditionExpression).toContain("lastActivityAt >= :idleCutoff");
    expect(input.ConditionExpression).toContain("lastActivityAt <= :activity");
    expect(input.ExpressionAttributeValues?.[":idleCutoff"]).toBe("2026-09-13T13:50:00.000Z");
  });

  it("reports conditional races without hiding infrastructure errors", async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send");
    const input = {
      rawSessionId: "session-secret",
      session,
      newLastActivityAt: "2026-09-13T14:20:00.000Z",
    };
    send.mockRejectedValueOnce(Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" }));
    await expect(store.touchSessionActivity(input)).resolves.toBe(false);
    send.mockRejectedValueOnce(new Error("DynamoDB unavailable"));
    await expect(store.touchSessionActivity(input)).rejects.toThrow("DynamoDB unavailable");
  });
});
