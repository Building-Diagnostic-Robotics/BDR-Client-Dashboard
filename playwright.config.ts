import { defineConfig, devices } from "@playwright/test";
import { liveBaseURL } from "./e2e/live-config";

const live = process.env.PORTAL_E2E_MODE === "live";
const localOrigin = "http://localhost:4300";
const baseURL = live ? liveBaseURL(process.env) : localOrigin;

export default defineConfig({
  testDir: "./e2e",
  testMatch: live ? "**/*.live.spec.ts" : "**/*.ui.spec.ts",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: live ? 60_000 : 30_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL,
    // Live traces/screenshots can capture credentials, callback queries, and cookies.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  ...(!live ? {
    webServer: {
      command: "npm run dev --workspace @bdr/web -- --hostname localhost --port 4300",
      url: localOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { CLIENT_BFF_API_URL: "" },
    },
  } : {}),
});
