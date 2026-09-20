"use client";

import { Icon, type IconName } from "@/components/Icon";
import type { ViewerLayer } from "./SplatViewerEngine";

const LAYERS: { id: ViewerLayer; label: string; icon: IconName; hint: string }[] = [
  { id: "splat", label: "Splat", icon: "sparkle", hint: "Draw the Gaussian splat scan" },
  { id: "mesh", label: "Mesh", icon: "layers", hint: "Draw the collision mesh instead of the splat" },
];

type Props = {
  layer: ViewerLayer;
  onLayer: (layer: ViewerLayer) => void;
  /** False when the world has no splat uploaded yet. */
  hasSplat: boolean;
  /** False until the .glb has loaded; choosing an unloaded mesh would blank the canvas. */
  meshReady: boolean;
  /** The whole control, e.g. while the renderer is still booting. */
  disabled?: boolean;
  /** Fill the row (inspector panel) rather than hug the labels (header). */
  block?: boolean;
  /** Drop the labels on narrow screens, as the header's other groups do. */
  compact?: boolean;
  className?: string;
};

/** Segmented Splat / Mesh switch: the two scans of one world, one drawn at a time. */
export function LayerToggle({ layer, onLayer, hasSplat, meshReady, disabled, block, compact, className = "" }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Scan layer"
      className={`flex items-center gap-0.5 rounded-lg border border-hairline p-0.5 ${
        block ? "w-full bg-stellar-white" : "bg-pure-white"
      } ${className}`}
    >
      {LAYERS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={layer === l.id}
          title={l.hint}
          disabled={disabled || (l.id === "splat" ? !hasSplat : !meshReady)}
          onClick={() => onLayer(l.id)}
          className={`inline-flex items-center justify-center gap-1.5 rounded-[6px] px-2.5 py-1 text-body-sm font-medium transition-colors duration-200 disabled:opacity-50 ${
            block ? "flex-1" : ""
          } ${layer === l.id ? "bg-sky-tint text-wander-blue" : "text-void-black/60 hover:text-void-black"}`}
        >
          <Icon name={l.icon} size={15} />
          <span className={compact ? "hidden sm:inline" : ""}>{l.label}</span>
        </button>
      ))}
    </div>
  );
}
