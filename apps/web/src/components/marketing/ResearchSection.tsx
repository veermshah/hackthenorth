import { Icon } from "@/components/Icon";
import { SectionHeader } from "./SectionHeader";
import { Stagger, StaggerItem } from "./Stagger";

type Paper = {
  venue: string;
  title: string;
  authors: string;
  gives: string;
  href?: string;
};

const PAPERS: Paper[] = [
  {
    venue: "CVPR 2023 · Niantic",
    title: "Accelerated Coordinate Encoding (ACE)",
    authors: "Brachmann, Cavallari, Prisacariu",
    gives:
      "Relocalize inside a scanned space from a single photo, in minutes, not hours. Our starting point; today we run on Niantic Lightship VPS, built on this lineage.",
    href: "https://nianticlabs.github.io/ace/",
  },
  {
    venue: "SIGGRAPH 2023",
    title: "3D Gaussian Splatting",
    authors: "Kerbl, Kopanas, Leimkühler, Drettakis",
    gives:
      "Photoreal, real-time 3D scenes from a phone scan. The walkable maps you orbit, annotate, and measure.",
    href: "https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/",
  },
  {
    venue: "SIGIR 2009",
    title: "Reciprocal Rank Fusion + BM25",
    authors: "Cormack, Clarke, Büttcher",
    gives:
      "Fuse keyword and semantic search so “take me somewhere quiet” resolves to the right waypoint.",
  },
  {
    venue: "BMVC 2012",
    title: "Locally Optimized RANSAC (PoseLib)",
    authors: "Lebeda, Matas, Chum",
    gives:
      "Robust 6-DoF camera pose from 2D to 3D matches, stable even when features are noisy.",
  },
  {
    venue: "1968",
    title: "A* Search",
    authors: "Hart, Nilsson, Raphael",
    gives:
      "Optimal shortest-path routing across the waypoint graph behind every spoken turn.",
  },
  {
    venue: "Open source",
    title: "Shepherd: LiDAR gap profiling",
    authors: "tonywangs/shepherd",
    gives:
      "On-device obstacle gaps from the phone’s LiDAR, fast enough to fire a safety cue before you reach it.",
    href: "https://github.com/tonywangs/shepherd",
  },
];

export function ResearchSection() {
  return (
    <section id="research" className="section scroll-mt-16">
      <div className="container-page">
        <SectionHeader
          eyebrow="Grounded in research"
          title="We started by reading, not guessing."
          intro="Wander is a stack of proven ideas wired together: visual positioning, splat reconstruction, robust pose, and fast routing. Here is what each layer stands on."
        />

        <Stagger className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PAPERS.map((p) => {
            const inner = (
              <div className="card hover-lift flex h-full flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="pill-sm bg-stellar-white text-graphite">{p.venue}</span>
                  {p.href && (
                    <Icon name="arrowRight" size={14} className="-rotate-45 text-void-black/40" />
                  )}
                </div>
                <div>
                  <h3 className="text-heading-sm font-medium tracking-[-0.24px] text-void-black">
                    {p.title}
                  </h3>
                  <p className="mt-1 text-caption text-void-black/45">{p.authors}</p>
                </div>
                <p className="mt-auto text-body-sm text-graphite">{p.gives}</p>
              </div>
            );
            return (
              <StaggerItem key={p.title} className="h-full">
                {p.href ? (
                  <a
                    href={p.href}
                    target="_blank"
                    rel="noreferrer"
                    className="block h-full focus-visible:outline-none"
                  >
                    {inner}
                  </a>
                ) : (
                  inner
                )}
              </StaggerItem>
            );
          })}
        </Stagger>
      </div>
    </section>
  );
}
