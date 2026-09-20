import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { WorldViewer } from "@/components/viewer/WorldViewer";
import { assetUrl } from "@/lib/world-manifest";
import { displayName, WORLDS, type WorldStatus } from "@/lib/worlds";
import {
  getLocalizations,
  getMeasurements,
  getNotes,
  getWorld,
  phoneBackendUrl,
  worldsSource,
} from "@/lib/worlds-api.server";

/** Always read the volume at request time — new exports and saved stops must show up without a rebuild. */
export const dynamic = "force-dynamic";

/** A world is viewable when it has a manifest on the volume; sample worlds only exist in local mode. */
const resolveWorld = cache(async (id: string) => {
  const manifest = await getWorld(id);
  const sample = worldsSource === "local" ? WORLDS.find((w) => w.id === id) : undefined;
  if (!manifest && !sample) return null;
  const status: WorldStatus =
    manifest?.status ?? sample?.status ?? (manifest?.alignment ? "aligned" : "processing");
  const name = manifest ? displayName(manifest) : (sample?.name ?? id);
  return { manifest, name, status };
});

export async function generateMetadata({ params }: PageProps<"/worlds/[id]">): Promise<Metadata> {
  const { id } = await params;
  const world = await resolveWorld(id);
  return { title: world?.name ?? "World" };
}

/** Full-viewport splat editor. Lives outside the dashboard shell so the scene is the whole page. */
export default async function WorldPage({ params }: PageProps<"/worlds/[id]">) {
  const { id } = await params;
  const world = await resolveWorld(id);
  if (!world) notFound();
  const [notes, measurements, localizations] = world.manifest
    ? await Promise.all([
        getNotes(id),
        getMeasurements(id),
        getLocalizations(id, 30).catch(() => []),
      ])
    : [[], [], []];

  return (
    <main className="flex flex-1 flex-col">
      <WorldViewer
        key={id}
        worldId={id}
        name={world.name}
        status={world.status}
        manifest={world.manifest}
        splatUrl={world.manifest ? assetUrl(world.manifest.assets.splat) : null}
        initialNotes={notes}
        initialMeasurements={measurements}
        initialLocalizations={localizations}
        phoneBackendUrl={phoneBackendUrl}
        source={worldsSource}
      />
    </main>
  );
}
