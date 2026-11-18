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
  teams: [], // {device, name}: one team per computer
  seq: { p: 0, r: 0, b: 0 },
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(FILE)) {
  db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  fs.copyFileSync(FILE, path.join(DATA_DIR, `vote.backup-${Date.now()}.json`));
  // Rounds closed before counts were frozen keep the counts in force now.
  for (const r of db.rounds) if (r.status === 'closed' && !r.frozen) r.frozen = countsNow();
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

const list = (v) => (Array.isArray(v) ? v : []);
const person = (id) => db.people.find((p) => p.id === id);
const round = (id) => db.rounds.find((r) => r.id === id) || bad('الجولة غير موجودة', 404);
const intIn = (v, lo, hi, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) bad(`قيمة غير صالحة: ${label}`);
  return n;
};

// addedBy: the team that wrote this unknown name. Such a name waits for the
// supervisor's decision (pending) and its votes are not counted until accepted.
function addPerson(name, isMember, addedBy) {
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) bad('الاسم فارغ');
  if (name.length > 80) bad('الاسم طويل جدا');
  const key = norm(name);
  let p = db.people.find((x) => norm(x.name) === key);
  if (p) {
    // A supervisor adding an existing non-member as a member promotes them.
    if (isMember && !p.isMember) p.isMember = true;
    if (isMember) delete p.pending;
    return p;
  }
  p = { id: ++db.seq.p, name, isMember: !!isMember };
  if (!isMember && addedBy) Object.assign(p, { pending: true, addedBy, addedAt: Date.now() });
  db.people.push(p);
  return p;
}

// Each computer is its own team: the first login of a computer creates the next
// free "الفريق N", and the same computer always gets the same team back.
function teamFor(device) {
  let t = db.teams.find((x) => x.device === device);
  if (!t) {
    const used = new Set([...db.teams.map((x) => x.name), ...db.ballots.map((b) => b.team), ...Object.values(db.sessions).map((s) => s.team)]);
    let n = 1;
    while (used.has(`الفريق ${n}`)) n++;
    t = { device, name: `الفريق ${n}` };
    db.teams.push(t);
  }
  return t;
}

// Splits the names written on a paper into those written once (counted) and
// those written more than once (not counted at all).
function splitDuplicates(ids) {
  const times = new Map();
  for (const id of ids) times.set(id, (times.get(id) || 0) + 1);
  const kept = [...times.keys()].filter((id) => times.get(id) === 1);
  const dropped = [...times.keys()].filter((id) => times.get(id) > 1);
  return { kept, dropped };
}

// The counts a round is judged on. A closed round keeps the counts it was closed
// with, so changing the present count later only affects rounds still in progress.
function countsNow() {
  return { expected: db.settings.expected, present: db.settings.present };
}

function resultsFor(r) {
  return computeResults(r, db.ballots.filter((b) => b.roundId === r.id), db.people, r.frozen || countsNow());
}

function personUsed(id) {
  return db.ballots.some((b) => b.choices.includes(id)) || db.rounds.some((r) => r.candidates.includes(id));
}

// The president vote is between the names retained by the latest nomination round
// (including any tied for the last place); the run-off is between candidates of the
// latest president vote. Returns null when there is no such earlier round.
function allowedCandidates(kind, exceptId) {
  const source = { president: 'nomination', runoff: 'president' }[kind];
  if (!source) return null;
  const prev = db.rounds.filter((r) => r.kind === source && r.id !== exceptId).sort((a, b) => b.id - a.id)[0];
  if (!prev) return null;
  const ids = kind === 'president'
    ? resultsFor(prev).rows.filter((x) => x.status === 'elected' || x.status === 'tied').map((x) => x.id)
    : prev.candidates;
  return { ids, title: prev.title };
}

function roundInput(body, existing) {
  const mode = body.mode === 'open' ? 'open' : 'list';
  const candidates = mode === 'list' ? [...new Set(list(body.candidates).map(Number))] : [];
  if (candidates.some((id) => !person(id))) bad('مرشح غير موجود في اللائحة');
  if (mode === 'list' && candidates.length < 2) bad('يجب اختيار مرشحين اثنين على الأقل');
  const allowed = mode === 'list' ? allowedCandidates(String(body.kind || ''), existing && existing.id) : null;
  if (allowed && candidates.some((id) => !allowed.ids.includes(id))) {
    bad(`المرشحون في هذه الجولة يجب أن يكونوا من المحتفظ بهم في «${allowed.title}»`);
  }
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
      const device = String(body.device || '');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) bad('معرف الحاسوب غير صالح');
      s = { role: 'team', team: teamFor(device).name };
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
    const cancelled = {};
    for (const b of mine) {
      const into = b.cancelled ? cancelled : counts;
      into[b.roundId] = (into[b.roundId] || 0) + 1;
    }
    return {
      team: session.team,
      rounds: open.map(({ id, title, mode, candidates, min, max }) => ({ id, title, mode, candidates, min, max })),
      people: db.people,
      counts,
      cancelled,
      recent: mine.slice(-15).reverse(),
    };
  }

  if (route === 'POST /people') {
    any();
    const p = session.role === 'supervisor' ? addPerson(body.name, !!body.isMember) : addPerson(body.name, false, session.team);
    save();
    return p;
  }

  if (route === 'POST /ballots') {
    any();
    const r = round(Number(body.roundId));
    if (r.status !== 'open') bad('هذه الجولة غير مفتوحة للإدخال');
    if (body.cancelled === true) {
      // A cancelled paper: recorded so it is counted per team and in total, gives no vote.
      const b = { id: ++db.seq.b, roundId: r.id, team: session.team, choices: [], cancelled: true, at: Date.now() };
      db.ballots.push(b);
      save();
      return b;
    }
    const written = list(body.choices).map(Number);
    // Names written on the paper that are not candidates of this round: the team
    // counts them (body.ignored) without having to type them.
    let ignored = body.ignored === undefined ? 0 : intIn(body.ignored, 0, 20, 'الأسماء الخارجة عن اللائحة');
    if (written.length + ignored > 20) bad('عدد الأسماء في الورقة كبير جدا');
    for (const c of written) if (!person(c)) bad('اسم غير موجود');
    // A name that is not a candidate, or is written more than once, is removed from
    // the paper as if it was never written. The limits are then checked on the rest.
    const outside = r.mode === 'list' ? written.filter((c) => !r.candidates.includes(c)) : [];
    ignored += outside.length;
    const { kept: choices, dropped } = splitDuplicates(written.filter((c) => !outside.includes(c)));
    if (choices.length < r.min || choices.length > r.max) {
      bad((dropped.length || ignored ? `بعد حذف الأسماء المكررة أو الخارجة عن اللائحة يبقى ${choices.length} من الأسماء. ` : '')
        + `عدد الأسماء يجب أن يكون بين ${r.min} و ${r.max}. الورقة ملغاة: سجلها بزر «ورقة ملغاة»`);
    }
    const b = { id: ++db.seq.b, roundId: r.id, team: session.team, choices, at: Date.now() };
    if (dropped.length) b.dropped = dropped;
    if (ignored) b.ignored = ignored;
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
      people: db.people.map((p) => ({ ...p, used: used.has(p.id), papers: db.ballots.filter((b) => b.choices.includes(p.id)).length })),
      teams: [...new Set([...db.teams.map((t) => t.name), ...db.ballots.map((b) => b.team)])]
        .map((name) => {
          const mine = db.ballots.filter((b) => b.team === name);
          const cancelled = mine.filter((b) => b.cancelled).length;
          return { name, ballots: mine.length - cancelled, cancelled };
        }),
      rounds: db.rounds.map((r) => {
        const perTeam = {};
        for (const b of db.ballots) {
          if (b.roundId !== r.id) continue;
          const t = perTeam[b.team] || (perTeam[b.team] = { valid: 0, cancelled: 0 });
          t[b.cancelled ? 'cancelled' : 'valid']++;
        }
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
    const swap = (ids) => ids.map((c) => (c === from.id ? to.id : c));
    for (const r of db.rounds) r.candidates = [...new Set(swap(r.candidates))];
    // A paper that had both spellings now has the same name twice: the duplicate
    // rule applies, and a paper left under the minimum becomes a cancelled paper.
    const cancelled = {};
    for (const b of db.ballots) {
      if (b.cancelled) continue;
      const { kept, dropped } = splitDuplicates(swap(b.choices));
      b.choices = kept;
      b.dropped = [...new Set(swap(b.dropped || []))].filter((id) => !kept.includes(id));
      if (dropped.length) b.dropped = [...new Set([...b.dropped, ...dropped])];
      if (!b.dropped.length) delete b.dropped;
      const r = db.rounds.find((x) => x.id === b.roundId);
      if (r && kept.length < r.min) {
        cancelled[r.title] = (cancelled[r.title] || 0) + 1;
        Object.assign(b, { choices: [], cancelled: true, cancelledByMerge: true });
        delete b.dropped;
        delete b.ignored;
      }
    }
    db.people = db.people.filter((p) => p !== from);
    save();
    return { ok: true, cancelled };
  }

  if (seg[0] === 'people' && id) {
    sup();
    const p = person(id) || bad('الاسم غير موجود', 404);
    if (method === 'PATCH') {
      if (body.isMember !== undefined) {
        // Accepting or rejecting a name added by a team settles it.
        p.isMember = !!body.isMember;
        delete p.pending;
      }
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
        if (body.status === 'closed' && r.status !== 'closed') r.frozen = countsNow();
        if (body.status !== 'closed') delete r.frozen;
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
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400).end(); return; }
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

function onRequest(req, res) {
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
}

// HTTPS is used when a certificate exists (create it with ./make-cert.sh).
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, 'certs');
const certFile = path.join(CERT_DIR, 'cert.pem');
const keyFile = path.join(CERT_DIR, 'key.pem');
const secure = fs.existsSync(certFile) && fs.existsSync(keyFile);
const scheme = secure ? 'https' : 'http';

let server;
if (secure) {
  const tls = require('https').createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, onRequest);
  // Same port for both: someone who types http:// is sent to https://.
  const redirect = http.createServer((req, res) => {
    res.writeHead(307, { Location: `https://${req.headers.host || 'localhost:' + PORT}${req.url}` }).end();
  });
  server = require('net').createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (first) => {
      socket.pause();
      socket.unshift(first);
      (first[0] === 22 ? tls : redirect).emit('connection', socket); // 22 = TLS handshake
      process.nextTick(() => socket.resume());
    });
  });
} else {
  server = http.createServer(onRequest);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nVote counting app is running${secure ? ' (HTTPS)' : ''}.\n  This computer:  ${scheme}://localhost:${PORT}`);
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr)/.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Other computers: ${scheme}://${a.address}:${PORT}`);
    }
  }
  if (!secure) console.log('\n  For HTTPS, run ./make-cert.sh then start again.');
  console.log('\n  Counting teams: /team   Supervisor: /admin   Public results: /\n');
});
