import { expect, test } from "@playwright/test";

test.describe("Sign-In UI & Password Recovery", () => {
  test("navigates forgot-password request, validates password live, and returns to credentials", async ({ page }) => {
    let resetRequested = false;
    let resetConfirmed = false;

    await page.route("**/bff/auth/password/reset/request", async (route) => {
      resetRequested = true;
      await route.fulfill({ status: 200, json: { accepted: true } });
    });

    await page.route("**/bff/auth/password/reset/confirm", async (route) => {
      resetConfirmed = true;
      await route.fulfill({ status: 200, json: { reset: true } });
    });

    await page.goto("/sign-in?returnTo=%2Fprojects");

    // 1. Credentials screen
    await expect(page.getByRole("heading", { name: "Sign In", exact: true })).toBeVisible();
    await expect(page.locator("form[data-ready='true']")).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill("client@example.com");

    // Click forgot password
    await page.getByRole("button", { name: "Forgot password?" }).click();

    // 2. Forgot-password request screen
    await expect(page.getByRole("heading", { name: "Reset your password", exact: true })).toBeVisible();
    // Email should remain pre-populated
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("client@example.com");
    await page.getByRole("button", { name: "Send reset code" }).click();
    expect(resetRequested).toBe(true);

    // 3. Reset confirmation screen
    await expect(page.getByRole("heading", { name: "Choose a new password", exact: true })).toBeVisible();
    await expect(page.getByText("client@example.com")).toBeVisible();

    const resetButton = page.getByRole("button", { name: "Reset password", exact: true });
    await expect(resetButton).toBeDisabled();

    await page.getByLabel("Confirmation code", { exact: true }).fill("123456");
    await expect(resetButton).toBeDisabled();

    // Live password requirements
    await page.getByLabel("New password", { exact: true }).fill("short");
    await expect(page.getByText("At least 12 characters")).toBeVisible();
    await expect(resetButton).toBeDisabled();

    await page.getByLabel("New password", { exact: true }).fill("ValidPass123!@#");
    await page.getByLabel("Confirm new password", { exact: true }).fill("Mismatch123!");
    await expect(page.getByText("Passwords match")).toBeVisible();
    await expect(resetButton).toBeDisabled();

    await page.getByLabel("Confirm new password", { exact: true }).fill("ValidPass123!@#");
    // All requirements met and passwords match -> button enabled
    await expect(resetButton).toBeEnabled();

    await resetButton.click();
    expect(resetConfirmed).toBe(true);

    // 4. Return to credentials screen with success banner and preserved email
    await expect(page.getByRole("heading", { name: "Sign In", exact: true })).toBeVisible();
    await expect(page.getByText("Password updated. Sign in with your new password.")).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("client@example.com");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  });

  test("handles temporary password challenge with requirements and cancellation", async ({ page }) => {
    await page.route("**/bff/auth/password", async (route) => {
      await route.fulfill({
        status: 200,
        json: { newPassword: true, session: "temp-session-token" },
      });
    });

    await page.goto("/sign-in?returnTo=%2Fprojects");
    await expect(page.getByRole("heading", { name: "Sign In", exact: true })).toBeVisible();
    await expect(page.locator("form[data-ready='true']")).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill("tempuser@example.com");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("tempuser@example.com");
    await page.getByLabel("Password", { exact: true }).fill("TempPassword123!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Set a new password", exact: true })).toBeVisible();
    const updateButton = page.getByRole("button", { name: "Update password and sign in", exact: true });
    await expect(updateButton).toBeDisabled();

    // Fill valid new password and match
    await page.getByLabel("New password", { exact: true }).fill("StrongPass456!");
    await page.getByLabel("Confirm new password", { exact: true }).fill("StrongPass456!");
    await expect(updateButton).toBeEnabled();

    // Cancel back to sign in
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await expect(page.getByRole("heading", { name: "Sign In", exact: true })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  });

  test("handles MFA challenge and back navigation", async ({ page }) => {
    await page.route("**/bff/auth/password", async (route) => {
      await route.fulfill({
        status: 200,
        json: { mfa: true, session: "mfa-session-token" },
      });
    });

    await page.goto("/sign-in?returnTo=%2Fprojects");
    await expect(page.getByRole("heading", { name: "Sign In", exact: true })).toBeVisible();
    await expect(page.locator("form[data-ready='true']")).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill("mfauser@example.com");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("mfauser@example.com");
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();


    await expect(page.getByRole("heading", { name: "Two-factor authentication", exact: true })).toBeVisible();
    const verifyButton = page.getByRole("button", { name: "Verify code", exact: true });
    await expect(verifyButton).toBeDisabled();

    await page.getByLabel("Authenticator code", { exact: true }).fill("654321");
    await expect(verifyButton).toBeEnabled();

    // Back to sign in clears code
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await expect(page.getByRole("heading", { name: "Sign In", exact: true })).toBeVisible();
  });
});
