import { Icon, type IconName } from "@/components/Icon";
import { SectionHeader } from "./SectionHeader";
import { Reveal } from "./Reveal";
import { Stagger, StaggerItem } from "./Stagger";

const USES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "mic",
    title: "Cues you can trust",
    body: "OpenAI turns route state and detections into short spoken cues, and stays silent when the camera can’t confirm what’s ahead.",
  },
  {
    icon: "eye",
    title: "Ask about the room",
    body: "“What’s in front of me?” A vision model answers from the live camera frame, in plain language.",
  },
  {
    icon: "sparkle",
    title: "Say where, not which door",
    body: "A BM25 and dense retriever with rank fusion lets the agent resolve natural destinations to real waypoints.",
  },
  {
    icon: "cube",
    title: "Codex on the team",
    body: "We gave Codex the Niantic SDK docs and our conventions; it built the companion app while we wired the phone and backend.",
  },
];

export function IntelligenceSection() {
  return (
    <section id="intelligence" className="section scroll-mt-16">
      <div className="container-page">
        <SectionHeader
          eyebrow="Powered by OpenAI"
          tone="pink"
          title="A calm voice that understands the space."
          intro="Geometry is fast but meaningless; a model understands meaning but is too slow for a safety loop. Wander splits the work: detection on-device, understanding in the model."
        />

        <Stagger className="mt-10 grid gap-4 sm:grid-cols-2">
          {USES.map((u) => (
            <StaggerItem key={u.title} className="h-full">
              <div className="card hover-lift flex h-full items-start gap-4">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-sky-tint text-wander-blue">
                  <Icon name={u.icon} size={18} />
                </span>
                <div>
                  <h3 className="text-heading-sm font-medium tracking-[-0.24px] text-void-black">
                    {u.title}
                  </h3>
                  <p className="mt-1 text-body-sm text-graphite">{u.body}</p>
                </div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>

        <Reveal delay={0.05}>
          <div className="card-dark mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:p-8">
            <p className="max-w-2xl text-editorial text-pure-white/90">
              Perception in, grounded action out. The same spatial-agent loop,
              general enough to drop into any environment we can scan.
            </p>
            <span className="pill bg-pure-white/10 text-pure-white">Toward a general spatial agent</span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
