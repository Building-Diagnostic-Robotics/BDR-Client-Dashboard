import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const common = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function ArrowRightIcon(props: IconProps) {
  return <svg {...common} {...props}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}

export function BuildingIcon(props: IconProps) {
  return <svg {...common} {...props}><path d="M4 21V5l8-3v19M4 9h8M4 13h8M4 17h8M12 8h8v13M16 12h1M16 16h1M2 21h20" /></svg>;
}

export function DownloadIcon(props: IconProps) {
  return <svg {...common} {...props}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>;
}

export function EyeIcon(props: IconProps) {
  return <svg {...common} {...props}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
}

export function FileIcon(props: IconProps) {
  return <svg {...common} {...props}><path d="M6 2h8l4 4v16H6zM14 2v5h4M9 12h6M9 16h6" /></svg>;
}

export function LogoutIcon(props: IconProps) {
  return <svg {...common} {...props}><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" /></svg>;
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}


