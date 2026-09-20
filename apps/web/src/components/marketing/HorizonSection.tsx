import { Icon, type IconName } from "@/components/Icon";
import { SectionHeader } from "./SectionHeader";
import { Stagger, StaggerItem } from "./Stagger";

type Horizon = {
  tag: "Today" | "Next" | "Horizon";
  icon: IconName;
  title: string;
  body: string;
};

const TAG_CLASS: Record<Horizon["tag"], string> = {
  Today: "bg-sky-tint text-wander-blue",
  Next: "bg-pink-tint text-wander-pink",
  Horizon: "bg-stellar-white text-graphite",
};

const ITEMS: Horizon[] = [
  { tag: "Today", icon: "phone", title: "People", body: "Blind and low-vision travelers, hands-free, guided by voice." },
  { tag: "Next", icon: "cube", title: "Warehouse robots", body: "The localize, route, avoid loop an AMR needs, from a phone-grade scan." },
  { tag: "Next", icon: "layers", title: "Inspection drones", body: "Indoor flight where GPS can’t reach, anchored to a VPS map." },
  { tag: "Horizon", icon: "eye", title: "AR glasses", body: "The same wayfinding, drawn as a visual overlay for anyone." },
  { tag: "Horizon", icon: "sparkle", title: "Emergency response", body: "Pre-scanned buildings guiding responders through smoke and dark." },
  { tag: "Horizon", icon: "pin", title: "Facilities & venues", body: "Airports, hospitals, campuses. Turn-by-turn, indoors." },
];

export function HorizonSection() {
  return (
    <section id="horizon" className="section scroll-mt-16">
      <div className="container-page">
        <SectionHeader
          eyebrow="Where it goes"
          title="One spatial engine. Many bodies."
          intro="The engine that guides a person doesn’t care what’s carrying it. Localize, route, avoid. A robot needs the same three. Wayfinding for humans is the first body, not the last."
        />

        <Stagger className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ITEMS.map((it) => (
            <StaggerItem key={it.title} className="h-full">
              <div className="card hover-lift flex h-full flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="inline-flex size-10 items-center justify-center rounded-lg bg-sky-tint text-wander-blue">
                    <Icon name={it.icon} size={18} />
                  </span>
                  <span className={`pill-sm ${TAG_CLASS[it.tag]}`}>{it.tag}</span>
                </div>
                <h3 className="text-heading-sm font-medium tracking-[-0.24px] text-void-black">
                  {it.title}
                </h3>
                <p className="text-body-sm text-graphite">{it.body}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
