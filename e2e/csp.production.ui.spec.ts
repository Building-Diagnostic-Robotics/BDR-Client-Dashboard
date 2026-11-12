import { expect, test, type Page } from "@playwright/test";

// next dev permits unsafe-eval. Production mode builds current sources before starting.
test.skip(process.env.PORTAL_E2E_SERVER !== "production", "Requires PORTAL_E2E_SERVER=production (builds and starts the frontend locally)");

const building = {
  buildingId: "pbl_111111111111111111111111", displayName: "CSP Test Building", address: "100 Main Street", engineerNames: "",
  revision: null, latestInspection: null, inspectionCount: 0, provisional: false,
};

type BrowserDiagnostics = { violations: Array<{ directive: string; blockedURI: string }> };
async function mockClient(page: Page, payload: unknown) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const diagnostics: BrowserDiagnostics = { violations: [] };
    (window as Window & { __cspDiagnostics?: BrowserDiagnostics }).__cspDiagnostics = diagnostics;
    document.addEventListener("securitypolicyviolation", (event) => {
      diagnostics.violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    });
  });
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/bff/auth/session") await route.fulfill({ json: { authenticated: true } });
    else if (path === "/bff/me") await route.fulfill({ json: { organization: { displayName: "CSP Test Client" }, admin: false } });
    else if (path === "/bff/portal/buildings") await route.fulfill({ json: payload });
    else await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return errors;
}

async function expectNoEvalViolations(page: Page) {
  const violations = await page.evaluate(() => (window as Window & { __cspDiagnostics?: BrowserDiagnostics }).__cspDiagnostics?.violations);
  expect(violations).toBeDefined();
  expect(violations?.filter((event) => event.blockedURI === "eval" || event.blockedURI === "wasm-eval")).toEqual([]);
}

test("production CSP permits valid contract parsing without eval and treats an absent guide normally", async ({ page }) => {
  const errors = await mockClient(page, { items: [building], admin: false });
  const response = await page.goto("/projects");
  const csp = response?.headers()["content-security-policy"];
  expect(csp).toContain("script-src");
  expect(csp).not.toContain("'unsafe-eval'");
  await expect(page.getByRole("heading", { name: building.displayName, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projects unavailable", exact: true })).toHaveCount(0);
  await expect(page.getByText("The How to Read guide is temporarily unavailable.")).toHaveCount(0);
  await expectNoEvalViolations(page);
  expect(errors).toEqual([]);
});

test("browser contract validation still rejects malformed project responses under production CSP", async ({ page }) => {
  const errors = await mockClient(page, { items: [{ ...building, buildingId: "../untrusted", unexpected: "must reject" }], admin: false });
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects unavailable", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: building.displayName, exact: true })).toHaveCount(0);
  await expectNoEvalViolations(page);
  expect(errors).toEqual([]);
});
