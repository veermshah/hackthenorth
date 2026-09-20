"use client";

import { QRCodeSVG } from "qrcode.react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import { buildConnectLink, isReachableFromPhone } from "@/lib/connect-link";

export type ConnectPhoneInfo = {
  worldId: string;
  name: string;
  nianticSiteId: string | null;
  /** Worlds API base URL from the server, or null in local mode (the page origin + /api is offered instead). */
  backendUrl: string | null;
};

const noSubscribe = () => () => {};
/** This server's origin + /api — where the phone posts in local mode. Empty during SSR so hydration matches. */
const useLocalBackendUrl = () =>
  useSyncExternalStore(noSubscribe, () => `${window.location.origin}/api`, () => "");

/**
 * QR code that hands a world to the front phone (`wander://connect?…`). The
 * backend URL is editable so a dev machine can be pointed at by LAN address.
 */
export function ConnectPhoneQR({
  info,
  size = 220,
  compact = false,
}: {
  info: ConnectPhoneInfo;
  size?: number;
  compact?: boolean;
}) {
  const id = useId();
  const localBackend = useLocalBackendUrl();
  /** null until the user edits the field; the default follows the server / local origin. */
  const [edited, setEdited] = useState<string | null>(null);
  const backendUrl = edited ?? info.backendUrl ?? localBackend;
  const setBackendUrl = setEdited;
  const [copied, setCopied] = useState(false);

  const link = buildConnectLink({
    worldId: info.worldId,
    name: info.name,
    nianticSiteId: info.nianticSiteId,
    backendUrl: backendUrl.trim() || null,
  });
  const unreachable = !!backendUrl && !isReachableFromPhone(backendUrl);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure origin); the link is still selectable below */
    }
  };

  return (
    <div className={compact ? "" : "grid gap-4 sm:grid-cols-[auto_1fr]"}>
      <figure className="mx-auto w-fit rounded-xl border border-hairline bg-pure-white p-3">
        {/* Void Black modules on Pure White with quiet zone; level M keeps the code scannable on a laptop screen. */}
        <QRCodeSVG
          value={link}
          size={size}
          level="M"
          marginSize={0}
          bgColor="#ffffff"
          fgColor="#0f172a"
          title={`Connect a phone to ${info.name}`}
        />
        <figcaption className="mt-2 text-center text-caption text-void-black/50">Scan with the Wander app</figcaption>
      </figure>

      <div className={compact ? "mt-3" : "min-w-0"}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
          <dt className="text-void-black/50">World</dt>
          <dd className="truncate font-mono text-[12px] text-void-black">{info.worldId}</dd>
        </dl>

        <label htmlFor={`${id}-backend`} className="label mt-3 block text-caption text-void-black/60">
          Backend the phone posts to
        </label>
        <input
          id={`${id}-backend`}
          className="input mt-1 py-1 font-mono text-[12px]"
          value={backendUrl}
          onChange={(e) => setBackendUrl(e.target.value)}
          placeholder="https://…modal.run"
          spellCheck={false}
          autoCapitalize="off"
        />
        {unreachable && (
          <p className="mt-1 text-caption text-wander-pink">
            The phone can&apos;t reach localhost — open this page with your Mac&apos;s LAN address (e.g. http://10.0.0.5:3000) or type it here.
          </p>
        )}
        <p className="mt-2 text-caption text-void-black/50">
          The code carries the world and the backend it posts to. The API key and Niantic token stay on the phone.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <button type="button" className="btn-text px-2 py-1 text-caption" onClick={copy}>
            <Icon name={copied ? "check" : "link"} size={13} />
            {copied ? "Copied" : "Copy link"}
          </button>
          <code className="min-w-0 flex-1 truncate text-[11px] text-void-black/40" title={link}>
            {link}
          </code>
        </div>
      </div>
    </div>
  );
}

/** Modal wrapper used from the viewer header. */
export function ConnectPhoneDialog({ open, info, onClose }: { open: boolean; info: ConnectPhoneInfo; onClose: () => void }) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="card w-full max-w-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-heading-sm font-bold text-void-black">
              Connect a phone to {info.name}
            </h2>
            <p className="mt-1 text-body-sm text-graphite">
              On the front phone open Settings › <strong>Scan world QR</strong>, or point the iOS Camera at the code.
              The phone takes this world and the backend, then starts localizing.
            </p>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="mt-5">
          <ConnectPhoneQR info={info} size={240} />
        </div>
      </div>
    </div>
  );
}
