"use client";

import { useEffect, useRef } from "react";

/**
 * Dotted spinning globe, drawn on a plain 2D canvas (no WebGL, no library).
 * On-theme with the flat light canvas: wander-blue dots on a Fibonacci sphere,
 * front dots brighter/larger for depth. React owns the <canvas>; cleanup only
 * cancels the animation frame, so there is no DOM detach to conflict with
 * unmount (unlike cobe, which caused a removeChild NotFoundError here).
 */
export function Globe({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Points evenly distributed on a unit sphere (Fibonacci lattice).
    const N = 900;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      pts.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
    }

    const resize = () => {
      const size = canvas.clientWidth || 1;
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let alive = true;
    let rot = 0;

    const draw = () => {
      if (!alive) return;
      const w = canvas.width;
      const h = canvas.height;
      const R = Math.min(w, h) * 0.46;
      const cx = w / 2;
      const cy = h / 2;
      ctx.clearRect(0, 0, w, h);
      rot += 0.0034;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      for (let i = 0; i < N; i++) {
        const p = pts[i];
        const xr = p[0] * cos - p[2] * sin;
        const zr = p[0] * sin + p[2] * cos;
        const depth = (zr + 1) / 2; // 0 (back) .. 1 (front)
        const px = cx + xr * R;
        const py = cy + p[1] * R;
        const alpha = 0.1 + depth * 0.6;
        const rad = (0.5 + depth * 1.4) * dpr;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(46,72,133,${alpha})`;
        ctx.fill();
      }
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
      aria-hidden
      className={className}
      style={{ width: "100%", aspectRatio: "1", display: "block" }}
    />
  );
}
