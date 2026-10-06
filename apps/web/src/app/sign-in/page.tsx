"use client";

import { useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";

type Screen =
  | "credentials"
  | "temporary-password"
  | "mfa"
  | "forgot-request"
  | "forgot-confirm";

type Requirement = {
  id: string;
  label: string;
  isMet: boolean;
};

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.739a.75.75 0 0 1 1.04-.208Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function PasswordRequirementsChecklist({
  password,
  confirmPassword,
}: {
  password: string;
  confirmPassword: string;
}) {
  const requirements: Requirement[] = useMemo(() => [
    {
      id: "length",
      label: "At least 12 characters",
      isMet: password.length >= 12,
    },
    {
      id: "upper",
      label: "One uppercase letter",
      isMet: /[A-Z]/.test(password),
    },
    {
      id: "lower",
      label: "One lowercase letter",
      isMet: /[a-z]/.test(password),
    },
    {
      id: "number",
      label: "One number",
      isMet: /[0-9]/.test(password),
    },
    {
      id: "symbol",
      label: "One symbol",
      isMet: /[^A-Za-z0-9]/.test(password),
    },
  ], [password]);

  const confirmationMet = confirmPassword.length > 0 && password === confirmPassword;

  return (
    <ul className="password-requirements" aria-label="Password requirements">
      <li className="password-requirements__title" aria-hidden="true">
        Password requirements:
      </li>
      {requirements.map((req) => (
        <li
          key={req.id}
          className={`password-requirement-item ${req.isMet ? "password-requirement-item--met" : ""}`}
        >
          {req.isMet ? <CheckIcon /> : <CircleIcon />}
          <span className="sr-only">{req.isMet ? "Satisfied: " : "Not satisfied: "}</span>
          <span>{req.label}</span>
        </li>
      ))}
      <li
        className={`password-requirement-item ${confirmationMet ? "password-requirement-item--met" : ""}`}
      >
        {confirmationMet ? <CheckIcon /> : <CircleIcon />}
        <span className="sr-only">{confirmationMet ? "Satisfied: " : "Not satisfied: "}</span>
        <span>Passwords match</span>
      </li>
    </ul>
  );
}

function SignInForm() {
  const params = useSearchParams();
  const rawReturnTo = params.get("returnTo") || "/projects";
  const returnTo = rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/projects";

  const [screen, setScreen] = useState<Screen>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaSession, setMfaSession] = useState<string | null>(null);
  const [resetCode, setResetCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  const isPasswordValid = useMemo(() => {

    return (
      newPassword.length >= 12 &&
      /[A-Z]/.test(newPassword) &&
      /[a-z]/.test(newPassword) &&
      /[0-9]/.test(newPassword) &&
      /[^A-Za-z0-9]/.test(newPassword)
    );
  }, [newPassword]);

  const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword;

  async function handleCredentialsSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/bff/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          returnTo,
        }),
      });

      const body = (await response.json()) as {
        returnTo?: string;
        mfa?: boolean;
        newPassword?: boolean;
        session?: string;
        error?: string;
      };

      if (response.ok && body.mfa && body.session) {
        setMfaSession(body.session);
        setPassword("");
        setError(null);
        setScreen("mfa");
        return;
      }

      if (response.ok && body.newPassword && body.session) {
        setMfaSession(body.session);
        setPassword("");
        setError(null);
        setScreen("temporary-password");
        return;
      }

      if (!response.ok || !body.returnTo) {
        setError("Incorrect email or password.");
        return;
      }

      window.location.assign(body.returnTo);
    } catch {
      setError("Incorrect email or password.");
    } finally {
      setPending(false);
    }
  }

  async function handleTemporaryPasswordSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isPasswordValid || !passwordsMatch || !mfaSession) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/bff/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password: "",
          newPassword,
          mfaSession,
          returnTo,
        }),
      });

      const body = (await response.json()) as {
        returnTo?: string;
        mfa?: boolean;
        session?: string;
        error?: string;
      };

      if (response.ok && body.mfa && body.session) {
        setMfaSession(body.session);
        setNewPassword("");
        setConfirmPassword("");
        setError(null);
        setScreen("mfa");
        return;
      }

      if (!response.ok || !body.returnTo) {
        setError("Unable to update password. Please ensure all requirements are met.");
        return;
      }

      window.location.assign(body.returnTo);
    } catch {
      setError("Unable to update password. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleMfaSubmit(event: FormEvent) {
    event.preventDefault();
    if (!mfaSession) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/bff/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password: "",
          mfaCode: mfaCode.trim(),
          mfaSession,
          returnTo,
        }),
      });

      const body = (await response.json()) as {
        returnTo?: string;
        error?: string;
      };

      if (!response.ok || !body.returnTo) {
        setError("Invalid authenticator code. Please try again.");
        return;
      }

      window.location.assign(body.returnTo);
    } catch {
      setError("Invalid authenticator code. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleForgotRequestSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/bff/auth/password/reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
        }),
      });

      if (!response.ok) {
        setError("Unable to send reset code. Please check your email and try again.");
        return;
      }

      setResetCode("");
      setNewPassword("");
      setConfirmPassword("");
      setError(null);
      setScreen("forgot-confirm");
    } catch {
      setError("Unable to send reset code. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleForgotConfirmSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isPasswordValid || !passwordsMatch) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/bff/auth/password/reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          confirmationCode: resetCode.trim(),
          newPassword,
        }),
      });

      const body = (await response.json().catch(() => null)) as {
        reset?: boolean;
        message?: string;
        error?: string;
      } | null;

      if (!response.ok || !body?.reset) {
        setError(body?.message || "Failed to reset password. Please check your reset code.");
        return;
      }

      setResetCode("");
      setNewPassword("");
      setConfirmPassword("");
      setPassword("");
      setError(null);
      setSuccessMessage("Password updated. Sign in with your new password.");
      setScreen("credentials");
    } catch {
      setError("Failed to reset password. Please try again.");
    } finally {
      setPending(false);
    }
  }

  function switchToForgotPassword() {
    setPassword("");
    setError(null);
    setSuccessMessage(null);
    setScreen("forgot-request");
  }

  function handleBackToSignIn() {
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setMfaCode("");
    setMfaSession(null);
    setResetCode("");
    setError(null);
    setSuccessMessage(null);
    setScreen("credentials");
  }

  function handleRequestNewCode() {
    setResetCode("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setScreen("forgot-request");
  }

  return (
    <main className="login-screen">
      <div className="login-card">
        <header className="login-card__header">
          <img
            src="/bdr_logo_name_cropped.png"
            alt="Building Diagnostic Robotics"
            className="login-card__logo"
          />
        </header>

        {screen === "credentials" && (
          <div className="login-card__body">
            <div className="login-card__title-group">
              <h1>Sign In</h1>
            </div>



            {successMessage && (
              <div className="login-success" role="status">
                <SuccessIcon />
                <span>{successMessage}</span>
              </div>
            )}

            {error && (
              <div className="login-error" role="alert">
                <ErrorIcon />
                <span>{error}</span>
              </div>
            )}

            <form
              className="login-form"
              data-ready={ready ? "true" : undefined}
              onSubmit={handleCredentialsSubmit}
            >
              <div className="login-field">
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>

              <div className="login-field">
                <div className="login-field__label-row">
                  <label htmlFor="login-password">Password</label>
                  <button
                    type="button"
                    className="login-field-action"
                    onClick={switchToForgotPassword}
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>

              <div className="login-actions">
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={pending}
                >
                  {pending ? "Signing in…" : "Sign in"}
                </button>
              </div>
            </form>
          </div>
        )}

        {screen === "temporary-password" && (
          <div className="login-card__body">
            <div className="login-card__title-group">
              <h1>Set a new password</h1>
              <p className="login-card__subtitle">
                Your temporary password has expired or must be replaced before signing in.
              </p>
            </div>

            {error && (
              <div className="login-error" role="alert">
                <ErrorIcon />
                <span>{error}</span>
              </div>
            )}

            <form className="login-form" onSubmit={handleTemporaryPasswordSubmit}>
              <div className="login-field">
                <label htmlFor="temp-new-password">New password</label>
                <input
                  id="temp-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                />
              </div>

              <div className="login-field">
                <label htmlFor="temp-confirm-password">Confirm new password</label>
                <input
                  id="temp-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </div>

              <PasswordRequirementsChecklist
                password={newPassword}
                confirmPassword={confirmPassword}
              />

              <div className="login-actions">
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={pending || !isPasswordValid || !passwordsMatch}
                >
                  {pending ? "Updating password…" : "Update password and sign in"}
                </button>
                <button
                  type="button"
                  className="button button--outline"
                  onClick={handleBackToSignIn}
                >
                  Back to sign in
                </button>
              </div>
            </form>
          </div>
        )}

        {screen === "mfa" && (
          <div className="login-card__body">
            <div className="login-card__title-group">
              <h1>Two-factor authentication</h1>
              <p className="login-card__subtitle">
                Enter the 6-digit verification code from your authenticator app.
              </p>
            </div>

            {error && (
              <div className="login-error" role="alert">
                <ErrorIcon />
                <span>{error}</span>
              </div>
            )}

            <form className="login-form" onSubmit={handleMfaSubmit}>
              <div className="login-field">
                <label htmlFor="mfa-code">Authenticator code</label>
                <input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                  required
                />
              </div>

              <div className="login-actions">
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={pending || mfaCode.trim().length === 0}
                >
                  {pending ? "Verifying…" : "Verify code"}
                </button>
                <button
                  type="button"
                  className="button button--outline"
                  onClick={handleBackToSignIn}
                >
                  Back to sign in
                </button>
              </div>
            </form>
          </div>
        )}

        {screen === "forgot-request" && (
          <div className="login-card__body">
            <div className="login-card__title-group">
              <h1>Reset your password</h1>
              <p className="login-card__subtitle">
                Enter the email address associated with your account and we’ll send you a reset code.
              </p>
            </div>

            {error && (
              <div className="login-error" role="alert">
                <ErrorIcon />
                <span>{error}</span>
              </div>
            )}

            <form className="login-form" onSubmit={handleForgotRequestSubmit}>
              <div className="login-field">
                <label htmlFor="reset-email">Email</label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>

              <div className="login-actions">
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={pending || !email.trim()}
                >
                  {pending ? "Sending code…" : "Send reset code"}
                </button>
                <button
                  type="button"
                  className="button button--outline"
                  onClick={handleBackToSignIn}
                >
                  Back to sign in
                </button>
              </div>
            </form>
          </div>
        )}

        {screen === "forgot-confirm" && (
          <div className="login-card__body">
            <div className="login-card__title-group">
              <h1>Choose a new password</h1>
              <p className="login-card__subtitle">
                Enter the confirmation code sent to <strong>{email}</strong> and choose your new password.
              </p>
            </div>

            {error && (
              <div className="login-error" role="alert">
                <ErrorIcon />
                <span>{error}</span>
              </div>
            )}

            <form className="login-form" onSubmit={handleForgotConfirmSubmit}>
              <div className="login-field">
                <label htmlFor="reset-code">Confirmation code</label>
                <input
                  id="reset-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={resetCode}
                  onChange={(event) => setResetCode(event.target.value)}
                  required
                />
              </div>

              <div className="login-field">
                <label htmlFor="reset-new-password">New password</label>
                <input
                  id="reset-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                />
              </div>

              <div className="login-field">
                <label htmlFor="reset-confirm-password">Confirm new password</label>
                <input
                  id="reset-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </div>

              <PasswordRequirementsChecklist
                password={newPassword}
                confirmPassword={confirmPassword}
              />

              <div className="login-actions">
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={
                    pending ||
                    !resetCode.trim() ||
                    !isPasswordValid ||
                    !passwordsMatch
                  }
                >
                  {pending ? "Resetting password…" : "Reset password"}
                </button>

                <button
                  type="button"
                  className="login-field-action"
                  onClick={handleRequestNewCode}
                  style={{ alignSelf: "center", marginTop: "0.25rem" }}
                >
                  Didn’t receive a code? Request a new code
                </button>

                <button
                  type="button"
                  className="button button--outline"
                  onClick={handleBackToSignIn}
                >
                  Back to sign in
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
