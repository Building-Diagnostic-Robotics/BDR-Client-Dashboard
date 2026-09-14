export type ApiRequest = Readonly<{ method: string; path: string; body?: unknown; idempotent?: boolean; idempotencyKey?: string }>;

export class PortalAdminClient {
  constructor(private readonly apiUrl: string, private readonly accessToken: string) {}

  async establish(): Promise<void> {
    await this.request({ method: "POST", path: "/admin/auth/sessions" });
  }

  async execute(request: ApiRequest): Promise<unknown> {
    return this.request(request);
  }

  private async request(request: ApiRequest): Promise<unknown> {
    const response = await fetch(new URL(request.path, this.apiUrl), {
      method: request.method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...(request.idempotent ? { "idempotency-key": request.idempotencyKey ?? `cli_${crypto.randomUUID()}` } : {}),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    const payload: unknown = await response.json().catch(() => ({ error: "invalid_response" }));
    if (!response.ok) throw new Error(`Admin API ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  }
}
