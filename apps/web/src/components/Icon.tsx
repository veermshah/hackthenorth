import type { SVGProps } from "react";

/** Minimal stroke icon set (24×24). Add paths here rather than pulling in an icon library. */
const PATHS = {
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  arrowUpRight: "M7 17 17 7M8 7h9v9",
  plus: "M12 5v14M5 12h14",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  list: "M8 6h13M8 12h13M8 18h13M4 6h.01M4 12h.01M4 18h.01",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 6 6 6-6 6",
  chevronsUpDown: "m7 15 5 5 5-5M7 9l5-5 5 5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2",
  star: "m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17l-5.4 2.8 1.1-6.1L3.2 9.4l6.1-.8L12 3Z",
  users:
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  cube: "m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM12 12l8-4.5M12 12v9M12 12 4 7.5",
  route:
    "M6 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM18 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8.5 17.5H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5",
  phone: "M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM12 18h.01",
  mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
  camera:
    "M4 8h3l2-3h6l2 3h3v11H4V8ZM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  pin: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21ZM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  layers: "m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
  upload: "M12 16V4M6 10l6-6 6 6M4 20h16",
  download: "M12 4v12M6 10l6 6 6-6M4 20h16",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2ZM10 21h4",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  check: "m5 12 5 5L20 7",
  sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2 2M15.5 15.5l2 2M6.5 17.5l2-2M15.5 8.5l2-2",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff:
    "M3 3l18 18M10.6 10.6a3 3 0 0 0 4.24 4.24M9.9 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4.1M6.5 6.7A17.3 17.3 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4-.85",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  compass:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM15.5 8.5l-2 5-5 2 2-5 5-2Z",
  home: "m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9Z",
  wave: "M3 12h2l2-6 3 12 3-9 2 5 2-2h4",
  battery: "M3 8h15v8H3zM18 10h2v4h-2z",
  x: "M6 6l12 12M18 6 6 18",
  menu: "M4 7h16M4 12h16M4 17h16",
  logout: "M10 4H5v16h5M14 8l5 4-5 4M19 12H9",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  orbit: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 12c0 3 3.8 5 8.5 5s8.5-2 8.5-5-3.8-5-8.5-5",
  walk: "M13 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12.5 8l-3 3.5 2.5 3-2.5 6.5M12.5 8l3 2.5 2.5 1.5M12 14.5l3 2 1.5 5M9.5 11.5 7 13.5",
  frame: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  flip: "M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  externalLink: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  arrowLeft: "M19 12H5M11 6l-6 6 6 6",
  pointer: "M5 4l14 7-6 2-2 6L5 4Z",
  ruler: "M3 17 17 3l4 4L7 21l-4-4ZM7 13l2 2M10 10l2 2M13 7l2 2",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5",
  panelRight: "M4 5h16v14H4zM15 5v14",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
} as const;

export type IconName = keyof typeof PATHS;

type Props = SVGProps<SVGSVGElement> & { name: IconName; size?: number };

export function Icon({ name, size = 18, className = "", ...rest }: Props) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
