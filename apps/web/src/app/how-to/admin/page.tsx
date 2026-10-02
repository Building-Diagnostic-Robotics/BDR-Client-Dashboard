import Link from "next/link";

import { PortalShell } from "../../../components/portal-shell";

export default function AdminHowToPage() {
  return (
    <PortalShell>
      <article>
        <h1>How to use for administrators</h1>
        <ol>
          <li>Open Clients, then a building. Approve a waiting file, or mark it stale and mark it ready again.</li>
          <li>History stays on that building. Hide the whole history with a reason, or hide one version. Clients still see History. A hidden history shows no versions, and a hidden version is left out. Restore either one from the same place. The PDF stays stored, and you can still open it.</li>
          <li>Open Review for every report waiting for approval. View the PDF, approve it for the client, or open Send notes. The building name opens that building. Notes do not publish or hide a file by themselves. Choose “Mark the current file stale” only when that version should leave the client’s current report.</li>
          <li>Organization tools shows Create client and Add admin side by side. Create client links a name and one folder, then invites the people who sign in as that client. Resend a pending invite, revoke a person, or change their email from that client. Add admin emails a temporary password to someone who can use Organization tools and see every client.</li>
        </ol>
        <p><Link href="/review">Review queue</Link></p>
      </article>
    </PortalShell>
  );
}
