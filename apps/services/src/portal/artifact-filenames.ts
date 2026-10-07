import type { PortalReportType } from "@bdr/contracts";

const REPORT_NAMES: Record<PortalReportType, string> = {
  ASSESSMENT: "Roof Assessment",
  EVIDENCE: "Inspection Evidence",
  ROOF_TAKEOFF: "Roof Takeoff",
  AS_BUILT: "As-built",
  CAPITAL_PLANNING: "Capital Planning",
};

export function safeArtifactFilename(value: string): string {
  const cleaned = value.normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|[. ]+$/g, "");
  return cleaned.slice(0, 180).replace(/[\uD800-\uDBFF]$/, "") || "BDR-report";
}

export function reportDownloadFilename(
  buildingName: string,
  type: PortalReportType,
  contentType = "application/pdf",
): string {
  const name = safeArtifactFilename(buildingName).slice(0, 120).replace(/[\uD800-\uDBFF]$/, "");
  const extension = contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : "pdf";
  return `${name} - ${REPORT_NAMES[type]}.${extension}`;
}

export function artifactContentDisposition(filename: string, disposition: "VIEW" | "DOWNLOAD"): string {
  const safe = safeArtifactFilename(filename);
  const fallback = safe.replace(/[^\x20-\x7e]/g, "-");
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `${disposition === "DOWNLOAD" ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
