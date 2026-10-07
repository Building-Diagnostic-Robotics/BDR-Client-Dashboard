export function formatDate(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}

export function formatShortDate(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}

export function formatScanTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

export function formatReportUpdatedDate(value: string, timeZone?: string, now = Date.now()): string {
  const date = new Date(value);
  const diffMs = now - date.getTime();

  if (diffMs >= 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 24) {
      if (diffHours < 1) {
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        if (diffMinutes <= 1) return "Updated just now";
        return `Updated ${diffMinutes} min ago`;
      }
      return `Updated ${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
    }
  }

  return `Updated ${formatShortDate(value, timeZone)}`;
}

export function formatUploadAge(value: string | null, now = Date.now(), timeZone?: string | null): string {
  if (!value) return "Upload time unavailable";
  const uploaded = new Date(value).getTime();
  if (Number.isNaN(uploaded)) return "Upload time unavailable";
  const elapsed = Math.max(0, now - uploaded);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 2) return "Data uploaded just now";
  if (minutes < 60) return `Data uploaded ${minutes} min ago`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 24) return `Data uploaded ${hours} ${hours === 1 ? "hr" : "hrs"} ago`;
  if (hours < 48) return "Data uploaded 1 day ago";
  return `Data uploaded on ${formatShortDate(value, timeZone ?? "UTC")}`;
}

export function formatBuildingScanDate(value: string | null, timeZone?: string | null): string {
  if (!value) return "No scans yet";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "No scans yet";
    return formatShortDate(value, timeZone || undefined);
  } catch {
    return "No scans yet";
  }
}

export function formatBuildingReportsStatus(
  readyReports: string[],
  latestReportUpdate: string | null,
  timeZone?: string | null,
  now = Date.now(),
): { text: string; isNone: boolean } {
  if (readyReports.length === 0) {
    return { text: "No reports yet", isNone: true };
  }
  if (!latestReportUpdate) {
    return { text: "Available", isNone: false };
  }
  try {
    const d = new Date(latestReportUpdate);
    if (Number.isNaN(d.getTime())) {
      return { text: "Available", isNone: false };
    }
    return {
      text: formatReportUpdatedDate(latestReportUpdate, timeZone || undefined, now),
      isNone: false,
    };
  } catch {
    return { text: "Available", isNone: false };
  }
}
