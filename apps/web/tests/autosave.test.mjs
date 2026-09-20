import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutosaveQueue } from '../src/lib/autosave.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('slow saves serialize and coalesce edits; Saved waits for the newest snapshot', async () => {
  const writes = [], requests = [];
  const queue = new AutosaveQueue('[]', body => {
    writes.push(body);
    const request = deferred(); requests.push(request);
    return request.promise;
  });
  queue.update('[1]');
  const flushed = queue.flush();
  queue.update('[1,2]');
  queue.update('[1,2,3]');
  assert.deepEqual(writes, ['[1]']);
  assert.equal(queue.getSnapshot().status, 'saving');
  requests[0].resolve(); await tick();
  assert.deepEqual(writes, ['[1]', '[1,2,3]']);
  assert.equal(queue.getSnapshot().status, 'saving');
  requests[1].resolve(); await flushed;
  assert.equal(queue.getSnapshot().status, 'saved');
});

test('undo during a pending save writes the original value back afterwards', async () => {
  const first = deferred(), writes = [];
  const queue = new AutosaveQueue('[]', async body => {
    writes.push(body);
    if (writes.length === 1) await first.promise;
  });
  queue.update('[1]'); const flushed = queue.flush();
  queue.update('[]'); first.resolve(); await flushed;
  assert.deepEqual(writes, ['[1]', '[]']);
});

test('failed writes remain retryable and retry uses the newest edits', async () => {
  const writes = [];
  const queue = new AutosaveQueue('[]', async body => {
    writes.push(body);
    if (writes.length === 1) throw new Error('Offline');
  });
  queue.update('[1]');
  await assert.rejects(queue.flush(), /Offline/);
  assert.deepEqual(queue.getSnapshot(), { status: 'error', error: 'Offline' });
  queue.update('[2]'); await queue.flush();
  assert.deepEqual(writes, ['[1]', '[2]']);
  assert.equal(queue.getSnapshot().status, 'saved');
});

test('unchanged content does not save; flushing bypasses the debounce', async () => {
  const writes = [];
  const queue = new AutosaveQueue('[]', async body => { writes.push(body); });
  queue.update('[]'); await queue.flush(); assert.deepEqual(writes, []);
  queue.update('[1]'); queue.update('[2]'); await queue.flush();
  assert.deepEqual(writes, ['[2]']);
});

test('debounced autosave runs without an explicit flush', async () => {
  const saved = deferred();
  const queue = new AutosaveQueue('[]', async body => { saved.resolve(body); }, 5);
  queue.update('[1]'); queue.update('[2]');
  assert.equal(await saved.promise, '[2]');
  await queue.flush();
  assert.equal(queue.getSnapshot().status, 'saved');
});
