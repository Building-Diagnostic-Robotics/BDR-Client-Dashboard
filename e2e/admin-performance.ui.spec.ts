import { expect, test, type Page } from "@playwright/test";

const clients = [
  { organizationId: "org_alpha_0123456789", displayName: "Alpha Client", clientPrefixes: ["alpha"] },
  { organizationId: "org_empty_0123456789", displayName: "Empty Client", clientPrefixes: ["empty"] },
  { organizationId: "org_beta_0123456789", displayName: "Beta Client", clientPrefixes: ["beta"] },
];
function building(prefix: string, displayName: string) {
  return { buildingId: `pbl_${prefix === "alpha" ? "a" : "b"}`.padEnd(28, "1"), displayName, address: "100 Main Street", engineerNames: "", revision: null,
    latestInspection: null, inspectionCount: 0, provisional: false, buildingPrefix: `${prefix}/robot/date/tower/`,
    scanTime: null, uploadTime: null, timeZone: null, readyReports: [], latestReportUpdate: null };
}
async function mockAdmin(page: Page) {
  await page.addInitScript(() => Object.defineProperty(document, "cookie", { get: () => "__Host-bdr_csrf=test-csrf" }));
  const reads: string[] = [];
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname; reads.push(path);
    if (path === "/bff/auth/session") await route.fulfill({ json: { authenticated: true } });
    else if (path === "/bff/me") await route.fulfill({ json: { organization: { displayName: "BDR Staff" }, admin: true } });
    else if (path === "/bff/portal/admin/clients") await route.fulfill({ json: { items: clients } });
    else if (path.endsWith("/building-count")) await route.fulfill({ json: { count: 0 } });
    else if (path.endsWith("/buildings")) {
      const prefix = path.includes("org_alpha") ? "alpha" : "beta";
      await route.fulfill({ json: { items: [building(prefix, prefix === "alpha" ? "Alpha Tower" : "Beta Tower")], admin: true } });
    } else await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return reads;
}

test("client cards render before counts, cap count requests at two, and prioritize the selected client", async ({ page }) => {
  const reads = await mockAdmin(page); let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; }); const counts: string[] = [];
  await page.route("**/bff/portal/admin/clients/*/building-count", async (route) => {
    counts.push(route.request().url()); await blocked;
    await route.fulfill({ json: { count: 0 } }).catch(() => undefined);
  });
  try {
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Alpha Client", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Empty Client", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Beta Client", exact: true })).toBeVisible();
    await expect.poll(() => counts.length).toBe(2);
    expect(reads.some((path) => path === "/bff/portal/buildings" || path.endsWith("/buildings"))).toBe(false);
    await page.getByRole("link", { name: /Alpha Client/ }).click();
    await expect(page.getByRole("heading", { name: "Alpha Tower", exact: true })).toBeVisible();
    expect(reads.filter((path) => path.endsWith("/buildings"))).toEqual([`/bff/portal/admin/clients/${clients[0]!.organizationId}/buildings`]);
  } finally { release(); }
});

test("a failed count remains unavailable while empty clients have a truthful zero", async ({ page }) => {
  await mockAdmin(page);
  await page.route(`**/bff/portal/admin/clients/${clients[0]!.organizationId}/building-count`, (route) => route.fulfill({ status: 500, json: { error: "unavailable" } }));
  await page.goto("/projects");
  await expect(page.getByRole("link", { name: /Alpha Client/ })).toContainText("Building count unavailable");
  await expect(page.getByRole("link", { name: /Empty Client/ })).toContainText("0 buildings");
  await expect(page.getByRole("button", { name: "Retry counts" })).toBeVisible();
});

test("a late response from another selected client cannot replace the current buildings", async ({ page }) => {
  await mockAdmin(page); let release!: () => void; let started = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/bff/portal/admin/clients/${clients[0]!.organizationId}/buildings`, async (route) => {
    started = true; await blocked;
    await route.fulfill({ json: { items: [building("alpha", "Alpha Tower")], admin: true } }).catch(() => undefined);
  });
  try {
    await page.goto("/projects?client=alpha"); await expect.poll(() => started).toBe(true);
    await page.getByRole("link", { name: "All clients", exact: true }).click();
    await page.getByRole("link", { name: /Beta Client/ }).click();
    await expect(page.getByRole("heading", { name: "Beta Tower", exact: true })).toBeVisible();
    release();
    await expect(page.getByRole("heading", { name: "Alpha Tower", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Beta Tower", exact: true })).toBeVisible();
  } finally { release(); }
});

test("directory errors are recoverable and do not appear as an empty client list", async ({ page }) => {
  await mockAdmin(page); let failing = true;
  await page.route("**/bff/portal/admin/clients", (route) => route.fulfill(failing ? { status: 503, json: { error: "unavailable" } } : { json: { items: clients } }));
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Clients unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No clients available" })).toHaveCount(0);
  failing = false; await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alpha Client", exact: true })).toBeVisible();
});
