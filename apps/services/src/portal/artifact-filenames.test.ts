import { describe, expect, it } from "vitest";

import { artifactContentDisposition, reportDownloadFilename, safeArtifactFilename } from "./artifact-filenames";

describe("report download filenames", () => {
  it("names PDFs by building and report type", () => {
    expect(reportDownloadFilename("Midland Business Park", "ASSESSMENT"))
      .toBe("Midland Business Park - Roof Assessment.pdf");
    expect(reportDownloadFilename("Midland Business Park", "CAPITAL_PLANNING"))
      .toBe("Midland Business Park - Capital Planning.pdf");
  });

  it("retains the true As-built file type", () => {
    expect(reportDownloadFilename("Tower", "AS_BUILT", "image/png")).toBe("Tower - As-built.png");
    expect(reportDownloadFilename("Tower", "AS_BUILT", "image/jpeg")).toBe("Tower - As-built.jpg");
    expect(reportDownloadFilename("Tower", "AS_BUILT", "application/pdf")).toBe("Tower - As-built.pdf");
  });

  it("removes path and header characters and bounds the building name without truncating the extension", () => {
    expect(reportDownloadFilename('North/West\\Tower\r\n"A"', "EVIDENCE"))
      .toBe("North-West-Tower---A- - Inspection Evidence.pdf");
    const name = reportDownloadFilename("Tower".repeat(100), "ASSESSMENT");
    expect(name.length).toBeLessThan(180);
    expect(name.endsWith(" - Roof Assessment.pdf")).toBe(true);
    const unicodeName = reportDownloadFilename("🏢".repeat(100), "ASSESSMENT");
    expect(unicodeName.length).toBeLessThan(180);
    expect(() => artifactContentDisposition(unicodeName, "DOWNLOAD")).not.toThrow();
    expect(safeArtifactFilename("... ")).toBe("BDR-report");
  });

  it("sends ASCII fallback and encoded UTF-8 filenames for both dispositions", () => {
    const name = reportDownloadFilename("École", "ASSESSMENT");
    expect(artifactContentDisposition(name, "DOWNLOAD"))
      .toBe('attachment; filename="-cole - Roof Assessment.pdf"; filename*=UTF-8\'\'%C3%89cole%20-%20Roof%20Assessment.pdf');
    expect(artifactContentDisposition(name, "VIEW")).toMatch(/^inline;/);
    expect(artifactContentDisposition('A\r\n"B.pdf', "DOWNLOAD")).not.toMatch(/[\r\n]/);
  });
});
