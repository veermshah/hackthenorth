"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { AutosaveQueue } from "@/lib/autosave";

/** The owning viewer is keyed by world ID, so this queue never crosses worlds. */
export function useAutosave(url: string, body: unknown, enabled: boolean) {
  const serialized = JSON.stringify(body);
  const [queue] = useState(() => new AutosaveQueue(serialized, async (snapshot) => {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: snapshot,
      // Browsers limit all outstanding keepalive bodies to 64 KiB.
      keepalive: new TextEncoder().encode(snapshot).byteLength < 32_000,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Save failed (${res.status})`);
  }));
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);

  useEffect(() => {
    if (enabled) queue.update(serialized);
  }, [enabled, queue, serialized]);

  useEffect(() => {
    const flush = () => { void queue.flush().catch(() => {}); };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [queue]);

  return { state, flush: queue.flush, retry: () => { void queue.flush().catch(() => {}); } };
}
