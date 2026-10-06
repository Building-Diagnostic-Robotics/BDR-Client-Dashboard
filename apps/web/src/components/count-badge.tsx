export function CountBadge({
  count,
  label,
  className = "",
}: {
  count: number | string;
  label?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={`count-badge ${className}`.trim()}
      aria-label={label ?? (typeof count === "number" ? `${count} items` : undefined)}
    >
      {count}
    </span>
  );
}
