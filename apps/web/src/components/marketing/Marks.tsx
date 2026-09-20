import type { CSSProperties } from "react";
import { Icon, type IconName } from "@/components/Icon";

/** Accent border colors rotate through the Wander cast: blue, pink, navy, sky. */
const RING_COLORS = ["#2e4885", "#d85598", "#1e293b", "#60baf4"] as const;

const HERO_MARKS: { icon: IconName; color: string }[] = [
  { icon: "compass", color: "#2e4885" },
  { icon: "pin", color: "#d85598" },
  { icon: "mic", color: "#1e293b" },
  { icon: "camera", color: "#60baf4" },
  { icon: "route", color: "#2e4885" },
  { icon: "phone", color: "#d85598" },
  { icon: "sparkle", color: "#1e293b" },
];

type MarkProps = {
  icon: IconName;
  color: string;
  ring: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
};

/** Character mark: 40-48px white circle, 2px colored ring, flat glyph inside. */
export function CharacterMark({
  icon,
  color,
  ring,
  size = 44,
  className = "",
  style,
}: MarkProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-full bg-pure-white ${className}`}
      style={{
        width: size,
        height: size,
        border: `2px solid ${ring}`,
        color,
        ...style,
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.45)} strokeWidth="2" />
    </span>
  );
}

/** The horizontal row of seven marks that opens the hero. */
export function HeroMarkRow() {
  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3">
      {HERO_MARKS.map((m, i) => (
        <CharacterMark
          key={m.icon}
          icon={m.icon}
          color={m.color}
          ring={RING_COLORS[i % RING_COLORS.length]}
          className={`mark-pop ${i > 4 ? "hidden sm:inline-flex" : ""}`}
          style={{ "--mark-delay": `${i * 60}ms` } as CSSProperties}
        />
      ))}
    </div>
  );
}

/** Hand-drawn style squiggle used as decorative punctuation. */
export function Squiggle({
  className = "",
  color = "#0f172a",
}: {
  className?: string;
  color?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 16"
      width="64"
      height="16"
      fill="none"
      className={className}
    >
      <path
        d="M2 10c6-8 10-8 16 0s10 8 16 0 10-8 16 0 8 6 12 2"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Four-point sparkle mark. */
export function Sparkle({
  className = "",
  color = "#0f172a",
  size = 20,
}: {
  className?: string;
  color?: string;
  size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
    >
      <path
        d="M12 2c.6 5.5 4.5 9.4 10 10-5.5.6-9.4 4.5-10 10-.6-5.5-4.5-9.4-10-10 5.5-.6 9.4-4.5 10-10Z"
        fill={color}
      />
    </svg>
  );
}
