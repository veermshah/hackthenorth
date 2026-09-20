"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/Icon";
import { BRAND } from "@/lib/brand";

/**
 * Scroll-driven hero. A small dotted globe spins below the copy; as you scroll,
 * the hero text fades and the points morph from a sphere into a WIREFRAME hotel
 * room (floor/walls/ceiling edges, a doorway, a window, a bed outline) with a
 * glowing Wander route to a destination pin. A navy viewer panel fades in and
 * the dots color up like a Gaussian splat. Downward tilt + perspective make the
 * floor recede. Plain 2D canvas (no WebGL).
 */
export function Hero() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const canvas = canvasRef.current;
    if (!section || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // ---- Wireframe room + route (edges sampled into dots) ----
    const LX: number[] = [];
    const LY: number[] = [];
    const LZ: number[] = [];
    const LR: number[] = [];
    const LG: number[] = [];
    const LB: number[] = [];
    const edge = (p0: number[], p1: number[], n: number, c: number[]) => {
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1);
        LX.push(p0[0] + (p1[0] - p0[0]) * t);
        LY.push(p0[1] + (p1[1] - p0[1]) * t);
        LZ.push(p0[2] + (p1[2] - p0[2]) * t);
        LR.push(c[0]); LG.push(c[1]); LB.push(c[2]);
      }
    };
    const WALL = [0.72, 0.75, 0.85], CEIL = [0.5, 0.54, 0.64], FLC = [0.52, 0.56, 0.64];
    const BED = [0.55, 0.8, 0.99], DOOR = [0.6, 0.8, 1.0], WIN = [0.5, 0.82, 1.0];
    const ROUTE = [0.34, 0.78, 1.0], WP = [0.98, 0.99, 1.0], PIN = [0.95, 0.34, 0.6];
    const yF = -0.72, yC = 0.82;
    const cf = [[-1, yF, -1], [1, yF, -1], [1, yF, 1], [-1, yF, 1]];
    const cc = [[-1, yC, -1], [1, yC, -1], [1, yC, 1], [-1, yC, 1]];
    for (let i = 0; i < 4; i++) {
      edge(cf[i], cf[(i + 1) % 4], 28, WALL);
      edge(cc[i], cc[(i + 1) % 4], 28, CEIL);
      edge(cf[i], cc[i], 22, WALL);
    }
    for (const gx of [-0.5, 0, 0.5]) edge([gx, yF, -1], [gx, yF, 1], 22, FLC);
    for (const gz of [-0.5, 0, 0.5]) edge([-1, yF, gz], [1, yF, gz], 26, FLC);
    const bx0 = -0.85, bx1 = -0.15, bz0 = 0.2, bz1 = 0.9, byT = -0.45;
    const bl = [[bx0, yF, bz0], [bx1, yF, bz0], [bx1, yF, bz1], [bx0, yF, bz1]];
    const bt = [[bx0, byT, bz0], [bx1, byT, bz0], [bx1, byT, bz1], [bx0, byT, bz1]];
    for (let i = 0; i < 4; i++) {
      edge(bl[i], bl[(i + 1) % 4], 13, BED);
      edge(bt[i], bt[(i + 1) % 4], 13, BED);
      edge(bl[i], bt[i], 7, BED);
    }
    edge([-0.15, yF, -1], [-0.15, 0.3, -1], 16, DOOR);
    edge([0.15, yF, -1], [0.15, 0.3, -1], 16, DOOR);
    edge([-0.15, 0.3, -1], [0.15, 0.3, -1], 10, DOOR);
    edge([0.4, 0.05, -1], [0.75, 0.05, -1], 12, WIN);
    edge([0.4, 0.5, -1], [0.75, 0.5, -1], 12, WIN);
    edge([0.4, 0.05, -1], [0.4, 0.5, -1], 12, WIN);
    edge([0.75, 0.05, -1], [0.75, 0.5, -1], 12, WIN);
    const rxf = (t: number) => 0.5 * Math.sin(t * Math.PI) * (1 - 0.25 * t);
    for (let k = 0; k < 90; k++) {
      const t = k / 89;
      LX.push(rxf(t)); LY.push(yF + 0.01); LZ.push(0.92 - 1.9 * t);
      LR.push(ROUTE[0]); LG.push(ROUTE[1]); LB.push(ROUTE[2]);
    }
    for (const tw of [0.12, 0.42, 0.72]) {
      const z = 0.92 - 1.9 * tw;
      const x = rxf(tw);
      for (let a = 0; a < 14; a++) {
        const ang = (a / 14) * 2 * Math.PI;
        LX.push(x + 0.07 * Math.cos(ang)); LY.push(yF + 0.01); LZ.push(z + 0.07 * Math.sin(ang));
        LR.push(WP[0]); LG.push(WP[1]); LB.push(WP[2]);
      }
    }
    for (let a = 0; a < 18; a++) {
      const ang = (a / 18) * 2 * Math.PI;
      LX.push(0.06 * Math.cos(ang)); LY.push(-0.5 + 0.07 * Math.sin(ang)); LZ.push(-0.94);
      LR.push(PIN[0]); LG.push(PIN[1]); LB.push(PIN[2]);
    }
    for (let k = 0; k < 7; k++) {
      LX.push(0); LY.push(-0.63 + 0.02 * k); LZ.push(-0.94);
      LR.push(PIN[0]); LG.push(PIN[1]); LB.push(PIN[2]);
    }
    const L = LX.length;

    // ---- Sphere points (denser than the room; room targets reused via modulo) ----
    const NP = 1500;
    const SX = new Float64Array(NP);
    const SY = new Float64Array(NP);
    const SZ = new Float64Array(NP);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NP; i++) {
      const y = 1 - (i / (NP - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const t = golden * i;
      SX[i] = Math.cos(t) * r;
      SY[i] = y;
      SZ[i] = Math.sin(t) * r;
    }

    let W = 0;
    let H = 0;
    const resize = () => {
      W = Math.round(canvas.clientWidth * dpr);
      H = Math.round(canvas.clientHeight * dpr);
      canvas.width = W;
      canvas.height = H;
    };
    resize();
    window.addEventListener("resize", resize);

    const ss = (a: number, b: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const roundRect = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    };

    let raf = 0;
    let alive = true;
    let spin = 0;

    const frame = () => {
      if (!alive) return;
      const rect = section.getBoundingClientRect();
      const total = Math.max(1, section.offsetHeight - window.innerHeight);
      const p = Math.max(0, Math.min(1, -rect.top / total));
      const mprog = ss(0.05, 0.7, p);
      const mp = ss(0.06, 0.55, p);
      const cp = ss(0.5, 0.95, p);
      const lock = ss(0.15, 0.55, p);
      const bg = ss(0.28, 0.62, p);

      if (textRef.current) textRef.current.style.opacity = String(1 - ss(0.12, 0.42, p));

      ctx.clearRect(0, 0, W, H);
      if (bg > 0.001) {
        const pad = Math.min(W, H) * 0.06;
        const y0 = H * 0.15;
        ctx.fillStyle = `rgba(15,23,42,${bg})`;
        roundRect(ctx, pad, y0, W - pad * 2, H - pad - y0, Math.min(W, H) * 0.03);
        ctx.fill();
      }

      if (!reduce) spin += 0.0032;
      const aY = spin * (1 - lock) + (-0.32 + (reduce ? 0 : 0.12 * Math.sin(Date.now() / 2800))) * lock;
      const aX = 0.55 * mprog;
      const f = 8 - 5.6 * mprog;
      const cyR = Math.cos(aY), syR = Math.sin(aY), cxR = Math.cos(aX), sxR = Math.sin(aX);
      const R = Math.min(W, H) * (0.15 + 0.21 * mprog);
      const cxC = W / 2;
      const cyC = lerp(0.74, 0.5, mprog) * H;

      for (let i = 0; i < NP; i++) {
        const m = i % L;
        const ax = lerp(SX[i], LX[m], mp);
        const ay = lerp(SY[i], LY[m], mp);
        const az = lerp(SZ[i], LZ[m], mp);
        const x1 = ax * cyR - az * syR;
        const z1 = ax * syR + az * cyR;
        const y2 = ay * cxR - z1 * sxR;
        const z2 = ay * sxR + z1 * cxR;
        const pf = f / (f - z2);
        const px = cxC + x1 * R * pf;
        const py = cyC - y2 * R * pf;
        const depth = Math.max(0, Math.min(1, (z2 + 1.4) / 2.8));
        const rr = lerp(46, LR[m] * 255, cp);
        const gg = lerp(72, LG[m] * 255, cp);
        const bb = lerp(133, LB[m] * 255, cp);
        const bfac = 0.45 + depth * 0.55;
        ctx.beginPath();
        ctx.arc(px, py, (0.5 + depth * 1.3) * dpr * pf * 0.62, 0, 6.2832);
        ctx.fillStyle = `rgba(${(rr * bfac) | 0},${(gg * bfac) | 0},${(bb * bfac) | 0},${0.16 + depth * 0.6})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <section ref={sectionRef} className="relative" style={{ height: "230vh" }}>
      <div className="sticky top-0 h-screen overflow-hidden">
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
        <div ref={textRef} className="relative z-10 container-page flex flex-col items-center pt-16 text-center md:pt-20">
          <span className="text-caption font-medium tracking-[0.08em] text-void-black/45 uppercase">
            Indoor navigation, by ear
          </span>
          <h1 className="mt-5 max-w-4xl text-[40px] leading-[1.08] font-medium tracking-[-1.2px] text-void-black sm:text-display-sm md:text-display">
            The map ends at
            <br />
            the door. We <span className="text-wander-blue">keep going</span>.
          </h1>
          <p className="editorial mt-6 max-w-2xl text-balance">
            {BRAND.name} turns real places into walkable 3D maps, then guides you
            through them with a chest-worn phone, live obstacle cues, and a calm
            voice in your ear, everywhere GPS gives up.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/login" className="btn-primary btn-lg tap hover-raise">
              Get started
              <Icon name="arrowRight" size={16} />
            </Link>
            <Link href="#how-it-works" className="btn-ghost btn-lg tap hover-raise">
              See how it works
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
