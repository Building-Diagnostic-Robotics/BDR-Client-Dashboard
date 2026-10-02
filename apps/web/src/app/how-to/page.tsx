import Link from "next/link";

import { PortalShell } from "../../components/portal-shell";

export default function HowToPage() {
  return (
    <PortalShell>
      <article className="surface">
        <header className="page-heading">
          <h1>How to use</h1>
        </header>
        <ol>
          <li>Open Buildings and filter by name, address, robot, time, or report.</li>
          <li>Open a building to see the scan time, the upload time, and the aerial when coordinates exist.</li>
          <li>A report file appears after it has been approved for your organization.</li>
          <li>When a report is visible, you can edit the inputs that belong to it. The previous file stays labeled stale while the new one is prepared.</li>
          <li>History lists earlier versions for this building. When an administrator hides that history, the section stays and says there is no history. A hidden version is left out of the list. The current approved file stays available.</li>
          <li>If an update fails, contact an admin.</li>
          <li>The moisture map appears after the main reports are available. A roof-takeoff-only building does not have that map.</li>
        </ol>
        <p><Link href="/projects">Back to buildings</Link></p>
      </article>
    </PortalShell>
  );
}
