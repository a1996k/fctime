import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, roundUp, weekStart, fromHM, rangesOverlap, isISODate } from '../public/js/shared/time.js';

test('parseDuration accepts 1:30, 1.5, 1.5h, 90m and rejects junk', () => {
  assert.equal(parseDuration('1:30'), 90);
  assert.equal(parseDuration('1.5'), 90);
  assert.equal(parseDuration('1.5h'), 90);
  assert.equal(parseDuration('.25'), 15);
  assert.equal(parseDuration('90m'), 90);
  assert.equal(parseDuration('45 min'), 45);
  assert.equal(parseDuration('0:07'), 7);
  for (const bad of ['', 'abc', '1:75', '-1', '1,5']) assert.equal(parseDuration(bad), null, bad);
});
test('roundUp follows the wireframe: none, 6 or 15 minutes, always up', () => {
  assert.equal(roundUp(47, 0), 47);
  assert.equal(roundUp(47, 6), 48);
  assert.equal(roundUp(47, 15), 60);
  assert.equal(roundUp(45, 15), 45);
  assert.equal(roundUp(1, 15), 15);
});
test('weeks start on Monday', () => {
  assert.equal(weekStart('2026-11-18'), '2026-11-16');
  assert.equal(weekStart('2026-11-22'), '2026-11-16');
  assert.equal(weekStart('2026-11-16'), '2026-11-16');
});
test('time and date helpers', () => {
  assert.equal(fromHM('09:30'), 570);
  assert.equal(fromHM('25:00'), null);
  assert.ok(rangesOverlap(540, 600, 570, 630));
  assert.ok(!rangesOverlap(540, 600, 600, 660), 'touching ranges do not overlap');
  assert.ok(isISODate('2026-02-28'));
  assert.ok(!isISODate('2026-02-30'));
});
