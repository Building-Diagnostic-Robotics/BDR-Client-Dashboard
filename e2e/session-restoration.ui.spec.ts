import { expect, test, type Page } from "@playwright/test";

async function mockAccount(page: Page) {
  const state = { active: true, organization: "First Test Organization", building: "First Test Building", sessionReads: 0 };
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/bff/auth/login") {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><h1>Sign in</h1></body></html>" });
      return;
    }
    if (path === "/bff/auth/session") state.sessionReads += 1;
    if (!state.active) {
      await route.fulfill({ status: 401, json: { error: "authentication_required" } });
      return;
    }
    if (path === "/bff/auth/session") await route.fulfill({ json: { authenticated: true } });
    else if (path === "/bff/me") await route.fulfill({ json: { organization: { displayName: state.organization } } });
    else if (path === "/bff/me/projects") await route.fulfill({ json: { items: [{
      projectId: "project_0123456789abcdef", displayName: state.building,
      address: "Test Address", timeZone: "America/New_York", latestInspection: null,
    }] } });
    else await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return state;
}

async function restoreFromHistory(page: Page) {
  // Deterministically exercise the BFCache event; live tests separately use browser Back.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
}

test("a restored dashboard rechecks the session and hides content after logout", async ({ page }) => {
  const state = await mockAccount(page);
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "First Test Building" })).toBeVisible();
  const initialReads = state.sessionReads;
  state.active = false;
  await restoreFromHistory(page);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(state.sessionReads).toBe(initialReads + 1);
  await expect(page.getByRole("heading", { name: "Your projects" })).toHaveCount(0);
  await expect(page.getByText("First Test Organization")).toHaveCount(0);
});

test("a restored dashboard reloads account and project data after account switching", async ({ page }) => {
  const state = await mockAccount(page);
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "First Test Building" })).toBeVisible();
  const initialReads = state.sessionReads;
  state.organization = "Second Test Organization";
  state.building = "Second Test Building";
  await restoreFromHistory(page);
  await expect(page.getByRole("heading", { name: "Second Test Building" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "First Test Building" })).toHaveCount(0);
  await expect(page.getByText("First Test Organization")).toHaveCount(0);
  expect(state.sessionReads).toBe(initialReads + 1);
});

test("ordinary pageshow does not restart an already active dashboard session", async ({ page }) => {
  const state = await mockAccount(page);
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "First Test Building" })).toBeVisible();
  const initialReads = state.sessionReads;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
  expect(state.sessionReads).toBe(initialReads);
});
