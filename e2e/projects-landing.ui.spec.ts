import { expect, test } from "@playwright/test";

const clientBuildingA = {
  buildingPrefix: "org-a/robot-1/2026-09-15/alpha-tower/",
  displayName: "Alpha Tower",
  address: "100 Main Street",
  scanTime: "2026-09-15T14:00:00-04:00",
  uploadTime: "2026-09-15T16:00:00-04:00",
  timeZone: "America/New_York",
  readyReports: ["ASSESSMENT"],
  latestReportUpdate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
};

const clientBuildingB = {
  buildingPrefix: "org-a/robot-1/2026-09-01/beta-center/",
  displayName: "Beta Center",
  address: "500 Market Boulevard",
  scanTime: "2026-09-01T10:00:00-04:00",
  uploadTime: "2026-09-01T12:00:00-04:00",
  timeZone: "America/New_York",
  readyReports: ["EVIDENCE"],
  latestReportUpdate: "2026-09-05T12:00:00.000Z", // Older than 24 hours
};

const clientBuildingC = {
  buildingPrefix: "org-a/robot-2/2026-08-20/gamma-hall/",
  displayName: "Gamma Hall",
  address: "750 University Way",
  scanTime: null,
  uploadTime: null,
  timeZone: "America/New_York",
  readyReports: ["ROOF_TAKEOFF"],
  latestReportUpdate: null, // Reports available, no timestamp
};

const clientBuildingD = {
  buildingPrefix: "org-a/robot-2/2026-08-10/delta-plaza/",
  displayName: "Delta Plaza",
  address: "",
  scanTime: "invalid-date",
  uploadTime: null,
  timeZone: null,
  readyReports: [], // No reports yet
  latestReportUpdate: null,
};

test.describe("Client Landing Page UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, "cookie", { get: () => "__Host-bdr_csrf=test-csrf" });
    });
  });

  test("renders client landing page with search, cards, and how to read banner", async ({ page }) => {
    let guideAccessRequested = false;

    await page.route("**/bff/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/bff/auth/session") {
        await route.fulfill({ json: { authenticated: true } });
      } else if (path === "/bff/me") {
        await route.fulfill({ json: { organization: { displayName: "Midland Holdings" }, admin: false } });
      } else if (path === "/bff/portal/buildings") {
        await route.fulfill({
          json: {
            items: [clientBuildingA, clientBuildingB, clientBuildingC, clientBuildingD],
            admin: false,
          },
        });
      } else if (path === "/bff/portal/how-to-read/current") {
        await route.fulfill({
          json: {
            updatedAt: "2026-09-20T10:00:00.000Z",
          },
        });
      } else if (path === "/bff/portal/how-to-read/current/access") {
        guideAccessRequested = true;
        await route.fulfill({
          json: {
            url: "https://portal-test.s3.us-east-1.amazonaws.com/guide.pdf",
            expiresInSeconds: 300,
          },
        });
      } else {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      }
    });

    await page.goto("/projects");

    // 1. Heading and description
    await expect(page.getByRole("heading", { name: "Your projects", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText("Inspection reports and building information for Midland Holdings.")).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(navigation.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator('a[aria-current="page"]')).toHaveCount(1);

    // 2. Section title and count badge
    await expect(page.getByRole("heading", { name: "Buildings", exact: true, level: 2 })).toBeVisible();
    await expect(page.getByLabel("4 buildings")).toBeVisible();

    // 3. Search input is present, but admin filters (Robot, Report, Scan from, Scan to) are absent
    await expect(page.getByLabel("Search buildings")).toBeVisible();
    await expect(page.getByText("Robot", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Report", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Scan from", { exact: true })).toHaveCount(0);

    // 4. Cards display correct scan dates and report update statuses
    // Building A: 2 hours ago relative format
    const alphaCard = page.locator('a.project-card', { hasText: 'Alpha Tower' });
    await expect(alphaCard).toBeVisible();
    await expect(alphaCard.getByText("Updated 2 hours ago")).toBeVisible();
    await expect(alphaCard.getByText("Sep 15, 2026")).toBeVisible();
    expect(await alphaCard.getAttribute("href")).toContain("/buildings/view?prefix=");

    // Building B: short date format for > 24 hours
    const betaCard = page.locator('a.project-card', { hasText: 'Beta Center' });
    await expect(betaCard).toBeVisible();
    await expect(betaCard.getByText("Updated Sep 5, 2026")).toBeVisible();

    // Building C: reports ready but no timestamp -> Available; scanTime null -> No scans yet
    const gammaCard = page.locator('a.project-card', { hasText: 'Gamma Hall' });
    await expect(gammaCard).toBeVisible();
    await expect(gammaCard.getByText("Available", { exact: true })).toBeVisible();
    await expect(gammaCard.getByText("No scans yet")).toBeVisible();

    // Building D: no ready reports -> No reports yet; invalid scanTime -> No scans yet
    const deltaCard = page.locator('a.project-card', { hasText: 'Delta Plaza' });
    await expect(deltaCard).toBeVisible();
    await expect(deltaCard.getByText("No address yet")).toBeVisible();
    await expect(deltaCard.getByText("No reports yet")).toBeVisible();
    await expect(deltaCard.getByText("No scans yet")).toBeVisible();

    // 6. Search filters case-insensitively by name and address
    await page.getByLabel("Search buildings").fill("market");
    await expect(page.getByRole("heading", { name: "Beta Center" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Alpha Tower" })).toHaveCount(0);

    // Clear search using the search bar's clear button ("×")
    await page.getByLabel("Clear search").click();
    await expect(page.getByRole("heading", { name: "Alpha Tower" })).toBeVisible();

    // Search with zero matches shows empty search state
    await page.getByLabel("Search buildings").fill("nonexistent-query");
    await expect(page.getByRole("heading", { name: "No matching buildings" })).toBeVisible();
    // Clear search using the empty state button
    await page.locator(".empty-card").getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByRole("heading", { name: "Alpha Tower" })).toBeVisible();

    // 7. How to Read banner is rendered beneath grid
    await expect(page.getByRole("heading", { name: "How to Read Your BDR Reports" })).toBeVisible();
    await expect(page.getByText("Updated Sep 20, 2026")).toBeVisible();

    // Click View on guide
    const accessPromise = page.waitForResponse((res) => res.url().includes("/bff/portal/how-to-read/current/access"));
    await page.getByRole("button", { name: "View" }).click();
    const accessRes = await accessPromise;
    expect(accessRes.status()).toBe(200);
    expect(guideAccessRequested).toBe(true);
  });

  test("hides How to Read banner when guide is 404", async ({ page }) => {
    await page.route("**/bff/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/bff/auth/session") {
        await route.fulfill({ json: { authenticated: true } });
      } else if (path === "/bff/me") {
        await route.fulfill({ json: { organization: { displayName: "Midland Holdings" }, admin: false } });
      } else if (path === "/bff/portal/buildings") {
        await route.fulfill({ json: { items: [clientBuildingA], admin: false } });
      } else if (path === "/bff/portal/how-to-read/current") {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      } else {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      }
    });

    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Alpha Tower" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "How to Read Your BDR Reports" })).toHaveCount(0);
  });

  test("renders building cards without waiting for How to Read metadata", async ({ page }) => {
    let releaseGuide!: () => void;
    const guidePending = new Promise<void>((resolve) => {
      releaseGuide = resolve;
    });
    await page.route("**/bff/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/bff/auth/session") {
        await route.fulfill({ json: { authenticated: true } });
      } else if (path === "/bff/me") {
        await route.fulfill({ json: { organization: { displayName: "Midland Holdings" }, admin: false } });
      } else if (path === "/bff/portal/buildings") {
        await route.fulfill({ json: { items: [clientBuildingA], admin: false } });
      } else if (path === "/bff/portal/how-to-read/current") {
        await guidePending;
        await route.fulfill({ json: { updatedAt: "2026-09-20T10:00:00.000Z" } });
      } else {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      }
    });

    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Alpha Tower" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "How to Read Your BDR Reports" })).toHaveCount(0);
    releaseGuide();
    await expect(page.getByRole("heading", { name: "How to Read Your BDR Reports" })).toBeVisible();
  });

  test("marks exactly one client navigation item active across project routes", async ({ page }) => {
    await page.route("**/bff/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/bff/auth/session") {
        await route.fulfill({ json: { authenticated: true } });
      } else if (path === "/bff/me") {
        await route.fulfill({ json: { organization: { displayName: "Midland Holdings" }, admin: false } });
      } else if (path === "/bff/portal/building") {
        await route.fulfill({
          json: { displayName: "Alpha Tower", address: "100 Main Street", reports: {}, released: false },
        });
      } else {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      }
    });

    await page.goto("/how-to");
    const navigation = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(navigation.getByRole("link", { name: "How to use" })).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator('a[aria-current="page"]')).toHaveCount(1);

    await page.goto("/buildings/view?prefix=org-a%2Frobot-1%2F2026-09-15%2Falpha-tower%2F");
    await expect(navigation.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator('a[aria-current="page"]')).toHaveCount(1);
  });

  test("shows compact error when How to Read guide fails unexpectedly without blocking buildings", async ({ page }) => {
    await page.route("**/bff/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/bff/auth/session") {
        await route.fulfill({ json: { authenticated: true } });
      } else if (path === "/bff/me") {
        await route.fulfill({ json: { organization: { displayName: "Midland Holdings" }, admin: false } });
      } else if (path === "/bff/portal/buildings") {
        await route.fulfill({ json: { items: [clientBuildingA], admin: false } });
      } else if (path === "/bff/portal/how-to-read/current") {
        await route.fulfill({ status: 500, json: { error: "internal_error" } });
      } else {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      }
    });

    await page.goto("/projects");
    // Building still loads
    await expect(page.getByRole("heading", { name: "Alpha Tower" })).toBeVisible();
    // Compact error banner shown
    await expect(page.getByText("The How to Read guide is temporarily unavailable.")).toBeVisible();
  });

  test("preserves administrator layout and workflow when admin: true", async ({ page }) => {
    await page.route("**/bff/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/bff/auth/session") {
        await route.fulfill({ json: { authenticated: true } });
      } else if (path === "/bff/me") {
        await route.fulfill({ json: { organization: { displayName: "BDR Staff" }, admin: true } });
      } else if (path === "/bff/portal/buildings") {
        await route.fulfill({
          json: {
            items: [clientBuildingA],
            admin: true,
          },
        });
      } else {
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      }
    });

    await page.goto("/projects");
    // Administrator shows Clients view
    await expect(page.getByRole("heading", { name: "Clients", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText("Choose a client. Create a client and send invites from Organization tools.")).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(navigation.getByRole("link", { name: "Clients" })).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator('a[aria-current="page"]')).toHaveCount(1);
  });
});
