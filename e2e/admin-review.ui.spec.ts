import { expect, test, type Page } from "@playwright/test";
import type { PortalAdminReviewResponse, PortalAdminReviewRow } from "@bdr/contracts";

const prefix = "alpha/robot/2026-01-01/tower/";
const row: PortalAdminReviewRow = { organizationId: "org_alpha_0123456789", clientName: "Alpha Client", prefix, name: "Earlier inspection",
  reportType: "CAPITAL_PLANNING", reportKey: "CAPITAL_PLAN", artifactKey: `${prefix}reportgen/client_portal/capital_plan.pdf`, generatedAt: "2026-01-01T12:00:00Z" };
const failure = { organizationId: row.organizationId, clientName: row.clientName, prefix: "alpha/robot/2026-02-01/tower/" };
async function mockAdmin(page: Page) {
  await page.addInitScript(() => Object.defineProperty(document, "cookie", { get: () => "__Host-bdr_csrf=test-csrf" }));
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/bff/auth/session") await route.fulfill({ json: { authenticated: true } });
    else if (path === "/bff/me") await route.fulfill({ json: { organization: { displayName: "BDR Staff" }, admin: true } });
    else await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
}

test("a failed queue load is an error and never reports Nothing waiting", async ({ page }) => {
  await mockAdmin(page);
  await page.route("**/bff/portal/admin/review", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "Review unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toHaveCount(0);
});

test("an incomplete queue retains successful rows and retry can establish an empty queue", async ({ page }) => {
  await mockAdmin(page); let result: PortalAdminReviewResponse = { items: [row], complete: false, failures: [failure] };
  await page.route("**/bff/portal/admin/review", (route) => route.fulfill({ json: result }));
  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "Review incomplete" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Earlier inspection", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toHaveCount(0);
  result = { items: [], complete: false, failures: [failure] };
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Earlier inspection", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Review incomplete" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toHaveCount(0);
  result = { items: [], complete: true, failures: [] };
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toBeVisible();
});

test("review actions keep the status report key and preserve rows after conditional conflicts", async ({ page }) => {
  await mockAdmin(page); const writes: Array<{ action: string; reportType: string; prefix: string; notes?: string; markStale?: boolean }> = []; let conflict = true;
  await page.route("**/bff/portal/admin/review", (route) => route.fulfill({ json: { items: [row], complete: true, failures: [] } }));
  await page.route("**/bff/portal/building", async (route) => {
    writes.push(route.request().postDataJSON());
    await route.fulfill(conflict ? { status: 409, json: { error: "conflict", message: "Reload and review the latest version." } } : { json: { ok: true } });
  });
  await page.goto("/review"); await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Reload and review the latest version.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: row.name, exact: true })).toBeVisible();
  expect(writes[0]).toMatchObject({ action: "approve", reportType: "CAPITAL_PLAN", prefix });
  conflict = false;
  await page.getByText("Send notes", { exact: true }).first().click();
  await page.getByLabel("Notes", { exact: true }).fill("Please check this earlier inspection.");
  await page.getByLabel("Mark the current file stale", { exact: true }).check();
  await page.getByRole("button", { name: "Send notes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nothing waiting" })).toBeVisible();
  expect(writes[1]).toMatchObject({ action: "notes", reportType: "CAPITAL_PLAN", notes: "Please check this earlier inspection.", markStale: true });
});

test("View opens a report tab using a freshly fetched access URL", async ({ page }) => {
  await mockAdmin(page); let requests = 0;
  await page.route("**/bff/portal/admin/review", (route) => route.fulfill({ json: { items: [row], complete: true, failures: [] } }));
  await page.route("**/bff/portal/file?**", async (route) => {
    requests++; expect(new URL(route.request().url()).searchParams.get("key")).toBe(row.artifactKey);
    await route.fulfill({ json: { url: "https://portal-test.s3.us-east-1.amazonaws.com/review.pdf" } });
  });
  await page.context().route("https://portal-test.s3.us-east-1.amazonaws.com/review.pdf", (route) => route.fulfill({ contentType: "text/html", body: "<title>Review report</title><p>Report preview</p>" }));
  await page.goto("/review");
  const popupEvent = page.waitForEvent("popup"); await page.getByRole("button", { name: "View", exact: true }).click();
  const popup = await popupEvent; await expect(popup.getByText("Report preview")).toBeVisible();
  expect(requests).toBe(1); await popup.close();
});
