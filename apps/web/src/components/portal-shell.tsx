"use client";

import {
  clientLogoutResponseSchema,
  clientMeResponseSchema,
  clientSessionResponseSchema,
  type ClientMeResponse,
} from "@bdr/contracts";
import Image from "next/image";
import Link from "next/link";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { ClientApiError, getClient, loginPath, postClient } from "../lib/client-api";
import { LogoutIcon } from "./icons";

const PortalContext = createContext<ClientMeResponse | null>(null);

export function usePortal(): ClientMeResponse {
  const value = useContext(PortalContext);
  if (!value) throw new Error("Portal context is unavailable");
  return value;
}

function currentReturnPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function PortalShell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<ClientMeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        await getClient("/bff/auth/session", clientSessionResponseSchema);
        const response = await getClient("/bff/me", clientMeResponseSchema);
        if (active) setMe(response);
      } catch (reason) {
        if (reason instanceof ClientApiError && reason.status === 401) {
          window.location.replace(loginPath(currentReturnPath()));
          return;
        }
        if (active) setError("We could not load your account. Please try again.");
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  async function logout() {
    setLoggingOut(true);
    setError(null);
    try {
      const response = await postClient("/bff/logout", {}, clientLogoutResponseSchema);
      window.location.assign(response.logoutUrl);
    } catch (reason) {
      if (reason instanceof ClientApiError && reason.status === 401) {
        window.location.replace(loginPath("/projects"));
        return;
      }
      setError("We could not sign you out. Please try again.");
      setLoggingOut(false);
    }
  }

  if (!me && !error) {
    return (
      <main className="centered-state" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        <p>Loading your dashboard…</p>
      </main>
    );
  }

  if (!me) {
    return (
      <main className="centered-state">
        <Image src="/bdr_logo_name.png" alt="Building Diagnostic Robotics" width={170} height={98} priority />
        <h1>Dashboard unavailable</h1>
        <p>{error}</p>
        <button className="button button--primary" type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }

  return (
    <PortalContext.Provider value={me}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="site-header">
        <div className="site-header__inner">
          <Link className="brand" href="/projects" aria-label="BDR Inspections Dashboard home">
            <Image src="/bdr_logo_name.png" alt="Building Diagnostic Robotics" width={132} height={76} priority />
          </Link>
          <nav className="site-nav" aria-label="Primary navigation">
            <Link href="/projects">Projects</Link>
          </nav>
          <div className="account-area">
            <span className="organization-name">{me.organization.displayName}</span>
            <button className="logout-button" type="button" onClick={logout} disabled={loggingOut}>
              <LogoutIcon />
              {loggingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
        {error ? <p className="header-error" role="alert">{error}</p> : null}
      </header>
      <main id="main-content" className="page-container">{children}</main>
    </PortalContext.Provider>
  );
}
