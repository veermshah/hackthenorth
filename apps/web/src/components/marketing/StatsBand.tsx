import { NumberTicker } from "./NumberTicker";
import { Stagger, StaggerItem } from "./Stagger";

const STATS = [
  { value: 0.3, decimals: 1, prefix: "", suffix: " m", label: "Localization accuracy", sub: "aligned to Niantic VPS" },
  { value: 40, decimals: 0, prefix: "<", suffix: " ms", label: "Obstacle alert", sub: "detected on-device" },
  { value: 1.2, decimals: 1, prefix: "", suffix: "M", label: "Splats per world", sub: "walk-through detail" },
];

/** Count-up stat band - numbers cascade in on scroll, cards lift on hover. */
export function StatsBand() {
  return (
    <section aria-label="By the numbers" className="section">
      <div className="container-page">
        <Stagger className="grid gap-4 sm:grid-cols-3">
          {STATS.map((s) => (
            <StaggerItem key={s.label}>
              <div className="card hover-lift flex h-full flex-col gap-1">
                <div className="num flex items-baseline text-[44px] leading-none font-medium tracking-[-1.6px] text-wander-blue">
                  {s.prefix && <span>{s.prefix}</span>}
                  <NumberTicker value={s.value} decimals={s.decimals} />
                  <span>{s.suffix}</span>
                </div>
                <p className="mt-2 text-body font-medium text-void-black">{s.label}</p>
                <p className="text-body-sm text-graphite">{s.sub}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
