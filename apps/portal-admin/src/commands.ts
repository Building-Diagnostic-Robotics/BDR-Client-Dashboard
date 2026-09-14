import type { ApiRequest } from "./client";

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Expected --name value, received ${key ?? "end of input"}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function required(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function confirm(values: Record<string, string>, idName: string): void {
  if (values.confirm !== required(values, idName)) throw new Error(`--confirm must exactly match --${idName}`);
}

function buildRequestInternal(argv: string[]): ApiRequest {
  const [resource, action, ...rest] = argv;
  const value = options(rest);
  if (resource === "auth" && action === "logout") return { method: "DELETE", path: "/admin/auth/session" };
  if (resource === "organizations" && action === "list") return { method: "GET", path: "/admin/organizations" };
  if (resource === "organizations" && action === "get") return { method: "GET", path: `/admin/organizations/${required(value, "organization")}` };
  if (resource === "organizations" && action === "create") return { method: "POST", path: "/admin/organizations", body: { displayName: required(value, "name") }, idempotent: true };
  if (resource === "organizations" && action === "update") return { method: "PATCH", path: `/admin/organizations/${required(value, "organization")}`, body: { displayName: required(value, "name"), expectedRevision: required(value, "revision") } };

  if (resource === "users" && action === "list") return { method: "GET", path: `/admin/organizations/${required(value, "organization")}/users` };
  if (resource === "users" && action === "invite") return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/invitations`, body: { email: required(value, "email") }, idempotent: true };
  if (resource === "users" && action === "revoke") { confirm(value, "user"); return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/users/${required(value, "user")}/revoke`, body: { expectedRevision: required(value, "revision") } }; }
  if (resource === "users" && action === "replace-identity") { confirm(value, "user"); return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/users/${required(value, "user")}/replace-identity`, body: { email: required(value, "email"), expectedRevision: required(value, "revision"), confirmedUserId: required(value, "user") }, idempotent: true }; }

  if (resource === "invitations" && action === "list") return { method: "GET", path: `/admin/organizations/${required(value, "organization")}/invitations` };
  if (resource === "invitations" && action === "resend") return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/invitations/${required(value, "invitation")}/resend` };
  if (resource === "invitations" && action === "cancel") { confirm(value, "invitation"); return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/invitations/${required(value, "invitation")}/cancel`, body: { expectedRevision: required(value, "revision") } }; }

  if (resource === "projects" && action === "list") return { method: "GET", path: `/admin/organizations/${required(value, "organization")}/projects` };
  if (resource === "projects" && action === "get") return { method: "GET", path: `/admin/organizations/${required(value, "organization")}/projects/${required(value, "project")}` };
  if (resource === "projects" && action === "create") return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/projects`, body: { displayName: required(value, "name"), address: required(value, "address"), timeZone: required(value, "timezone") }, idempotent: true };
  if (resource === "projects" && action === "update") return { method: "PATCH", path: `/admin/organizations/${required(value, "organization")}/projects/${required(value, "project")}`, body: { displayName: required(value, "name"), address: required(value, "address"), timeZone: required(value, "timezone"), expectedRevision: required(value, "revision") } };
  if (resource === "projects" && ["archive-preview", "restore-preview"].includes(action ?? "")) return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/projects/${required(value, "project")}/${action}` };
  if (resource === "projects" && action === "archive") { confirm(value, "project"); return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/projects/${required(value, "project")}/archive`, body: { expectedRevision: required(value, "revision"), reason: required(value, "reason") } }; }
  if (resource === "projects" && action === "restore") { confirm(value, "project"); return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/projects/${required(value, "project")}/restore`, body: { expectedRevision: required(value, "revision") } }; }

  const inspectionBase = resource === "inspections" || resource === "reports"
    ? `/admin/organizations/${required(value, "organization")}/projects/${required(value, "project")}/inspections`
    : "";
  if (resource === "inspections" && action === "list") return { method: "GET", path: `/admin/organizations/${required(value, "organization")}/projects/${required(value, "project")}/inspections` };
  if (resource === "inspections" && action === "get") return { method: "GET", path: `${inspectionBase}/${required(value, "inspection")}` };
  if (resource === "inspections" && action === "create") return { method: "POST", path: `/admin/organizations/${required(value, "organization")}/projects/${required(value, "project")}/inspections`, body: { scannedAt: required(value, "scanned-at") }, idempotent: true };
  if (resource === "inspections" && action === "update") return { method: "PATCH", path: `${inspectionBase}/${required(value, "inspection")}`, body: { scannedAt: required(value, "scanned-at"), expectedRevision: required(value, "revision") } };
  if (resource === "inspections" && ["archive-preview", "restore-preview"].includes(action ?? "")) return { method: "POST", path: `${inspectionBase}/${required(value, "inspection")}/${action}` };
  if (resource === "inspections" && action === "archive") { confirm(value, "inspection"); return { method: "POST", path: `${inspectionBase}/${required(value, "inspection")}/archive`, body: { expectedRevision: required(value, "revision"), reason: required(value, "reason") } }; }
  if (resource === "inspections" && action === "restore") { confirm(value, "inspection"); return { method: "POST", path: `${inspectionBase}/${required(value, "inspection")}/restore`, body: { expectedRevision: required(value, "revision") } }; }

  const reportBase = resource === "reports" ? `${inspectionBase}/${required(value, "inspection")}/reports` : "";
  if (resource === "reports" && action === "list") return { method: "GET", path: `${reportBase}` };
  if (resource === "reports" && action === "status") return { method: "PATCH", path: `${reportBase}/${required(value, "type")}`, body: { expectedRevision: required(value, "revision"), deliveryStatus: required(value, "status") } };
  if (resource === "reports" && action === "withdraw") { confirm(value, "inspection"); return { method: "POST", path: `${reportBase}/${required(value, "type")}/withdraw`, body: { expectedRevision: required(value, "revision"), deliveryStatus: required(value, "status"), reason: required(value, "reason") } }; }

  if (resource === "how-to-read" && action === "get") return { method: "GET", path: `/admin/organizations/${required(value, "organization")}/documents/how-to-read` };
  if (resource === "how-to-read" && action === "init") return { method: "PUT", path: `/admin/organizations/${required(value, "organization")}/documents/how-to-read`, idempotent: true };
  throw new Error("Unknown command. Use auth, organizations, users, invitations, projects, inspections, reports, or how-to-read.");
}

export function buildRequest(argv: string[]): ApiRequest {
  const request = buildRequestInternal(argv);
  if (!request.idempotent) return request;
  const supplied = options(argv.slice(2))["idempotency-key"];
  return supplied ? { ...request, idempotencyKey: supplied } : request;
}
