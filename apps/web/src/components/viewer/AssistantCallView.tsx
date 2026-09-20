"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { getSpeechRecognition, ThinkingIndicator, type SpeechRecognitionLike } from "./AssistantPanel";

type CallMessage = { role: "user" | "assistant"; text: string };
type CallState = "idle" | "listening" | "thinking" | "speaking";

type Props = {
  ask: (text: string, uiContext: string) => Promise<string>;
  /** Built fresh per utterance, since the camera can move between turns of the call. */
  getUiContext: () => string;
};

const STATE_LABEL: Record<CallState, string> = {
  idle: "Tap to start a call",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

/** Hands-free "voice call" alternative to the desktop chat, for narrow viewports.
 * Continuous SpeechRecognition -> the same /api/assistant/query call the desktop
 * chat uses -> speechSynthesis for the reply. The mic only ever restarts after
 * playback ends, so it never picks up the assistant's own voice. */
export function AssistantCallView({ ask, getUiContext }: Props) {
  const [state, setState] = useState<CallState>("idle");
  const [messages, setMessages] = useState<CallMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => () => hangUp(), []);

  function startListening() {
    if (!activeRef.current) return;
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setError("Voice input isn't supported in this browser.");
      activeRef.current = false;
      setState("idle");
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    let handled = false;
    recognition.onresult = (e) => {
      handled = true;
      const last = e.results[e.results.length - 1];
      const transcript = last?.[0]?.transcript;
      if (transcript) void handleUtterance(transcript);
      else if (activeRef.current) startListening();
    };
    recognition.onerror = () => {
      handled = true;
      if (activeRef.current) startListening();
    };
    recognition.onend = () => {
      if (!handled && activeRef.current) startListening();
    };
    recognitionRef.current = recognition;
    recognition.start();
    setState("listening");
  }

  async function handleUtterance(text: string) {
    recognitionRef.current = null;
    setState("thinking");
    setError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const answer = await ask(text, getUiContext());
      setMessages((m) => [...m, { role: "assistant", text: answer }]);
      speak(answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      if (activeRef.current) startListening();
    }
  }

  function speak(text: string) {
    if (!activeRef.current) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      startListening();
      return;
    }
    setState("speaking");
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
      if (activeRef.current) startListening();
    };
    utterance.onerror = () => {
      if (activeRef.current) startListening();
    };
    window.speechSynthesis.speak(utterance);
  }

  function startCall() {
    activeRef.current = true;
    setError(null);
    setMessages([]);
    startListening();
  }

  function hangUp() {
    activeRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setState("idle");
  }

  const inCall = state !== "idle";

  return (
    <div className="flex h-full flex-col">
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-body-sm text-void-black/60">
            Start a call, then ask about this building — “Where’s the nearest restroom?”
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
        {error && <p className="text-body-sm text-wander-pink">{error}</p>}
      </div>
      <div className="flex flex-col items-center gap-3 border-t border-hairline p-6">
        <div aria-live="polite" className="flex h-5 items-center text-body-sm text-void-black/60">
          {state === "thinking" ? <ThinkingIndicator /> : STATE_LABEL[state]}
        </div>
        <button
          type="button"
          onClick={inCall ? hangUp : startCall}
          aria-label={inCall ? "End call" : "Start call"}
          className={`flex h-16 w-16 items-center justify-center rounded-full transition-colors ${
            inCall ? "bg-wander-pink text-pure-white" : "bg-wander-blue text-pure-white"
          } ${state === "listening" ? "animate-pulse" : ""}`}
        >
          <Icon name="phone" size={26} />
        </button>
      </div>
    </div>
  );
}
