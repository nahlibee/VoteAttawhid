'use strict';
// Tests for the browser-side logic in public/common.js that needs no DOM:
// name search, the plain-language verdict, and the suggested next round.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { computeResults } = require('../lib/results');

const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/common.js'), 'utf8'), ctx);
const { searchPeople, verdict, nextRound, runoffCandidates, allowedCandidates } = ctx;

const NAMES = ['أحمد العلوي', 'محمد بنعلي', 'فاطمة الزهراء', 'يوسف الإدريسي', 'خديجة المنصوري', 'عمر التازي', 'سعيد الفاسي', 'مريم الصقلي'];
const people = NAMES.map((name, i) => ({ id: i + 1, name, isMember: true }));
const settings = { expected: 170, present: 160 };
const ballots = (votes) => Object.entries(votes).flatMap(([id, n]) => Array.from({ length: n }, () => ({ choices: [Number(id)] })));
const run = (round, votes) => {
  const results = computeResults(round, ballots(votes), people, settings);
  return { ...round, results };
};
const texts = (r) => Array.from(verdict(r, r.results), (v) => v.text).join(' | ');
const found = (text, limit) => Array.from(searchPeople(people, text, limit), (p) => p.name);

// ---------- name search ----------
test('F01 typing the first letters finds the name', () => {
  assert.deepEqual(found('فاط'), ['فاطمة الزهراء']);
});

test('F02 search ignores hamza and other spelling variants', () => {
  assert.deepEqual(found('احم'), ['أحمد العلوي']);
  assert.deepEqual(found('الادر'), ['يوسف الإدريسي']);
});

test('F03 search matches the start of any word, in any order', () => {
  assert.deepEqual(found('العل اح'), ['أحمد العلوي']);
  assert.deepEqual(found('حمد'), []); // middle of a word does not match
});

test('F04 empty text or unknown name gives no result', () => {
  assert.deepEqual(found('   '), []);
  assert.deepEqual(found('زكرياء'), []);
});

test('F05 search respects the result limit', () => {
  assert.equal(found('ال', 3).length, 3);
});

// ---------- verdict text ----------
const PRESIDENT = { kind: 'president', mode: 'list', candidates: [1, 2, 3, 4, 5], seats: 1, threshold: 'absolute' };
const RUNOFF = { kind: 'runoff', mode: 'list', candidates: [1, 2], seats: 1, threshold: 'present' };
const BUREAU = { kind: 'bureau', mode: 'list', candidates: [1, 2, 3, 4, 5, 6, 7, 8], seats: 5, threshold: 'absolute' };
const NOMINATION = { kind: 'nomination', mode: 'open', candidates: [], seats: 5, threshold: 'none' };

test('F06 no paper entered yet', () => {
  assert.match(texts(run(PRESIDENT, {})), /لم يتم إدخال أي ورقة/);
});

test('F07 president elected in the first vote', () => {
  const t = texts(run(PRESIDENT, { 1: 90, 2: 40, 3: 30 }));
  assert.match(t, /المنتخب: أحمد العلوي/);
  assert.doesNotMatch(t, /يعاد التصويت/);
});

test('F08 no absolute majority: run-off announced between the first two', () => {
  const t = texts(run(PRESIDENT, { 1: 70, 2: 50, 3: 40 }));
  assert.match(t, /لم يحصل أي مرشح على الأغلبية المطلوبة \(86/);
  assert.match(t, /يعاد التصويت بين الأول والثاني: أحمد العلوي ، محمد بنعلي/);
});

test('F09 draw for second place: the draw is announced with the names', () => {
  const t = texts(run(PRESIDENT, { 1: 70, 2: 45, 3: 45 }));
  assert.match(t, /تعادل في المراتب الأولى بين: أحمد العلوي ، فاطمة الزهراء ، محمد بنعلي/);
});

test('F10 run-off won by majority of those present', () => {
  assert.match(texts(run(RUNOFF, { 1: 85, 2: 75 })), /المنتخب: أحمد العلوي/);
});

test('F11 tied run-off is announced as a draw with both names', () => {
  const t = texts(run(RUNOFF, { 1: 80, 2: 80 }));
  assert.match(t, /تعادل \(80 صوتا\) بين: أحمد العلوي ، محمد بنعلي/);
});

test('F12 nomination lists the retained candidates and the draw', () => {
  const t = texts(run(NOMINATION, { 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 10 }));
  assert.match(t, /المرشحون المحتفظ بهم: أحمد العلوي ، محمد بنعلي ، فاطمة الزهراء ، يوسف الإدريسي/);
  assert.match(t, /تعادل \(10 صوتا\) على 1 من المقاعد بين: خديجة المنصوري ، عمر التازي/);
});

test('F13 bureau with seats left says how many', () => {
  const t = texts(run(BUREAU, { 1: 120, 2: 110, 3: 100, 4: 90, 5: 80 }));
  assert.match(t, /الأعضاء المحتفظ بهم/);
  assert.match(t, /مقاعد لم تحسم بعد: 1/);
});

test('F14 "present" round without a present count shows a warning, no winner', () => {
  const results = computeResults(RUNOFF, ballots({ 1: 90, 2: 10 }), people, { expected: 170, present: 0 });
  const t = Array.from(verdict(RUNOFF, results), (v) => v.text).join(' | ');
  assert.match(t, /عدد الحاضرين غير محدد/);
  assert.doesNotMatch(t, /المنتخب/);
});

// ---------- suggested next round ----------
test('F15 nomination -> president vote with the five retained names', () => {
  const n = nextRound(run(NOMINATION, { 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 9 }));
  assert.equal(n.kind, 'president');
  assert.deepEqual(Array.from(n.candidates), [1, 2, 3, 4, 5]);
});

test('F16 nomination with a draw -> the tied names are proposed too', () => {
  const n = nextRound(run(NOMINATION, { 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 10 }));
  assert.deepEqual(Array.from(n.candidates), [1, 2, 3, 4, 5, 6]);
});

test('F17 president elected -> no next round', () => {
  assert.equal(nextRound(run(PRESIDENT, { 1: 90, 2: 40 })), null);
});

test('F18 president not elected -> run-off between the first two', () => {
  const n = nextRound(run(PRESIDENT, { 1: 70, 2: 50, 3: 40 }));
  assert.equal(n.kind, 'runoff');
  assert.deepEqual(Array.from(n.candidates), [1, 2]);
});

test('F19 draw for second place -> all tied names go to the run-off proposal', () => {
  const r = run(PRESIDENT, { 1: 70, 2: 45, 3: 45, 4: 5 });
  assert.deepEqual(Array.from(nextRound(r).candidates).sort(), [1, 2, 3]); // tied names are listed alphabetically
  assert.equal(runoffCandidates(r.results).length, 3);
});

test('F20 bureau complete -> no next round', () => {
  assert.equal(nextRound(run(BUREAU, { 1: 130, 2: 120, 3: 110, 4: 100, 5: 90 })), null);
});

test('F21 bureau with seats left -> re-vote on the candidates not kept', () => {
  const n = nextRound(run(BUREAU, { 1: 130, 2: 120, 3: 110, 4: 80, 5: 70, 6: 60 }));
  assert.equal(n.kind, 'bureau2');
  assert.equal(n.seats, 2);
  assert.equal(n.max, 2);
  assert.deepEqual(Array.from(n.candidates), [4, 5, 6, 7, 8]);
});

test('F22 bureau draw on the last seat -> re-vote between the tied candidates only', () => {
  const n = nextRound(run(BUREAU, { 1: 130, 2: 120, 3: 110, 4: 100, 5: 90, 6: 90, 7: 20 }));
  assert.equal(n.seats, 1);
  assert.deepEqual(Array.from(n.candidates), [5, 6]);
});

test('F23 run-off never proposes a next round by itself', () => {
  assert.equal(nextRound(run(RUNOFF, { 1: 80, 2: 80 })), null);
});

// ---------- page scripts ----------
test('F24 the script of every page is valid JavaScript', () => {
  for (const page of ['admin', 'team', 'index']) {
    const html = fs.readFileSync(path.join(__dirname, `../public/${page}.html`), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length, `${page}.html has its script`);
    for (const [, code] of scripts) assert.doesNotThrow(() => new vm.Script(code, { filename: `${page}.html` }), `${page}.html`);
  }
});

test('F25 bureau rounds keep members, they do not elect them', () => {
  const t = texts(run({ kind: 'bureau2', mode: 'list', candidates: [1, 2], seats: 1, threshold: 'present' }, { 1: 90, 2: 10 }));
  assert.match(t, /المحتفظ به: أحمد العلوي/);
  assert.doesNotMatch(t, /المنتخب|الفائز/);
});

test('F26 elements marked hidden stay hidden whatever their display style', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('F27 president candidates come from the latest nomination, run-off from the latest president vote', () => {
  const nom = { id: 1, kind: 'nomination', title: 'الترشيح', ...run(NOMINATION, { 1: 50, 2: 40, 3: 30, 4: 20, 5: 10, 6: 10, 7: 1 }) };
  const pres = { id: 2, kind: 'president', title: 'التصويت', candidates: [1, 2, 3] };
  const p = allowedCandidates([nom, pres], 'president');
  assert.deepEqual(Array.from(p.ids).sort(), [1, 2, 3, 4, 5, 6], 'retained + tied, not 7');
  assert.equal(p.title, 'الترشيح');
  assert.deepEqual(Array.from(allowedCandidates([nom, pres], 'runoff').ids), [1, 2, 3]);
  assert.equal(allowedCandidates([nom, pres], 'bureau'), null, 'bureau is free');
  assert.equal(allowedCandidates([], 'president'), null, 'no nomination yet: free');
  assert.equal(allowedCandidates([pres], 'runoff', 2), null, 'a round is not its own source');
});
