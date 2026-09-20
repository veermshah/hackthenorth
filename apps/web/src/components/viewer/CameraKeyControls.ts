import * as THREE from "three";

const MAX_PITCH = Math.PI / 2 - 0.05;

/** Camera-relative move axes: x = right, y = up, z = forward. */
const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, 1],
  KeyS: [0, 0, -1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  KeyE: [0, 1, 0],
  KeyR: [0, 1, 0],
  Space: [0, 1, 0],
  KeyQ: [0, -1, 0],
  KeyF: [0, -1, 0],
  KeyC: [0, -1, 0],
};

/** Turn axes: x = yaw (left positive), y = pitch (up positive). */
const TURN_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

export type CameraMotion = {
  /** Unit-ish camera-relative move direction for this frame (x right, y up, z forward), or zero. */
  move: THREE.Vector3;
  /** Yaw / pitch turn rates in radians for this frame. */
  yaw: number;
  pitch: number;
  sprint: boolean;
};

/**
 * Keyboard + drag-to-look input for the viewer camera, shared by Orbit and
 * Walk modes. It only *collects* input: `consume(dt)` returns the motion for
 * this frame and the engine applies it (orbit moves camera + pivot together,
 * walk moves the camera on the horizontal plane). Keys are read from the
 * focusable viewer element (not the document) so typing elsewhere never moves
 * the camera. Everything is removed again in `dispose()`.
 */
export class CameraKeyControls {
  enabled = true;
  /** Drag-to-look is only wanted in walk mode; OrbitControls owns the pointer otherwise. */
  dragLook = false;
  /** Radians per second for arrow-key turning. */
  turnSpeed = 1.6;
  sprintMultiplier = 3;
  /** Radians per CSS pixel of drag. */
  lookSpeed = 0.0022;

  private yaw = 0;
  private pitch = 0;
  private readonly keys = new Set<string>();
  private drag: { id: number; x: number; y: number } | null = null;
  private readonly motion: CameraMotion = { move: new THREE.Vector3(), yaw: 0, pitch: 0, sprint: false };
  private readonly tmp = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    private readonly pointerElement: HTMLElement = element,
  ) {
    this.syncFromCamera();
    this.listen(pointerElement, "pointerdown", this.onPointerDown);
    this.listen(pointerElement, "pointermove", this.onPointerMove);
    this.listen(pointerElement, "pointerup", this.onPointerUp);
    this.listen(pointerElement, "pointercancel", this.onPointerUp);
    this.listen(pointerElement, "lostpointercapture", this.onPointerUp);
    this.listen(element, "keydown", this.onKeyDown);
    this.listen(element, "keyup", this.onKeyUp);
    this.listen(element, "blur", () => this.keys.clear());
  }

  /** Read yaw/pitch back from the camera after something else moved it. */
  syncFromCamera() {
    this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this.euler.y;
    this.pitch = THREE.MathUtils.clamp(this.euler.x, -MAX_PITCH, MAX_PITCH);
  }

  /** Apply the tracked yaw/pitch to the camera (walk mode). */
  applyRotation() {
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.euler);
  }

  /** Nudge the tracked orientation (walk mode arrows). */
  turn(yaw: number, pitch: number) {
    this.yaw += yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch, -MAX_PITCH, MAX_PITCH);
    this.applyRotation();
  }

  get hasInput(): boolean {
    return this.keys.size > 0;
  }

  /** Motion requested by held keys for a frame of `dt` seconds. */
  consume(dt: number): CameraMotion {
    const m = this.motion;
    m.move.set(0, 0, 0);
    m.yaw = 0;
    m.pitch = 0;
    m.sprint = false;
    if (!this.enabled || this.keys.size === 0) return m;

    for (const code of this.keys) {
      const v = MOVE_KEYS[code];
      if (v) m.move.add(this.tmp.set(v[0], v[1], v[2]));
      const t = TURN_KEYS[code];
      if (t) {
        m.yaw += t[0];
        m.pitch += t[1];
      }
    }
    if (m.move.lengthSq() > 0) m.move.normalize();
    const step = Math.min(dt, 0.1) * this.turnSpeed;
    m.yaw *= step;
    m.pitch *= step;
    m.sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    return m;
  }

  dispose() {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled || !this.dragLook || (e.pointerType === "mouse" && e.button !== 0)) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.pointerElement.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragLook || !this.drag || e.pointerId !== this.drag.id) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.turn(-dx * this.lookSpeed, -dy * this.lookSpeed);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.drag?.id !== e.pointerId) return;
    this.drag = null;
    if (this.pointerElement.hasPointerCapture(e.pointerId)) this.pointerElement.releasePointerCapture(e.pointerId);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code in MOVE_KEYS || e.code in TURN_KEYS || e.code === "ShiftLeft" || e.code === "ShiftRight") {
      this.keys.add(e.code);
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ) {
    target.addEventListener(type, handler);
    this.disposers.push(() => target.removeEventListener(type, handler));
  }
}
