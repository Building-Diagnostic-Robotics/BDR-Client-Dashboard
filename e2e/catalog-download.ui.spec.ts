import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import type { PortalReport } from "@bdr/contracts";
import { expect, test as base, type Page } from "@playwright/test";
import JSZip from "jszip";

const buildingId = "pbl_111111111111111111111111";
const inspectionId = "pin_111111111111111111111111";
const pdf = "%PDF-1.4\n%%EOF\n";
const buildingName = "Midland Business Park";
const zipError = "We could not bundle all reports. Please download them individually.";
const test = base.extend<{ artifactOrigin: string }>({
  artifactOrigin: async ({}, use) => {
    // Serve real attachment responses: WebKit downloads are not reliable with route.fulfill.
    const server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (request.url === "/ASSESSMENT/view") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Report preview</title><p>Report preview</p>");
      } else if (request.url === "/ASSESSMENT/download") {
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${buildingName} - Roof Assessment.pdf"`,
          "Content-Length": Buffer.byteLength(pdf),
        });
        response.end(pdf);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Artifact server did not bind a TCP port");
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  },
});
const reports: PortalReport[] = [
  { reportType: "ASSESSMENT", deliveryStatus: "AVAILABLE", publishedAt: "2026-10-01T12:00:00Z", filename: `${buildingName} - Roof Assessment.pdf` },
  { reportType: "EVIDENCE", deliveryStatus: "AVAILABLE", publishedAt: "2026-10-01T12:00:00Z", filename: `${buildingName} - Inspection Evidence.pdf` },
  { reportType: "ROOF_TAKEOFF", deliveryStatus: "AVAILABLE", publishedAt: "2026-10-01T12:00:00Z", filename: `${buildingName} - Roof Takeoff.pdf` },
  { reportType: "AS_BUILT", deliveryStatus: "AVAILABLE", publishedAt: "2026-10-01T12:00:00Z", filename: `${buildingName} - As-built.png` },
  { reportType: "CAPITAL_PLANNING", deliveryStatus: "NOT_INCLUDED", publishedAt: null, filename: null },
];

async function mockCatalog(
  page: Page,
  accessStatus = 200,
  reportRows: readonly PortalReport[] = reports,
  artifactUrl: (reportType: string, disposition: string) => string =
    (reportType) => `https://portal-test.s3.us-east-1.amazonaws.com/${reportType}`,
) {
  const accessRequests: Array<{ disposition: string; reportType: string }> = [];
  await page.addInitScript(() => {
    Object.defineProperty(document, "cookie", { get: () => "__Host-bdr_csrf=test-csrf" });
  });
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/bff/auth/session") await route.fulfill({ json: { authenticated: true } });
    else if (path === "/bff/me") await route.fulfill({ json: { organization: { displayName: "Midland Holdings" }, admin: false } });
    else if (path === "/bff/portal/building-detail") await route.fulfill({ json: {
      buildingId, displayName: buildingName, address: "100 Main Street", engineerNames: "", revision: null,
      provisional: true, inspectionCount: 1,
      latestInspection: {
        inspectionId, scannedAt: "2026-05-13T02:00:00Z", uploadCompletedAt: "2026-05-13T02:00:00Z",
        timeZone: "America/New_York", availableReportTypes: ["ASSESSMENT", "EVIDENCE", "ROOF_TAKEOFF", "AS_BUILT"],
        latestReportUpdate: "2026-10-01T12:00:00Z", reports: reportRows,
      },
      inspections: [{
        inspectionId, scannedAt: "2026-05-13T02:00:00Z", uploadCompletedAt: "2026-05-13T02:00:00Z",
        timeZone: "America/New_York", availableReportTypes: ["ASSESSMENT", "EVIDENCE", "ROOF_TAKEOFF", "AS_BUILT"],
        latestReportUpdate: "2026-10-01T12:00:00Z", reports: reportRows,
      }],
    } });
    else if (path === "/bff/portal/artifact-access") {
      const body = route.request().postDataJSON() as { buildingId: string; inspectionId: string; disposition: string; reportType: string };
      expect(body.buildingId).toBe(buildingId);
      expect(body.inspectionId).toBe(inspectionId);
      expect(route.request().headers()["x-bdr-csrf"]).toBe("test-csrf");
      accessRequests.push(body);
      await route.fulfill(accessStatus === 200 ? { json: {
        url: artifactUrl(body.reportType, body.disposition),
        expiresInSeconds: 300,
      } } : { status: accessStatus, json: { error: "authentication_required" } });
    } else await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto(`/buildings/view?buildingId=${buildingId}`);
  await expect(page.getByRole("heading", { name: buildingName, level: 1 })).toBeVisible();
  return accessRequests;
}

test("catalog ZIP contains all available reports with friendly names and at most two simultaneous fetches", async ({ page }) => {
  let active = 0;
  let maximum = 0;
  let started = 0;
  let releaseFirstBatch = () => {};
  const gate = new Promise<void>((resolve) => { releaseFirstBatch = resolve; });
  await page.route("https://portal-test.s3.us-east-1.amazonaws.com/**", async (route) => {
    started += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    if (started <= 2) await gate;
    const image = new URL(route.request().url()).pathname.endsWith("AS_BUILT");
    active -= 1;
    await route.fulfill({ status: 200, contentType: image ? "image/png" : "application/pdf",
      headers: { "access-control-allow-origin": "http://localhost:4300" }, body: image ? "test-image" : pdf });
  });
  const accessRequests = await mockCatalog(page);
  await expect(page.getByText("Data uploaded on May 12, 2026", { exact: false })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all (.zip)" }).click();
  await expect.poll(() => started).toBe(2);
  expect(active).toBe(2);
  releaseFirstBatch();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`${buildingName} - May 12, 2026.zip`);
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  for (const report of reports.filter((report) => report.deliveryStatus === "AVAILABLE")) {
    expect(await zip.file(report.filename!)?.async("string")).toBe(report.reportType === "AS_BUILT" ? "test-image" : pdf);
  }
  expect(Object.keys(zip.files)).toHaveLength(4);
  expect(maximum).toBe(2);
  expect(accessRequests.map((request) => request.reportType).sort()).toEqual(["ASSESSMENT", "AS_BUILT", "EVIDENCE", "ROOF_TAKEOFF"].sort());
  expect(accessRequests.every((request) => request.disposition === "DOWNLOAD")).toBe(true);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("catalog ZIP failure produces an error and no partial archive", async ({ page }) => {
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await page.route("https://portal-test.s3.us-east-1.amazonaws.com/**", async (route) => {
    await route.fulfill({ status: 403, headers: { "access-control-allow-origin": "http://localhost:4300" } });
  });
  await mockCatalog(page);
  await page.getByRole("button", { name: "Download all (.zip)" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(zipError);
  await expect(page.getByRole("button", { name: "Download all (.zip)" })).toBeEnabled();
  expect(downloads).toBe(0);
  // A retry must get fresh access URLs and build a complete new archive.
  await page.route("https://portal-test.s3.us-east-1.amazonaws.com/**", async (route) => {
    await route.fulfill({ contentType: "application/pdf", headers: { "access-control-allow-origin": "http://localhost:4300" }, body: pdf });
  });
  const retryDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all (.zip)" }).click();
  const zip = await JSZip.loadAsync(await readFile(await (await retryDownload).path()));
  expect(Object.keys(zip.files)).toHaveLength(4);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("catalog ZIP rejects duplicate filenames without silently losing a report", async ({ page }) => {
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await page.route("https://portal-test.s3.us-east-1.amazonaws.com/**", async (route) => {
    await route.fulfill({ contentType: "application/pdf", headers: { "access-control-allow-origin": "http://localhost:4300" }, body: pdf });
  });
  const duplicated = reports.map((report) => report.reportType === "EVIDENCE" ? { ...report, filename: reports[0]!.filename } : report);
  await mockCatalog(page, 200, duplicated);
  await page.getByRole("button", { name: "Download all (.zip)" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(zipError);
  await expect(page.getByRole("button", { name: "Download all (.zip)" })).toBeEnabled();
  expect(downloads).toBe(0);
});

test("expired ZIP access returns to sign-in", async ({ page }) => {
  await mockCatalog(page, 401);
  await page.getByRole("button", { name: "Download all (.zip)" }).click();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
});

test("View opens a report tab and Download uses the attachment's suggested filename", async ({ page, artifactOrigin }) => {
  const requests = await mockCatalog(page, 200, reports,
    (reportType, disposition) => `${artifactOrigin}/${reportType}/${disposition.toLowerCase()}`);
  const row = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Roof Assessment", exact: true }) });
  const popupEvent = page.waitForEvent("popup");
  await row.getByRole("button", { name: "View", exact: true }).click();
  const popup = await popupEvent;
  await expect(popup).toHaveURL(`${artifactOrigin}/ASSESSMENT/view`);
  await expect(popup.getByText("Report preview", { exact: true })).toBeVisible();
  await popup.close();
  const downloadEvent = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(`${buildingName} - Roof Assessment.pdf`);
  expect(await readFile(await download.path(), "utf8")).toBe(pdf);
  expect(requests.map((request) => request.disposition)).toEqual(["VIEW", "DOWNLOAD"]);
  await expect(page).toHaveURL(new RegExp(`/buildings/view\\?buildingId=${buildingId}`));
  await expect(page.getByRole("heading", { name: buildingName, level: 1 })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});
