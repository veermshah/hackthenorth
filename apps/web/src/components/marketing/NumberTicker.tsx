"use client";

import { useEffect, useRef } from "react";
import { useInView, useMotionValue, useSpring } from "motion/react";

type Props = {
  value: number;
  decimals?: number;
  className?: string;
};

/**
 * Count-up number that springs from 0 to `value` when scrolled into view.
 * Adapted from Magic UI's NumberTicker, built on `motion`.
 */
export function NumberTicker({ value, decimals = 0, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { damping: 34, stiffness: 110 });
  const inView = useInView(ref, { once: true, margin: "0px 0px -60px 0px" });

  useEffect(() => {
    if (inView) mv.set(value);
  }, [inView, value, mv]);

  useEffect(() => {
    return spring.on("change", (v) => {
      if (ref.current) ref.current.textContent = v.toFixed(decimals);
    });
  }, [spring, decimals]);

  return (
    <span ref={ref} className={className}>
      0
    </span>
  );
}
