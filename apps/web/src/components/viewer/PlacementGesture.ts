type Pointer = { pointerId: number; clientX: number; clientY: number; button: number };

/** A placement click can be held, but can never be a drag or a multi-touch gesture. */
export class PlacementGesture {
  private active = new Set<number>();
  private press: { id: number; x: number; y: number; dragged: boolean } | null = null;

  constructor(private threshold = 5) {}

  get pressed() { return this.press !== null; }

  start(e: Pointer) {
    this.active.add(e.pointerId);
    this.press = this.active.size === 1 && e.button === 0
      ? { id: e.pointerId, x: e.clientX, y: e.clientY, dragged: false }
      : null;
  }

  move(e: Pointer): boolean {
    const p = this.press;
    if (!p || p.id !== e.pointerId) return false;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > this.threshold) p.dragged = true;
    return p.dragged;
  }

  finish(e: Pointer): boolean {
    const p = this.press;
    this.active.delete(e.pointerId);
    if (!p || p.id !== e.pointerId) return false;
    this.move(e);
    this.press = null;
    return !p.dragged;
  }

  cancel(e: Pick<Pointer, "pointerId">) {
    this.active.delete(e.pointerId);
    if (this.press?.id === e.pointerId) this.press = null;
  }

  reset() { this.press = null; }
}
