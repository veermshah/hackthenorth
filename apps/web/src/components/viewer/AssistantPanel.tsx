"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useTextStream } from "@/components/ui/response-stream";
import type { NavigationGraph, Vec3, WorldNote } from "@/lib/world-manifest";
import type { WorldStatus } from "@/lib/worlds";
import { AssistantCallView } from "./AssistantCallView";
import type { ViewerSelection } from "./SplatViewerEngine";

type ChatMessage = { role: "user" | "assistant"; text: string };

type Props = {
  worldId: string;
  name: string;
  status: WorldStatus;
  graph: NavigationGraph;
  notes: WorldNote[];
  selection: ViewerSelection | null;
  /** Current camera position (world frame) in the 3D reconstruction viewer — this is a
   * standalone, Next.js-only notion of "what's in view" and has nothing to do with the
   * iOS app's live phone localization/pose. */
  getCameraPosition: () => Vec3 | null;
};

const DEVICE_ID_KEY = "wander-device-id";

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Plain-text hint of what's currently on screen, so "what is this?" has something
 * to point at. The backend treats this as a hint only, never as sensor/navigation
 * truth (see building_assistant.txt's ui_context rule). */
function describeSelection(graph: NavigationGraph, notes: WorldNote[], selection: ViewerSelection | null): string | null {
  if (!selection) return null;
  if (selection.kind === "node") {
    const node = graph.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    return `Selected ${node.kind ?? "waypoint"}: "${node.name ?? node.id}".`;
  }
  const note = notes.find((n) => n.id === selection.id);
  if (!note) return null;
  const location = note.location ? ` (${note.location})` : "";
  const description = note.description ? `: ${note.description}` : "";
  return `Selected pin "${note.title}"${location}${description}`;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Nearest mapped waypoints/pins to the current camera position, for questions like
 * "what can you see" that aren't about one specific selected pin. Graph nodes only count
 * when the graph is in the world frame (the default) — a `"splat"`-frame graph would need
 * the alignment transform this Vec3 doesn't carry, so it's left out rather than guessed. */
function describeNearby(position: Vec3, graph: NavigationGraph, notes: WorldNote[]): string | null {
  const RADIUS_M = 8;
  const LIMIT = 3;
  const candidates: { label: string; distanceM: number }[] = [];
  if ((graph.frame ?? "world") === "world") {
    for (const node of graph.nodes) candidates.push({ label: node.name ?? node.id, distanceM: distance(position, node.position) });
  }
  for (const note of notes) candidates.push({ label: note.title || "Untitled pin", distanceM: distance(position, note.position) });
  const nearby = candidates
    .filter((c) => c.distanceM <= RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, LIMIT);
  if (!nearby.length) return null;
  return `Nearby in the current 3D view: ${nearby.map((c) => `${c.label} (~${c.distanceM.toFixed(1)} m)`).join(", ")}.`;
}

function buildUiContext(
  name: string,
  status: WorldStatus,
  graph: NavigationGraph,
  notes: WorldNote[],
  selection: ViewerSelection | null,
  cameraPosition: Vec3 | null,
): string {
  const parts = [`Viewing world "${name}" (status: ${status}) in the web dashboard's 3D reconstruction viewer.`];
  const selected = describeSelection(graph, notes, selection);
  if (selected) parts.push(selected);
  else if (cameraPosition) {
    const nearby = describeNearby(cameraPosition, graph, notes);
    if (nearby) parts.push(nearby);
  }
  return parts.join(" ");
}

// Minimal Web Speech API surface — not part of the standard TS DOM lib, and
// only Chrome/Edge/Safari ship it (as the vendor-prefixed webkit* global).
type SpeechRecognitionResultLike = { transcript: string };
type SpeechRecognitionEventLike = { results: ArrayLike<ArrayLike<SpeechRecognitionResultLike>> };
export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

/** Bouncing-dots "waiting on the model" indicator, shown while a query is in flight
 * and no answer text has streamed in yet. */
export function ThinkingIndicator({ label = "Thinking" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="thinking-dot inline-block size-1.5 rounded-full bg-void-black/50"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

export function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Shared session/query plumbing for both the desktop chat view and the mobile
 * call view — one POST /api/assistant/sessions + /api/assistant/query pair. */
export function useAssistantSession(worldId: string) {
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    sessionRef.current = sessionStorage.getItem(`wander-assistant-session-${worldId}`);
  }, [worldId]);

  async function ensureSession(): Promise<string> {
    if (sessionRef.current) return sessionRef.current;
    const res = await fetch("/api/assistant/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worldId, deviceId: deviceId() }),
    });
    const body = (await res.json()) as { sessionId?: string; error?: string };
    if (!res.ok || !body.sessionId) throw new Error(body.error ?? "Could not start a session");
    sessionRef.current = body.sessionId;
    sessionStorage.setItem(`wander-assistant-session-${worldId}`, body.sessionId);
    return body.sessionId;
  }

  async function ask(text: string, uiContext: string): Promise<string> {
    const sessionId = await ensureSession();
    const res = await fetch("/api/assistant/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, text, uiContext }),
    });
    const body = (await res.json()) as { text?: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? "The assistant did not respond");
    return body.text ?? "";
  }

  /** Same query, but as an async iterable of text chunks (POST /api/assistant/query/stream,
   * server-sent events proxied straight through from FastAPI). `onFinal` fires once with the
   * backend's authoritative final answer text — not necessarily identical byte-for-byte to the
   * concatenated deltas, so callers should persist that instead of the streamed text. */
  function askStream(text: string, uiContext: string, onFinal: (text: string) => void): AsyncIterable<string> {
    return (async function* stream() {
      const sessionId = await ensureSession();
      const res = await fetch("/api/assistant/query/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text, uiContext }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "The assistant did not respond");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue;
          const event = JSON.parse(chunk.slice("data: ".length)) as { type: string; text?: string };
          if (event.type === "delta" && event.text) yield event.text;
          else if (event.type === "final") onFinal(event.text ?? "");
        }
      }
    })();
  }

  return { ask, askStream };
}

/** Drives useTextStream over a live SSE-backed async iterable; shows the bouncing-dots
 * indicator until the first chunk of real text arrives. */
function StreamingReply({
  stream,
  onDone,
  onError,
}: {
  stream: AsyncIterable<string>;
  onDone: () => void;
  onError: (error: unknown) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { displayedText } = useTextStream({ textStream: stream, mode: "typewriter", speed: 70, onComplete: onDone, onError });

  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [displayedText]);

  if (!displayedText) return <ThinkingIndicator />;
  return (
    <span ref={ref} className="whitespace-pre-wrap">
      {displayedText}
    </span>
  );
}

/** Inspector tab: type or speak a question, get an answer from the building assistant
 * (POST /api/assistant/sessions, /api/assistant/query -> the FastAPI backend on Modal).
 * Desktop shows a normal chat; a narrow viewport (`lg:hidden`) swaps in a hands-free
 * call-style view instead — both are always mounted, so switching costs nothing and
 * neither activates the mic without an explicit tap. */
export function AssistantPanel({ worldId, name, status, graph, notes, selection, getCameraPosition }: Props) {
  const getUiContext = () => buildUiContext(name, status, graph, notes, selection, getCameraPosition());
  const { ask, askStream } = useAssistantSession(worldId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [stream, setStream] = useState<AsyncIterable<string> | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalTextRef = useRef("");

  useEffect(() => () => recognitionRef.current?.stop(), []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text: trimmed }]);
    setSending(true);
    finalTextRef.current = "";
    setStream(askStream(trimmed, getUiContext(), (text) => (finalTextRef.current = text)));
  }

  function finishStreaming() {
    if (finalTextRef.current) setMessages((m) => [...m, { role: "assistant", text: finalTextRef.current }]);
    setStream(null);
    setSending(false);
  }

  function failStreaming(err: unknown) {
    setError(err instanceof Error ? err.message : "Something went wrong");
    setStream(null);
    setSending(false);
  }

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setError("Voice input isn't supported in this browser — try typing instead.");
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      const transcript = last?.[0]?.transcript;
      if (transcript) send(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  return (
    <>
      <div className="hidden h-full flex-col lg:flex">
        <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-4">
          {messages.length === 0 && (
            <p className="text-body-sm text-void-black/60">
              Ask about this building — “Where’s the nearest restroom?”, “What obstacles were reported recently?”
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 text-body-sm whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-wander-blue text-pure-white"
                    : "border border-hairline bg-pure-white text-void-black"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-xl border border-hairline bg-pure-white px-3 py-2 text-body-sm text-void-black">
                {stream ? <StreamingReply stream={stream} onDone={finishStreaming} onError={failStreaming} /> : <ThinkingIndicator />}
              </div>
            </div>
          )}
          {error && <p className="text-body-sm text-wander-pink">{error}</p>}
        </div>
        <form
          className="flex items-end gap-2 border-t border-hairline p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            className="input min-h-9 flex-1 resize-none"
            rows={1}
            placeholder="Type a question…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <button
            type="button"
            aria-label={listening ? "Stop listening" : "Ask by speaking"}
            aria-pressed={listening}
            onClick={toggleMic}
            className={`btn-icon ${listening ? "bg-pink-tint text-wander-pink" : ""}`}
          >
            <Icon name="mic" />
          </button>
          <button type="submit" className="btn-primary" disabled={sending || !input.trim()} aria-label="Send">
            <Icon name="arrowRight" />
          </button>
        </form>
      </div>
      <div className="h-full lg:hidden">
        <AssistantCallView ask={ask} getUiContext={getUiContext} />
      </div>
    </>
  );
}
