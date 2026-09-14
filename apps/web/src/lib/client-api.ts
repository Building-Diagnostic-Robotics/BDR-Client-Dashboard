type Schema<T> = Readonly<{ parse(value: unknown): T }>;

export class ClientApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ClientApiError";
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ClientApiError(response.status, "The server returned an invalid response.");
  }
}

async function request<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new ClientApiError(
      response.status,
      response.status === 401
        ? "Your session has expired."
        : "The requested information is unavailable.",
    );
  }
  return schema.parse(await parseJson(response));
}

function cookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

export function getClient<T>(path: string, schema: Schema<T>): Promise<T> {
  return request(path, schema);
}

export function postClient<T>(path: string, body: unknown, schema: Schema<T>): Promise<T> {
  const csrfToken = cookie("__Host-bdr_csrf");
  if (!csrfToken) throw new ClientApiError(401, "Your session has expired.");
  return request(path, schema, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bdr-csrf": csrfToken,
    },
    body: JSON.stringify(body),
  });
}

export function loginPath(returnTo: string): string {
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : "/projects";
  return `/bff/auth/login?returnTo=${encodeURIComponent(safeReturnTo)}`;
}
