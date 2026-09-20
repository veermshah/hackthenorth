import type { ReactNode } from "react";
import { ImageSlot } from "@/components/ImageSlot";
import { Icon, type IconName } from "@/components/Icon";
import type { ImageAsset } from "@/lib/images";

type Bullet = { icon: IconName; text: string };

type Props = {
  id?: string;
  eyebrow: string;
  /** Tailwind classes for the eyebrow pill (bg + text). */
  eyebrowClass: string;
  title: ReactNode;
  body: string;
  bullets: Bullet[];
  /** Background class for the accent panel, e.g. "bg-wander-pink". */
  panelClass: string;
  /** Live-HTML visual for the panel; falls back to the image asset. */
  visual?: ReactNode;
  asset?: ImageAsset;
  /** Panel on the left, copy on the right. */
  reverse?: boolean;
};

/** Two-column feature block: copy on one side, colored accent panel on the other. */
export function FeatureBlock({
  id,
  eyebrow,
  eyebrowClass,
  title,
  body,
  bullets,
  panelClass,
  visual,
  asset,
  reverse,
}: Props) {
  return (
    <section id={id} className="section scroll-mt-16">
      <div
        className={`container-page grid items-center gap-10 lg:grid-cols-2 lg:gap-16 ${
          reverse ? "lg:[&>*:first-child]:order-2" : ""
        }`}
      >
        <div className="min-w-0 max-w-xl">
          <span className={`pill ${eyebrowClass}`}>{eyebrow}</span>
          <h2 className="mt-4 text-[32px] leading-[1.15] font-medium tracking-[-0.9px] text-void-black md:text-heading md:leading-[1.2] md:tracking-[-1.2px]">
            {title}
          </h2>
          <p className="mt-4 text-body text-graphite">{body}</p>
          <ul className="mt-6 space-y-3">
            {bullets.map((b) => (
              <li key={b.text} className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-sky-tint text-wander-blue">
                  <Icon name={b.icon} size={14} />
                </span>
                <span className="text-body-sm text-void-black/90">{b.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className={`card-accent min-w-0 ${panelClass} p-5 md:p-8`}>
          {visual ??
            (asset ? (
              <ImageSlot
                asset={asset}
                sizes="(min-width: 1024px) 45vw, 100vw"
                className="rounded-lg shadow-[var(--shadow-mockup)]"
              />
            ) : null)}
        </div>
      </div>
    </section>
  );
}
