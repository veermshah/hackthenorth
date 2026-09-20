import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SplatViewerEngine } from '../src/components/viewer/SplatViewerEngine.ts';
import { measurementLength } from '../src/lib/world-manifest.ts';

function engine() {
  const viewer = Object.create(SplatViewerEngine.prototype);
  viewer.camera = new THREE.PerspectiveCamera(60, 1, .1, 100);
  viewer.camera.position.set(0, 0, 5);
  viewer.renderer = { domElement: { getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 400 }) } };
  viewer.raycaster = new THREE.Raycaster();
  viewer.graphGroup = new THREE.Group();
  viewer.meshGroup = new THREE.Group();
  viewer.nodePositions = new Map([['center', new THREE.Vector3(0, 0, 0)]]);
  viewer.collisionMeshes = [];
  viewer.mesh = null;
  viewer.events = [];
  viewer.opts = { onEvent: e => viewer.events.push(e) };
  return viewer;
}
const center = { clientX: 300, clientY: 250 };

test('placement bypasses waypoints; Navigate selects them and clears on misses', () => {
  const v = engine();
  v.intersectScene = () => ({ point: new THREE.Vector3(0, 0, 0), surface: 'mesh' });
  for (const tool of ['measure', 'note']) {
    v.tool = tool; v.pick(center);
    assert.equal(v.events.at(-1).type, 'pick');
  }
  v.tool = 'navigate'; v.pick(center);
  assert.deepEqual(v.events.at(-1), { type: 'pick-node', tool: 'navigate', id: 'center' });
  v.pick({ clientX: 110, clientY: 60 });
  assert.deepEqual(v.events.at(-1), { type: 'pick-miss', tool: 'navigate' });
});

test('mesh hits use world metres exactly once after translation, rotation and scale', () => {
  const v = engine();
  const root = new THREE.Group();
  root.position.set(2, 0, -1); root.rotation.y = Math.PI / 2; root.scale.setScalar(2);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  root.add(v.meshGroup, v.graphGroup); v.meshGroup.add(mesh); v.collisionMeshes = [mesh];
  root.updateMatrixWorld(true);
  v.camera.position.set(8, 0, -1); v.camera.lookAt(2, 0, -1); v.setRayFromEvent(center);
  const hit = v.intersectCollision();
  assert.ok(hit.point.distanceTo(new THREE.Vector3(2, 0, -1)) < 1e-9);
  const points = [[0, 0, 0], [0, 1.5, 0]].map(p => mesh.localToWorld(new THREE.Vector3(...p)).toArray());
  assert.equal(measurementLength({ points }), 3);
  v.tool = 'measure'; v.pick(center);
  assert.ok(new THREE.Vector3(...v.events.at(-1).point).distanceTo(hit.point) < 1e-9);
  assert.ok(new THREE.Vector3(...v.events.at(-1).graphPoint).length() < 1e-9);
});

test('nearest scan surface wins and the displayed layer breaks a near tie', () => {
  const v = engine();
  const hit = distance => ({ distance, point: new THREE.Vector3(0, 0, -distance) });
  v.intersectCollision = () => hit(10); v.intersectSplat = () => hit(3);
  assert.equal(v.intersectScene().surface, 'splat');
  v.intersectCollision = () => hit(2);
  assert.equal(v.intersectScene().surface, 'mesh');
  v.intersectCollision = () => hit(3.1);
  v.meshGroup.visible = false; assert.equal(v.intersectScene().surface, 'splat');
  v.meshGroup.visible = true; assert.equal(v.intersectScene().surface, 'mesh');
});

test('raycasting updates camera matrices before picking and respects clipping planes', () => {
  const v = engine();
  v.camera.position.set(2, 3, 4); v.setRayFromEvent(center);
  assert.deepEqual(v.raycaster.ray.origin.toArray(), [2, 3, 4]);
  assert.equal(v.raycaster.near, .1); assert.equal(v.raycaster.far, 100);
});

test('rebuilding or clearing saved measurements preserves exactly one pending endpoint', () => {
  const v = engine();
  v.measureGroup = new THREE.Group(); v.sphereGeo = new THREE.SphereGeometry();
  v.pendingMaterial = new THREE.MeshBasicMaterial(); v.measureMaterial = new THREE.MeshBasicMaterial();
  v.previewLine = { visible: false }; v.removeLabels = () => {}; v.addLabel = () => {};
  v.setPendingPoint([1, 2, 3]); v.setPendingPoint([2, 3, 4]);
  assert.equal(v.measureGroup.children.length, 1);
  v.setMeasurements([{ points: [[0, 0, 0], [0, 3, 4]] }]);
  assert.equal(v.measureGroup.children.filter(c => c.userData.pending).length, 1);
  assert.deepEqual(v.measureGroup.children.find(c => c.userData.pending).position.toArray(), [2, 3, 4]);
  v.setPendingPoint(null);
  assert.equal(v.measureGroup.children.filter(c => c.userData.pending).length, 0);
});

test('pin labels let placement through and selection scaling anchors the pin tip', () => {
  const v = engine();
  const el = { style: {}, setAttribute() {}, firstElementChild: {}, lastElementChild: { style: {} } };
  v.tool = 'measure'; v.setPinInteraction(el); assert.equal(el.style.pointerEvents, 'none');
  v.tool = 'note'; v.setPinInteraction(el); assert.equal(el.tabIndex, -1);
  v.tool = 'navigate'; v.setPinInteraction(el); assert.equal(el.style.pointerEvents, 'auto'); assert.equal(el.tabIndex, 0);
  v.stylePin(el, true); assert.equal(el.lastElementChild.style.transformOrigin, '50% 100%');
});

test('mesh-only framing never applies alignment a second time', () => {
  const v = engine();
  const root = new THREE.Group(); root.position.set(10, 0, 4); root.scale.setScalar(2);
  v.collision = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  root.add(v.meshGroup); v.meshGroup.add(v.collision); root.updateMatrixWorld(true);
  v.localBounds = new THREE.Box3().setFromObject(v.collision);
  assert.deepEqual(v.worldBounds().min.toArray(), [8, -2, 2]);
  assert.deepEqual(v.worldBounds().max.toArray(), [12, 2, 6]);
});

test('a loaded collision mesh remains usable while the splat is missing or loading', () => {
  const v = engine(); v.collision = {}; v.layer = 'splat';
  v.mesh = { isInitialized: false, visible: true };
  v.applyLayer(); assert.equal(v.meshGroup.visible, true); assert.equal(v.mesh.visible, false);
  v.mesh.isInitialized = true;
  v.applyLayer(); assert.equal(v.meshGroup.visible, false); assert.equal(v.mesh.visible, true);
  v.layer = 'mesh'; v.applyLayer(); assert.equal(v.meshGroup.visible, true);
});
