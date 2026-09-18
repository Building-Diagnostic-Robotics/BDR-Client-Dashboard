import { expect, test, type Page } from "@playwright/test";
import { clientMeResponseSchema, clientProjectListResponseSchema } from "@bdr/contracts";

const portalOrigin = () => new URL(process.env.PORTAL_E2E_BASE_URL!).origin;
const authOrigin = () => new URL(process.env.PORTAL_E2E_AUTH_ORIGIN!).origin;

// Classic Hosted UI duplicates IDs across hidden and visible responsive forms,
// and its submit input has aria-label="submit" rather than "Sign in".
const cognitoEmail = (page: Page) => page.locator('input[name="username"]:visible');
const cognitoPassword = (page: Page) => page.locator('input[name="password"][type="password"]:visible');
const cognitoSignIn = (page: Page) => page.locator('input[name="signInSubmitButton"][type="submit"]:visible');
const cognitoRememberedSignIn = (page: Page) => page.getByRole("button", { name: /^sign in as /i });

async function signIn(page: Page, other = false) {
  await page.goto("/projects");
  await expect.poll(() => new URL(page.url()).origin).toBe(authOrigin());
  const priorLoginUrl = page.url();
  // Verify the exact trusted Cognito origin before entering credentials.
  await cognitoEmail(page).fill(process.env[other ? "PORTAL_E2E_OTHER_EMAIL" : "PORTAL_E2E_CLIENT_EMAIL"]!);
  await cognitoPassword(page).fill(process.env[other ? "PORTAL_E2E_OTHER_PASSWORD" : "PORTAL_E2E_CLIENT_PASSWORD"]!);
  await cognitoSignIn(page).click();
  await expect(page.getByRole("heading", { name: "Your projects", exact: true })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(portalOrigin());
  const expectedOrganization = process.env[other ? "PORTAL_E2E_OTHER_ORGANIZATION" : "PORTAL_E2E_CLIENT_ORGANIZATION"]?.trim();
  if (expectedOrganization) {
    expect((await me(page)).organization.displayName).toBe(expectedOrganization);
  }
  return priorLoginUrl;
}

async function me(page: Page) {
  const response = await page.request.get("/bff/me");
  expect(response.status()).toBe(200);
  return clientMeResponseSchema.parse(await response.json());
}

async function projects(page: Page) {
  const response = await page.request.get("/bff/me/projects");
  expect(response.status()).toBe(200);
  const result = clientProjectListResponseSchema.parse(await response.json());
  expect(result.items.length).toBeGreaterThan(0);
  return result.items;
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
  await expect(page.getByRole("heading", { name: "Your projects", exact: true })).toBeVisible();
  expect(await me(page)).toEqual(before);
});

test("Back to the remembered Cognito login preserves the current dashboard session", async ({ page }) => {
  const previousLogin = await signIn(page);
  const before = await me(page);
  await page.goBack();
  // Some engines replace redirect history. Reopening that same page reproduces the stale flow.
  if (new URL(page.url()).origin !== authOrigin()) await page.goto(previousLogin);
  await expect(cognitoRememberedSignIn(page)).toBeVisible();
  await cognitoRememberedSignIn(page).click();
  await expect(page.getByRole("heading", { name: "Your projects", exact: true })).toBeVisible();
  expect(await me(page)).toEqual(before);
});

test("a stale callback without a session offers manual retry rather than an automatic login loop", async ({ page }) => {
  const response = await page.goto("/bff/auth/callback?code=expired-test-code&state=expired-test-state");
  expect(response?.status()).toBe(401);
  await expect(page.getByRole("heading", { name: "Please sign in again" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in again", exact: true })).toHaveAttribute("href", "/bff/auth/login?returnTo=%2Fprojects");
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
  await page.goto("/projects");
  await expect.poll(() => new URL(page.url()).origin).toBe(authOrigin());
  await expect(cognitoEmail(page)).toBeVisible();
});

test("logout in one tab denies access from a second tab", async ({ page, context }) => {
  await signIn(page);
  const second = await context.newPage();
  await second.goto("/projects");
  await expect(second.getByRole("heading", { name: "Your projects", exact: true })).toBeVisible();
  await signOut(page);
  expect((await second.request.get("/bff/me")).status()).toBe(401);
  await second.reload();
  await expect.poll(() => new URL(second.url()).origin).toBe(authOrigin());
  await expect(second.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
});

test("switching accounts cannot expose the previous organization's building", async ({ page }) => {
  await signIn(page);
  const first = await me(page);
  const firstProject = (await projects(page))[0]!;
  await signOut(page);
  await signIn(page, true);
  const second = await me(page);
  expect(second.organization.displayName).not.toBe(first.organization.displayName);
  const otherProjects = await projects(page);
  expect(otherProjects.some((project) => project.projectId === firstProject.projectId)).toBe(false);
  expect([403, 404]).toContain((await page.request.get(`/bff/projects/${encodeURIComponent(firstProject.projectId)}`)).status());
});
