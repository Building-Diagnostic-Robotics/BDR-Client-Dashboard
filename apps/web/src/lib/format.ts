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

