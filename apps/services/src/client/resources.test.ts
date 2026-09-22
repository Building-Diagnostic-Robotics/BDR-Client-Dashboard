import { projectSchema } from "@bdr/contracts";
import { describe, expect, it, vi } from "vitest";

import { ClientResourceService } from "./resources";

const project = projectSchema.parse({
  organizationId: "org_0123456789abcdef",
  projectId: "project_0123456789abcdef",
  displayName: "Midland Business Park",
  address: "4300 West Loop, Fort Worth, TX",
  timeZone: "America/Chicago",
  lifecycleStatus: "ACTIVE",
  archivedAt: null,
  archivedByAdminId: null,
  archiveReason: null,
});

describe("client project responses", () => {
  it("returns basic project detail and a separate list summary", async () => {
    const resources = new ClientResourceService({} as never, {} as never);
    const context = {} as never;
    vi.spyOn(resources.policy, "loadVisibleProject").mockResolvedValue(project);
    vi.spyOn(resources.policy, "listVisibleProjects").mockResolvedValue([project]);
    vi.spyOn(resources.policy, "latestInspectionSummaryForProject").mockResolvedValue({
      scannedAt: "2026-09-04T14:30:00.000Z",
      scanTimeZone: "America/Chicago",
      overallStatus: "PUBLISHED",
    });

    await expect(resources.project(context, project.projectId)).resolves.toEqual({
      projectId: project.projectId,
      displayName: project.displayName,
      address: project.address,
      timeZone: project.timeZone,
    });
    await expect(resources.projects(context)).resolves.toEqual([{
      projectId: project.projectId,
      displayName: project.displayName,
      address: project.address,
      timeZone: project.timeZone,
      latestInspection: {
        scannedAt: "2026-09-04T14:30:00.000Z",
        scanTimeZone: "America/Chicago",
        overallStatus: "PUBLISHED",
      },
    }]);
  });
});
