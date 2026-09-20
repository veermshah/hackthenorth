import type { Metadata } from "next";
import { Icon } from "@/components/Icon";
import { TopBar } from "@/components/dashboard/TopBar";
import { WorldsBrowser, type WorldView } from "@/components/dashboard/WorldsBrowser";
import { IMAGES } from "@/lib/images";
import { hasImage } from "@/lib/images.server";
import { CURRENT_USER, WORLDS, worldFromManifest } from "@/lib/worlds";
import { listWorlds, worldsSource } from "@/lib/worlds-api.server";

export const metadata: Metadata = { title: "Dashboard" };

/** Worlds on the volume change without a rebuild, so render per request. */
export const dynamic = "force-dynamic";

async function loadLiveWorlds() {
  try {
    return { live: await listWorlds(), backendError: null };
  } catch (err) {
    console.error("[dashboard]", err);
    return { live: [], backendError: err instanceof Error ? err.message : "Worlds backend unavailable" };
  }
}

export default async function DashboardPage() {
  const { live, backendError } = await loadLiveWorlds();

  // Sample worlds are design placeholders for local work only; with a real backend, show only the volume.
  const samples = worldsSource === "local" ? WORLDS.filter((w) => !live.some((m) => m.id === w.id)) : [];

  const worlds: WorldView[] = [
    ...live.map((m) => ({ ...worldFromManifest(m, CURRENT_USER), imageReady: false })),
    ...samples.map((w) => ({ ...w, imageReady: w.image ? hasImage(IMAGES[w.image]) : false })),
  ];

  const emptyMessage =
    worldsSource === "api"
      ? "No worlds on the volume yet. Upload worlds/<id>/world.json and a scene.spz through the API, then refresh."
      : "No worlds yet. Run `npm run world:add -- <id> path/to/scene.spz` to register a local export.";

  return (
    <>
      <TopBar title="Recents" crumbs={["HTN 2026"]} />
      <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
        {backendError && (
          <div
            role="alert"
            className="card mb-6 flex flex-wrap items-center gap-3 border-wander-pink/40 p-4"
          >
            <span className="pill-sm bg-wander-pink text-pure-white">Backend unreachable</span>
            <p className="min-w-0 flex-1 text-body-sm text-graphite">
              {backendError}. Check <code>WANDER_API_URL</code> / <code>WANDER_API_KEY</code> in{" "}
              <code>apps/web/.env.local</code>, or unset the URL to read from <code>maps/assets</code>.
            </p>
            <Icon name="x" size={16} className="text-wander-pink" />
          </div>
        )}
        <WorldsBrowser worlds={worlds} emptyMessage={emptyMessage} />
      </main>
    </>
  );
}
