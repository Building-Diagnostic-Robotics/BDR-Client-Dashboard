import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import JSZip from "jszip";

const projectId = "project_0123456789abcdef";
const inspectionId = "inspection_0123456789abcdef";
const pdf = "%PDF-1.4\n%%EOF\n";

test("downloads current inspection reports as a ZIP from the regional S3 host", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "cookie", { get: () => "__Host-bdr_csrf=test-csrf" });
  });

  let fetchedPdf = false;
  await page.route("https://portal-test.s3.us-east-1.amazonaws.com/**", async (route) => {
    fetchedPdf = true;
    await route.fulfill({
      status: 200,
      contentType: "application/pdf",
      headers: { "access-control-allow-origin": "http://localhost:4300" },
      body: pdf,
    });
  });
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/bff/auth/session") {
      await route.fulfill({ json: { authenticated: true } });
    } else if (path === "/bff/me") {
      await route.fulfill({ json: { organization: { displayName: "Test Organization" } } });
    } else if (path === `/bff/projects/${projectId}`) {
      await route.fulfill({ json: {
        projectId, displayName: "Sample Building", address: "Test Address", timeZone: "America/New_York",
      } });
    } else if (path === `/bff/projects/${projectId}/inspections`) {
      await route.fulfill({ json: { items: [{
        inspectionId, scannedAt: "2026-09-16T14:00:00-04:00", scanTimeZone: "America/New_York",
      }] } });
    } else if (path === `/bff/projects/${projectId}/inspections/${inspectionId}/reports`) {
      await route.fulfill({ json: { items: [{
        reportType: "ASSESSMENT", deliveryStatus: "PUBLISHED", publishedAt: "2026-09-17T14:00:00Z",
      }] } });
    } else if (path === `/bff/projects/${projectId}/inspections/${inspectionId}/reports/ASSESSMENT/access`) {
      await route.fulfill({ json: {
        url: "https://portal-test.s3.us-east-1.amazonaws.com/versions/report.pdf",
        expiresInSeconds: 300,
      } });
    } else {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
    }
  });

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("heading", { name: "Sample Building" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all (.zip)" }).click();
  const download = await downloadPromise;
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  expect(await zip.file("Roof Assessment.pdf")?.async("string")).toBe(pdf);
  expect(fetchedPdf).toBe(true);
  await expect(page.getByText("We could not bundle all reports.")).toHaveCount(0);
});
