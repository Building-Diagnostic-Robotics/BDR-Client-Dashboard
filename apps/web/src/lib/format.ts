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
