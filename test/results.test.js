'use strict';
// Unit tests for the counting rules (lib/results.js). IDs match docs/TEST_PLAN.md.
const test = require('node:test');
const assert = require('node:assert');
const { computeResults, majority, norm } = require('../lib/results');

const people = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: 'P' + (i + 1), isMember: true }));
const settings = { expected: 170, present: 160 };
// votes: {personId: count} -> one single-choice ballot per vote
const ballots = (votes) => Object.entries(votes).flatMap(([id, n]) => Array.from({ length: n }, () => ({ choices: [Number(id)] })));
const status = (res) => Object.fromEntries(res.rows.map((r) => [r.id, r.status]));
const NOMINATION = { mode: 'open', candidates: [], seats: 5, threshold: 'none' };

// ---------- majority ----------
test('U01 majority is half rounded down plus one', () => {
  assert.equal(majority(170), 86);
  assert.equal(majority(171), 86);
  assert.equal(majority(160), 81);
  assert.equal(majority(161), 81);
});

test('U02 majority at the small limits', () => {
  assert.equal(majority(1), 1);
  assert.equal(majority(2), 2);
  assert.equal(majority(3), 2);
});

// ---------- name matching ----------
test('U03 names match regardless of hamza, ta marbuta and diacritics', () => {
  assert.equal(norm('أحمد  فاطمة'), norm('احمد فاطمه'));
  assert.equal(norm('مُحَمَّد'), norm('محمد'));
  assert.equal(norm('إبراهيم'), norm('ابراهيم'));
  assert.equal(norm('مصطفى'), norm('مصطفي'));
  assert.equal(norm('  Ali   BEN  '), 'ali ben');
});

test('U04 different names stay different', () => {
  assert.notEqual(norm('أحمد العلوي'), norm('أحمد العلمي'));
});

// ---------- nomination (top five, no majority) ----------
test('U05 nomination keeps the top five members', () => {
  const res = computeResults(NOMINATION, ballots({ 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 9, 7: 8 }), people, settings);
  const s = status(res);
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => s[i]), Array(5).fill('elected'));
  assert.deepEqual([s[6], s[7]], ['below', 'below']);
  assert.equal(res.seatsLeft, 0);
  assert.equal(res.threshold, null);
});

test('U06 nomination ignores non-members, then counts them once they are members', () => {
  const votes = { 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 9, 7: 8 };
  const withOutsider = people.map((p) => (p.id === 1 ? { ...p, isMember: false } : p));
  const s = status(computeResults(NOMINATION, ballots(votes), withOutsider, settings));
  assert.equal(s[1], 'nonmember');
  assert.deepEqual([2, 3, 4, 5, 6].map((i) => s[i]), Array(5).fill('elected'));
  assert.equal(s[7], 'below');
  const s2 = status(computeResults(NOMINATION, ballots(votes), people, settings));
  assert.equal(s2[1], 'elected');
  assert.equal(s2[6], 'below');
});

test('U07 nomination reports a draw for the fifth place', () => {
  const res = computeResults(NOMINATION, ballots({ 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 10, 7: 8 }), people, settings);
  const s = status(res);
  assert.deepEqual([s[5], s[6]], ['tied', 'tied']);
  assert.equal(s[4], 'elected');
  assert.equal(s[7], 'below');
  assert.equal(res.seatsLeft, 1);
});

test('U08 nomination draw of three names for the last two places', () => {
  const res = computeResults(NOMINATION, ballots({ 1: 50, 2: 40, 3: 30, 4: 10, 5: 10, 6: 10 }), people, settings);
  const s = status(res);
  assert.deepEqual([s[4], s[5], s[6]], ['tied', 'tied', 'tied']);
  assert.equal(res.seatsLeft, 2);
});

test('U09 nomination with fewer than five names keeps them all', () => {
  const res = computeResults(NOMINATION, ballots({ 1: 5, 2: 4, 3: 3 }), people, settings);
  assert.deepEqual(Object.values(status(res)), ['elected', 'elected', 'elected']);
  assert.equal(res.seatsLeft, 2);
});

test('U10 nomination where every name has the same votes is a full draw', () => {
  const res = computeResults(NOMINATION, ballots({ 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3 }), people, settings);
  assert.ok(res.rows.every((r) => r.status === 'tied'));
  assert.equal(res.seatsLeft, 5);
});

test('U11 a multi-name paper gives one vote to each name', () => {
  const res = computeResults(NOMINATION, [{ choices: [1, 2, 3] }, { choices: [1, 2] }, { choices: [1] }], people, settings);
  assert.deepEqual(res.rows.map((r) => [r.id, r.votes]), [[1, 3], [2, 2], [3, 1]]);
  assert.equal(res.valid, 3);
});

// ---------- president (absolute majority) ----------
test('U12 president wins with exactly the absolute majority', () => {
  const round = { mode: 'list', candidates: [1, 2, 3], seats: 1, threshold: 'absolute' };
  const res = computeResults(round, ballots({ 1: 86, 2: 50, 3: 20 }), people, settings);
  assert.equal(status(res)[1], 'elected');
  assert.equal(res.threshold, 86);
  assert.equal(res.seatsLeft, 0);
});

test('U13 president one vote short of the absolute majority does not win', () => {
  const round = { mode: 'list', candidates: [1, 2, 3], seats: 1, threshold: 'absolute' };
  const res = computeResults(round, ballots({ 1: 85, 2: 50, 3: 20 }), people, settings);
  assert.ok(res.rows.every((r) => r.status === 'below'));
  assert.equal(res.seatsLeft, 1);
});

test('U14 absolute majority uses the expected count, not the present count', () => {
  const round = { mode: 'list', candidates: [1, 2], seats: 1, threshold: 'absolute' };
  // 82 is above the majority of 160 present (81) but below the majority of 170 expected (86).
  const res = computeResults(round, ballots({ 1: 82, 2: 60 }), people, settings);
  assert.equal(status(res)[1], 'below');
});

test('U15 a candidate with no vote is listed with zero', () => {
  const round = { mode: 'list', candidates: [1, 2, 3], seats: 1, threshold: 'absolute' };
  const res = computeResults(round, ballots({ 1: 100 }), people, settings);
  assert.deepEqual(res.rows.map((r) => r.votes), [100, 0, 0]);
});

test('U16 a round with no paper elects nobody', () => {
  const round = { mode: 'list', candidates: [1, 2], seats: 1, threshold: 'none' };
  const res = computeResults(round, [], people, settings);
  assert.ok(res.rows.every((r) => r.status === 'below'));
  assert.equal(res.valid, 0);
  assert.equal(res.seatsLeft, 1);
});

// ---------- run-off (majority of those present) ----------
test('U17 run-off uses the majority of those present', () => {
  const round = { mode: 'list', candidates: [1, 2], seats: 1, threshold: 'present' };
  const res = computeResults(round, ballots({ 1: 81, 2: 79 }), people, settings);
  assert.equal(res.threshold, 81);
  assert.equal(status(res)[1], 'elected');
});

test('U18 cancelled papers do not lower the majority of those present', () => {
  const round = { mode: 'list', candidates: [1, 2], seats: 1, threshold: 'present', void: 10 };
  const res = computeResults(round, ballots({ 1: 80, 2: 70 }), people, settings);
  assert.equal(res.threshold, 81);
  assert.equal(status(res)[1], 'below');
  assert.deepEqual([res.valid, res.void, res.total], [150, 10, 160]);
});

test('U19 a tied run-off elects nobody', () => {
  const round = { mode: 'list', candidates: [1, 2], seats: 1, threshold: 'present' };
  const res = computeResults(round, ballots({ 1: 80, 2: 80 }), people, settings);
  assert.ok(res.rows.every((r) => r.status === 'below'));
  assert.equal(res.seatsLeft, 1);
});

test('U20 without a present count, nobody can win a "present" round', () => {
  const round = { mode: 'list', candidates: [1, 2], seats: 1, threshold: 'present' };
  const res = computeResults(round, ballots({ 1: 100, 2: 5 }), people, { expected: 170, present: 0 });
  assert.equal(res.thresholdMissing, true);
  assert.equal(res.threshold, null);
  assert.ok(res.rows.every((r) => r.status === 'below'));
});

// ---------- bureau (five seats, absolute majority) ----------
const BUREAU = { mode: 'list', candidates: [1, 2, 3, 4, 5, 6, 7, 8], seats: 5, threshold: 'absolute' };

test('U21 bureau: five candidates above the majority take the five seats', () => {
  const res = computeResults(BUREAU, ballots({ 1: 130, 2: 120, 3: 110, 4: 100, 5: 90, 6: 60, 7: 40 }), people, settings);
  const s = status(res);
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => s[i]), Array(5).fill('elected'));
  assert.equal(res.seatsLeft, 0);
});

test('U22 bureau: more than five above the majority, only the first five are kept', () => {
  const res = computeResults(BUREAU, ballots({ 1: 130, 2: 120, 3: 110, 4: 100, 5: 95, 6: 90, 7: 88 }), people, settings);
  const s = status(res);
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => s[i]), Array(5).fill('elected'));
  assert.deepEqual([s[6], s[7]], ['below', 'below']);
});

test('U23 bureau: only those above the majority are kept, seats remain', () => {
  const res = computeResults(BUREAU, ballots({ 1: 120, 2: 110, 3: 100, 4: 90, 5: 85, 6: 60 }), people, settings);
  const s = status(res);
  assert.deepEqual([1, 2, 3, 4].map((i) => s[i]), Array(4).fill('elected'));
  assert.deepEqual([s[5], s[6], s[8]], ['below', 'below', 'below']);
  assert.equal(res.seatsLeft, 1);
});

test('U24 bureau: draw for the fifth seat among candidates above the majority', () => {
  const res = computeResults(BUREAU, ballots({ 1: 120, 2: 110, 3: 100, 4: 95, 5: 90, 6: 90, 7: 88 }), people, settings);
  const s = status(res);
  assert.deepEqual([s[5], s[6]], ['tied', 'tied']);
  assert.equal(s[7], 'below');
  assert.equal(res.seatsLeft, 1);
});

test('U25 bureau: a draw below the majority is not a draw for a seat', () => {
  const res = computeResults(BUREAU, ballots({ 1: 120, 2: 110, 3: 100, 4: 95, 5: 80, 6: 80 }), people, settings);
  const s = status(res);
  assert.deepEqual([s[5], s[6]], ['below', 'below']);
  assert.equal(res.seatsLeft, 1);
});

test('U26 bureau: nobody reaches the majority', () => {
  const res = computeResults(BUREAU, ballots({ 1: 85, 2: 80, 3: 70 }), people, settings);
  assert.ok(res.rows.every((r) => r.status === 'below'));
  assert.equal(res.seatsLeft, 5);
});

test('U27 bureau re-vote: remaining seats by majority of those present', () => {
  const round = { mode: 'list', candidates: [5, 6, 7], seats: 2, threshold: 'present' };
  const res = computeResults(round, ballots({ 5: 100, 6: 81, 7: 80 }), people, settings);
  const s = status(res);
  assert.deepEqual([s[5], s[6], s[7]], ['elected', 'elected', 'below']);
  assert.equal(res.seatsLeft, 0);
});

// ---------- robustness ----------
test('U28 rows are sorted by votes, highest first', () => {
  const res = computeResults(NOMINATION, ballots({ 3: 1, 1: 7, 2: 4 }), people, settings);
  assert.deepEqual(res.rows.map((r) => r.id), [1, 2, 3]);
});

test('U29 a vote for an unknown id is shown as a non-member and never kept', () => {
  const res = computeResults(NOMINATION, [{ choices: [999] }], people, settings);
  assert.equal(res.rows[0].status, 'nonmember');
});

test('U30 totals add valid and cancelled papers', () => {
  const round = { ...NOMINATION, void: 4 };
  const res = computeResults(round, ballots({ 1: 6 }), people, settings);
  assert.deepEqual([res.valid, res.void, res.total, res.expected, res.present], [6, 4, 10, 170, 160]);
});

test('U31 a name waiting for the supervisor is flagged and not kept', () => {
  const ppl = people.map((p) => (p.id === 1 ? { ...p, isMember: false, pending: true } : p));
  const res = computeResults(NOMINATION, ballots({ 1: 50, 2: 40 }), ppl, settings);
  assert.deepEqual([res.rows[0].status, res.rows[0].pending, res.rows[1].pending], ['nonmember', true, false]);
});

test('U32 cancelled papers give no vote and add to the cancelled total', () => {
  const round = { ...NOMINATION, void: 2 };
  const res = computeResults(round, [...ballots({ 1: 3 }), { choices: [], cancelled: true }, { choices: [], cancelled: true }], people, settings);
  assert.deepEqual([res.valid, res.voidTeams, res.voidManual, res.void, res.total], [3, 2, 2, 4, 7]);
  assert.deepEqual(res.rows.map((r) => [r.id, r.votes]), [[1, 3]]);
});
