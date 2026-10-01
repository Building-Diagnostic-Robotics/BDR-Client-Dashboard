import Link from "next/link";

import { PortalShell } from "../../../components/portal-shell";

export default function AdminHowToPage() {
  return (
    <PortalShell>
      <article>
        <h1>How to use for administrators</h1>
        <ol>
          <li>Open Clients, then a building. Approve a waiting file, or mark it stale and mark it ready again.</li>
          <li>Open Review to send notes. Notes do not publish or hide a file by themselves.</li>
          <li>Organization tools creates a client from a name and one folder, then invites as many people as that client needs. Resend a pending invite, revoke a person, or change their email from the same client.</li>
        </ol>
        <p><Link href="/review">Review queue</Link></p>
      </article>
    </PortalShell>
  );
}
