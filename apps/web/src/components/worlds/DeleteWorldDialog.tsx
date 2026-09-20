"use client";

import { useEffect, useId, useState } from "react";
import { Icon } from "@/components/Icon";

export type DeletableWorld = { id: string; name: string };

type Props = {
  /** The world to delete; null keeps the dialog closed. */
  world: DeletableWorld | null;
  onClose: () => void;
  /** Called after the world is gone, so the caller can drop it from its list. */
  onDeleted: (id: string) => void;
};

/**
 * Confirmation for deleting a world.
 *
 * The volume has no trash: this removes the manifest, every version's splat and mesh,
 * and the stored localization frames. So the id has to be typed out — a misclick in a
 * grid of thumbnails should not be able to destroy a capture.
 */
export function DeleteWorldDialog({ world, onClose, onDeleted }: Props) {
  // Keyed by id so a different world always gets a fresh, empty confirmation.
  return world ? <Dialog key={world.id} world={world} onClose={onClose} onDeleted={onDeleted} /> : null;
}

function Dialog({ world, onClose, onDeleted }: Props & { world: DeletableWorld }) {
  const titleId = useId();
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = typed.trim() === world.id;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(world.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not delete the world (${res.status})`);
      }
      onDeleted(world.id);
      onClose();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Could not delete the world");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="card w-full max-w-md">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-heading-sm font-bold text-void-black">
              Delete {world.name}?
            </h2>
            <p className="mt-1 text-body-sm text-graphite">
              This removes the manifest, every version&rsquo;s splat and mesh, and the stored
              localization frames. It cannot be undone.
            </p>
          </div>
          <button type="button" className="btn-icon shrink-0" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="mt-4">
          <label className="label" htmlFor={inputId}>
            Type <span className="font-mono text-void-black">{world.id}</span> to confirm
          </label>
          <input
            id={inputId}
            className="input mt-1 font-mono text-body-sm"
            value={typed}
            placeholder={world.id}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
        </div>

        {error && (
          <p role="alert" className="mt-3 text-body-sm text-wander-pink">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" className="btn-text" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-danger" disabled={!confirmed || busy} onClick={() => void submit()}>
            <Icon name="trash" size={15} />
            {busy ? "Deleting…" : "Delete world"}
          </button>
        </div>
      </div>
    </div>
  );
}
