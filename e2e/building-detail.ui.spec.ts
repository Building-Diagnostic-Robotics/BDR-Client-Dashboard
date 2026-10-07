import { expect, test } from "@playwright/test";

const reportRows = (publishedAt: string | null) => [
  {
    reportType: "ASSESSMENT",
    deliveryStatus: publishedAt ? "AVAILABLE" : "IN_PREPARATION",
    publishedAt,
    filename: publishedAt ? "assessment.pdf" : null,
  },
  {
    reportType: "EVIDENCE",
    deliveryStatus: "IN_PREPARATION",
    publishedAt: null,
    filename: null,
  },
  {
    reportType: "ROOF_TAKEOFF",
    deliveryStatus: "NOT_INCLUDED",
    publishedAt: null,
    filename: null,
  },
  {
    reportType: "AS_BUILT",
    deliveryStatus: "NOT_INCLUDED",
    publishedAt: null,
    filename: null,
  },
  {
    reportType: "CAPITAL_PLANNING",
    deliveryStatus: "NOT_INCLUDED",
    publishedAt: null,
    filename: null,
  },
] as const;

const latest = {
  inspectionId: "pin_111111111111111111111111",
  scannedAt: "2026-10-01T14:00:00.000Z",
  uploadCompletedAt: "2026-10-01T16:00:00.000Z",
  timeZone: "America/New_York",
  availableReportTypes: ["ASSESSMENT"],
  latestReportUpdate: "2026-10-02T12:00:00.000Z",
  reports: reportRows("2026-10-02T12:00:00.000Z"),
};

const previous = {
  inspectionId: "pin_222222222222222222222222",
  scannedAt: "2026-08-01T14:00:00.000Z",
  uploadCompletedAt: "2026-08-01T16:00:00.000Z",
  timeZone: "America/New_York",
  availableReportTypes: [],
  latestReportUpdate: null,
  reports: reportRows(null),
};

test("renders the physical-building inspection hierarchy without an empty-state flash", async ({ page }) => {
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/bff/auth/session") {
      await route.fulfill({ json: { authenticated: true } });
    } else if (path === "/bff/me") {
      await route.fulfill({ json: { organization: { displayName: "Midland Holdings" }, admin: false } });
    } else if (path === "/bff/portal/building-detail") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({
        json: {
          buildingId: "pbl_111111111111111111111111",
          displayName: "Midland Business Park",
          address: "100 Main Street",
          engineerNames: "Tony, Thom",
          revision: "rev_111111111111111111111111",
          latestInspection: latest,
          inspectionCount: 2,
          provisional: false,
          inspections: [latest, previous],
        },
      });
    } else {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
    }
  });

  await page.goto("/buildings/view?buildingId=pbl_111111111111111111111111");
  await expect(page.getByLabel("Loading building")).toBeVisible();
  await expect(page.getByText("No reports yet")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Midland Business Park", level: 1 })).toBeVisible();
  await expect(page.getByText("Engineers: Tony, Thom")).toBeVisible();
  await expect(page.getByText("Latest inspection")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Roof Assessment" })).toHaveCount(1);
  await expect(page.getByText("Available", { exact: true })).toBeVisible();
  await expect(page.getByText("In preparation", { exact: true })).toBeVisible();
  await expect(page.getByText("Not included", { exact: true })).toHaveCount(3);

  await page.getByRole("button", { name: "Expand inspection reports" }).click();
  await expect(page.getByRole("heading", { name: "Roof Assessment" })).toHaveCount(2);
  await expect(page.getByText("Request roof takeoff")).toHaveCount(0);
  await expect(page.getByText("History", { exact: true })).toHaveCount(0);
});
