'use strict';
// End-to-end tests of the server over HTTP. Each suite starts its own server on a
// spare port with an empty temporary data folder, so real data is never touched.
// IDs match docs/TEST_PLAN.md.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

const ROOT = path.join(__dirname, '..');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(dataDir, certDir, extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // Tests try many wrong codes on purpose: the limit has its own test (A43).
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, CERT_DIR: certDir || path.join(dataDir, 'no-certs'), LOGIN_MAX_TRIES: '100000', MDNS: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + log)), 8000);
    const onData = (d) => { log += d; if (log.includes('Public results')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => reject(new Error('server exited: ' + log)));
  });
  const stop = () => new Promise((resolve) => { child.removeAllListeners('exit'); child.on('exit', resolve); child.kill(); });
  return { port, stop, alive: () => child.exitCode === null, log: () => log };
}

// Raw request, so odd paths and both protocols can be tested.
function raw(port, { method = 'GET', path: p = '/', body, token, secure = false, from }) {
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      host: '127.0.0.1', port, method, path: p, rejectUnauthorized: false, ...(from ? { localAddress: from } : {}),
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, data, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vote-test-'));
const NAMES = ['أحمد العلوي', 'محمد بنعلي', 'فاطمة الزهراء', 'يوسف الإدريسي', 'خديجة المنصوري', 'عمر التازي', 'سعيد الفاسي', 'مريم الصقلي'];

describe('API', () => {
  let srv, dir, sup, team1, team2;
  const api = (method, p, body, token) => raw(srv.port, { method, path: '/api' + p, body, token });
  const state = async () => (await api('GET', '/admin/state', undefined, sup)).data;
  const roundOf = async (id) => (await state()).rounds.find((r) => r.id === id);
  const idOf = async (name) => (await state()).people.find((p) => p.name === name).id;
  const statusOf = (round, name) => round.results.rows.find((r) => r.name === name)?.status;

  before(async () => { dir = tmp(); srv = await startServer(dir); });
  after(async () => { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  // ---------- first setup and login ----------
  test('A01 before setup: nothing is accessible', async () => {
    assert.deepEqual((await api('GET', '/public')).data, { ready: false, rounds: [] });
    assert.equal((await api('POST', '/login', { role: 'supervisor', code: 'x' })).status, 400);
    assert.equal((await api('GET', '/admin/state')).status, 401);
  });

  test('A02 setup refuses codes that are too short', async () => {
    assert.equal((await api('POST', '/setup', { supervisorCode: 'abc' })).status, 400);
    assert.equal((await api('POST', '/setup', {})).status, 400);
  });

  test('A03 setup works once only', async () => {
    assert.equal((await api('POST', '/setup', { supervisorCode: 'super1' })).status, 200);
    assert.equal((await api('POST', '/setup', { supervisorCode: 'hacker1' })).status, 400);
    assert.equal((await api('GET', '/public')).data.ready, true);
  });

  test('A04 supervisor login: wrong code refused, right code accepted', async () => {
    assert.equal((await api('POST', '/login', { role: 'supervisor', code: 'wrong' })).status, 401);
    assert.equal((await api('POST', '/login', { role: 'supervisor', code: 'team1' })).status, 401);
    const r = await api('POST', '/login', { role: 'supervisor', code: 'super1' });
    assert.equal(r.status, 200);
    sup = r.data.token;
    assert.equal(r.data.role, 'supervisor');
  });

  const teamLogin = (code, extra) => api('POST', '/login', { role: 'team', code, ...extra });
  const newTeam = async () => (await api('POST', '/teams', undefined, sup)).data;
  let code1;

  test('A05 team login: only a code created by the supervisor works', async () => {
    for (const code of ['nope', '', 'super1', '0000000000']) assert.equal((await teamLogin(code)).status, 401, code);
    assert.equal((await teamLogin(undefined)).status, 401);
    assert.equal((await state()).teams.length, 0, 'refused logins create no team');
    const t1 = await newTeam();
    const t2 = await newTeam();
    assert.deepEqual([t1.name, t2.name], ['الفريق 1', 'الفريق 2']);
    assert.match(t1.code, /^\d{5}$/);
    assert.notEqual(t1.code, t2.code);
    code1 = t1.code;
    const a = (await teamLogin(t1.code)).data;
    const b = (await teamLogin(t2.code)).data;
    team1 = a.token;
    team2 = b.token;
    assert.deepEqual([a.team, b.team], ['الفريق 1', 'الفريق 2']);
  });

  test('A05b one device per team: a second device is refused until the first logs out', async () => {
    assert.equal((await teamLogin(code1)).status, 409);
    assert.equal((await api('GET', '/team/state', undefined, team1)).status, 200, 'the first device keeps working');
    const t3 = await newTeam();
    assert.equal((await state()).teams.find((t) => t.name === t3.name).inUse, false);
    // Typed with a space and in Arabic digits; a team name sent by the browser is ignored.
    const arabic = t3.code.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
    const first = (await teamLogin(`${arabic.slice(0, 2)} ${arabic.slice(2)}`, { team: 'الفريق 1' })).data;
    assert.equal(first.team, 'الفريق 3');
    assert.equal((await state()).teams.find((t) => t.name === t3.name).inUse, true);
    assert.equal((await teamLogin(t3.code)).status, 409);
    assert.equal((await api('POST', '/logout')).status, 401, 'logout needs a login');
    assert.equal((await api('POST', '/logout', undefined, first.token)).status, 200);
    assert.equal((await api('GET', '/team/state', undefined, first.token)).status, 401);
    assert.equal((await api('GET', '/team/state', undefined, team1)).status, 200, 'other teams stay logged in');
    assert.equal((await teamLogin(t3.code)).data.team, 'الفريق 3', 'free again after logout');
    assert.deepEqual((await state()).teams.map((t) => [t.name, t.ballots, t.cancelled]), [['الفريق 1', 0, 0], ['الفريق 2', 0, 0], ['الفريق 3', 0, 0]]);
  });

  test('A05c a new code stops the old one and logs the team out; deleting a team does too', async () => {
    const t = await newTeam();
    const first = (await teamLogin(t.code)).data.token;
    const renewed = (await api('POST', `/teams/${t.id}/code`, undefined, sup)).data;
    assert.notEqual(renewed.code, t.code);
    assert.equal((await teamLogin(t.code)).status, 401, 'old code');
    assert.equal((await api('GET', '/team/state', undefined, first)).status, 401, 'old login');
    const second = (await teamLogin(renewed.code)).data;
    assert.equal(second.team, t.name);
    assert.equal((await api('GET', '/team/state', undefined, team1)).status, 200, 'other teams are not affected');
    assert.equal((await api('DELETE', `/teams/${t.id}`, undefined, sup)).status, 200);
    assert.equal((await api('GET', '/team/state', undefined, second.token)).status, 401);
    assert.equal((await teamLogin(renewed.code)).status, 401);
    assert.equal((await api('DELETE', '/teams/9999', undefined, sup)).status, 404);
  });

  test('A06 a team cannot use supervisor functions', async () => {
    const calls = [
      ['GET', '/admin/state'], ['PUT', '/settings', { expected: 5 }], ['POST', '/people/import', { text: 'x y z' }],
      ['POST', '/rounds', { title: 't', mode: 'open', min: 1, max: 1, seats: 1 }], ['PATCH', '/rounds/1', { published: true }],
      ['DELETE', '/rounds/1'], ['PATCH', '/people/1', { isMember: true }], ['DELETE', '/people/1'],
      ['POST', '/people/merge', { from: 1, to: 2 }], ['GET', '/rounds/1/ballots'],
      ['POST', '/teams'], ['POST', '/teams/1/code'], ['DELETE', '/teams/1'], ['PATCH', '/ballots/1', {}], ['GET', '/history'],
    ];
    for (const [m, p, b] of calls) assert.equal((await api(m, p, b, team1)).status, 401, `${m} ${p}`);
  });

  test('A07 without login, entry functions are refused', async () => {
    assert.equal((await api('GET', '/team/state')).status, 401);
    assert.equal((await api('POST', '/ballots', { roundId: 1, choices: [1] })).status, 401);
    assert.equal((await api('POST', '/people', { name: 'شخص ما' })).status, 401);
    assert.equal((await api('GET', '/team/state', undefined, 'not-a-real-token')).status, 401);
  });

  test('A07b tokens named after built-in properties are refused', async () => {
    for (const token of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal((await api('GET', '/team/state', undefined, token)).status, 401, token);
      assert.equal((await api('POST', '/ballots', { roundId: 1, choices: [1] }, token)).status, 401, token);
      assert.equal((await api('POST', '/people', { name: 'شخص ما' }, token)).status, 401, token);
      assert.equal((await api('DELETE', '/ballots/1', undefined, token)).status, 401, token);
    }
  });

  // ---------- settings ----------
  test('A08 settings: invalid numbers refused', async () => {
    for (const body of [{ expected: 0 }, { expected: -3 }, { expected: 1.5 }, { expected: 'abc' }, { present: -1 }]) {
      assert.equal((await api('PUT', '/settings', body, sup)).status, 400, JSON.stringify(body));
    }
  });

  test('A09 settings: majorities follow the counts (170 -> 86, 160 -> 81)', async () => {
    assert.equal((await api('PUT', '/settings', { expected: 170, present: 160 }, sup)).status, 200);
    const s = (await state()).settings;
    assert.deepEqual([s.expected, s.absolute, s.present, s.presentMajority], [170, 86, 160, 81]);
  });

  test('A10 settings: the supervisor code can be changed, a short one refused', async () => {
    assert.equal((await api('PUT', '/settings', { supervisorCode: 'abc' }, sup)).status, 400);
    assert.equal((await api('PUT', '/settings', { supervisorCode: 'super2' }, sup)).status, 200);
    assert.equal((await api('POST', '/login', { role: 'supervisor', code: 'super1' })).status, 401);
    assert.equal((await api('POST', '/login', { role: 'supervisor', code: 'super2' })).status, 200);
    assert.equal((await api('GET', '/team/state', undefined, team1)).status, 200, 'teams already logged in stay logged in');
  });

  // ---------- member list ----------
  test('A11 import: blank lines, extra columns and duplicates are handled', async () => {
    const text = [NAMES[0], '', NAMES[1] + '\tعمود آخر', '  ' + NAMES[2] + '  ', NAMES[0], ...NAMES.slice(3)].join('\r\n');
    const r = await api('POST', '/people/import', { text }, sup);
    assert.deepEqual(r.data, { added: 8, total: 9 });
    const people = (await state()).people;
    assert.equal(people.length, 8);
    assert.ok(people.every((p) => p.isMember));
    assert.equal((await api('POST', '/people/import', { text }, sup)).data.added, 0);
  });

  test('A12 the same name spelled without hamza is not added twice', async () => {
    const r = await api('POST', '/people', { name: 'احمد العلوي', isMember: true }, sup);
    assert.equal(r.data.name, 'أحمد العلوي');
    assert.equal((await state()).people.length, 8);
  });

  test('A13 empty or oversized names are refused', async () => {
    assert.equal((await api('POST', '/people', { name: '   ' }, sup)).status, 400);
    assert.equal((await api('POST', '/people', { name: 'ا'.repeat(81) }, sup)).status, 400);
  });

  test('A14 a name added by a team is "not a member", even if the team claims otherwise', async () => {
    const r = await api('POST', '/people', { name: 'حسن الغريب', isMember: true }, team1);
    assert.equal(r.status, 200);
    assert.equal(r.data.isMember, false);
  });

  test('A14b a name added by a team waits for the supervisor and is shown with who added it', async () => {
    const p = (await state()).people.find((x) => x.name === 'حسن الغريب');
    assert.equal(p.pending, true);
    assert.equal(p.addedBy, 'الفريق 1');
    assert.equal(p.papers, 0);
    // A name added by the supervisor never waits.
    const q = (await api('POST', '/people', { name: 'اسم من المشرف' }, sup)).data;
    assert.equal(q.pending, undefined);
    await api('DELETE', `/people/${q.id}`, undefined, sup);
  });

  test('A15 supervisor: correct a name, refuse a name that already exists', async () => {
    const id = await idOf('مريم الصقلي');
    assert.equal((await api('PATCH', `/people/${id}`, { name: 'محمد بنعلي' }, sup)).status, 400);
    assert.equal((await api('PATCH', `/people/${id}`, { name: '  ' }, sup)).status, 400);
    assert.equal((await api('PATCH', `/people/${id}`, { name: 'مريم الصقلي الإدريسي' }, sup)).data.name, 'مريم الصقلي الإدريسي');
    assert.equal((await api('PATCH', `/people/${id}`, { name: 'مريم الصقلي' }, sup)).status, 200);
    assert.equal((await api('PATCH', '/people/9999', { name: 'x' }, sup)).status, 404);
  });

  test('A16 supervisor: delete an unused name', async () => {
    const p = (await api('POST', '/people', { name: 'اسم بالخطأ', isMember: true }, sup)).data;
    assert.equal((await api('DELETE', `/people/${p.id}`, undefined, sup)).status, 200);
    assert.equal((await state()).people.some((x) => x.id === p.id), false);
  });

  // ---------- round creation ----------
  test('A17 round creation: invalid configurations refused', async () => {
    const ok = { title: 'جولة', mode: 'list', candidates: [1, 2, 3], min: 1, max: 1, seats: 1, threshold: 'absolute' };
    const bad = [
      { ...ok, title: '   ' },
      { ...ok, candidates: [1] },
      { ...ok, candidates: [1, 9999] },
      { ...ok, candidates: 'abc' },
      { ...ok, min: 3, max: 2 },
      { ...ok, max: 4 },
      { ...ok, min: 0 },
      { ...ok, seats: 0 },
      { ...ok, seats: 'x' },
    ];
    for (const b of bad) assert.equal((await api('POST', '/rounds', b, sup)).status, 400, JSON.stringify(b));
    assert.equal((await state()).rounds.length, 0);
  });

  // ---------- operation 1, step 1: nomination ----------
  let nomId;
  test('A18 nomination round is created closed to entry', async () => {
    const r = await api('POST', '/rounds', { kind: 'nomination', title: 'الترشيح', mode: 'open', min: 3, max: 5, seats: 5, threshold: 'none' }, sup);
    assert.equal(r.status, 200);
    nomId = r.data.id;
    assert.deepEqual([r.data.status, r.data.published, r.data.void], ['draft', false, 0]);
    assert.equal((await api('GET', '/team/state', undefined, team1)).data.rounds.length, 0);
    assert.equal((await api('POST', '/ballots', { roundId: nomId, choices: [1, 2, 3] }, team1)).status, 400);
  });

  test('A19 opening the round makes it appear for the teams', async () => {
    assert.equal((await api('PATCH', `/rounds/${nomId}`, { status: 'open' }, sup)).status, 200);
    const t = (await api('GET', '/team/state', undefined, team1)).data;
    assert.equal(t.team, 'الفريق 1');
    assert.deepEqual(t.rounds.map((r) => [r.id, r.min, r.max, r.mode]), [[nomId, 3, 5, 'open']]);
    assert.equal(t.people.length, 9);
    assert.equal((await api('PATCH', `/rounds/${nomId}`, { status: 'banana' }, sup)).status, 400);
  });

  test('A20 invalid papers are refused (too few, too many, unknown)', async () => {
    const send = (choices) => api('POST', '/ballots', { roundId: nomId, choices }, team1);
    assert.equal((await send([1, 2])).status, 400, 'two names');
    assert.equal((await send([1, 2, 3, 4, 5, 6])).status, 400, 'six names');
    const short = await send([1, 1, 2, 3]);
    assert.equal(short.status, 400, 'duplicate removed leaves 2 names, under the minimum of 3');
    assert.match(short.data.error, /بعد حذف الأسماء المكررة أو الخارجة عن اللائحة يبقى 2/);
    assert.equal((await send(Array(21).fill(1))).status, 400, 'more than 20 entries');
    assert.equal((await send([1, 2, 9999])).status, 400, 'unknown name');
    assert.equal((await send([])).status, 400, 'empty');
    assert.equal((await send('1,2,3')).status, 400, 'not a list');
    assert.equal((await api('POST', '/ballots', { roundId: 9999, choices: [1, 2, 3] }, team1)).status, 404);
    assert.equal((await roundOf(nomId)).results.valid, 0);
  });

  test('A20b a name written twice is removed entirely, the rest of the paper counts', async () => {
    const send = (choices) => api('POST', '/ballots', { roundId: nomId, choices }, team1);
    const del = (b) => api('DELETE', `/ballots/${b.id}`, undefined, sup);
    // 1 twice + 2, 3, 4: name 1 is not counted, the paper counts for 2, 3 and 4.
    const a = await send([1, 2, 1, 3, 4]);
    assert.equal(a.status, 200);
    assert.deepEqual([a.data.choices, a.data.dropped], [[2, 3, 4], [1]]);
    let res = (await roundOf(nomId)).results;
    assert.equal(res.rows.find((x) => x.id === 1)?.votes || 0, 0, 'the duplicated name gets no vote');
    assert.equal(res.rows.find((x) => x.id === 2).votes, 1);
    // Three times is the same as twice.
    const b = await send([1, 1, 1, 2, 3, 4]);
    assert.deepEqual([b.data.choices, b.data.dropped], [[2, 3, 4], [1]]);
    // Six lines but one name twice: 4 names remain, within the maximum of 5.
    const c = await send([1, 1, 2, 3, 4, 5]);
    assert.equal(c.status, 200);
    assert.deepEqual(c.data.choices, [2, 3, 4, 5]);
    // Two different names each written twice: only 1 name remains.
    assert.equal((await send([1, 1, 2, 2, 3])).status, 400);
    // A duplicated name that does not exist is still refused.
    assert.equal((await send([9999, 9999, 2, 3, 4])).status, 400);
    for (const x of [a, b, c]) assert.equal((await del(x.data)).status, 200);
    res = (await roundOf(nomId)).results;
    assert.equal(res.valid, 0);
  });

  test('A21 valid papers of three, four and five names are counted', async () => {
    const outsider = await idOf('حسن الغريب');
    const papers = [
      [team1, [1, 2, 3]], [team1, [1, 2, 4, 5]], [team1, [1, 3, 6, 7, 8]],
      [team2, [1, 2, outsider]], [team2, [1, 4, outsider]], [team2, [1, 2, 3, outsider]],
    ];
    for (const [tok, choices] of papers) assert.equal((await api('POST', '/ballots', { roundId: nomId, choices }, tok)).status, 200);
    const r = await roundOf(nomId);
    assert.equal(r.results.valid, 6);
    assert.deepEqual(r.perTeam, { 'الفريق 1': { valid: 3, cancelled: 0 }, 'الفريق 2': { valid: 3, cancelled: 0 } });
    assert.deepEqual(r.results.rows.slice(0, 2).map((x) => [x.name, x.votes]), [['أحمد العلوي', 6], ['محمد بنعلي', 4]]);
  });

  test('A22 each team sees its own count and recent papers only', async () => {
    const t1 = (await api('GET', '/team/state', undefined, team1)).data;
    const t2 = (await api('GET', '/team/state', undefined, team2)).data;
    assert.equal(t1.counts[nomId], 3);
    assert.equal(t2.counts[nomId], 3);
    assert.ok(t1.recent.every((b) => b.team === 'الفريق 1'));
  });

  test('A22c a team that entered papers cannot be deleted', async () => {
    const t1 = (await state()).teams.find((t) => t.name === 'الفريق 1');
    assert.equal((await api('DELETE', `/teams/${t1.id}`, undefined, sup)).status, 400);
    assert.equal((await api('GET', '/team/state', undefined, team1)).status, 200);
  });

  test('A22b a team created in the middle of a round joins it, nothing else changes', async () => {
    const before = await roundOf(nomId);
    const late = (await teamLogin((await newTeam()).code)).data;
    assert.equal(late.team, 'الفريق 4');
    const t = (await api('GET', '/team/state', undefined, late.token)).data;
    assert.deepEqual([t.rounds.length, t.counts[nomId] || 0, t.recent.length], [1, 0, 0]);
    assert.deepEqual((await roundOf(nomId)).results, before.results, 'results unchanged by the arrival');
    const paper = (await api('POST', '/ballots', { roundId: nomId, choices: [1, 2, 3] }, late.token)).data;
    let r = await roundOf(nomId);
    assert.deepEqual(r.perTeam, { ...before.perTeam, 'الفريق 4': { valid: 1, cancelled: 0 } });
    assert.equal((await state()).teams.find((x) => x.name === 'الفريق 4').ballots, 1);
    assert.equal((await api('GET', '/team/state', undefined, team1)).data.counts[nomId], 3, 'other teams keep their own count');
    assert.equal((await api('DELETE', `/ballots/${paper.id}`, undefined, team1)).status, 403);
    assert.equal((await api('DELETE', `/ballots/${paper.id}`, undefined, late.token)).status, 200);
    assert.equal((await api('DELETE', `/ballots/${paper.id}`, undefined, sup)).status, 200);
    r = await roundOf(nomId);
    assert.deepEqual(r.results, before.results);
  });

  test('A23 the non-member is left out; once made a member, the same votes count', async () => {
    let r = await roundOf(nomId);
    assert.equal(statusOf(r, 'حسن الغريب'), 'nonmember');
    assert.equal(statusOf(r, 'يوسف الإدريسي'), 'elected');
    assert.equal(r.results.rows.filter((x) => x.status === 'elected').length, 4);
    // The supervisor adds the same name as a member: no duplicate, votes kept.
    const p = (await api('POST', '/people', { name: 'حسن الغريب', isMember: true }, sup)).data;
    assert.equal(p.isMember, true);
    assert.equal(p.pending, undefined, 'adding the name as a member settles it');
    assert.equal((await state()).people.length, 9);
    r = await roundOf(nomId);
    assert.equal(statusOf(r, 'حسن الغريب'), 'elected');
    assert.equal(r.results.rows.find((x) => x.name === 'حسن الغريب').votes, 3);
  });

  test('A23b reject or accept a name added by a team', async () => {
    const z = (await api('POST', '/people', { name: 'زكرياء المختار' }, team2)).data;
    assert.equal(z.pending, true);
    // Three other names, so the papers stay valid when this name is rejected (see A44).
    for (let i = 0; i < 2; i++) await api('POST', '/ballots', { roundId: nomId, choices: [z.id, 6, 7, 8] }, team2);
    let r = await roundOf(nomId);
    let row = r.results.rows.find((x) => x.id === z.id);
    assert.deepEqual([row.status, row.pending, row.votes], ['nonmember', true, 2], 'not counted while waiting');
    assert.equal((await state()).people.find((x) => x.id === z.id).papers, 2);
    // Rejected: no longer waiting, still not counted.
    await api('PATCH', `/people/${z.id}`, { isMember: false }, sup);
    r = await roundOf(nomId);
    row = r.results.rows.find((x) => x.id === z.id);
    assert.deepEqual([row.status, row.pending], ['nonmember', false]);
    assert.equal((await state()).people.filter((x) => x.pending).length, 0);
    // Writing the rejected name again does not ask again.
    assert.equal((await api('POST', '/people', { name: 'زكرياء المختار' }, team1)).data.pending, undefined);
    // Accepted later: counted with the votes already entered.
    await api('PATCH', `/people/${z.id}`, { isMember: true }, sup);
    row = (await roundOf(nomId)).results.rows.find((x) => x.id === z.id);
    assert.deepEqual([row.isMember, row.pending, row.votes], [true, false, 2]);
    // Remove the test papers so the following totals stay the same.
    const mine = (await api('GET', `/rounds/${nomId}/ballots`, undefined, sup)).data.filter((b) => b.choices.includes(z.id));
    for (const b of mine) await api('DELETE', `/ballots/${b.id}`, undefined, sup);
    await api('DELETE', `/people/${z.id}`, undefined, sup);
  });

  test('A24 membership can be removed and given back with the button action', async () => {
    const id = await idOf('حسن الغريب');
    await api('PATCH', `/people/${id}`, { isMember: false }, sup);
    assert.equal(statusOf(await roundOf(nomId), 'حسن الغريب'), 'nonmember');
    await api('PATCH', `/people/${id}`, { isMember: true }, sup);
    assert.equal(statusOf(await roundOf(nomId), 'حسن الغريب'), 'elected');
  });

  test('A25 a name that received votes cannot be deleted', async () => {
    assert.equal((await api('DELETE', '/people/1', undefined, sup)).status, 400);
    assert.equal((await state()).people.find((p) => p.id === 1).used, true);
  });

  test('A26 a round with papers cannot be reconfigured', async () => {
    const config = { title: 'x', mode: 'open', min: 1, max: 9, seats: 9, threshold: 'none' };
    assert.equal((await api('PATCH', `/rounds/${nomId}`, { config }, sup)).status, 400);
    assert.equal((await roundOf(nomId)).max, 5);
  });

  test('A27 deleting papers: a team only asks for its own, the supervisor accepts', async () => {
    const all = (await api('GET', `/rounds/${nomId}/ballots`, undefined, sup)).data;
    const mine = all.find((b) => b.team === 'الفريق 1');
    const theirs = all.find((b) => b.team === 'الفريق 2');
    assert.equal((await api('DELETE', `/ballots/${theirs.id}`, undefined, team1)).status, 403);
    const asked = await api('DELETE', `/ballots/${mine.id}`, undefined, team1);
    assert.deepEqual([asked.status, asked.data.requested], [200, true]);
    assert.equal((await roundOf(nomId)).results.valid, 6, 'still counted while waiting');
    const waiting = (await state()).deleteRequests;
    assert.deepEqual(waiting.map((b) => [b.id, b.team, b.roundTitle]), [[mine.id, 'الفريق 1', 'الترشيح']]);
    assert.equal((await api('DELETE', `/ballots/${mine.id}`, undefined, sup)).status, 200);
    assert.equal((await api('DELETE', `/ballots/${mine.id}`, undefined, team1)).status, 404);
    assert.equal((await api('DELETE', `/ballots/${theirs.id}`, undefined, sup)).status, 200);
    assert.equal((await roundOf(nomId)).results.valid, 4);
    assert.equal((await state()).deleteRequests.length, 0);
    // Put them back so the following tests keep the same totals.
    await api('POST', '/ballots', { roundId: nomId, choices: mine.choices }, team1);
    await api('POST', '/ballots', { roundId: nomId, choices: theirs.choices }, team2);
    assert.equal((await roundOf(nomId)).results.valid, 6);
  });

  test('A27b the supervisor rejects a request: the paper stays counted and cannot be asked again', async () => {
    const paper = (await api('POST', '/ballots', { roundId: nomId, choices: [1, 2, 3] }, team1)).data;
    assert.equal((await api('PATCH', `/ballots/${paper.id}`, {}, sup)).status, 400, 'no request yet');
    await api('DELETE', `/ballots/${paper.id}`, undefined, team1);
    const shown = (await api('GET', '/team/state', undefined, team1)).data.recent.find((b) => b.id === paper.id);
    assert.ok(shown.deleteRequest, 'the team sees it is waiting');
    assert.equal((await api('PATCH', `/ballots/${paper.id}`, {}, team1)).status, 401, 'a team cannot decide');
    assert.equal((await api('PATCH', `/ballots/${paper.id}`, {}, sup)).status, 200);
    assert.equal((await state()).deleteRequests.length, 0);
    assert.equal((await roundOf(nomId)).results.valid, 7, 'still counted');
    const after = (await api('GET', '/team/state', undefined, team1)).data.recent.find((b) => b.id === paper.id);
    assert.deepEqual([after.deleteRequest, after.deleteRejected], [undefined, true]);
    assert.equal((await api('DELETE', `/ballots/${paper.id}`, undefined, team1)).status, 403, 'cannot ask again');
    assert.equal((await api('PATCH', '/ballots/9999', {}, sup)).status, 404);
    // The supervisor can still delete it directly.
    assert.equal((await api('DELETE', `/ballots/${paper.id}`, undefined, sup)).status, 200);
    assert.equal((await roundOf(nomId)).results.valid, 6);
  });

  test('A28 merging two spellings moves the votes; a paper with both spellings applies the duplicate rule', async () => {
    const dup = (await api('POST', '/people', { name: 'محمد بن علي' }, team1)).data;
    await api('POST', '/ballots', { roundId: nomId, choices: [dup.id, 6, 7] }, team1);
    const both = (await api('POST', '/ballots', { roundId: nomId, choices: [dup.id, 2, 3, 6, 7] }, team1)).data;
    await api('POST', '/ballots', { roundId: nomId, choices: [dup.id, 2, 8] }, team1);
    const before = await roundOf(nomId);
    const votes = (r, id) => r.results.rows.find((x) => x.id === id)?.votes || 0;
    assert.equal((await api('POST', '/people/merge', { from: dup.id, to: dup.id }, sup)).status, 400);
    assert.equal((await api('POST', '/people/merge', { from: 9999, to: 2 }, sup)).status, 404);
    const m = await api('POST', '/people/merge', { from: dup.id, to: 2 }, sup);
    assert.equal(m.status, 200);
    assert.deepEqual(m.data.cancelled, { 'الترشيح': 1 }, 'paper [name, name, 8] is left with 1 name: cancelled');
    const r = await roundOf(nomId);
    assert.equal(r.results.valid, before.results.valid - 1);
    assert.equal(r.results.voidTeams, before.results.voidTeams + 1, 'kept as a cancelled paper, not deleted');
    const gone = (await api('GET', `/rounds/${nomId}/ballots`, undefined, sup)).data.filter((b) => b.cancelledByMerge);
    assert.deepEqual(gone.map((b) => [b.cancelled, b.choices.length, b.team]), [[true, 0, 'الفريق 1']]);
    // +1 from the paper with only the other spelling; -1 from each of the two papers that had both.
    assert.equal(votes(r, 2), votes(before, 2) - 1);
    assert.equal(votes(r, 8), votes(before, 8) - 1);
    const kept = (await api('GET', `/rounds/${nomId}/ballots`, undefined, sup)).data.find((b) => b.id === both.id);
    assert.deepEqual([kept.choices, kept.dropped], [[3, 6, 7], [2]]);
    assert.equal(r.results.rows.some((x) => x.id === dup.id), false);
    assert.equal((await state()).people.some((p) => p.id === dup.id), false);
  });

  test('A29 cancelled papers: invalid count refused, valid count added to the total', async () => {
    assert.equal((await api('PATCH', `/rounds/${nomId}`, { void: -1 }, sup)).status, 400);
    assert.equal((await api('PATCH', `/rounds/${nomId}`, { void: 2.5 }, sup)).status, 400);
    assert.equal((await api('PATCH', `/rounds/${nomId}`, { void: 2 }, sup)).status, 200);
    const res = (await roundOf(nomId)).results;
    // 1 paper cancelled by the merge (A28) + 2 added by the supervisor.
    assert.deepEqual([res.valid, res.void, res.voidTeams, res.voidManual, res.total], [8, 3, 1, 2, 11]);
  });

  test('A29b a team cannot record a cancelled paper: only the supervisor counts them', async () => {
    const before = await roundOf(nomId);
    for (const body of [{ cancelled: true }, { cancelled: true, choices: [1, 2, 3] }, { cancelled: 1, choices: [1, 2, 3] }]) {
      assert.equal((await api('POST', '/ballots', { roundId: nomId, ...body }, team1)).status, 403, JSON.stringify(body));
    }
    assert.equal((await api('POST', '/ballots', { roundId: nomId, cancelled: true })).status, 401);
    assert.deepEqual((await roundOf(nomId)).results, before.results);
  });

  test('A30 closing the round stops entry and deletion by the teams', async () => {
    await api('PATCH', `/rounds/${nomId}`, { status: 'closed' }, sup);
    assert.equal((await api('POST', '/ballots', { roundId: nomId, choices: [1, 2, 3] }, team1)).status, 400);
    assert.equal((await api('POST', '/ballots', { roundId: nomId, cancelled: true }, team1)).status, 400, 'no cancelled paper either');
    const mine = (await api('GET', `/rounds/${nomId}/ballots`, undefined, sup)).data.find((b) => b.team === 'الفريق 1');
    assert.equal((await api('DELETE', `/ballots/${mine.id}`, undefined, team1)).status, 403);
    assert.equal((await api('GET', '/team/state', undefined, team1)).data.rounds.length, 0);
  });

  test('A31 results stay hidden until published; nomination shows only retained names', async () => {
    assert.deepEqual((await api('GET', '/public')).data.rounds, []);
    await api('PATCH', `/rounds/${nomId}`, { published: true }, sup);
    const pub = (await api('GET', '/public')).data.rounds;
    assert.equal(pub.length, 1);
    assert.ok(pub[0].results.rows.length > 0);
    assert.ok(pub[0].results.rows.every((x) => x.status === 'elected' || x.status === 'tied'));
    await api('PATCH', `/rounds/${nomId}`, { published: false }, sup);
    assert.deepEqual((await api('GET', '/public')).data.rounds, []);
  });

  // ---------- operation 1, step 2: president vote ----------
  let presId;
  test('A32a president vote candidates must come from the names retained by the nomination', async () => {
    // Nomination at this point: 1, 2, 3 kept; 9, 7, 6 tied for the last places; 4, 5, 8 not kept.
    const base = { kind: 'president', title: 'تجربة', mode: 'list', min: 1, max: 1, seats: 1, threshold: 'absolute' };
    const r = await api('POST', '/rounds', { ...base, candidates: [1, 2, 3, 9, 4] }, sup);
    assert.equal(r.status, 400, 'name 4 was not retained');
    assert.match(r.data.error, /من المحتفظ بهم في «الترشيح»/);
    // Tied names are allowed: the supervisor decides between them.
    const ok = await api('POST', '/rounds', { ...base, candidates: [1, 2, 3, 9, 7, 6] }, sup);
    assert.equal(ok.status, 200);
    // Editing a president round is held to the same rule.
    assert.equal((await api('PATCH', `/rounds/${ok.data.id}`, { config: { ...base, candidates: [1, 5] } }, sup)).status, 400);
    await api('DELETE', `/rounds/${ok.data.id}`, undefined, sup);
    // Bureau rounds are free: the president proposes any member.
    const bureau = await api('POST', '/rounds', { kind: 'bureau', title: 'مكتب', mode: 'list', candidates: [4, 5, 8], min: 1, max: 3, seats: 3, threshold: 'absolute' }, sup);
    assert.equal(bureau.status, 200);
    await api('DELETE', `/rounds/${bureau.data.id}`, undefined, sup);
  });

  test('A32 president vote: one name only, among the candidates only', async () => {
    const r = await api('POST', '/rounds', { kind: 'president', title: 'التصويت', mode: 'list', candidates: [1, 2, 3, 9, 7], min: 1, max: 1, seats: 1, threshold: 'absolute' }, sup);
    presId = r.data.id;
    await api('PATCH', `/rounds/${presId}`, { status: 'open' }, sup);
    const send = (choices) => api('POST', '/ballots', { roundId: presId, choices }, team1);
    assert.equal((await send([1, 2])).status, 400, 'two names');
    assert.equal((await send([6])).status, 400, 'only a non-candidate: nothing left');
    assert.equal((await send([])).status, 400, 'blank');
    assert.equal((await send([1, 1])).status, 400, 'the only name written twice: nothing left');
    const extra = await send([2, 6]);
    assert.deepEqual([extra.status, extra.data.choices, extra.data.ignored], [200, [2], 1], 'candidate + non-candidate: counts for the candidate');
    await api('DELETE', `/ballots/${extra.data.id}`, undefined, sup);
    assert.equal((await send([1])).status, 200);
  });

  test('A32b a name that is not a candidate is ignored, the rest of the paper counts', async () => {
    const b = await api('POST', '/rounds', { kind: 'bureau', title: 'المكتب', mode: 'list', candidates: [1, 2, 3, 4, 5, 6], min: 1, max: 5, seats: 5, threshold: 'absolute' }, sup);
    const id = b.data.id;
    await api('PATCH', `/rounds/${presId}`, { status: 'closed' }, sup); // one round open at a time
    await api('PATCH', `/rounds/${id}`, { status: 'open' }, sup);
    const send = (body) => api('POST', '/ballots', { roundId: id, ...body }, team1);
    // 4 candidates + 1 name outside the list, counted by the team with the button.
    const a = await send({ choices: [1, 2, 3, 4], ignored: 1 });
    assert.equal(a.status, 200);
    assert.deepEqual([a.data.choices, a.data.ignored], [[1, 2, 3, 4], 1]);
    // A non-candidate sent by id is ignored the same way.
    const c = await send({ choices: [1, 2, 3, 4, 7] });
    assert.deepEqual([c.data.choices, c.data.ignored], [[1, 2, 3, 4], 1]);
    // 5 candidates + 1 outside name: 5 remain, within the maximum.
    assert.equal((await send({ choices: [1, 2, 3, 4, 5], ignored: 1 })).status, 200);
    // 6 candidates is still too many, whatever else is on the paper.
    assert.equal((await send({ choices: [1, 2, 3, 4, 5, 6] })).status, 400);
    // Duplicate and outside name together: 1 twice + 7 -> only 2 counts.
    const d = await send({ choices: [1, 1, 2, 7] });
    assert.deepEqual([d.data.choices, d.data.dropped, d.data.ignored], [[2], [1], 1]);
    // Only names outside the list: nothing remains, cancelled.
    const e = await send({ choices: [], ignored: 2 });
    assert.equal(e.status, 400);
    assert.match(e.data.error, /يبقى 0/);
    for (const bad of [-1, 2.5, 21, 'x']) assert.equal((await send({ choices: [1], ignored: bad })).status, 400, String(bad));
    const r = await roundOf(id);
    assert.equal(r.results.valid, 4);
    assert.equal(r.results.rows.some((x) => x.id === 7), false, 'the outside name never appears in the results');
    assert.equal((await api('DELETE', `/rounds/${id}`, undefined, sup)).status, 200);
    await api('PATCH', `/rounds/${presId}`, { status: 'open' }, sup);
  });

  test('A33 a round without papers can still be reconfigured', async () => {
    const r = (await api('POST', '/rounds', { title: 'مؤقتة', mode: 'list', candidates: [1, 2], min: 1, max: 1, seats: 1, threshold: 'none' }, sup)).data;
    const config = { title: 'معدلة', mode: 'list', candidates: [1, 2, 3], min: 1, max: 2, seats: 2, threshold: 'present' };
    assert.equal((await api('PATCH', `/rounds/${r.id}`, { config }, sup)).status, 200);
    const now = await roundOf(r.id);
    assert.deepEqual([now.title, now.max, now.seats, now.threshold, now.candidates.length], ['معدلة', 2, 2, 'present', 3]);
    assert.equal((await api('DELETE', `/rounds/${r.id}`, undefined, sup)).status, 200);
  });

  test('A34 president: 85 votes is not enough, the 86th elects', async () => {
    for (let i = 1; i < 85; i++) await api('POST', '/ballots', { roundId: presId, choices: [1] }, i % 2 ? team1 : team2);
    for (let i = 0; i < 40; i++) await api('POST', '/ballots', { roundId: presId, choices: [2] }, team2);
    let r = await roundOf(presId);
    assert.equal(r.results.rows[0].votes, 85);
    assert.equal(r.results.threshold, 86);
    assert.equal(statusOf(r, 'أحمد العلوي'), 'below');
    assert.equal(r.results.seatsLeft, 1);
    await api('POST', '/ballots', { roundId: presId, choices: [1] }, team1);
    r = await roundOf(presId);
    assert.equal(statusOf(r, 'أحمد العلوي'), 'elected');
    assert.equal(r.results.seatsLeft, 0);
  });

  test('A35 a candidate of a round cannot be deleted from the list', async () => {
    assert.equal((await api('DELETE', '/people/7', undefined, sup)).status, 400);
  });

  test('A36 published list round shows every candidate with the result', async () => {
    await api('PATCH', `/rounds/${presId}`, { published: true }, sup);
    const pub = (await api('GET', '/public')).data.rounds.find((r) => r.id === presId);
    assert.equal(pub.results.rows.length, 5);
    assert.equal(pub.results.rows[0].status, 'elected');
    assert.equal(pub.results.threshold, 86);
  });

  // ---------- robustness ----------
  test('A32b run-off candidates must come from the president vote', async () => {
    const base = { kind: 'runoff', title: 'إعادة', mode: 'list', min: 1, max: 1, seats: 1, threshold: 'present' };
    const bad = await api('POST', '/rounds', { ...base, candidates: [1, 4] }, sup);
    assert.equal(bad.status, 400, 'name 4 was not a candidate of the president vote');
    assert.match(bad.data.error, /«التصويت»/);
    const ok = await api('POST', '/rounds', { ...base, candidates: [1, 2] }, sup);
    assert.equal(ok.status, 200);
    await api('DELETE', `/rounds/${ok.data.id}`, undefined, sup);
  });

  test('A36b changing the present count affects rounds in progress only; a closed round keeps its counts', async () => {
    await api('PUT', '/settings', { present: 160 }, sup);
    const mk = async (title) => (await api('POST', '/rounds', { kind: 'runoff', title, mode: 'list', candidates: [1, 2], min: 1, max: 1, seats: 1, threshold: 'present' }, sup)).data.id;
    const done = await mk('مغلقة');
    const live = await mk('جارية');
    await api('PATCH', `/rounds/${presId}`, { status: 'closed' }, sup); // one round open at a time
    for (const id of [done, live]) {
      await api('PATCH', `/rounds/${id}`, { status: 'open' }, sup);
      for (let i = 0; i < 70; i++) await api('POST', '/ballots', { roundId: id, choices: [1] }, team1);
      if (id === done) await api('PATCH', `/rounds/${done}`, { status: 'closed' }, sup);
    }
    let a = await roundOf(done);
    assert.deepEqual(a.frozen, { expected: 170, present: 160 });
    assert.deepEqual([a.results.threshold, a.results.rows[0].status], [81, 'below'], '70 < 81');
    // Some members leave: 120 present now.
    assert.equal((await api('PUT', '/settings', { present: 120 }, sup)).status, 200);
    a = await roundOf(done);
    const b = await roundOf(live);
    assert.deepEqual([a.results.threshold, a.results.present, a.results.rows[0].status], [81, 160, 'below'], 'closed round unchanged');
    assert.deepEqual([b.results.threshold, b.results.present, b.results.rows[0].status], [61, 120, 'elected'], 'open round follows: 70 >= 61');
    // Entry keeps working in the open round.
    assert.equal((await api('POST', '/ballots', { roundId: live, choices: [2] }, team2)).status, 200);
    // Reopening the closed round makes it follow the current count again.
    await api('PATCH', `/rounds/${live}`, { status: 'closed' }, sup);
    await api('PATCH', `/rounds/${done}`, { status: 'open' }, sup);
    a = await roundOf(done);
    assert.equal(a.frozen, undefined);
    assert.equal(a.results.threshold, 61);
    for (const id of [done, live]) await api('DELETE', `/rounds/${id}`, undefined, sup);
    await api('PUT', '/settings', { present: 160 }, sup);
  });

  test('A37 broken requests get a clean error and the server keeps running', async () => {
    assert.equal((await raw(srv.port, { method: 'POST', path: '/api/login', body: '{not json' })).status, 400);
    assert.equal((await api('GET', '/does-not-exist', undefined, sup)).status, 404);
    assert.equal((await api('PATCH', '/rounds/9999', { status: 'open' }, sup)).status, 404);
    assert.equal((await raw(srv.port, { path: '/%E0%A4%A' })).status, 400);
    assert.equal((await api('GET', '/public')).status, 200);
    assert.ok(srv.alive());
  });

  test('A38 pages are served; files outside the public folder are not', async () => {
    for (const p of ['/', '/team', '/admin', '/app.css', '/common.js']) assert.equal((await raw(srv.port, { path: p })).status, 200, p);
    assert.equal((await raw(srv.port, { path: '/nothing-here' })).status, 404);
    for (const p of ['/../server.js', '/..%2fserver.js', '/..%2fdata%2fvote.json', '/%2e%2e/package.json']) {
      const r = await raw(srv.port, { path: p });
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(r.text, /createServer|supHash/);
    }
  });

  test('A39 the supervisor code is never sent to the browser; team codes only to the supervisor', async () => {
    const st = await state();
    const others = (await api('GET', '/public')).text + (await api('GET', '/team/state', undefined, team1)).text;
    assert.doesNotMatch(JSON.stringify(st) + others, /supHash|supSalt|super2/);
    assert.doesNotMatch(others, /"code"/);
  });

  // ---------- data safety ----------
  test('A40 everything survives a restart, including logins; a backup is made', async () => {
    const beforeState = await state();
    await srv.stop();
    srv = await startServer(dir);
    const afterState = await state();
    assert.deepEqual(afterState, beforeState);
    assert.equal((await api('GET', '/team/state', undefined, team1)).status, 200);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('vote.backup-')));
  });

  test('A41 deleting a round removes its papers and its public result', async () => {
    assert.equal((await api('DELETE', `/rounds/${presId}`, undefined, sup)).status, 200);
    assert.equal((await api('GET', `/rounds/${presId}/ballots`, undefined, sup)).status, 404);
    assert.equal((await api('GET', '/public')).data.rounds.some((r) => r.id === presId), false);
    assert.equal((await state()).rounds.some((r) => r.id === presId), false);
    assert.equal((await roundOf(nomId)).results.valid, 8, 'other rounds are untouched');
  });
});

describe('Data from the earlier version', () => {
  test('A42 old data: each team gets its own code, the shared code and old team logins stop working', async () => {
    const dir = tmp();
    const boot = await startServer(dir);
    const call = (srv, method, p, body, token) => raw(srv.port, { method, path: '/api' + p, body, token });
    await call(boot, 'POST', '/setup', { supervisorCode: 'super1' });
    await boot.stop();
    // Rewrite the file the way the earlier version saved it: one shared code, teams by computer.
    const file = path.join(dir, 'vote.json');
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    db.settings.teamCode = 'team1';
    db.teams = [{ device: 'computer-aaaa', name: 'الفريق 3' }];
    db.people = [{ id: 1, name: 'أحمد', isMember: true }, { id: 2, name: 'محمد', isMember: true }];
    db.rounds = [{ id: 1, title: 'قديمة', kind: 'president', mode: 'list', candidates: [1, 2], min: 1, max: 1, seats: 1, threshold: 'none', status: 'open', published: false, void: 0 }];
    db.rounds.push({ id: 2, title: 'مغلقة قديمة', kind: 'runoff', mode: 'list', candidates: [1, 2], min: 1, max: 1, seats: 1, threshold: 'present', status: 'closed', published: false, void: 0 });
    db.settings.present = 50;
    db.ballots = [{ id: 1, roundId: 1, team: 'الفريق 1', choices: [1], at: 1 }];
    db.sessions = { 'old-team-token': { role: 'team', team: 'الفريق 2' } };
    db.seq = { p: 2, r: 1, b: 1 };
    fs.writeFileSync(file, JSON.stringify(db));

    let srv = await startServer(dir);
    try {
      assert.equal((await call(srv, 'GET', '/team/state', undefined, 'old-team-token')).status, 401, 'old team login stopped');
      assert.equal((await call(srv, 'POST', '/login', { role: 'team', code: 'team1' })).status, 401, 'shared code stopped');
      let sup = (await call(srv, 'POST', '/login', { role: 'supervisor', code: 'super1' })).data.token;
      const st = (await call(srv, 'GET', '/admin/state', undefined, sup)).data;
      assert.equal(st.rounds[0].results.valid, 1);
      assert.deepEqual(st.rounds[1].frozen, { expected: 170, present: 50 }, 'an old closed round is frozen with the counts in force');
      assert.equal(st.rounds[0].frozen, undefined, 'an open round is not');
      assert.deepEqual(st.teams.map((t) => t.name).sort(), ['الفريق 1', 'الفريق 3']);
      assert.ok(st.teams.every((t) => /^\d{5}$/.test(t.code)));
      const one = st.teams.find((t) => t.name === 'الفريق 1');
      assert.equal(one.ballots, 1, 'the team keeps its papers');
      const login = (await call(srv, 'POST', '/login', { role: 'team', code: one.code })).data;
      assert.equal(login.team, 'الفريق 1');
      assert.equal((await call(srv, 'POST', '/teams', undefined, sup)).data.name, 'الفريق 2', 'next free number');
      // The new codes are saved: they are the same after another restart.
      await srv.stop();
      srv = await startServer(dir);
      assert.equal((await call(srv, 'POST', '/logout', undefined, login.token)).status, 200, 'the login survived');
      assert.equal((await call(srv, 'POST', '/login', { role: 'team', code: one.code })).status, 200);
    } finally {
      await srv.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A42b if saved data has two logins for one team, only the latest stays', async () => {
    const dir = tmp();
    const boot = await startServer(dir);
    const call = (srv, method, p, body, token) => raw(srv.port, { method, path: '/api' + p, body, token });
    await call(boot, 'POST', '/setup', { supervisorCode: 'super1' });
    const sup = (await call(boot, 'POST', '/login', { role: 'supervisor', code: 'super1' })).data.token;
    const team = (await call(boot, 'POST', '/teams', undefined, sup)).data;
    await boot.stop();
    const file = path.join(dir, 'vote.json');
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    db.sessions['older-login'] = { role: 'team', team: team.name };
    db.sessions['newer-login'] = { role: 'team', team: team.name };
    fs.writeFileSync(file, JSON.stringify(db));
    const srv = await startServer(dir);
    try {
      assert.equal((await call(srv, 'GET', '/team/state', undefined, 'older-login')).status, 401);
      assert.equal((await call(srv, 'GET', '/team/state', undefined, 'newer-login')).status, 200);
      assert.equal((await call(srv, 'GET', '/admin/state', undefined, sup)).status, 200, 'supervisor login kept');
    } finally {
      await srv.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Wrong team codes', () => {
  test('A43 after 5 wrong codes a device must wait, other devices are not affected', async (t) => {
    const dir = tmp();
    const srv = await startServer(dir, undefined, { LOGIN_MAX_TRIES: '5', LOGIN_BLOCK_MS: '500' });
    const call = (method, p, body, token, from) => raw(srv.port, { method, path: '/api' + p, body, token, from });
    const login = (code, from) => call('POST', '/login', { role: 'team', code }, undefined, from);
    try {
      await call('POST', '/setup', { supervisorCode: 'super1' });
      const sup = (await call('POST', '/login', { role: 'supervisor', code: 'super1' })).data.token;
      const a = (await call('POST', '/teams', undefined, sup)).data;
      const b = (await call('POST', '/teams', undefined, sup)).data;
      const c = (await call('POST', '/teams', undefined, sup)).data;
      for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
      const blocked = await login(a.code);
      assert.equal(blocked.status, 429, 'even the right code waits');
      assert.match(blocked.data.error, /انتظر دقيقة/);
      assert.equal((await call('POST', '/login', { role: 'supervisor', code: 'super1' })).status, 200, 'the supervisor can still log in');
      if (process.platform === 'linux') assert.equal((await login(b.code, '127.0.0.2')).status, 200, 'another device is not blocked');
      const history = (await call('GET', '/history', undefined, sup)).data.map((x) => x.text).join('\n');
      assert.match(history, /حظر مؤقت للجهاز 127\.0\.0\.1/);
      await new Promise((r) => setTimeout(r, 550));
      assert.equal((await login(a.code)).status, 200, 'allowed again after the wait');
      // A successful login clears the count.
      for (let i = 0; i < 4; i++) assert.equal((await login('wrong')).status, 401);
      assert.equal((await login(c.code)).status, 200);
      for (let i = 0; i < 4; i++) assert.equal((await login('wrong')).status, 401);
    } finally {
      await srv.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Rules added after the logic review', () => {
  let srv, dir, sup, team, teamCode;
  const api = (method, p, body, token) => raw(srv.port, { method, path: '/api' + p, body, token });
  const state = async () => (await api('GET', '/admin/state', undefined, sup)).data;
  const roundOf = async (id) => (await state()).rounds.find((r) => r.id === id);
  const open = async (cfg) => {
    const r = (await api('POST', '/rounds', cfg, sup)).data;
    await api('PATCH', `/rounds/${r.id}`, { status: 'open' }, sup);
    return r.id;
  };
  const finish = async (id) => {
    await api('PATCH', `/rounds/${id}`, { status: 'closed' }, sup);
    await api('DELETE', `/rounds/${id}`, undefined, sup);
  };
  const FREE = { kind: 'custom', title: 'حرة', mode: 'open', min: 1, max: 5, seats: 5, threshold: 'none' };

  before(async () => {
    dir = tmp();
    srv = await startServer(dir);
    await api('POST', '/setup', { supervisorCode: 'super1' });
    sup = (await api('POST', '/login', { role: 'supervisor', code: 'super1' })).data.token;
    teamCode = (await api('POST', '/teams', undefined, sup)).data.code;
    team = (await api('POST', '/login', { role: 'team', code: teamCode })).data.token;
    await api('POST', '/people/import', { text: NAMES.join('\n') }, sup);
  });
  after(async () => { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('A44 a rejected name is removed: a paper left under the minimum is cancelled until the name is accepted', async () => {
    const z = (await api('POST', '/people', { name: 'اسم مرفوض' }, team)).data;
    const id = await open({ kind: 'nomination', title: 'ترشيح', mode: 'open', min: 3, max: 5, seats: 5, threshold: 'none' });
    const paper = (await api('POST', '/ballots', { roundId: id, choices: [z.id, 1, 2] }, team)).data;
    let r = await roundOf(id);
    assert.deepEqual([r.results.valid, r.results.voidTeams], [1, 0], 'counted while the name is waiting');
    await api('PATCH', `/people/${z.id}`, { isMember: false }, sup);
    r = await roundOf(id);
    assert.deepEqual([r.results.valid, r.results.voidTeams, r.results.total], [0, 1, 1]);
    assert.equal(r.results.rows.some((x) => x.id === 1 && x.votes), false, 'the other names get no vote');
    assert.deepEqual(r.perTeam['الفريق 1'], { valid: 0, cancelled: 1 });
    const t = (await api('GET', '/team/state', undefined, team)).data;
    assert.deepEqual([t.counts[id] || 0, t.cancelled[id], t.recent[0].short], [0, 1, true]);
    assert.equal((await api('GET', `/rounds/${id}/ballots`, undefined, sup)).data[0].short, true);
    // A new paper with the rejected name and only two others is refused.
    const refused = await api('POST', '/ballots', { roundId: id, choices: [z.id, 1, 2] }, team);
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /المرفوضة/);
    // With three other names it counts for those three.
    assert.equal((await api('POST', '/ballots', { roundId: id, choices: [z.id, 1, 2, 3] }, team)).status, 200);
    r = await roundOf(id);
    assert.equal(r.results.valid, 1);
    assert.equal(r.results.rows.find((x) => x.id === 3).votes, 1);
    // Accepted later: both papers count again, with the votes already entered.
    await api('PATCH', `/people/${z.id}`, { isMember: true }, sup);
    r = await roundOf(id);
    assert.deepEqual([r.results.valid, r.results.voidTeams], [2, 0]);
    assert.equal(r.results.rows.find((x) => x.id === z.id).votes, 2);
    assert.ok(paper.id);
    await finish(id);
  });

  test('A45 merge: a person written three times on a paper gets no vote', async () => {
    const x = (await api('POST', '/people', { name: 'كتابة أخرى' }, team)).data;
    const id = await open(FREE);
    const a = (await api('POST', '/ballots', { roundId: id, choices: [x.id, x.id, 7, 3] }, team)).data;
    const b = (await api('POST', '/ballots', { roundId: id, choices: [x.id, x.id, 7] }, team)).data;
    assert.deepEqual([a.choices, a.dropped], [[7, 3], [x.id]]);
    const m = await api('POST', '/people/merge', { from: x.id, to: 7 }, sup);
    assert.deepEqual(m.data.cancelled, { 'حرة': 1 }, 'the paper with only that person is left empty');
    const all = (await api('GET', `/rounds/${id}/ballots`, undefined, sup)).data;
    const after = all.find((p) => p.id === a.id);
    assert.deepEqual([after.choices, after.dropped], [[3], [7]]);
    assert.equal(all.find((p) => p.id === b.id).cancelled, true);
    assert.equal((await roundOf(id)).results.rows.find((r) => r.id === 7)?.votes || 0, 0);
    await finish(id);
  });

  test('A46 the history records changes, without codes, for the supervisor only', async () => {
    const id = await open({ ...FREE, title: 'سجل' });
    const a = (await api('POST', '/ballots', { roundId: id, choices: [1, 2] }, team)).data;
    const b = (await api('POST', '/ballots', { roundId: id, choices: [3] }, team)).data;
    await api('DELETE', `/ballots/${a.id}`, undefined, team);
    await api('PATCH', `/ballots/${a.id}`, {}, sup);
    await api('DELETE', `/ballots/${b.id}`, undefined, team);
    await api('DELETE', `/ballots/${b.id}`, undefined, sup);
    await api('PATCH', `/rounds/${id}`, { void: 3 }, sup);
    await api('PATCH', `/rounds/${id}`, { void: 5, published: true }, sup);
    await api('PUT', '/settings', { expected: 100, present: 90 }, sup);
    await api('POST', `/teams/1/code`, undefined, sup);
    team = (await api('POST', '/login', { role: 'team', code: (await state()).teams[0].code })).data.token;
    await finish(id);
    const items = (await api('GET', '/history', undefined, sup)).data;
    const text = items.map((x) => x.text).join('\n');
    for (const pattern of [
      /طلب حذف الورقة #\d+ \(الفريق 1، سجل\): أحمد العلوي ، محمد بنعلي/, /رفض طلب حذف الورقة/, /قبول طلب حذف الورقة #\d+/,
      /الأوراق الملغاة في «سجل»: 0 ← 3/, /الأوراق الملغاة في «سجل»: 3 ← 5/, /نشر نتيجة الجولة: سجل/,
      /العدد المقرر حضورهم: 170 ← 100/, /عدد الحاضرين: 0 ← 90/, /رمز جديد لـالفريق 1/,
      /إغلاق الجولة: سجل \(1 صحيحة، 5 ملغاة\)/, /حذف الجولة: سجل مع 1 ورقة/, /دخول من الجهاز 127\.0\.0\.1/,
    ]) assert.match(text, pattern);
    assert.ok(items.every((x) => x.at && x.who), 'each line has a time and an author');
    assert.ok(items[0].at >= items[items.length - 1].at, 'newest first');
    assert.equal(text.includes(teamCode), false, 'no team code');
    assert.equal(text.includes('super1'), false, 'no supervisor code');
    assert.equal((await api('GET', '/history', undefined, team)).status, 401);
    assert.equal((await api('GET', '/history')).status, 401);
    await srv.stop();
    srv = await startServer(dir);
    assert.equal((await api('GET', '/history', undefined, sup)).data.length, items.length, 'kept after a restart');
  });

  test('A47 only one round can be open at a time', async () => {
    const a = await open({ ...FREE, title: 'الأولى' });
    const b = (await api('POST', '/rounds', { ...FREE, title: 'الثانية' }, sup)).data;
    const refused = await api('PATCH', `/rounds/${b.id}`, { status: 'open' }, sup);
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /«الأولى»/);
    assert.equal((await roundOf(b.id)).status, 'draft');
    assert.equal((await api('PATCH', `/rounds/${a}`, { status: 'open' }, sup)).status, 200, 'an open round can stay open');
    await api('PATCH', `/rounds/${a}`, { status: 'closed' }, sup);
    assert.equal((await api('PATCH', `/rounds/${b.id}`, { status: 'open' }, sup)).status, 200);
    assert.equal((await api('PATCH', `/rounds/${a}`, { status: 'open' }, sup)).status, 400, 'nor can a closed round be reopened');
    await finish(b.id);
    await api('DELETE', `/rounds/${a}`, undefined, sup);
  });

  test('A48 a bureau re-vote can have one candidate; other rounds still need two', async () => {
    const one = { title: 'واحد', mode: 'list', candidates: [5], min: 1, max: 1, seats: 1, threshold: 'present' };
    const r = await api('POST', '/rounds', { ...one, kind: 'bureau2' }, sup);
    assert.equal(r.status, 200);
    assert.equal((await api('POST', '/rounds', { ...one, kind: 'bureau2', candidates: [] }, sup)).status, 400);
    for (const kind of ['president', 'runoff', 'bureau']) assert.equal((await api('POST', '/rounds', { ...one, kind }, sup)).status, 400, kind);
    await api('DELETE', `/rounds/${r.data.id}`, undefined, sup);
  });

  test('A49 a name kept only as a duplicate on a paper cannot be deleted', async () => {
    const id = await open(FREE);
    await api('POST', '/ballots', { roundId: id, choices: [8, 8, 1, 2] }, team);
    assert.equal((await state()).people.find((p) => p.id === 8).used, true);
    assert.equal((await api('DELETE', '/people/8', undefined, sup)).status, 400);
    await finish(id);
    assert.equal((await api('DELETE', '/people/8', undefined, sup)).status, 200, 'free again once the paper is gone');
  });
});

describe('HTTPS', () => {
  let srv, dir;
  let skip = false;

  before(async () => {
    dir = tmp();
    const certs = path.join(dir, 'certs');
    fs.mkdirSync(certs);
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-keyout', path.join(certs, 'key.pem'), '-out', path.join(certs, 'cert.pem')], { stdio: 'ignore' });
    } catch { skip = true; return; }
    srv = await startServer(path.join(dir, 'data'), certs);
  });
  after(async () => { if (srv) await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('H01 with a certificate the app answers in HTTPS', async (t) => {
    if (skip) return t.skip('openssl not available');
    assert.match(srv.log(), /\(HTTPS\)/);
    assert.equal((await raw(srv.port, { path: '/team', secure: true })).status, 200);
    assert.deepEqual((await raw(srv.port, { path: '/api/public', secure: true })).data, { ready: false, rounds: [] });
  });

  test('H02 an http:// address is redirected to https:// on the same port', async (t) => {
    if (skip) return t.skip('openssl not available');
    const r = await raw(srv.port, { path: '/team?x=1' });
    assert.equal(r.status, 307);
    assert.equal(r.headers.location, `https://127.0.0.1:${srv.port}/team?x=1`);
  });

  test('H03 the API works end to end over HTTPS', async (t) => {
    if (skip) return t.skip('openssl not available');
    const call = (method, p, body, token) => raw(srv.port, { method, path: '/api' + p, body, token, secure: true });
    assert.equal((await call('POST', '/setup', { supervisorCode: 'super1' })).status, 200);
    const token = (await call('POST', '/login', { role: 'supervisor', code: 'super1' })).data.token;
    assert.equal((await call('GET', '/admin/state', undefined, token)).status, 200);
    // The device address is known over HTTPS too: the wrong-code limit depends on it.
    const history = (await call('GET', '/history', undefined, token)).data.map((x) => x.text).join('\n');
    assert.match(history, /دخول من الجهاز 127\.0\.0\.1/);
  });
});
