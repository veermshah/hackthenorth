/**
 * Live-HTML visuals for the three feature blocks. Clean, token-only
 * illustrations of what the product does.
 */
import { ChestCam } from "./ChestCam";

/** Voice guidance (pink panel): a calm spoken-cue transcript, current cue lit. */
export function VoiceCard() {
  return (
    <div className="hover-lift rounded-lg bg-pure-white p-6">
      <p className="text-caption font-medium tracking-wide text-wander-pink uppercase">
        Spoken cues
      </p>
      <ul className="mt-5 flex flex-col gap-4">
        <li className="flex items-center gap-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-tint text-wander-blue">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 19 V11 a3 3 0 0 0 -3 -3 H6" />
              <path d="M9 5 L5 8 L9 11" />
            </svg>
          </span>
          <span className="text-heading-sm font-medium text-void-black">Turn left in 3 metres</span>
        </li>
        <li className="flex items-center gap-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-stellar-white text-void-black/40">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5 V19 M6 13 L12 19 L18 13" />
            </svg>
          </span>
          <span className="text-body text-void-black/70">Continue for 8 metres</span>
        </li>
        <li className="flex items-center gap-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-stellar-white">
            <span className="size-2 rounded-full bg-void-black/25" />
          </span>
          <span className="text-body text-void-black/40">Arriving, Room 7302</span>
        </li>
      </ul>
    </div>
  );
}

/** First-person detection view (sky panel): animated chest-cam POV. */
export function VisionCard() {
  return (
    <div className="hover-lift overflow-hidden rounded-lg">
      <ChestCam />
    </div>
  );
}

/** Dollhouse splat (navy panel) - darker void-black screen for contrast + a real isometric room. */
export function SplatCard() {
  return (
    <div className="hover-lift relative aspect-[4/3] overflow-hidden rounded-lg bg-void-black ring-1 ring-inset ring-white/5">
      <div className="splat-specks absolute inset-0 opacity-70" />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-6 top-4 h-44 w-44 rounded-full opacity-60 blur-2xl"
        style={{ background: "radial-gradient(circle, #60baf4 0%, transparent 70%)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 h-40 w-40 rounded-full opacity-40 blur-2xl"
        style={{ background: "radial-gradient(circle, #d85598 0%, transparent 70%)" }}
      />
      {/* isometric room */}
      <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
        <g stroke="#8fb7e6" strokeWidth="1.5" fill="none" opacity="0.8">
          {/* floor diamond */}
          <polygon points="200,110 320,175 200,240 80,175" />
          {/* floor grid */}
          <line x1="140" y1="142.5" x2="260" y2="207.5" />
          <line x1="260" y1="142.5" x2="140" y2="207.5" />
          {/* rising walls */}
          <path d="M80,175 V118 L200,53 V110" />
          <path d="M320,175 V118 L200,53" opacity="0.45" />
        </g>
        {/* route + destination pin on the floor */}
        <polyline points="120,196 175,181 215,168 265,150" fill="none" stroke="#60baf4" strokeWidth="3" strokeDasharray="2 8" strokeLinecap="round" />
        <circle cx="267" cy="148" r="6" fill="#d85598" stroke="#0f172a" strokeWidth="2" />
      </svg>
      {/* chips */}
      <div className="absolute inset-x-4 bottom-4 flex flex-wrap gap-2">
        <span className="pill-sm bg-pure-white/95 text-wander-navy">Aligned to Niantic VPS</span>
        <span className="pill-sm bg-pure-white/15 text-pure-white num">1.2M splats</span>
        <span className="pill-sm bg-pure-white/15 text-pure-white num">14 waypoints</span>
      </div>
    </div>
  );
}
