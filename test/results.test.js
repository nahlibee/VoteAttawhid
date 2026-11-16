'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeResults, majority, norm } = require('../lib/results');

const people = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: 'P' + (i + 1), isMember: true }));
const settings = { expected: 170, present: 160 };
// votes: {personId: count} -> one single-choice ballot per vote
const ballots = (votes) => Object.entries(votes).flatMap(([id, n]) => Array.from({ length: n }, () => ({ choices: [Number(id)] })));
const status = (res) => Object.fromEntries(res.rows.map((r) => [r.id, r.status]));

test('majority is half rounded down plus one', () => {
  assert.equal(majority(170), 86);
  assert.equal(majority(171), 86);
  assert.equal(majority(160), 81);
});

test('names match regardless of hamza, ta marbuta and diacritics', () => {
  assert.equal(norm('أحمد  فاطمة'), norm('احمد فاطمه'));
  assert.equal(norm('مُحَمَّد'), norm('محمد'));
});

test('nomination keeps the top five members and ignores non-members', () => {
  const ppl = people.map((p) => (p.id === 1 ? { ...p, isMember: false } : p));
  const round = { mode: 'open', candidates: [], seats: 5, threshold: 'none' };
  const res = computeResults(round, ballots({ 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 9, 7: 8 }), ppl, settings);
  const s = status(res);
  assert.equal(s[1], 'nonmember');
  assert.deepEqual([2, 3, 4, 5, 6].map((i) => s[i]), Array(5).fill('elected'));
  assert.equal(s[7], 'below');
  // Once the supervisor marks the person as a member, the same votes count.
  const res2 = computeResults(round, ballots({ 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 9, 7: 8 }), people, settings);
  assert.equal(status(res2)[1], 'elected');
  assert.equal(status(res2)[6], 'below');
});

test('nomination reports a draw for the last places', () => {
  const round = { mode: 'open', candidates: [], seats: 5, threshold: 'none' };
  const res = computeResults(round, ballots({ 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 10, 7: 8 }), people, settings);
  const s = status(res);
  assert.deepEqual([s[5], s[6]], ['tied', 'tied']);
  assert.equal(s[4], 'elected');
  assert.equal(res.seatsLeft, 1);
});

test('president needs the absolute majority of expected members', () => {
  const round = { mode: 'list', candidates: [1, 2, 3], seats: 1, threshold: 'absolute' };
  assert.equal(status(computeResults(round, ballots({ 1: 86, 2: 50, 3: 20 }), people, settings))[1], 'elected');
  const res = computeResults(round, ballots({ 1: 85, 2: 50, 3: 20 }), people, settings);
  assert.equal(status(res)[1], 'below');
  assert.equal(res.seatsLeft, 1);
  assert.equal(res.threshold, 86);
});

test('run-off uses the majority of those present, void ballots do not lower it', () => {
  const round = { mode: 'list', candidates: [1, 2], seats: 1, threshold: 'present', void: 10 };
  const res = computeResults(round, ballots({ 1: 80, 2: 70 }), people, settings);
  assert.equal(res.threshold, 81);
  assert.equal(status(res)[1], 'below');
  assert.equal(res.total, 160);
  assert.equal(status(computeResults(round, ballots({ 1: 81, 2: 69 }), people, settings))[1], 'elected');
});

test('bureau keeps only those above the majority, up to the seats', () => {
  const round = { mode: 'list', candidates: [1, 2, 3, 4, 5, 6, 7, 8], seats: 5, threshold: 'absolute' };
  const res = computeResults(round, ballots({ 1: 120, 2: 110, 3: 100, 4: 90, 5: 85, 6: 60 }), people, settings);
  const s = status(res);
  assert.deepEqual([1, 2, 3, 4].map((i) => s[i]), Array(4).fill('elected'));
  assert.equal(s[5], 'below');
  assert.equal(s[8], 'below');
  assert.equal(res.seatsLeft, 1);
});

test('bureau draw on the fifth seat among candidates above the majority', () => {
  const round = { mode: 'list', candidates: [1, 2, 3, 4, 5, 6, 7], seats: 5, threshold: 'absolute' };
  const res = computeResults(round, ballots({ 1: 120, 2: 110, 3: 100, 4: 95, 5: 90, 6: 90, 7: 88 }), people, settings);
  const s = status(res);
  assert.deepEqual([s[5], s[6]], ['tied', 'tied']);
  assert.equal(s[7], 'below');
  assert.equal(res.seatsLeft, 1);
});
