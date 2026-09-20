export type SaveState = { status: "clean" | "dirty" | "saving" | "saved" | "error"; error?: string };

/** One writer per resource. An older PUT must finish before a newer snapshot is sent. */
export class AutosaveQueue {
  private saved: string;
  private latest: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private state: SaveState = { status: "clean" };
  private listeners = new Set<() => void>();

  constructor(initial: string, private write: (body: string) => Promise<void>, private delay = 900) {
    this.saved = this.latest = initial;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  update(body: string) {
    if (body === this.latest) return;
    this.latest = body;
    clearTimeout(this.timer);
    if (this.running) return; // drain() will send the latest snapshot next.
    this.publish({ status: body === this.saved ? "saved" : "dirty" });
    if (body !== this.saved) this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, this.delay);
  }

  /** Flush before leaving or running another operation that edits the same resource. */
  flush = (): Promise<void> => {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    if (this.latest === this.saved) return Promise.resolve();
    this.running = this.drain().finally(() => {
      this.running = null;
      // A subscriber may edit as the completion notification is delivered.
      if (this.latest !== this.saved && this.state.status !== "error") {
        this.publish({ status: "dirty" });
        this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, this.delay);
      }
    });
    return this.running;
  };

  private async drain() {
    this.publish({ status: "saving" });
    try {
      while (this.latest !== this.saved) {
        const body = this.latest;
        await this.write(body);
        this.saved = body;
      }
      this.publish({ status: "saved" });
    } catch (error) {
      this.publish({ status: "error", error: error instanceof Error ? error.message : "Save failed" });
      throw error;
    }
  }

  private publish(state: SaveState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
