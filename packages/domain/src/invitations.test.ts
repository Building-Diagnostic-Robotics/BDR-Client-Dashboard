import { describe, expect, it } from "vitest";

import type { Invitation } from "@bdr/contracts";

import { DomainError } from "./errors";
import {
  acceptInvitation,
  assertInvitationCanBeAccepted,
  assertInvitationCanBeResent,
  expireInvitation,
  normalizeEmail,
} from "./invitations";

const invitation: Invitation = {
  invitationId: "invitation_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  email: "Client@Example.com",
  normalizedEmail: "client@example.com",
  status: "PENDING",
  absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
  ttlExpiresAt: null,
  acceptedAt: null,
};

describe("invitation rules", () => {
  it("normalizes equivalent email forms deterministically", () => {
    expect(normalizeEmail("  CLIENT@Example.COM ")).toBe("client@example.com");
  });

  it("uses absolute expiry rather than TTL cleanup", () => {
    expect(() =>
      assertInvitationCanBeAccepted(
        { ...invitation, ttlExpiresAt: 9_999_999_999 },
        new Date("2026-09-20T14:00:00.000Z"),
      ),
    ).toThrowError(DomainError);
  });

  it("records acceptance only for an unexpired pending invitation", () => {
    expect(acceptInvitation(invitation, new Date("2026-09-13T14:00:00.000Z"))).toMatchObject({
      status: "ACCEPTED",
      acceptedAt: "2026-09-13T14:00:00.000Z",
    });
  });

  it("permits resend after delivery failure but never after acceptance", () => {
    expect(() =>
      assertInvitationCanBeResent({ ...invitation, status: "DELIVERY_FAILED" }),
    ).not.toThrow();
    expect(() =>
      assertInvitationCanBeResent({ ...invitation, status: "ACCEPTED" }),
    ).toThrowError(DomainError);
  });

  it("expires only after the application deadline", () => {
    expect(
      expireInvitation(invitation, new Date("2026-09-20T14:00:00.000Z")).status,
    ).toBe("EXPIRED");
  });
});
