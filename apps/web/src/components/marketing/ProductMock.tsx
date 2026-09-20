/**
 * Live-HTML product screenshot: a browser window with the splat map editor,
 * rendered in the DOM so it stays crisp and themeable.
 */

function SplatCanvas() {
  return (
    <div className="splat-specks relative min-h-[320px] flex-1 overflow-hidden bg-wander-navy">
      {/* soft splat glow blobs */}
      <div
        aria-hidden
        className="float-slow pointer-events-none absolute -left-10 top-6 h-48 w-48 rounded-full opacity-60 blur-2xl"
        style={{ background: "radial-gradient(circle, #60baf4 0%, transparent 70%)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-4 bottom-2 h-40 w-40 rounded-full opacity-50 blur-2xl"
        style={{ background: "radial-gradient(circle, #d85598 0%, transparent 70%)" }}
      />
      {/* route overlay */}
      <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full">
        <polyline
          points="46,252 120,214 192,150 252,120 322,70"
          fill="none"
          stroke="#60baf4"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="2 9"
          opacity="0.9"
        />
        {[
          { x: 46, y: 252, n: 1 },
          { x: 192, y: 150, n: 2 },
          { x: 252, y: 120, n: 3 },
        ].map((p) => (
          <g key={p.n}>
            <circle cx={p.x} cy={p.y} r="11" fill="#ffffff" />
            <circle cx={p.x} cy={p.y} r="11" fill="none" stroke="#2e4885" strokeWidth="2" />
            <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize="11" fontWeight="700" fill="#2e4885">
              {p.n}
            </text>
          </g>
        ))}
        {/* destination pin */}
        <g>
          <path
            d="M322 54 c-9 0 -16 7 -16 16 c0 12 16 24 16 24 c0 0 16 -12 16 -24 c0 -9 -7 -16 -16 -16 z"
            fill="#d85598"
            stroke="#1e293b"
            strokeWidth="2"
          />
          <circle cx="322" cy="70" r="5.5" fill="#ffffff" />
        </g>
      </svg>
      {/* status pills */}
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <span className="pill-sm bg-sky-tint text-wander-blue">
          <span className="inline-block size-1.5 rounded-full bg-wander-blue" />
          Localized
        </span>
        <span className="pill-sm bg-pure-white/90 text-graphite">E7 · Atrium</span>
      </div>
    </div>
  );
}

function NavRail() {
  const items = ["Worlds", "Routes", "Devices", "Sessions"];
  return (
    <nav className="hidden w-36 shrink-0 flex-col gap-1 border-r border-hairline bg-stellar-white p-3 md:flex">
      {items.map((it, i) => (
        <span
          key={it}
          className={`rounded-lg px-3 py-1.5 text-body-sm font-medium ${
            i === 0 ? "bg-sky-tint text-wander-blue" : "text-void-black/50"
          }`}
        >
          {it}
        </span>
      ))}
    </nav>
  );
}

export function ProductMock() {
  return (
    <div className="elev overflow-hidden rounded-xl border border-hairline bg-pure-white">
      {/* browser chrome (neutral window dots) */}
      <div className="flex items-center gap-3 border-b border-hairline bg-pure-white px-4 py-3">
        <div className="flex gap-1.5">
          <span className="size-3 rounded-full bg-void-black/15" />
          <span className="size-3 rounded-full bg-void-black/15" />
          <span className="size-3 rounded-full bg-void-black/15" />
        </div>
        <div className="mx-auto flex items-center gap-2 rounded-full bg-stellar-white px-4 py-1 text-caption text-void-black/50">
          <span className="size-1.5 rounded-full bg-void-black/20" />
          wander.app/worlds/e7-atrium
        </div>
        <div className="hidden gap-1.5 sm:flex">
          <span className="size-6 rounded-md bg-stellar-white" />
          <span className="size-6 rounded-md bg-stellar-white" />
        </div>
      </div>
      {/* app body: nav · splat map */}
      <div className="flex items-stretch">
        <NavRail />
        <SplatCanvas />
      </div>
    </div>
  );
}
