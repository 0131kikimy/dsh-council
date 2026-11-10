import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';
import { BoardStore } from '../lib/board.js';
import { dispatchBrief, verifyBrief, clip } from '../lib/briefs.js';

const ok = resolveConfig({});
assert.equal(ok.issues.length, 0, ok.issues.join());
assert.equal(ok.config.executorName, 'executor');
assert.equal(ok.config.maxRounds, 2);

const bad = resolveConfig({ executorName: 'AB', verifierName: 'AB', maxRounds: 0, boardFile: '../x' });
assert.ok(bad.issues.length >= 3, JSON.stringify(bad.issues));

const store = new BoardStore('.', '.council/test-board.json', false);
assert.equal(store.read().round, 0);
await store.update((b) => { b.round = 1; b.phase = 'open'; });
assert.equal(store.read().round, 1);
// 串行性：两个并发更新都要落到最终状态
await Promise.all([
  store.update((b) => { b.criteria = ['a']; }),
  store.update((b) => { b.criteria.push('b'); }),
]);
assert.deepEqual(store.read().criteria, ['a', 'b']);

const d = dispatchBrief({ round: 1, task: 'T', criteria: ['c1', 'c2'], files: ['src/a.js'] });
assert.ok(d.includes('1. c1') && d.includes('src/a.js'));
const v = verifyBrief({ round: 1, task: 'T', criteria: ['c1'], report: '', files: [] });
assert.ok(v.includes('没有证据'), v);
assert.ok(clip('x'.repeat(100), 40).length <= 40 + 20);

console.log('ALL LOCAL TESTS PASSED');
