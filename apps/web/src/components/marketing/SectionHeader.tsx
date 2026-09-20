import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

type Props = {
  eyebrow: string;
  tone?: "sky" | "pink";
  title: ReactNode;
  intro?: ReactNode;
  align?: "left" | "center";
  className?: string;
};

const TONE = {
  sky: "bg-sky-tint text-wander-blue",
  pink: "bg-pink-tint text-wander-pink",
} as const;

/**
 * The one section header used across the whole page: eyebrow pill, title, and
 * an optional editorial intro, with a single canonical type scale. Reveals on
 * scroll so every section enters the same way. Sections supply only content.
 */
export function SectionHeader({
  eyebrow,
  tone = "sky",
  title,
  intro,
  align = "left",
  className = "",
}: Props) {
  const box = align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl";
  return (
    <Reveal className={className}>
      <div className={box}>
        <span className={`pill ${TONE[tone]}`}>{eyebrow}</span>
        <h2 className="mt-4 text-[32px] leading-[1.15] font-medium tracking-[-0.9px] text-void-black md:text-heading-lg md:leading-[1.1] md:tracking-[-1.7px]">
          {title}
        </h2>
        {intro && <p className="editorial mt-4">{intro}</p>}
      </div>
    </Reveal>
  );
}
