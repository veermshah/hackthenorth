import { SiteNav } from "@/components/marketing/SiteNav";
import { Hero } from "@/components/marketing/Hero";
import { LogoWall } from "@/components/marketing/LogoWall";
import { StatsBand } from "@/components/marketing/StatsBand";
import { FeatureBlock } from "@/components/marketing/FeatureBlock";
import { ResearchSection } from "@/components/marketing/ResearchSection";
import { IntelligenceSection } from "@/components/marketing/IntelligenceSection";
import { HorizonSection } from "@/components/marketing/HorizonSection";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { CtaBand } from "@/components/marketing/CtaBand";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { Reveal } from "@/components/marketing/Reveal";
import { SectionHeader } from "@/components/marketing/SectionHeader";
import { ProductMock } from "@/components/marketing/ProductMock";
import { VoiceCard, VisionCard, SplatCard } from "@/components/marketing/FeatureVisuals";

export default function Home() {
  return (
    <>
      <SiteNav />
      <main className="flex-1 pt-[var(--nav-height)]">
        <Hero />
        <LogoWall />

        {/* OpenAI leads: this project is about what the model makes possible */}
        <IntelligenceSection />

        {/* Live session: the product itself */}
        <section className="section">
          <SectionHeader
            eyebrow="Live session"
            title="See a route the moment it runs."
            align="center"
            className="container-page"
          />
          <Reveal className="container-page">
            <div className="mx-auto mt-12 max-w-6xl md:mt-16">
              <ProductMock />
            </div>
          </Reveal>
        </section>

        <StatsBand />

        <div id="product" className="scroll-mt-16">
          <Reveal>
            <FeatureBlock
              eyebrow="Voice guidance"
              eyebrowClass="bg-pink-tint text-wander-pink"
              title={
                <>
                  Hear the path,
                  <br />
                  not the noise.
                </>
              }
              body="Short, spoken cues arrive exactly when they matter. Distances are counted down, landmarks are named, and silence is treated as a feature."
              bullets={[
                { icon: "mic", text: "Turn-by-turn cues generated from the route, not a script" },
                { icon: "wave", text: "Adaptive verbosity: more detail in busy spaces, less in hallways" },
                { icon: "phone", text: "Works with earbuds or the phone speaker" },
              ]}
              panelClass="bg-wander-pink"
              visual={<VoiceCard />}
            />
          </Reveal>

          <Reveal>
            <FeatureBlock
              eyebrow="Obstacle sensing"
              eyebrowClass="bg-sky-tint text-wander-blue"
              title={
                <>
                  See what your
                  <br />
                  phone sees.
                </>
              }
              body="A chest-mounted iPhone watches the ground ahead. Benches, doors, and people are detected on-device and folded into the next cue before you reach them."
              bullets={[
                { icon: "camera", text: "On-device detection with ARKit depth, no video leaves the phone" },
                { icon: "eye", text: "Left, right, and back mounts supported for wider coverage" },
                { icon: "sparkle", text: "Cues rank by urgency so the important thing is said first" },
              ]}
              panelClass="bg-wander-sky"
              visual={<VisionCard />}
              reverse
            />
          </Reveal>

          <Reveal>
            <FeatureBlock
              eyebrow="3D maps"
              eyebrowClass="bg-wander-navy text-pure-white"
              title={
                <>
                  Maps you can
                  <br />
                  walk through.
                </>
              }
              body="Every space is a Gaussian splat you can orbit, annotate, and measure. Align it once to Niantic's positioning and the phone knows where it is within a footstep."
              bullets={[
                { icon: "cube", text: "Import .ply or .splat exports, or capture directly from the app" },
                { icon: "layers", text: "Multi-floor worlds with elevator and stair transitions" },
                { icon: "pin", text: "Waypoints stay anchored as the scan improves" },
              ]}
              panelClass="bg-wander-navy"
              visual={<SplatCard />}
            />
          </Reveal>
        </div>

        <ResearchSection />
        <HorizonSection />

        <Reveal>
          <HowItWorks />
        </Reveal>
        <Reveal>
          <CtaBand />
        </Reveal>
      </main>
      <SiteFooter />
    </>
  );
}
