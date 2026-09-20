"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";

/** Failed reads must never open an empty editor that could overwrite saved work. */
export default function WorldError({ reset }: { reset: () => void }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-sm text-center">
        <span className="mx-auto inline-flex size-11 items-center justify-center rounded-full border-2 border-wander-pink bg-pure-white text-wander-pink">
          <Icon name="x" size={18} />
        </span>
        <p className="mt-4 text-body font-medium text-void-black">Could not load this world</p>
        <p className="mt-1 text-body-sm text-graphite">
          The scan, pins or measurements could not be read. Try again to load your saved work before editing.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" className="btn-ghost" onClick={reset}>
            <Icon name="refresh" size={15} />
            Try again
          </button>
          <Link href="/dashboard" className="btn-text">
            Back to worlds
          </Link>
        </div>
      </div>
    </main>
  );
}
