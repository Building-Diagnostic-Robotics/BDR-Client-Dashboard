import { expect, test } from "@playwright/test";

import { formatUploadAge } from "../apps/web/src/lib/format";

test("upload age switches to the inspection's calendar date at exactly 48 hours", () => {
  const value = "2026-10-01T02:00:00.000Z";
  const uploaded = Date.parse(value);
  expect(formatUploadAge(value, uploaded + 47 * 3_600_000 + 59 * 60_000)).toBe("Data uploaded 1 day ago");
  expect(formatUploadAge(value, uploaded + 48 * 3_600_000, "America/New_York")).toBe("Data uploaded on Sep 30, 2026");
  expect(formatUploadAge(value, uploaded + 48 * 3_600_000)).toBe("Data uploaded on Oct 1, 2026");
  expect(formatUploadAge(value, uploaded + 139 * 86_400_000, "America/New_York")).toBe("Data uploaded on Sep 30, 2026");
});

test("upload age preserves recent and unavailable date messages", () => {
  const value = "2026-10-01T12:00:00.000Z";
  const uploaded = Date.parse(value);
  expect(formatUploadAge(value, uploaded + 10 * 60_000)).toBe("Data uploaded 10 min ago");
  expect(formatUploadAge(value, uploaded + 2 * 3_600_000)).toBe("Data uploaded 2 hrs ago");
  expect(formatUploadAge(value, uploaded - 60_000)).toBe("Data uploaded just now");
  expect(formatUploadAge(null, uploaded)).toBe("Upload time unavailable");
  expect(formatUploadAge("invalid", uploaded)).toBe("Upload time unavailable");
});
