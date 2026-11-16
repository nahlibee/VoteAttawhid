'use strict';
// Vote counting server. No dependencies: run with `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { computeResults, majority, norm } = require('./lib/results');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'vote.json');
const PUBLIC = path.join(__dirname, 'public');

let db = {
  settings: { expected: 170, present: 0, teamCode: '', supHash: '', supSalt: '' },
  people: [], // {id, name, isMember}
  rounds: [], // {id, title, kind, mode, candidates, min, max, seats, threshold, status, published, void}
  ballots: [], // {id, roundId, team, choices, at}
  sessions: {}, // token -> {role, team}
  seq: { p: 0, r: 0, b: 0 },
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(FILE)) {
  db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  fs.copyFileSync(FILE, path.join(DATA_DIR, `vote.backup-${Date.now()}.json`));
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

const hash = (code, salt) => crypto.scryptSync(String(code), salt, 32).toString('hex');
const isSetup = () => !!db.settings.supHash;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

const person = (id) => db.people.find((p) => p.id === id);
const round = (id) => db.rounds.find((r) => r.id === id) || bad('الجولة غير موجودة', 404);
const intIn = (v, lo, hi, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) bad(`قيمة غير صالحة: ${label}`);
  return n;
};

function addPerson(name, isMember) {
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) bad('الاسم فارغ');
  if (name.length > 80) bad('الاسم طويل جدا');
  const key = norm(name);
  let p = db.people.find((x) => norm(x.name) === key);
  if (p) {
    // A supervisor adding an existing non-member as a member promotes them.
    if (isMember && !p.isMember) p.isMember = true;
    return p;
  }
  p = { id: ++db.seq.p, name, isMember: !!isMember };
  db.people.push(p);
  return p;
}

function resultsFor(r) {
  return computeResults(r, db.ballots.filter((b) => b.roundId === r.id), db.people, db.settings);
}

function personUsed(id) {
  return db.ballots.some((b) => b.choices.includes(id)) || db.rounds.some((r) => r.candidates.includes(id));
}

function roundInput(body, existing) {
  const mode = body.mode === 'open' ? 'open' : 'list';
  const candidates = mode === 'list' ? [...new Set((body.candidates || []).map(Number))] : [];
  if (candidates.some((id) => !person(id))) bad('مرشح غير موجود في اللائحة');
  if (mode === 'list' && candidates.length < 2) bad('يجب اختيار مرشحين اثنين على الأقل');
  const min = intIn(body.min, 1, 20, 'الحد الأدنى');
  const max = intIn(body.max, min, 20, 'الحد الأقصى');
  if (mode === 'list' && max > candidates.length) bad('الحد الأقصى أكبر من عدد المرشحين');
  const title = String(body.title || '').trim().slice(0, 120) || bad('عنوان الجولة فارغ');
  return Object.assign(existing || {}, {
    title, mode, candidates, min, max,
    kind: String(body.kind || 'custom').slice(0, 20),
    seats: intIn(body.seats, 1, 20, 'عدد المقاعد'),
    threshold: ['none', 'absolute', 'present'].includes(body.threshold) ? body.threshold : 'none',
  });
}

// ---------- API ----------
function handle(method, url, body, session) {
  const seg = url.split('/').filter(Boolean).slice(1); // drop "api"
  const route = `${method} /${seg.join('/')}`;
  const sup = () => { if (!session || session.role !== 'supervisor') bad('غير مصرح', 401); };
  const any = () => { if (!session) bad('غير مصرح', 401); };
  const id = Number(seg[1]);

  if (route === 'GET /public') {
    return {
      ready: isSetup(),
      rounds: db.rounds.filter((r) => r.published).map((r) => {
        const results = resultsFor(r);
        // Free-nomination rounds only show who was retained, not every name written.
        if (r.mode === 'open') results.rows = results.rows.filter((x) => x.status === 'elected' || x.status === 'tied');
        return { id: r.id, title: r.title, kind: r.kind, mode: r.mode, seats: r.seats, results };
      }),
    };
  }

  if (route === 'POST /setup') {
    if (isSetup()) bad('تم الإعداد مسبقا');
    if (String(body.supervisorCode || '').length < 4) bad('رمز المشرف يجب أن يتكون من 4 رموز على الأقل');
    if (String(body.teamCode || '').length < 3) bad('رمز الفرق يجب أن يتكون من 3 رموز على الأقل');
    db.settings.supSalt = crypto.randomBytes(16).toString('hex');
    db.settings.supHash = hash(body.supervisorCode, db.settings.supSalt);
    db.settings.teamCode = String(body.teamCode);
    save();
    return { ok: true };
  }

  if (route === 'POST /login') {
    if (!isSetup()) bad('لم يتم إعداد البرنامج بعد');
    let s;
    if (body.role === 'supervisor') {
      const h = hash(body.code || '', db.settings.supSalt);
      if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(db.settings.supHash))) bad('الرمز غير صحيح', 401);
      s = { role: 'supervisor', team: 'المشرف' };
    } else {
      if (String(body.code || '') !== db.settings.teamCode) bad('الرمز غير صحيح', 401);
      const team = String(body.team || '').trim().slice(0, 30) || bad('اسم الفريق فارغ');
      s = { role: 'team', team };
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = s;
    save();
    return { token, ...s };
  }

  // ----- shared (team + supervisor) -----
  if (route === 'GET /team/state') {
    any();
    const open = db.rounds.filter((r) => r.status === 'open');
    const openIds = new Set(open.map((r) => r.id));
    const mine = db.ballots.filter((b) => b.team === session.team && openIds.has(b.roundId));
    const counts = {};
    for (const b of mine) counts[b.roundId] = (counts[b.roundId] || 0) + 1;
    return {
      team: session.team,
      rounds: open.map(({ id, title, mode, candidates, min, max }) => ({ id, title, mode, candidates, min, max })),
      people: db.people,
      counts,
      recent: mine.slice(-15).reverse(),
    };
  }

  if (route === 'POST /people') {
    any();
    const p = addPerson(body.name, session.role === 'supervisor' && body.isMember);
    save();
    return p;
  }

  if (route === 'POST /ballots') {
    any();
    const r = round(Number(body.roundId));
    if (r.status !== 'open') bad('هذه الجولة غير مفتوحة للإدخال');
    const choices = [...new Set((body.choices || []).map(Number))];
    if (choices.length !== (body.choices || []).length) bad('اسم مكرر في نفس الورقة');
    if (choices.length < r.min || choices.length > r.max) bad(`عدد الأسماء يجب أن يكون بين ${r.min} و ${r.max}. الورقة ملغاة: تسلم للمشرف`);
    for (const c of choices) {
      if (!person(c)) bad('اسم غير موجود');
      if (r.mode === 'list' && !r.candidates.includes(c)) bad('اسم خارج لائحة المرشحين');
    }
    const b = { id: ++db.seq.b, roundId: r.id, team: session.team, choices, at: Date.now() };
    db.ballots.push(b);
    save();
    return b;
  }

  if (method === 'DELETE' && seg[0] === 'ballots') {
    any();
    const b = db.ballots.find((x) => x.id === id) || bad('الورقة غير موجودة', 404);
    if (session.role !== 'supervisor') {
      if (b.team !== session.team) bad('لا يمكن حذف ورقة فريق آخر', 403);
      if (round(b.roundId).status !== 'open') bad('الجولة مغلقة', 403);
    }
    db.ballots = db.ballots.filter((x) => x !== b);
    save();
    return { ok: true };
  }

  // ----- supervisor only -----
  if (route === 'GET /admin/state') {
    sup();
    const used = new Set();
    for (const b of db.ballots) b.choices.forEach((c) => used.add(c));
    for (const r of db.rounds) r.candidates.forEach((c) => used.add(c));
    return {
      settings: {
        expected: db.settings.expected, present: db.settings.present, teamCode: db.settings.teamCode,
        absolute: majority(db.settings.expected), presentMajority: majority(db.settings.present),
      },
      people: db.people.map((p) => ({ ...p, used: used.has(p.id) })),
      rounds: db.rounds.map((r) => {
        const perTeam = {};
        for (const b of db.ballots) if (b.roundId === r.id) perTeam[b.team] = (perTeam[b.team] || 0) + 1;
        return { ...r, results: resultsFor(r), perTeam };
      }),
    };
  }

  if (route === 'PUT /settings') {
    sup();
    if (body.expected !== undefined) db.settings.expected = intIn(body.expected, 1, 100000, 'العدد المقرر');
    if (body.present !== undefined) db.settings.present = intIn(body.present, 0, 100000, 'عدد الحاضرين');
    if (body.teamCode !== undefined) {
      if (String(body.teamCode).length < 3) bad('رمز الفرق قصير جدا');
      db.settings.teamCode = String(body.teamCode);
    }
    if (body.supervisorCode) {
      if (String(body.supervisorCode).length < 4) bad('رمز المشرف قصير جدا');
      db.settings.supHash = hash(body.supervisorCode, db.settings.supSalt);
    }
    save();
    return { ok: true };
  }

  if (route === 'POST /people/import') {
    sup();
    const names = String(body.text || '').split(/[\r\n]+/).map((s) => s.split('\t')[0].trim()).filter(Boolean);
    if (names.length > 5000) bad('اللائحة طويلة جدا');
    const before = db.people.length;
    names.forEach((n) => addPerson(n, true));
    save();
    return { added: db.people.length - before, total: names.length };
  }

  if (route === 'POST /people/merge') {
    sup();
    const from = person(Number(body.from)) || bad('الاسم غير موجود', 404);
    const to = person(Number(body.to)) || bad('الاسم غير موجود', 404);
    if (from === to) bad('لا يمكن دمج الاسم في نفسه');
    const swap = (list) => [...new Set(list.map((c) => (c === from.id ? to.id : c)))];
    for (const b of db.ballots) b.choices = swap(b.choices);
    for (const r of db.rounds) r.candidates = swap(r.candidates);
    db.people = db.people.filter((p) => p !== from);
    save();
    return { ok: true };
  }

  if (seg[0] === 'people' && id) {
    sup();
    const p = person(id) || bad('الاسم غير موجود', 404);
    if (method === 'PATCH') {
      if (body.isMember !== undefined) p.isMember = !!body.isMember;
      if (body.name !== undefined) {
        const name = String(body.name).replace(/\s+/g, ' ').trim() || bad('الاسم فارغ');
        if (db.people.some((x) => x !== p && norm(x.name) === norm(name))) bad('هذا الاسم موجود مسبقا');
        p.name = name.slice(0, 80);
      }
      save();
      return p;
    }
    if (method === 'DELETE') {
      if (personUsed(p.id)) bad('لا يمكن حذف اسم ورد في أوراق التصويت أو في لائحة مرشحين');
      db.people = db.people.filter((x) => x !== p);
      save();
      return { ok: true };
    }
  }

  if (route === 'POST /rounds') {
    sup();
    const r = roundInput(body);
    Object.assign(r, { id: ++db.seq.r, status: 'draft', published: false, void: 0 });
    db.rounds.push(r);
    save();
    return r;
  }

  if (seg[0] === 'rounds' && id) {
    sup();
    const r = round(id);
    if (method === 'GET' && seg[2] === 'ballots') {
      return db.ballots.filter((b) => b.roundId === r.id);
    }
    if (method === 'PATCH') {
      if (body.status !== undefined) {
        if (!['draft', 'open', 'closed'].includes(body.status)) bad('حالة غير صالحة');
        r.status = body.status;
      }
      if (body.published !== undefined) r.published = !!body.published;
      if (body.void !== undefined) r.void = intIn(body.void, 0, 100000, 'الأوراق الملغاة');
      if (body.config) {
        if (db.ballots.some((b) => b.roundId === r.id)) bad('لا يمكن تعديل جولة تم إدخال أوراقها');
        roundInput(body.config, r);
      }
      save();
      return r;
    }
    if (method === 'DELETE') {
      db.rounds = db.rounds.filter((x) => x !== r);
      db.ballots = db.ballots.filter((b) => b.roundId !== r.id);
      save();
      return { ok: true };
    }
  }

  bad('المسار غير موجود', 404);
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (!path.extname(p)) p += '.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': 'no-cache',
    }).end(data);
  });
}

http.createServer((req, res) => {
  if (!req.url.startsWith('/api/')) return serveStatic(req, res);
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1e6) req.destroy(); else chunks.push(c);
  });
  req.on('end', () => {
    let status = 200;
    let out;
    try {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const session = db.sessions[req.headers['x-token']] || null;
      out = handle(req.method, req.url.split('?')[0], body || {}, session);
    } catch (e) {
      status = e.status || (e instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error(e);
      out = { error: e.status ? e.message : 'خطأ في الخادم' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`\nVote counting app is running.\n  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Other computers: http://${a.address}:${PORT}`);
    }
  }
  console.log('\n  Counting teams: /team   Supervisor: /admin   Public results: /\n');
});
