import { describe, expect, it } from "vitest";

import { normalizeEmail } from "./invitations";
import {
  auditExpiresAt,
  auditKeys,
  identityKeys,
  publishedArtifactKey,
  sessionKeys,
  tenantKeys,
} from "./keys";

const ids = {
  organization: "org_0123456789abcdef",
  project: "project_0123456789abcdef",
  inspection: "inspection_0123456789abcdef",
  reportVersion: "version_0123456789abcdef",
  session: "session-secret-with-enough-entropy",
};

describe("DynamoDB key schema", () => {
  it("places all tenant data in the organization partition", () => {
    const project = tenantKeys.project(ids.organization, ids.project);
    const inspection = tenantKeys.inspection(
      ids.organization,
      ids.project,
      ids.inspection,
    );
    const version = tenantKeys.reportVersion(
      ids.organization,
      ids.project,
      ids.inspection,
      "ASSESSMENT",
      ids.reportVersion,
    );

    expect(project.PK).toBe(`ORG#${ids.organization}`);
    expect(inspection.PK).toBe(project.PK);
    expect(version.PK).toBe(project.PK);
    expect(version.SK).toContain(`#${ids.reportVersion}`);
  });

  it("separates organization documents from inspection reports", () => {
    expect(tenantKeys.organizationDocument(ids.organization).SK).toBe(
      "DOCUMENT#HOW_TO_READ",
    );
    expect(tenantKeys.documentVersion(ids.organization, ids.reportVersion).SK).toBe(
      `DOCUMENT_VERSION#HOW_TO_READ#${ids.reportVersion}`,
    );
  });

  it("uses base keys for identities and session revocation pointers", () => {
    const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example";
    const subject = "subject-0123456789";

    expect(identityKeys.subject(issuer, subject).SK).toBe("PROFILE");
    expect(sessionKeys.clientSession(ids.session).PK).toMatch(/^SESSION#[a-f0-9]{64}$/);
    expect(sessionKeys.clientLogin("oauth-state").PK).toMatch(/^LOGIN#[a-f0-9]{64}$/);
    expect(sessionKeys.clientSubjectPointer(issuer, subject, ids.session).PK).toMatch(
      /^SUBJECT#[a-f0-9]{64}#subject-/,
    );
  });

  it("normalizes case-variant email reservations to the same key", () => {
    const left = identityKeys.emailReservation(normalizeEmail(" Client@Example.COM "));
    const right = identityKeys.emailReservation(normalizeEmail("client@example.com"));
    expect(left).toEqual(right);
  });

  it("creates append-only sortable audit keys and flat artifact keys", () => {
    expect(
      auditKeys.organization(
        ids.organization,
        "2026-09-13T14:00:00.000Z",
        "event_0123456789abcdef",
      ).SK,
    ).toBe("EVENT#2026-09-13T14:00:00.000Z#event_0123456789abcdef");
    expect(publishedArtifactKey(ids.reportVersion)).toBe(
      `versions/${ids.reportVersion}.pdf`,
    );
    expect(auditExpiresAt("2026-09-13T14:00:00.000Z")).toBe(
      Date.parse("2027-03-13T14:00:00.000Z") / 1000,
    );
  });

  it("clamps six-month audit retention to the end of shorter months", () => {
    expect(auditExpiresAt("2026-08-31T14:00:00.000Z")).toBe(
      Date.parse("2027-02-28T14:00:00.000Z") / 1000,
    );
  });

  it("rejects an invalid audit timestamp", () => {
    expect(() => auditExpiresAt("not-a-date")).toThrow(/valid timestamp/);
  });

  it("rejects delimiters that could forge parentage", () => {
    expect(() => tenantKeys.project(ids.organization, "project#foreign")).toThrow(
      /safe key segment/,
    );
  });
});
