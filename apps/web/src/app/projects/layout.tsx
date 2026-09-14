import type { ReactNode } from "react";

import { PortalShell } from "../../components/portal-shell";

export default function ProjectsLayout({ children }: { children: ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
