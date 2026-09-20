"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { ImagePlaceholder } from "@/components/ImagePlaceholder";
import { DeleteWorldDialog, type DeletableWorld } from "@/components/worlds/DeleteWorldDialog";
import { IMAGES } from "@/lib/images";
import { CURRENT_USER, STATUS_META, worldHref, type World } from "@/lib/worlds";
import { Avatar, AvatarStack } from "./Avatar";

/** World plus a server-resolved flag for whether its thumbnail exists in /public. */
export type WorldView = World & { imageReady: boolean };

type View = "grid" | "list";
type Tab = "all" | "starred" | "shared" | "drafts";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All worlds" },
  { id: "starred", label: "Starred" },
  { id: "shared", label: "Shared with you" },
  { id: "drafts", label: "Drafts" },
];

export function WorldsBrowser({
  worlds,
  emptyMessage,
}: {
  worlds: WorldView[];
  /** Copy for the "All worlds" empty state; depends on where the server reads worlds from. */
  emptyMessage?: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>("grid");
  const [tab, setTab] = useState<Tab>("all");
  const [starred, setStarred] = useState<Set<string>>(
    () => new Set(worlds.filter((w) => w.starred).map((w) => w.id)),
  );
  const [deleting, setDeleting] = useState<DeletableWorld | null>(null);
  /** Hidden straight away so the grid reacts to the delete; `router.refresh()` then re-reads the volume. */
  const [deleted, setDeleted] = useState<Set<string>>(() => new Set());

  const visible = useMemo(() => {
    const live = worlds.filter((w) => !deleted.has(w.id));
    switch (tab) {
      case "starred":
        return live.filter((w) => starred.has(w.id));
      case "shared":
        return live.filter((w) => w.owner.name !== CURRENT_USER.name);
      case "drafts":
        return live.filter((w) => w.status === "draft");
      default:
        return live;
    }
  }, [worlds, tab, starred, deleted]);

  function onDeleted(id: string) {
    setDeleted((prev) => new Set(prev).add(id));
    router.refresh(); // the dashboard is force-dynamic, so this re-lists the volume
  }

  function toggleStar(id: string) {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section aria-labelledby="worlds-heading" className="mt-10">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="worlds-heading" className="text-heading-sm font-bold text-void-black">
          Recently viewed
        </h2>
        <div className="flex-1" />
        <div
          role="tablist"
          aria-label="Filter worlds"
          className="flex items-center gap-0.5 rounded-lg border border-hairline bg-pure-white p-0.5"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-[6px] px-3 py-1 text-body-sm font-medium transition-colors duration-200 ${
                tab === t.id
                  ? "bg-sky-tint text-wander-blue"
                  : "text-void-black/60 hover:text-void-black"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn-text gap-1.5 px-2.5 text-void-black/70">
          Last viewed
          <Icon name="chevronDown" size={14} />
        </button>
        <div
          role="group"
          aria-label="View"
          className="flex items-center rounded-lg border border-hairline bg-pure-white p-0.5"
        >
          <ViewToggle icon="grid" label="Grid view" active={view === "grid"} onClick={() => setView("grid")} />
          <ViewToggle icon="list" label="List view" active={view === "list"} onClick={() => setView("list")} />
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState tab={tab} allMessage={emptyMessage} />
      ) : view === "grid" ? (
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((w) => (
            <li key={w.id}>
              <WorldCard
                world={w}
                starred={starred.has(w.id)}
                onStar={() => toggleStar(w.id)}
                onDelete={() => setDeleting({ id: w.id, name: w.name })}
              />
            </li>
          ))}
        </ul>
      ) : (
        <WorldTable
          worlds={visible}
          starred={starred}
          onStar={toggleStar}
          onDelete={(w) => setDeleting({ id: w.id, name: w.name })}
        />
      )}

      <DeleteWorldDialog world={deleting} onClose={() => setDeleting(null)} onDeleted={onDeleted} />
    </section>
  );
}

function ViewToggle({
  icon,
  label,
  active,
  onClick,
}: {
  icon: "grid" | "list";
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded-[6px] transition-colors duration-200 ${
        active ? "bg-sky-tint text-wander-blue" : "text-void-black/60 hover:text-void-black"
      }`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

function Thumbnail({ world, className = "" }: { world: WorldView; className?: string }) {
  const asset = world.image ? IMAGES[world.image] : null;
  return (
    <div className={`relative overflow-hidden bg-stellar-white ${className}`}>
      {world.thumbnailUrl ? (
        // Served by the worlds proxy; skip the optimizer so the API stays the single source.
        <Image src={world.thumbnailUrl} alt="" fill unoptimized className="object-cover" />
      ) : asset && world.imageReady ? (
        <Image
          src={asset.src}
          alt={asset.alt}
          fill
          sizes="(min-width: 1536px) 22vw, (min-width: 1280px) 30vw, (min-width: 640px) 45vw, 100vw"
          className="object-cover"
        />
      ) : asset ? (
        <ImagePlaceholder asset={asset} compact className="rounded-none border-0" />
      ) : (
        <div
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center bg-wander-navy text-wander-sky"
        >
          <Icon name="cube" size={22} />
        </div>
      )}
    </div>
  );
}

function StarButton({
  starred,
  onClick,
  className = "",
}: {
  starred: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={starred ? "Remove from starred" : "Add to starred"}
      aria-pressed={starred}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded-lg transition-colors duration-200 ${
        starred
          ? "text-wander-pink"
          : "text-void-black/40 hover:bg-void-black/5 hover:text-void-black"
      } ${className}`}
    >
      <Icon name="star" size={15} fill={starred ? "currentColor" : "none"} />
    </button>
  );
}

/**
 * Only worlds on the volume can be deleted; the sample worlds in `worlds.ts` are design
 * placeholders with nothing behind them, so they get no delete control.
 */
function DeleteButton({ onClick, className = "" }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label="Delete world"
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded-lg text-void-black/40 transition-colors duration-200 hover:bg-pink-tint hover:text-wander-pink ${className}`}
    >
      <Icon name="trash" size={15} />
    </button>
  );
}

function WorldCard({
  world,
  starred,
  onStar,
  onDelete,
}: {
  world: WorldView;
  starred: boolean;
  onStar: () => void;
  onDelete: () => void;
}) {
  const status = STATUS_META[world.status];
  const href = worldHref(world.id);
  return (
    <article className="card group overflow-hidden p-0 transition-colors duration-200 hover:border-void-black/20">
      <div className="relative">
        <Link href={href} aria-label={`Open ${world.name}`} className="block rounded-none">
          <Thumbnail world={world} className="aspect-[16/10] border-b border-hairline" />
        </Link>
        <span className={`pill-sm absolute top-2 left-2 ${status.className}`}>
          {status.label}
        </span>
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
          {world.live && (
            <DeleteButton
              onClick={onDelete}
              className="bg-pure-white/90 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            />
          )}
          <StarButton
            starred={starred}
            onClick={onStar}
            className={`bg-pure-white/90 ${
              starred ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            }`}
          />
        </div>
      </div>
      <div className="p-3">
        <h3 className="truncate text-body-sm font-medium text-void-black">
          <Link href={href} className="rounded-sm transition-colors duration-200 hover:text-wander-blue">
            {world.name}
          </Link>
        </h3>
        <p className="mt-0.5 truncate text-caption text-void-black/50">
          {world.space} · {world.live ? "Updated" : "Edited"} {world.editedAt}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="truncate text-caption text-void-black/50">
            {world.splats} splats · {world.waypoints} waypoints
          </span>
          <AvatarStack people={[world.owner, ...world.collaborators]} />
        </div>
      </div>
    </article>
  );
}

function WorldTable({
  worlds,
  starred,
  onStar,
  onDelete,
}: {
  worlds: WorldView[];
  starred: Set<string>;
  onStar: (id: string) => void;
  onDelete: (world: WorldView) => void;
}) {
  return (
    <div className="card mt-5 overflow-x-auto p-0">
      <table className="w-full min-w-[720px] text-left text-body-sm">
        <thead className="text-caption font-medium text-void-black/50">
          <tr className="border-b border-hairline">
            <th className="px-4 py-2.5 font-medium">Name</th>
            <th className="px-4 py-2.5 font-medium">Space</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 text-right font-medium">Waypoints</th>
            <th className="px-4 py-2.5 text-right font-medium">Splats</th>
            <th className="px-4 py-2.5 font-medium">Edited</th>
            <th className="px-4 py-2.5 font-medium">People</th>
            <th className="w-20 px-2 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {worlds.map((w) => {
            const status = STATUS_META[w.status];
            return (
              <tr
                key={w.id}
                className="border-b border-hairline last:border-b-0 hover:bg-void-black/[0.02]"
              >
                <td className="px-4 py-2">
                  <Link
                    href={worldHref(w.id)}
                    className="flex items-center gap-3 rounded-sm text-void-black transition-colors duration-200 hover:text-wander-blue"
                  >
                    <Thumbnail world={w} className="h-9 w-14 rounded-sm border border-hairline" />
                    <span className="truncate font-medium">{w.name}</span>
                  </Link>
                </td>
                <td className="px-4 py-2 text-void-black/70">{w.space}</td>
                <td className="px-4 py-2">
                  <span className={`pill-sm ${status.className}`}>{status.label}</span>
                </td>
                <td className="px-4 py-2 text-right text-void-black/70">{w.waypoints}</td>
                <td className="px-4 py-2 text-right text-void-black/70">{w.splats}</td>
                <td className="px-4 py-2 text-void-black/70">{w.editedAt}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <Avatar person={w.owner} size={22} />
                    <span className="truncate text-void-black/70">{w.owner.name}</span>
                    {w.collaborators.length > 0 && (
                      <span className="text-caption text-void-black/40">
                        +{w.collaborators.length}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center justify-end gap-0.5">
                    {w.live && <DeleteButton onClick={() => onDelete(w)} />}
                    <StarButton starred={starred.has(w.id)} onClick={() => onStar(w.id)} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ tab, allMessage }: { tab: Tab; allMessage?: string }) {
  const copy: Record<Tab, string> = {
    all: allMessage ?? "No worlds yet. Start one above.",
    starred: "Star a world to keep it within reach.",
    shared: "Nothing has been shared with you yet.",
    drafts: "No drafts. Every world here is ready to walk.",
  };
  return (
    <div className="card mt-5 flex flex-col items-center py-14 text-center">
      <span className="inline-flex size-11 items-center justify-center rounded-full border-2 border-wander-sky bg-pure-white text-wander-blue">
        <Icon name="cube" size={18} />
      </span>
      <p className="mt-4 text-body text-graphite">{copy[tab]}</p>
    </div>
  );
}
