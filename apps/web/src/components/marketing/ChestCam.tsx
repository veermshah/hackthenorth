"use client";

import { useEffect, useRef } from "react";

/**
 * Animated chest-cam POV (2D canvas): a corridor whose floor grid scrolls
 * toward the camera (walking), a bench detected on the left, a person ahead,
 * and a guidance path that clearly routes to the RIGHT around the bench (dots
 * flow forward). No WebGL; React owns the canvas, cleanup cancels the RAF.
 */
export function ChestCam() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let W = 0;
    let H = 0;
    let cx = 0;
    let VPy = 0;
    let Hb = 0;
    let halfW = 0;
    const resize = () => {
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      W = canvas.width;
      H = canvas.height;
      cx = W / 2;
      VPy = H * 0.32;
      Hb = H * 0.99;
      halfW = W * 0.62;
    };
    resize();
    window.addEventListener("resize", resize);

    const proj = (x: number, z: number): [number, number] => [
      cx + x * halfW * (1 - z * 0.82),
      VPy + (Hb - VPy) * (1 - z),
    ];
    const bez = (a: number, b: number, c: number, d: number, t: number) => {
      const m = 1 - t;
      return m * m * m * a + 3 * m * m * t * b + 3 * m * t * t * c + t * t * t * d;
    };
    const PX = [0, 0.55, 0.5, 0.12];
    const PZ = [0.03, 0.3, 0.52, 0.7];
    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };
    const chip = (text: string, x: number, y: number, bg: string, fg: string) => {
      ctx.font = `600 ${12 * dpr}px ui-sans-serif, system-ui, sans-serif`;
      const tw = ctx.measureText(text).width;
      rr(x, y, tw + 14 * dpr, 20 * dpr, 10 * dpr);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.fillText(text, x + 7 * dpr, y + 14 * dpr);
    };

    let raf = 0;
    let alive = true;
    let phase = 0;

    const draw = () => {
      if (!alive) return;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#141c2e";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#1a2236";
      ctx.fillRect(0, 0, W, VPy);

      // glass door near the vanishing point
      const d0 = proj(-0.16, 0.985);
      const d1 = proj(0.16, 0.985);
      const dtop = proj(0, 0.86);
      ctx.fillStyle = "rgba(96,186,244,0.24)";
      ctx.fillRect(d0[0], VPy - 6, d1[0] - d0[0], dtop[1] - (VPy - 6));

      // perspective rails
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = "rgba(70,90,130,0.5)";
      for (const xj of [-1, -0.55, 0, 0.55, 1]) {
        const a = proj(xj, 0.02);
        const b = proj(xj, 0.97);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      // floor lines scrolling toward the camera
      const nH = 9;
      for (let i = 0; i < nH; i++) {
        const z = ((i / nH) + phase) % 1;
        if (z < 0.02 || z > 0.97) continue;
        const a = proj(-1, z);
        const b = proj(1, z);
        ctx.strokeStyle = `rgba(90,120,170,${0.6 * (1 - z)})`;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }

      // bench (left)
      const xb = -0.55;
      const zb = 0.45;
      const fx = proj(xb, zb);
      const wpx = proj(xb + 0.24, zb)[0] - proj(xb - 0.24, zb)[0];
      const seatH = 40 * dpr * (1 - zb);
      const sx0 = fx[0] - wpx / 2;
      const sx1 = fx[0] + wpx / 2;
      const sy1 = fx[1] - seatH;
      const sy0 = sy1 - 14 * dpr;
      ctx.fillStyle = "#786e5f";
      rr(sx0, sy0, sx1 - sx0, 14 * dpr, 5 * dpr);
      ctx.fill();
      ctx.fillStyle = "#5a5042";
      ctx.fillRect(sx0 + 4 * dpr, sy1, 6 * dpr, fx[1] - sy1);
      ctx.fillRect(sx1 - 10 * dpr, sy1, 6 * dpr, fx[1] - sy1);
      ctx.strokeStyle = "#d85598";
      ctx.lineWidth = 2 * dpr;
      rr(sx0 - 8 * dpr, sy0 - 8 * dpr, sx1 - sx0 + 16 * dpr, fx[1] - sy0 + 12 * dpr, 6 * dpr);
      ctx.stroke();
      chip("bench · 1.8 m", sx0 - 8 * dpr, sy0 - 30 * dpr, "#d85598", "#ffffff");

      // person ahead
      const xp = 0.12;
      const zp = 0.72;
      const pp = proj(xp, zp);
      const ph = 70 * dpr * (1 - zp);
      ctx.fillStyle = "#96a0b4";
      rr(pp[0] - 9 * dpr, pp[1] - ph, 18 * dpr, ph * 0.65, 8 * dpr);
      ctx.fill();
      ctx.fillStyle = "#aab4c8";
      ctx.beginPath();
      ctx.arc(pp[0], pp[1] - ph - 7 * dpr, 8 * dpr, 0, 6.2832);
      ctx.fill();
      ctx.strokeStyle = "#f0f4fa";
      ctx.lineWidth = 2 * dpr;
      rr(pp[0] - 16 * dpr, pp[1] - ph - 20 * dpr, 32 * dpr, ph + 24 * dpr, 6 * dpr);
      ctx.stroke();
      chip("person · 4 m", pp[0] - 16 * dpr, pp[1] - ph - 40 * dpr, "#ffffff", "#1e293b");

      // guidance path dots (right of the bench, flowing forward)
      const steps = 64;
      const off = Math.floor(phase * steps);
      for (let k = 0; k < steps; k++) {
        if ((k + off) % 3 !== 0) continue;
        const t = k / (steps - 1);
        const x = bez(PX[0], PX[1], PX[2], PX[3], t);
        const z = bez(PZ[0], PZ[1], PZ[2], PZ[3], t);
        const s = proj(x, z);
        const flow = (Math.sin(t * 6 - phase * 6.2832) + 1) / 2;
        const rad = (1.6 + (1 - z) * 3.2) * dpr;
        ctx.fillStyle = `rgba(96,186,244,${0.5 + 0.45 * flow})`;
        ctx.beginPath();
        ctx.arc(s[0], s[1], rad, 0, 6.2832);
        ctx.fill();
      }

      // chest-cam pill
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      rr(12 * dpr, 12 * dpr, 142 * dpr, 24 * dpr, 11 * dpr);
      ctx.fill();
      ctx.fillStyle = "#475569";
      ctx.font = `600 ${12 * dpr}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText("Chest cam · 30 fps", 22 * dpr, 28 * dpr);

      if (!reduce) phase = (phase + 0.0045) % 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="Chest camera view: a bench and a person detected in a corridor, with a guidance path routing around the bench"
      className="block h-full w-full"
      style={{ aspectRatio: "4 / 3" }}
    />
  );
}
