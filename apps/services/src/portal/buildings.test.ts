import { describe, expect, it } from "vitest";

import { clientCanSee, clientUserStatus } from "./buildings";

describe("shared building client visibility", () => {
  it("shows an existing building after a report has been approved", () => {
    expect(clientCanSee({
      released: false,
      reports: {
        EVIDENCE: { clientVisible: true, awaitingClientAdmin: false },
      },
    }, "org_sig", false)).toBe(true);
  });

  it("keeps an unreleased building with no approved report hidden", () => {
    expect(clientCanSee({
      released: false,
      reports: {
        ASSESSMENT: { clientVisible: false, awaitingClientAdmin: true },
      },
    }, "org_sig", false)).toBe(false);
  });

  it("allows administrators to inspect an unreleased building", () => {
    expect(clientCanSee({ released: false, reports: {} }, "org_sig", true)).toBe(true);
  });
});

describe("shared client account status", () => {
  it("does not present a disabled Cognito account as signed in", () => {
    expect(clientUserStatus("ACTIVE", { Enabled: false, UserStatus: "CONFIRMED" })).toBe("REVOKED");
  });

  it("preserves invitation and active states for enabled accounts", () => {
    expect(clientUserStatus("ACTIVE", { Enabled: true, UserStatus: "FORCE_CHANGE_PASSWORD" })).toBe("INVITED");
    expect(clientUserStatus("ACTIVE", { Enabled: true, UserStatus: "CONFIRMED" })).toBe("ACTIVE");
  });
});
