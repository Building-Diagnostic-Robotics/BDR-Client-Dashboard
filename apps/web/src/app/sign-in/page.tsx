"use client";

import { useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";

function SignInForm() {
  const params = useSearchParams();
  const returnTo = params.get("returnTo") || "/projects";
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/projects";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaSession, setMfaSession] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/bff/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          returnTo: safe,
          ...(mfaSession ? { mfaCode, mfaSession } : {}),
          ...(needsNewPassword ? { newPassword, mfaSession } : {}),
        }),
      });
      const body = await response.json() as { returnTo?: string; mfa?: boolean; newPassword?: boolean; session?: string };
      if (response.ok && body.mfa && body.session) {
        setMfaSession(body.session);
        return;
      }
      if (response.ok && body.newPassword && body.session) {
        setNeedsNewPassword(true);
        setMfaSession(body.session);
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

  return (
    <main className="login-screen">
      <form className="login-card form-grid" onSubmit={submit}>
        <img src="/bdr_logo_name_cropped.png" alt="Building Diagnostic Robotics" />
        <h1>Sign in with your email and password</h1>
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required />
        </label>
        {needsNewPassword ? (
          <label>
            Choose a new password
            <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" required />
          </label>
        ) : null}
        {mfaSession && !needsNewPassword ? (
          <label>
            Authenticator code
            <input value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
          </label>
        ) : null}
        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <button className="button button--primary" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      </form>
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
