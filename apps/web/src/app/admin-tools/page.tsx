"use client";

import { useEffect, useState } from "react";

import { PortalShell } from "../../components/portal-shell";
import { ClientApiError, getClient, postClient } from "../../lib/client-api";

type Client = { clientPrefix: string; displayName: string; buildings: number };
type User = { email: string; status: string };

const asClients = {
  parse(value: unknown): { items: Client[]; folders: string[] } {
    const row = value as { items?: Client[]; folders?: string[] };
    return { items: row.items ?? [], folders: row.folders ?? [] };
  },
};
const asUsers = {
  parse(value: unknown): { items: User[] } {
    return { items: (value as { items?: User[] }).items ?? [] };
  },
};
const asOk = { parse(value: unknown) { return value; } };

function statusLabel(status: string): string {
  if (status === "INVITED") return "Invited";
  if (status === "REVOKED") return "Revoked";
  return "Signed in";
}

function ClientWorkspace({ client, onRenamed }: { client: Client; onRenamed: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState(client.displayName);
  const [email, setEmail] = useState("");
  const [nextEmail, setNextEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadPeople() {
    getClient(`/bff/portal/client-users?client=${encodeURIComponent(client.clientPrefix)}`, asUsers)
      .then((result) => setUsers(result.items))
      .catch(() => setError("People could not be loaded."));
  }

  useEffect(() => {
    setName(client.displayName);
    loadPeople();
  }, [client.clientPrefix, client.displayName]);

  return (
    <div className="form-grid">
      <h2>{client.displayName}</h2>
      <p>Folder {client.clientPrefix}. {client.buildings} {client.buildings === 1 ? "building" : "buildings"}. Everyone invited here signs in to this client only.</p>
      {message ? <p>{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      <form className="surface form-grid" onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        void postClient("/bff/portal/client-rename", { clientPrefix: client.clientPrefix, displayName: name }, asOk)
          .then(() => { setMessage("Name saved."); onRenamed(); })
          .catch(() => setError("The name could not be saved."));
      }}>
        <h3>Name</h3>
        <label>Display name
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <button className="button button--outline" type="submit">Save name</button>
      </form>

      <div className="surface form-grid">
        <h3>People</h3>
        <form onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          void postClient("/bff/portal/client-account", { clientPrefix: client.clientPrefix, email }, asOk)
            .then(() => { setEmail(""); setMessage("Invite sent. Cognito emailed a temporary password."); loadPeople(); })
            .catch(() => setError("The invite could not be sent."));
        }}>
          <label>Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="name@client.com" />
          </label>
          <button className="button button--primary" type="submit">Invite</button>
        </form>
        <ul>
          {users.map((user) => (
            <li key={user.email}>
              {user.email} · {statusLabel(user.status)}
              {user.status === "INVITED" ? (
                <button className="button button--outline" type="button" onClick={() => {
                  void postClient("/bff/portal/client-resend", { clientPrefix: client.clientPrefix, email: user.email }, asOk)
                    .then(() => setMessage(`Invite resent to ${user.email}.`))
                    .catch(() => setError("The invite could not be resent."));
                }}>Resend</button>
              ) : null}
              {user.status !== "REVOKED" ? (
                <button className="button button--outline" type="button" onClick={() => {
                  if (!window.confirm(`Revoke ${user.email}?`)) return;
                  void postClient("/bff/portal/client-revoke", { clientPrefix: client.clientPrefix, email: user.email }, asOk)
                    .then(loadPeople);
                }}>Revoke</button>
              ) : null}
            </li>
          ))}
        </ul>
        <form onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const current = String(new FormData(form).get("current") || "");
          setError(null);
          void postClient("/bff/portal/client-email", { clientPrefix: client.clientPrefix, email: current, nextEmail }, asOk)
            .then(() => { setNextEmail(""); form.reset(); setMessage("Email replaced. A temporary password was sent to the new address."); loadPeople(); })
            .catch(() => setError("The email could not be changed."));
        }}>
          <label>Current email
            <input name="current" type="email" required />
          </label>
          <label>New email
            <input type="email" value={nextEmail} onChange={(event) => setNextEmail(event.target.value)} required />
          </label>
          <button className="button button--outline" type="submit">Change email</button>
        </form>
      </div>
    </div>
  );
}

export default function AdminToolsPage() {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function load() {
    getClient("/bff/portal/clients", asClients)
      .then((result) => {
        setClients(result.items);
        setFolders(result.folders);
      })
      .catch((reason) => {
        if (reason instanceof ClientApiError && reason.status === 401) {
          window.location.reload();
          return;
        }
        setError("Clients could not be loaded.");
      });
  }

  useEffect(() => { load(); }, []);

  const current = clients?.find((client) => client.clientPrefix === selected) ?? null;

  return (
    <PortalShell>
      <section>
        <h1>Organization tools</h1>
        <p>Create a client, link one folder, then invite the people who should sign in to that client.</p>
        {error ? <p role="alert">{error}</p> : null}
        <form className="surface form-grid" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          setError(null);
          void postClient("/bff/portal/clients", {
            displayName: String(data.get("name") || ""),
            clientPrefix: String(data.get("folder") || ""),
          }, asOk).then(() => { form.reset(); setSelected(String(data.get("folder") || "")); load(); })
            .catch(() => setError("The client could not be created. Choose a folder that is not already linked."));
        }}>
          <h2>Create client</h2>
          <label>Client name
            <input name="name" required placeholder="SIG Roofing" />
          </label>
          <label>Folder
            <select name="folder" required defaultValue="">
              <option value="" disabled>Choose a folder</option>
              {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
            </select>
          </label>
          <button className="button button--primary" type="submit">Create and link</button>
          {folders.length === 0 ? <p>No unlinked client folders are available.</p> : null}
        </form>

        <h2>Clients</h2>
        {!clients ? <p>Loading clients…</p> : clients.length === 0 ? <p>No clients yet.</p> : (
          <div className="project-grid">
            {clients.map((client) => (
              <button className="project-card" key={client.clientPrefix} type="button" onClick={() => setSelected(client.clientPrefix)}>
                <div className="project-card__body">
                  <h3>{client.displayName}</h3>
                  <p className="project-card__address">{client.clientPrefix} · {client.buildings} {client.buildings === 1 ? "building" : "buildings"}</p>
                </div>
              </button>
            ))}
          </div>
        )}
        {current ? <ClientWorkspace client={current} onRenamed={load} /> : null}
      </section>
    </PortalShell>
  );
}
