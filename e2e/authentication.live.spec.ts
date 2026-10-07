import { expect, test, type Page } from "@playwright/test";
import { clientMeResponseSchema } from "@bdr/contracts";

const portalOrigin = () => new URL(process.env.PORTAL_E2E_BASE_URL!).origin;
const dashboardHeading = (page: Page) => page.getByRole("heading", { name: "Your projects", exact: true, level: 1 });
const signInHeading = (page: Page) => page.getByRole("heading", {
  name: "Sign In",
  exact: true,
});


async function signIn(page: Page, other = false) {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fprojects$/);
  await expect(signInHeading(page)).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(process.env[other ? "PORTAL_E2E_OTHER_EMAIL" : "PORTAL_E2E_CLIENT_EMAIL"]!);
  await page.getByLabel("Password", { exact: true }).fill(process.env[other ? "PORTAL_E2E_OTHER_PASSWORD" : "PORTAL_E2E_CLIENT_PASSWORD"]!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dashboardHeading(page)).toBeVisible();
  expect(new URL(page.url()).origin).toBe(portalOrigin());
  const expectedOrganization = process.env[other ? "PORTAL_E2E_OTHER_ORGANIZATION" : "PORTAL_E2E_CLIENT_ORGANIZATION"]?.trim();
  if (expectedOrganization) {
    expect((await me(page)).organization.displayName).toBe(expectedOrganization);
  }
}

async function me(page: Page) {
  const response = await page.request.get("/bff/me");
  expect(response.status()).toBe(200);
  return clientMeResponseSchema.parse(await response.json());
}

async function buildings(page: Page, options: { requireAny?: boolean } = {}) {
  const response = await page.request.get("/bff/portal/buildings");
  expect(response.status()).toBe(200);
  const result = await response.json() as { items?: Array<{ buildingId?: unknown }> };
  const items = Array.isArray(result.items)
    ? result.items.filter((item): item is { buildingId: string } => typeof item.buildingId === "string")
    : [];
  if (options.requireAny) expect(items.length).toBeGreaterThan(0);
  return items;
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You’re signed out" })).toBeVisible();
}

test("fresh and remembered dashboard access use a secure opaque session", async ({ page, context }) => {
  await signIn(page);
  const before = await me(page);
  const cookies = await context.cookies(portalOrigin());
  const session = cookies.find((cookie) => cookie.name === "__Host-bdr_client_session");
  expect(Boolean(session?.httpOnly && session.secure && session.sameSite === "Lax")).toBe(true);
  expect(session?.domain).toBe(new URL(portalOrigin()).hostname);
  expect(Boolean(session?.value && !session.value.includes("."))).toBe(true);
  await page.reload();
  await expect(dashboardHeading(page)).toBeVisible();
  expect(await me(page)).toEqual(before);
});

test("Back to the custom sign-in page preserves the current dashboard session", async ({ page }) => {
  await signIn(page);
  const before = await me(page);
  await page.goBack();
  if (!new URL(page.url()).pathname.startsWith("/sign-in")) {
    await page.goto("/sign-in?returnTo=%2Fprojects");
  }
  await expect(signInHeading(page)).toBeVisible();
  expect((await page.request.get("/bff/auth/session")).status()).toBe(200);
  await page.goto("/projects");
  await expect(dashboardHeading(page)).toBeVisible();
  expect(await me(page)).toEqual(before);
});

test("a stale callback without a session offers manual retry rather than an automatic login loop", async ({ page }) => {
  const response = await page.goto("/bff/auth/callback?code=expired-test-code&state=expired-test-state");
  expect(response?.status()).toBe(401);
  await expect(page.getByRole("heading", { name: "Please sign in again" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in again", exact: true })).toHaveAttribute("href", "/sign-in?returnTo=%2Fprojects");
  expect((await page.request.get("/bff/auth/session")).status()).toBe(401);
});

test("logout revokes the session and Back cannot restore authenticated access", async ({ page, context }) => {
  await signIn(page);
  const sessionCookie = (await context.cookies(portalOrigin())).find((cookie) => cookie.name === "__Host-bdr_client_session");
  if (!sessionCookie) throw new Error("Expected a dashboard session after login.");
  await signOut(page);
  const replay = await page.request.get("/bff/auth/session", {
    headers: { cookie: `${sessionCookie.name}=${sessionCookie.value}` },
  });
  expect(replay.status()).toBe(401);
  await page.goBack();
  // Wait for any page restored from history to perform its session check.
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  expect((await page.request.get("/bff/me")).status()).toBe(401);
  await page.goto("/projects", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fprojects$/);
  await expect(signInHeading(page)).toBeVisible();
});

test("logout in one tab denies access from a second tab", async ({ page, context }) => {
  await signIn(page);
  const second = await context.newPage();
  await second.goto("/projects");
  await expect(dashboardHeading(second)).toBeVisible();
  await signOut(page);
  expect((await second.request.get("/bff/me")).status()).toBe(401);
  await second.goto("/projects", { waitUntil: "commit" });
  await expect(second).toHaveURL(/\/sign-in\?returnTo=%2Fprojects$/);
  await expect(signInHeading(second)).toBeVisible();
  await expect(second.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
});

test("switching accounts cannot expose the previous organization's building", async ({ page }) => {
  const skipSecondary = process.env.PORTAL_E2E_SKIP_SECONDARY === "true";
  const otherEmail = process.env.PORTAL_E2E_OTHER_EMAIL?.trim();
  const otherPassword = process.env.PORTAL_E2E_OTHER_PASSWORD?.trim();
  const clientEmail = process.env.PORTAL_E2E_CLIENT_EMAIL?.trim();
  const hasSecondAccount = Boolean(
    !skipSecondary &&
    otherEmail &&
    otherPassword &&
    (!clientEmail || otherEmail.toLowerCase() !== clientEmail.toLowerCase())
  );
  test.skip(!hasSecondAccount, "Multi-account tenant isolation test skipped: secondary test account not configured or skipped.");

  await signIn(page);
  const first = await me(page);
  const firstBuildings = await buildings(page);
  test.skip(firstBuildings.length === 0, "Tenant isolation test skipped: primary organization has no buildings in this environment.");
  const firstBuilding = firstBuildings[0]!;
  await signOut(page);
  await signIn(page, true);
  const second = await me(page);
  expect(second.organization.displayName).not.toBe(first.organization.displayName);
  const otherBuildings = await buildings(page);
  expect(otherBuildings.some((building) => building.buildingId === firstBuilding.buildingId)).toBe(false);
  expect([403, 404]).toContain((await page.request.get(
    `/bff/portal/building-detail?buildingId=${encodeURIComponent(firstBuilding.buildingId)}`,
  )).status());
});
