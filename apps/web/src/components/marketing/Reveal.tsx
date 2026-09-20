"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Seconds of delay before the reveal starts. */
  delay?: number;
  /** Pixels to travel up while fading in. */
  y?: number;
  className?: string;
};

/**
 * Scroll-triggered blur-fade-up. Wrap any section so it animates in once as it
 * enters the viewport. Softer 4px blur (cleaner text, no Safari stutter) and a
 * single shared easing. Falls back to no motion under prefers-reduced-motion.
 */
export function Reveal({ children, delay = 0, y = 20, className }: Props) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y, filter: "blur(4px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "0px 0px -80px 0px" }}
      transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
