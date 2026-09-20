import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlacementGesture } from '../src/components/viewer/PlacementGesture.ts';
import { CameraKeyControls } from '../src/components/viewer/CameraKeyControls.ts';
import * as THREE from 'three';

const pointer = (x = 0, y = 0, id = 1, button = 0) => ({ clientX: x, clientY: y, pointerId: id, button });

test('stationary presses and small aiming movements place points', () => {
  const gesture = new PlacementGesture();
  gesture.start(pointer()); assert.equal(gesture.finish(pointer(3, 2)), true);
});
test('a drag returning to its starting pixel is never a click', () => {
  const gesture = new PlacementGesture();
  gesture.start(pointer()); gesture.move(pointer(30)); gesture.move(pointer());
  assert.equal(gesture.finish(pointer()), false);
});
test('movement first reported at release still cancels placement', () => {
  const gesture = new PlacementGesture();
  gesture.start(pointer()); assert.equal(gesture.finish(pointer(30)), false);
});
test('pinching, cancellation, tool changes and secondary buttons never place', () => {
  const gesture = new PlacementGesture();
  gesture.start(pointer()); gesture.start(pointer(0, 0, 2));
  assert.equal(gesture.finish(pointer(0, 0, 2)), false);
  assert.equal(gesture.finish(pointer()), false);
  gesture.start(pointer()); gesture.cancel(pointer()); assert.equal(gesture.finish(pointer()), false);
  gesture.start(pointer()); gesture.reset(); assert.equal(gesture.finish(pointer()), false);
  gesture.start(pointer(0, 0, 1, 2)); assert.equal(gesture.finish(pointer(0, 0, 1, 2)), false);
  gesture.start(pointer()); assert.equal(gesture.finish(pointer()), true);
});
test('walk mode captures the canvas while keyboard focus remains on the container', () => {
  class Element extends EventTarget {
    captured = new Set();
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
  }
  const container = new Element(), canvas = new Element();
  const controls = new CameraKeyControls(new THREE.PerspectiveCamera(), container, canvas);
  controls.dragLook = true;
  const down = Object.assign(new Event('pointerdown'), pointer(), { pointerType: 'mouse' });
  canvas.dispatchEvent(down);
  assert.equal(canvas.hasPointerCapture(1), true);
  assert.equal(container.hasPointerCapture(1), false);
  canvas.dispatchEvent(Object.assign(new Event('pointerup'), pointer()));
  assert.equal(canvas.hasPointerCapture(1), false);
  controls.dispose();
});
