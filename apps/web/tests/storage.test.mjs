import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMeasurements, validateNotes } from '../src/lib/world-manifest.ts';

const root = await mkdtemp(join(tmpdir(), 'wander-storage-test-'));
process.env.WANDER_API_URL = '';
process.env.WANDER_ASSETS_DIR = root;
const { getNotes, getMeasurements, saveNotes, saveMeasurements } = await import('../src/lib/worlds-api.server.ts');
const dir = join(root, 'worlds', 'check');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'world.json'), JSON.stringify({
  schema: 'wander.world/v1', id: 'check', name: 'Check', version: 'v1', nianticSiteId: null,
  assets: { splat: 'worlds/check/v1/scene.splat' },
}));
const note = { id: 'pin', title: 'Door', position: [1, 2, 3], createdAt: '2026-09-20T00:00:00Z' };
const measure = { id: 'width', points: [[1, 2, 3], [4, 2, 3]] };

test('missing files are empty, malformed existing files stop editing, and valid files round-trip', async () => {
  try {
    assert.deepEqual(await getNotes('check'), []);
    assert.deepEqual(await getMeasurements('check'), []);
    for (const [name, read] of [['notes', getNotes], ['measurements', getMeasurements]]) {
      for (const corrupt of ['{', '{}', JSON.stringify({ [name]: [{}] })]) {
        await writeFile(join(dir, `${name}.json`), corrupt);
        await assert.rejects(read('check'));
      }
    }
    await saveNotes('check', [note]); await saveMeasurements('check', [measure]);
    assert.deepEqual(await getNotes('check'), [note]);
    assert.deepEqual(await getMeasurements('check'), [measure]);
    await saveNotes('check', [{ ...note, title: 'Edited' }]);
    assert.equal(JSON.parse(await readFile(join(dir, 'notes.json'), 'utf8')).notes[0].title, 'Edited');
    assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('duplicate pin and measurement IDs cannot make selection or deletion ambiguous', () => {
  assert.match(validateNotes([note, note]).join(), /duplicate id/);
  assert.match(validateMeasurements([measure, measure]).join(), /duplicate id/);
  assert.deepEqual(validateMeasurements([measure]), []);
});
