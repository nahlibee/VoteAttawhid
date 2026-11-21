'use strict';
// Browser test of every screen control, driven through Firefox's built-in remote
// protocol (WebDriver BiDi). It starts its own copy of the app on a spare port with
// empty data, so real votes are never touched.
//
//   node e2e/ui-check.js            (needs Firefox and openssl)
//
// Prints one line per check (IDs from docs/TEST_PLAN.md) and saves screenshots of
// failures in e2e/out/.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const KEY = { Enter: '', Backspace: '', Escape: '', ArrowDown: '', ArrowUp: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// ---------------- app server ----------------
let appProc = null;
async function startApp(port, dataDir, certDir) {
  appProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, CERT_DIR: certDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('app did not start: ' + log)), 8000);
    const on = (d) => { log += d; if (log.includes('Public results')) { clearTimeout(t); resolve(); } };
    appProc.stdout.on('data', on);
    appProc.stderr.on('data', on);
  });
}
const stopApp = () => new Promise((resolve) => {
  if (!appProc || appProc.exitCode !== null) return resolve();
  appProc.on('exit', resolve);
  appProc.kill();
});

// ---------------- Firefox remote control ----------------
class Bidi {
  async start(profile) {
    const port = await freePort();
    fs.mkdirSync(profile, { recursive: true });
    this.ff = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('firefox did not start: ' + log)), 30000);
      const on = (d) => { log += d; if (log.includes('WebDriver BiDi listening')) { clearTimeout(t); resolve(); } };
      this.ff.stdout.on('data', on);
      this.ff.stderr.on('data', on);
    });
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
    this.pending = new Map();
    this.n = 0;
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.type === 'error') reject(new Error(`${m.error}: ${m.message}`)); else resolve(m.result);
      }
    };
    await this.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
    // Dialogs are answered by the test, and recorded so their text can be checked.
    await this.send('script.addPreloadScript', { functionDeclaration: `() => {
      window.__log = []; window.__confirmNext = []; window.__promptNext = []; window.__errors = [];
      window.addEventListener('error', (e) => __errors.push(e.message));
      window.addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)));
      window.confirm = (m) => { __log.push('confirm:' + m); return __confirmNext.length ? __confirmNext.shift() : true; };
      window.prompt = (m, d) => { __log.push('prompt:' + m); return __promptNext.length ? __promptNext.shift() : d; };
      window.print = () => __log.push('print');
      window.__vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
      window.__find = (sel, text, within) => {
        const root = (within && document.querySelector(within)) || document.querySelector('dialog[open]') || document;
        const all = [...root.querySelectorAll(sel)].filter(__vis);
        if (text == null) return all[0] || null;
        return all.find((e) => e.textContent.trim() === text) || all.find((e) => e.textContent.includes(text)) || null;
      };
    }` });
  }
  send(method, params) {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout ' + method)); }, 30000);
    });
  }
  async page() {
    const { userContext } = await this.send('browser.createUserContext', {});
    const { context } = await this.send('browsingContext.create', { type: 'tab', userContext });
    await this.send('browsingContext.setViewport', { context, viewport: { width: 1200, height: 900 } });
    return new Page(this, context);
  }
  stop() { try { this.ws.close(); } catch {} this.ff.kill(); }
}

class Page {
  constructor(b, context) { this.b = b; this.ctx = context; }
  goto(url) { return this.b.send('browsingContext.navigate', { context: this.ctx, url, wait: 'complete' }); }
  async ev(expr) {
    const r = await this.b.send('script.evaluate', {
      expression: `(async () => JSON.stringify(await (async () => (${expr}))()))()`,
      target: { context: this.ctx }, awaitPromise: true, resultOwnership: 'none',
    });
    if (r.type === 'exception') throw new Error('page error: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
  }
  async waitFor(expr, what, ms = 8000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try { last = await this.ev(expr); if (last) return last; } catch (e) { last = e.message; }
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${what || expr} (last: ${JSON.stringify(last)})`);
  }
  // Real mouse click in the middle of the element.
  async click(sel, text, within) {
    const box = await this.waitFor(`(() => { const e = __find(${JSON.stringify(sel)}, ${JSON.stringify(text ?? null)}, ${JSON.stringify(within ?? null)});
      if (!e || e.disabled) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`, `clickable ${sel} "${text ?? ''}"`, 6000);
    await this.b.send('input.performActions', { context: this.ctx, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', x: box.x, y: box.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    await sleep(120);
  }
  async keys(list) {
    const actions = [];
    for (const k of list) actions.push({ type: 'keyDown', value: k }, { type: 'keyUp', value: k });
    await this.b.send('input.performActions', { context: this.ctx, actions: [{ type: 'key', id: 'kb', actions }] });
    await sleep(80);
  }
  type(text) { return this.keys([...text]); }
  press(name) { return this.keys([KEY[name] || name]); }
  // Set a field the way a person would: focus it, clear it, type.
  async fill(sel, value, text) {
    await this.click(sel, text);
    await this.ev(`(() => { const e = document.activeElement; e.select && e.select(); return true; })()`);
    await this.keys([KEY.Backspace]);
    await this.type(String(value));
  }
  text(sel = 'body') { return this.ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`); }
  async toast(includes, ms = 5000) {
    return this.waitFor(`(() => { const t = document.querySelector('#toast'); return t && t.classList.contains('show') && t.textContent.includes(${JSON.stringify(includes)}) && t.textContent; })()`, `message "${includes}"`, ms);
  }
  async errToast(includes) {
    return this.waitFor(`(() => { const t = document.querySelector('#toast'); return t && t.classList.contains('err') && t.textContent.includes(${JSON.stringify(includes)}) && t.textContent; })()`, `red message "${includes}"`);
  }
  answers({ confirm = [], prompt = [] }) { return this.ev(`(() => { __confirmNext.push(...${JSON.stringify(confirm)}); __promptNext.push(...${JSON.stringify(prompt)}); return true; })()`); }
  log() { return this.ev('window.__log'); }
  async shot(name) {
    const r = await this.b.send('browsingContext.captureScreenshot', { context: this.ctx });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  }
}

// ---------------- checks ----------------
const results = [];
let current = null;
async function check(id, what, fn, pages = []) {
  current = id;
  try {
    await fn();
    results.push({ id, ok: true, what });
    console.log(`OK   ${id}  ${what}`);
  } catch (e) {
    results.push({ id, ok: false, what, err: e.message });
    console.log(`FAIL ${id}  ${what}\n       ${e.message}`);
    for (const [i, p] of pages.entries()) await p.shot(`${id}-${i}`).catch(() => {});
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const A = 'أحمد العلوي', B = 'محمد بنعلي', C = 'فاطمة الزهراء', D = 'يوسف الإدريسي', E = 'خديجة المنصوري', F = 'عمر التازي', G = 'سعيد الفاسي', H = 'مريم الصقلي';
const PREFIX = { [A]: 'احم', [B]: 'محم', [C]: 'فاط', [D]: 'يوس', [E]: 'خدي', [F]: 'عمر', [G]: 'سعي', [H]: 'مري' };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vote-ui-'));
  const certs = path.join(tmp, 'certs');
  fs.mkdirSync(certs);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(certs, 'key.pem'), '-out', path.join(certs, 'cert.pem')], { stdio: 'ignore' });
  const port = await freePort();
  const data = path.join(tmp, 'data');
  await startApp(port, data, certs);
  const BASE = `https://localhost:${port}`;
  fs.rmSync(OUT, { recursive: true, force: true });

  const ff = new Bidi();
  await ff.start(path.join(tmp, 'ff'));
  const sup = await ff.page();
  const t1 = await ff.page();
  const t2 = await ff.page();
  const pub = await ff.page();
  const all = [sup, t1, t2, pub];

  // Admin helpers
  const tab = async (name) => { await sup.click(`[data-tab=${name}]`); await sup.waitFor(`document.querySelector('[data-tab=${name}]').classList.contains('on')`); };
  const card = (title) => `[...document.querySelectorAll('section.card')].find((s) => s.querySelector('h2') && s.querySelector('h2').textContent.startsWith(${JSON.stringify(title)}))`;
  const cardText = (title) => sup.ev(`(${card(title)} || {}).textContent || ''`);
  const clickInCard = async (title, text) => {
    await sup.ev(`(() => { document.querySelectorAll('[data-test-card]').forEach((e) => e.removeAttribute('data-test-card')); const c = ${card(title)}; if (c) c.setAttribute('data-test-card', '1'); return !!c; })()`);
    await sup.click('button', text, '[data-test-card]');
  };
  const waitCard = (title, includes, ms = 8000) => sup.waitFor(`((${card(title)} || {}).textContent || '').includes(${JSON.stringify(includes)})`, `"${includes}" in round «${title}»`, ms);

  // Team helpers
  const pick = async (t, name) => { await t.type(PREFIX[name] || name); await t.waitFor(`document.querySelector('.picker-item.active')`, 'suggestions'); await t.press('Enter'); };
  const nominate = async (t, names) => {
    for (const n of names) await pick(t, n);
    await t.press('Enter');
    await t.toast('تم حفظ الورقة');
    await t.waitFor(`document.querySelectorAll('.chip').length === 0`, 'entry cleared');
  };
  const keyFor = (t, name) => t.waitFor(`(() => { const b = [...document.querySelectorAll('.cand')].find((x) => x.textContent.includes(${JSON.stringify(name)})); return b && b.querySelector('kbd').textContent; })()`, 'candidate ' + name);
  const listVote = async (t, names, { outside = 0, dup = [] } = {}) => {
    for (const n of [...names, ...dup]) await t.keys([await keyFor(t, n)]);
    for (const n of dup) await t.click('button', `${n} مكرر`);
    for (let i = 0; i < outside; i++) await t.keys(['0']);
    await t.ev('document.activeElement.blur(), true');
    await t.press('Enter');
    await t.toast('تم حفظ الورقة');
    await t.waitFor(`!document.querySelector('.cand.on')`, 'selection cleared');
  };
  const teamCount = (t) => t.ev(`(document.querySelector('#side h2') || {}).textContent || ''`);

  // ---------- supervisor: first setup, login, tabs ----------
  await sup.goto(BASE + '/admin');
  await check('F26', 'Tabs stay hidden before login', async () => {
    await sup.waitFor(`document.querySelector('form.login')`, 'login form');
    assert(await sup.ev(`getComputedStyle(document.querySelector('#tabs')).display === 'none'`), 'tabs visible before login');
  }, [sup]);
  await check('M02', 'Setup refuses a 3-character supervisor code', async () => {
    await sup.fill('input[type=password]', 'abc');
    await sup.click('button', 'حفظ ودخول');
    await sup.errToast('4 رموز');
    assert(await sup.ev(`!!document.querySelector('form.login')`), 'left the form');
  }, [sup]);
  await check('M01', 'First setup with both codes opens the supervisor page', async () => {
    await sup.fill('input[type=password]', 'super1');
    await sup.click('button', 'حفظ ودخول');
    await sup.waitFor(`getComputedStyle(document.querySelector('#tabs')).display !== 'none'`, 'tabs');
  }, [sup]);
  await check('M04', 'Log out returns to the login form', async () => {
    await sup.click('#logout');
    await sup.waitFor(`!!document.querySelector('form.login') && document.querySelector('h2').textContent.includes('دخول المشرف')`, 'login form');
  }, [sup]);
  await check('M03', 'Wrong code refused, right code accepted', async () => {
    await sup.fill('input[type=password]', 'nope1');
    await sup.click('button', 'دخول');
    await sup.errToast('الرمز غير صحيح');
    await sup.fill('input[type=password]', 'super1');
    await sup.click('button', 'دخول');
    await sup.waitFor(`getComputedStyle(document.querySelector('#tabs')).display !== 'none'`, 'tabs');
  }, [sup]);
  await check('M05', 'Public results link opens / in a new tab', async () => {
    const l = await sup.ev(`(() => { const a = [...document.querySelectorAll('header a')].find((x) => x.textContent.includes('صفحة النتائج العامة')); return a && [a.getAttribute('href'), a.target]; })()`);
    assert(l && l[0] === '/' && l[1] === '_blank', JSON.stringify(l));
  }, [sup]);
  await check('M06', 'Each tab shows its screen and is highlighted', async () => {
    await tab('people'); assert((await sup.text('#app')).includes('إضافة عضو'), 'people screen');
    await tab('teams'); assert((await sup.text('#app')).includes('إنشاء فريق'), 'teams screen');
    await tab('settings'); assert((await sup.text('#app')).includes('أعداد الجمع العام'), 'settings screen');
    await tab('rounds'); assert((await sup.text('#app')).includes('جولة جديدة'), 'rounds screen');
  }, [sup]);

  // ---------- settings ----------
  await check('M07', 'Expected 10, present 9: majorities 6 and 5', async () => {
    await tab('settings');
    await sup.fill('input[type=number]', 10);
    await sup.ev(`(() => { const i = document.querySelectorAll('input[type=number]')[1]; i.focus(); i.select(); return true; })()`);
    await sup.keys([KEY.Backspace, '9']);
    await sup.click('button', 'حفظ');
    await sup.toast('تم الحفظ');
    await sup.waitFor(`document.querySelector('#app').textContent.includes('الأغلبية المطلقة = 6') && document.querySelector('#app').textContent.includes('أغلبية الحاضرين = 5')`, 'majorities 6 and 5');
  }, [sup]);
  await check('M08', 'Expected count 0 refused (by the browser form check or the app)', async () => {
    await sup.fill('input[type=number]', 0);
    await sup.click('button', 'حفظ');
    await sup.waitFor(`!document.querySelectorAll('input[type=number]')[0].validity.valid || (document.querySelector('#toast.err') || {}).textContent?.includes('قيمة غير صالحة')`, 'refusal');
    await sleep(500);
    await tab('rounds');
    await tab('settings');
    assert(await sup.ev(`document.querySelectorAll('input[type=number]')[0].value === '10'`), 'value changed');
  }, [sup]);
  await check('M10', 'Empty supervisor code keeps the old one', async () => {
    await sup.ev(`(() => { document.querySelectorAll('form')[1].querySelector('button').click(); return true; })()`);
    await sup.toast('تم الحفظ');
    await sup.click('#logout');
    await sup.fill('input[type=password]', 'super1');
    await sup.click('button', 'دخول');
    await sup.waitFor(`getComputedStyle(document.querySelector('#tabs')).display !== 'none'`, 'logged in with the unchanged supervisor code');
  }, [sup]);

  // ---------- member list ----------
  await check('M11', 'Paste 8 names: 8 added', async () => {
    await tab('people');
    await sup.click('textarea');
    await sup.ev(`(() => { const t = document.querySelector('textarea'); t.value = ${JSON.stringify([A, B, C, D, E, F, G, H].join('\n'))}; return true; })()`);
    await sup.click('button', 'إضافة اللائحة');
    await sup.toast('تمت إضافة 8 اسما من أصل 8');
    await sup.waitFor(`document.querySelector('#app').textContent.includes('اللائحة: 8 اسما')`, '8 in list');
  }, [sup]);
  await check('M12', 'Same list again: 0 added', async () => {
    await sup.ev(`(() => { document.querySelector('textarea').value = ${JSON.stringify([A, B].join('\n'))}; return true; })()`);
    await sup.click('button', 'إضافة اللائحة');
    await sup.toast('تمت إضافة 0');
  }, [sup]);
  const row = (name) => `[...document.querySelectorAll('.scroll tr')].find((r) => r.querySelector('td').firstChild.textContent === ${JSON.stringify(name)})`;
  const rowClick = async (name, text) => {
    await sup.ev(`(() => { document.querySelectorAll('[data-test-row]').forEach((e) => e.removeAttribute('data-test-row')); const r = ${row(name)}; if (r) r.setAttribute('data-test-row', '1'); return !!r; })()`);
    await sup.click('button', text, '[data-test-row]');
  };
  const rowText = (name) => sup.ev(`(${row(name)} || {}).textContent || ''`);
  await check('M13', 'Add one member', async () => {
    await sup.fill('input[placeholder="الاسم الكامل"]', 'اسم تجريبي');
    await sup.click('button', 'إضافة كعضو');
    await sup.toast('تمت الإضافة');
    await sup.waitFor(`(${row('اسم تجريبي')} || {}).textContent?.includes('عضو')`, 'new row');
  }, [sup]);
  await check('M14', 'Search filters the list as you type', async () => {
    await sup.click('input[placeholder="بحث في اللائحة…"]');
    await sup.type('فاط');
    await sup.waitFor(`document.querySelectorAll('.scroll tr').length === 1`, 'one row');
    await sup.keys(Array(3).fill(KEY.Backspace));
    await sup.waitFor(`document.querySelectorAll('.scroll tr').length === 9`, 'all rows back');
  }, [sup]);
  await check('M15', 'Correct a name', async () => {
    await sup.answers({ prompt: ['اسم تجريبي معدل'] });
    await rowClick('اسم تجريبي', 'تصحيح');
    await sup.toast('تم التصحيح');
    await sup.waitFor(`!!${row('اسم تجريبي معدل')}`, 'renamed row');
  }, [sup]);
  await check('M16', 'Rename to an existing name refused', async () => {
    await sup.answers({ prompt: [A] });
    await rowClick('اسم تجريبي معدل', 'تصحيح');
    await sup.errToast('موجود مسبقا');
  }, [sup]);
  await check('M17', 'Remove membership', async () => {
    await sup.answers({ confirm: [true] });
    await rowClick('اسم تجريبي معدل', 'إزالة العضوية');
    await sup.waitFor(`(${row('اسم تجريبي معدل')} || {}).textContent?.includes('غير عضو')`, 'badge غير عضو');
  }, [sup]);
  await check('M18', 'Make member again', async () => {
    await rowClick('اسم تجريبي معدل', 'اعتماده كعضو');
    await sup.toast('تم اعتماده كعضو');
    await sup.waitFor(`(() => { const t = (${row('اسم تجريبي معدل')} || {}).textContent || ''; return t.includes('عضو') && !t.includes('غير عضو'); })()`, 'badge عضو');
  }, [sup]);
  await check('M19', 'Delete an unused name (after confirming)', async () => {
    await sup.answers({ confirm: [false] });
    await rowClick('اسم تجريبي معدل', 'حذف');
    await sleep(400);
    assert(await sup.ev(`!!${row('اسم تجريبي معدل')}`), 'deleted although cancelled');
    await sup.answers({ confirm: [true] });
    await rowClick('اسم تجريبي معدل', 'حذف');
    await sup.toast('تم الحذف');
    await sup.waitFor(`!${row('اسم تجريبي معدل')}`, 'row gone');
  }, [sup]);

  // ---------- round dialog ----------
  await check('M24', 'New round window opens on the nomination type', async () => {
    await tab('rounds');
    await sup.click('button', '＋ جولة جديدة');
    await sup.waitFor(`document.querySelector('dialog[open] select').value === 'nomination'`, 'nomination selected');
  }, [sup]);
  await check('M25', 'Each round type fills its own rules', async () => {
    const want = { president: ['1', '1', '1', 'absolute'], runoff: ['1', '1', '1', 'present'], bureau: ['1', '5', '5', 'absolute'], bureau2: ['1', '1', '1', 'present'], nomination: ['3', '5', '5', 'none'] };
    for (const [k, v] of Object.entries(want)) {
      const got = await sup.ev(`(() => { const d = document.querySelector('dialog[open]'); const s = d.querySelector('select'); s.value = ${JSON.stringify(k)}; s.dispatchEvent(new Event('change'));
        const n = [...d.querySelectorAll('input[type=number]')].map((i) => i.value); return [...n, d.querySelectorAll('select')[1].value]; })()`);
      assert(JSON.stringify(got) === JSON.stringify(v), `${k}: ${JSON.stringify(got)}`);
    }
  }, [sup]);
  await check('M30', 'Cancel closes the window, no round created', async () => {
    await sup.click('button', 'إلغاء');
    await sup.waitFor(`!document.querySelector('dialog[open]')`, 'closed');
    assert((await sup.text('#app')).includes('لا توجد أي جولة'), 'a round was created');
  }, [sup]);
  await check('M26/M27/M28', 'Candidate picker adds and removes; 1 candidate refused', async () => {
    await sup.click('button', '＋ جولة جديدة');
    await sup.ev(`(() => { const s = document.querySelector('dialog[open] select'); s.value = 'president'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sup.click('dialog .picker-input');
    await sup.type('احم'); await sup.waitFor(`document.querySelector('dialog .picker-item.active')`); await sup.press('Enter');
    await sup.type('محم'); await sup.waitFor(`document.querySelector('dialog .picker-item.active')`); await sup.press('Enter');
    await sup.waitFor(`document.querySelectorAll('dialog .chip').length === 2`, 'two chips');
    await sup.ev(`(() => { [...document.querySelectorAll('dialog .chip')].find((c) => c.textContent.includes(${JSON.stringify(B)})).querySelector('button').click(); return true; })()`);
    await sup.waitFor(`document.querySelectorAll('dialog .chip').length === 1`, 'chip removed');
    await sup.click('button', 'حفظ');
    await sup.errToast('مرشحين اثنين على الأقل');
    await sup.click('button', 'إلغاء');
  }, [sup]);

  // ---------- teams created by the supervisor ----------
  const codeOf = (name) => sup.ev(`api('GET', '/admin/state').then((s) => s.teams.find((t) => t.name === ${JSON.stringify(name)}).code)`);
  let code1, code2;
  await check('M09', 'Supervisor creates two teams, each with its own code', async () => {
    await tab('teams');
    await sup.click('button', '＋ إنشاء فريق');
    await sup.toast('تم إنشاء الفريق');
    await sup.waitFor(`document.querySelector('#app').textContent.includes('الفريق 1')`, 'team 1');
    await sup.click('button', '＋ إنشاء فريق');
    await sup.waitFor(`document.querySelector('#app').textContent.includes('الفريق 2')`, 'team 2');
    code1 = await codeOf('الفريق 1');
    code2 = await codeOf('الفريق 2');
    assert(/^\d{5}$/.test(code1) && /^\d{5}$/.test(code2) && code1 !== code2, 'codes');
    assert((await sup.text('#app')).includes(code1), 'code shown');
    await tab('rounds');
  }, [sup]);

  // ---------- team login before any round ----------
  await t1.goto(BASE + '/team');
  await check('M47', 'Team login: wrong code refused, its own code gives its team', async () => {
    await t1.fill('input[type=password]', 'team1');
    await t1.click('button', 'دخول');
    await t1.errToast('الرمز غير صحيح');
    await t1.fill('input[type=password]', code1);
    await t1.click('button', 'دخول');
    await t1.waitFor(`document.querySelector('#who').textContent === 'الفريق 1'`, 'header الفريق 1');
  }, [t1]);
  await check('M48', 'No round open: waiting message', async () => {
    await t1.waitFor(`document.querySelector('#app').textContent.includes('لا توجد جولة مفتوحة')`, 'waiting message');
  }, [t1]);
  await t2.goto(BASE + '/team');
  await check('M47b', 'The second code opens the second team; the first code still opens the first', async () => {
    await t2.fill('input[type=password]', code2);
    await t2.click('button', 'دخول');
    await t2.waitFor(`document.querySelector('#who').textContent === 'الفريق 2'`, 'header الفريق 2');
    await t1.click('#logout');
    await t1.fill('input[type=password]', code1);
    await t1.click('button', 'دخول');
    await t1.waitFor(`document.querySelector('#who').textContent === 'الفريق 1'`, 'still الفريق 1');
  }, [t1, t2]);
  await check('M47d', 'A second device cannot open a team already in use', async () => {
    const other = await ff.page();
    await other.goto(BASE + '/team');
    await other.fill('input[type=password]', code1);
    await other.click('button', 'دخول');
    await other.errToast('مفتوح على جهاز آخر');
    assert(await other.ev(`!!document.querySelector('form.login')`), 'second device got in');
  }, [t1]);

  // ---------- nomination round ----------
  await check('M29', 'Create the nomination round', async () => {
    await sup.click('button', '＋ جولة جديدة');
    await sup.click('button', 'حفظ');
    await sup.toast('تم حفظ الجولة');
    await waitCard('انتخاب الرئيس - الترشيح', 'لم تفتح بعد');
  }, [sup]);
  await check('M31', 'Edit the title of a round without papers', async () => {
    await clickInCard('انتخاب الرئيس - الترشيح', 'تعديل');
    await sup.fill('dialog input[type=text]', 'الترشيح لرئاسة الجهة');
    await sup.click('button', 'حفظ');
    await waitCard('الترشيح لرئاسة الجهة', 'لم تفتح بعد');
  }, [sup]);
  const NOM = 'الترشيح لرئاسة الجهة';
  await check('M33', 'Open the round; it appears for the teams by itself', async () => {
    await clickInCard(NOM, 'فتح الإدخال');
    await waitCard(NOM, 'مفتوحة للإدخال');
    await t1.waitFor(`!!document.querySelector('.picker-input')`, 'entry screen on team 1', 9000);
  }, [sup, t1]);

  await check('M50', 'Typing 3 letters lists the names, first one highlighted', async () => {
    await t1.click('.picker-input');
    await t1.type('ال');
    await t1.waitFor(`document.querySelectorAll('.picker-item').length > 1 && document.querySelector('.picker-item').classList.contains('active')`, 'suggestions');
  }, [t1]);
  await check('M51', 'Arrow down + Enter adds the highlighted name as a chip', async () => {
    const second = await t1.ev(`document.querySelectorAll('.picker-item')[1].textContent`);
    await t1.press('ArrowDown');
    await t1.press('Enter');
    await t1.waitFor(`document.querySelector('.chip') && document.querySelector('.chip').textContent.includes(${JSON.stringify(second)}.trim())`, 'chip of the second name');
  }, [t1]);
  await check('M52', 'Escape clears the field', async () => {
    await t1.type('محم');
    await t1.press('Escape');
    assert(await t1.ev(`document.querySelector('.picker-input').value === ''`), 'not cleared');
  }, [t1]);
  await check('M53', 'Backspace on the empty field removes the last chip', async () => {
    await t1.press('Backspace');
    await t1.waitFor(`document.querySelectorAll('.chip').length === 0`, 'no chips');
  }, [t1]);
  await check('M54', '× on a chip removes that name', async () => {
    await pick(t1, A); await pick(t1, B);
    await t1.ev(`(() => { [...document.querySelectorAll('.chip')].find((c) => c.textContent.includes(${JSON.stringify(A)})).querySelector('button').click(); return true; })()`);
    await t1.waitFor(`document.querySelectorAll('.chip').length === 1 && document.querySelector('.chip').textContent.includes(${JSON.stringify(B)})`, 'only B left');
  }, [t1]);
  await check('M59', 'Clear removes all names', async () => {
    await pick(t1, C);
    await t1.click('button', 'مسح');
    await t1.waitFor(`document.querySelectorAll('.chip').length === 0`, 'cleared');
  }, [t1]);
  await check('M56', 'Two names: save greyed out; Enter says to set the paper aside, nothing recorded', async () => {
    await pick(t1, A); await pick(t1, B);
    assert(await t1.ev(`document.querySelector('#save').disabled`), 'save enabled with 2 names');
    await t1.press('Enter');
    await t1.errToast('ضع الورقة جانبا');
    await sleep(300);
    const count = await teamCount(t1);
    assert(count.includes('0 صحيحة') && !count.includes('ملغاة'), count);
    await t1.click('button', 'مسح');
    await t1.waitFor(`document.querySelectorAll('.chip').length === 0`, 'cleared');
  }, [t1]);
  await check('M57', 'A 6th name is refused', async () => {
    for (const n of [A, B, C, D, E]) await pick(t1, n);
    await pick(t1, F);
    await t1.errToast('الحد الأقصى 5');
    assert(await t1.ev(`document.querySelectorAll('.chip').length === 5`), 'six chips');
    await t1.click('button', 'مسح');
  }, [t1]);
  await check('M58', 'Paper with 3 names saved; counter +1', async () => {
    await nominate(t1, [A, B, C]);
    await t1.waitFor(`document.querySelector('#side h2').textContent.includes('1 صحيحة')`, 'valid count 1');
  }, [t1]);
  await check('M56b', 'Same name twice: struck through, not counted', async () => {
    for (const n of [A, B, C, D]) await pick(t1, n);
    await pick(t1, A);
    await t1.waitFor(`document.querySelector('.chip.dup') && document.querySelector('.chip.dup').textContent.includes('مكرر')`, 'struck chip');
    assert((await t1.text('#hint')).includes('الأسماء المحتسبة: 3'), await t1.text('#hint'));
    await t1.press('Enter');
    await t1.toast('تم حفظ الورقة');
    await t1.waitFor(`document.querySelector('#side').textContent.includes('مكرر لا يحتسب: ' + ${JSON.stringify(A)})`, 'paper shows the dropped name');
  }, [t1]);
  await check('M55', 'Unknown name added by the team: orange chip, waiting for the supervisor', async () => {
    await t1.type('حسن الغريب');
    await t1.waitFor(`document.querySelector('.picker-item.create')`, 'add option');
    await t1.answers({ confirm: [true] });
    await t1.press('Enter');
    await t1.waitFor(`document.querySelector('.chip.nonmember') && document.querySelector('.chip.nonmember').textContent.includes('في انتظار مصادقة المشرف')`, 'waiting chip');
    await pick(t1, A); await pick(t1, B);
    await t1.press('Enter');
    await t1.toast('تم حفظ الورقة');
  }, [t1]);
  await check('M18b', 'Supervisor is notified: message, notice with name, team, papers; tab title (1)', async () => {
    await sup.waitFor(`document.querySelector('#pending').textContent.includes('حسن الغريب') && document.querySelector('#pending').textContent.includes('أضافه الفريق 1') && document.querySelector('#pending').textContent.includes('ورد في 1 ورقة')`, 'notice', 8000);
    assert((await sup.ev('document.title')).startsWith('(1)'), await sup.ev('document.title'));
    await sup.toast('اسم جديد يحتاج إلى قرارك');
  }, [sup]);
  await check('M58b', 'The team page has no button to record a cancelled paper', async () => {
    assert(await t1.ev(`![...document.querySelectorAll('button')].some((b) => b.textContent.includes('ملغاة'))`), 'button still shown');
  }, [t1]);
  await check('M62a', 'A team asks to delete its paper: still counted until the supervisor accepts', async () => {
    await nominate(t1, [A, F, G]);
    await t1.waitFor(`document.querySelector('#side h2').textContent.includes('4 صحيحة')`, '4 valid');
    await t1.answers({ confirm: [true] });
    await t1.click('#side button', 'طلب حذف');
    await t1.toast('تم إرسال طلب الحذف');
    await t1.waitFor(`document.querySelector('#side').textContent.includes('في انتظار موافقة المشرف')`, 'waiting badge');
    assert((await teamCount(t1)).includes('4 صحيحة'), await teamCount(t1));
    await sup.waitFor(`document.querySelector('#requests').textContent.includes('الفريق 1')`, 'notice', 8000);
    await sup.answers({ confirm: [true] });
    await sup.click('#requests button', 'قبول الحذف');
    await sup.toast('تم حذف الورقة');
    await t1.waitFor(`document.querySelector('#side h2').textContent.includes('3 صحيحة')`, 'back to 3', 9000);
  }, [t1, sup]);

  // Team 2 papers: B 8, A 6, C 6, D 5, E 5 after merge; see docs.
  await check('S1a', 'Team 2 enters its nomination papers, including two unknown names', async () => {
    await t2.waitFor(`!!document.querySelector('.picker-input')`, 'entry screen');
    for (const p of [[A, B, C, D, E], [A, B, C, D, E], [A, B, D, E, F], [A, C, E, 'حسن', G], [B, C, D, E, H]]) await nominate(t2, p);
    for (const [name, rest] of [['محمد بن علي', [F, G]], ['شخص مرفوض', [F, H]]]) {
      await t2.type(name);
      await t2.waitFor(`document.querySelector('.picker-item.create')`, 'add option');
      await t2.answers({ confirm: [true] });
      await t2.press('Enter');
      await t2.waitFor(`document.querySelectorAll('.chip').length === 1`, 'chip');
      await nominate(t2, rest);
    }
    await t2.waitFor(`document.querySelector('#side h2').textContent.includes('7 صحيحة')`, '7 valid');
  }, [t2, t1]);
  await check('M45/M47c', 'Supervisor totals update live, per team', async () => {
    await waitCard(NOM, 'الفريق 1: 3 صحيحة');
    await waitCard(NOM, 'الفريق 2: 7 صحيحة');
    await waitCard(NOM, 'الأوراق الصحيحة: 10');
    assert((await sup.text('#app')).includes('الفرق: الفريق 1: 3 صحيحة'), 'team list at the top');
  }, [sup]);
  await check('M46', 'Warning when papers exceed the present count', async () => {
    await waitCard(NOM, 'أكبر من عدد الحاضرين');
  }, [sup]);
  await check('S6a', 'Waiting names are not counted and flagged on the round', async () => {
    await waitCard(NOM, 'أسماء في انتظار مصادقتك قد تغير هذه النتيجة');
    const t = await cardText(NOM);
    assert(t.includes('في انتظار المصادقة'), 'badge missing');
  }, [sup]);
  await check('M18c', 'Accept, reject and «same member» on waiting names', async () => {
    await sup.waitFor(`document.querySelectorAll('#pending tr').length === 3`, '3 waiting names');
    const decide = async (name, text) => {
      await sup.ev(`(() => { document.querySelectorAll('[data-test-row]').forEach((e) => e.removeAttribute('data-test-row')); const r = [...document.querySelectorAll('#pending tr')].find((x) => x.textContent.includes(${JSON.stringify(name)})); r.setAttribute('data-test-row', '1'); return true; })()`);
      await sup.click('button', text, '[data-test-row]');
    };
    await decide('حسن الغريب', 'مصادقة: عضو');
    await sup.toast('تمت المصادقة');
    await sup.answers({ confirm: [true] });
    await decide('شخص مرفوض', 'رفض: ليس عضوا');
    await sup.toast('تم رفض');
    await decide('محمد بن علي', 'نفس عضو موجود');
    await sup.waitFor(`document.querySelector('dialog[open]') && document.querySelector('dialog[open] h2').textContent.includes('محمد بن علي')`, 'merge window');
    await sup.click('dialog .picker-input');
    await sup.type('محمد بنع');
    await sup.waitFor(`document.querySelector('dialog .picker-item.active')`);
    await sup.press('Enter');
    await sup.click('button', 'دمج', 'dialog[open] .row');
    await sup.toast('تم الدمج');
    await sup.waitFor(`document.querySelectorAll('#pending tr').length === 0 && !document.title.startsWith('(')`, 'notice gone');
  }, [sup]);
  await check('S1b', 'Nomination result: B 8, A 6, C 6, D 5, E 5 kept; Hassan counted (2)', async () => {
    await waitCard(NOM, 'المرشحون المحتفظ بهم');
    const rows = await sup.ev(`[...(${card(NOM)}).querySelectorAll('table.tally tbody tr')].map((r) => [r.children[1].firstChild.textContent, r.children[2].textContent, r.className])`);
    const get = (n) => rows.find((r) => r[0] === n) || [];
    for (const [n, v] of [[B, '8'], [A, '6'], [C, '6'], [D, '5'], [E, '5']]) assert(get(n)[1] === v && get(n)[2] === 'elected', `${n}: ${JSON.stringify(get(n))}`);
    assert(get('حسن الغريب')[1] === '2' && get('حسن الغريب')[2] === 'below', 'hassan ' + JSON.stringify(get('حسن الغريب')));
    assert(!get('شخص مرفوض').length, 'rejected name still listed: its paper is left with 2 names, so it is cancelled');
    assert(!rows.some((r) => r[0] === 'محمد بن علي'), 'merged name still listed');
  }, [sup]);
  await check('M20', 'A name with votes has no delete button', async () => {
    await tab('people');
    const t = await rowText(A);
    assert(t && !t.includes('حذف'), t);
    await tab('rounds');
  }, [sup]);
  await check('M21-M23', 'Merge window: no name chosen refused; cancel closes', async () => {
    await tab('people');
    await rowClick('شخص مرفوض', 'دمج');
    await sup.waitFor(`!!document.querySelector('dialog[open]')`, 'window');
    await sup.click('button', 'دمج', 'dialog[open] .row');
    await sup.errToast('اختر الاسم الصحيح');
    await sup.click('button', 'إلغاء');
    await sup.waitFor(`!document.querySelector('dialog[open]')`, 'closed');
    await tab('rounds');
  }, [sup]);
  await check('M36', 'Supervisor adds 1 cancelled paper: it is in the total', async () => {
    await sup.ev(`(() => { const i = (${card(NOM)}).querySelector('input[type=number]'); i.value = '1'; return true; })()`);
    await clickInCard(NOM, 'حفظ');
    await waitCard(NOM, 'مجموع الملغاة: 2 (من الأوراق المدخلة: 1، المشرف: 1)');
    await waitCard(NOM, 'المجموع: 11');
  }, [sup]);
  await check('M65', 'Supervisor rejects a delete request: paper stays counted, cannot be asked again', async () => {
    await nominate(t1, [A, F, H]);
    await waitCard(NOM, 'الأوراق الصحيحة: 10');
    await t1.answers({ confirm: [true] });
    await t1.click('#side button', 'طلب حذف');
    await sup.waitFor(`document.querySelector('#requests').textContent.includes('الفريق 1')`, 'notice', 8000);
    await sup.click('#requests button', 'رفض');
    await sup.toast('تم رفض الحذف');
    await t1.waitFor(`document.querySelector('#side tr').textContent.includes('رفض المشرف الحذف') && !document.querySelector('#side tr').textContent.includes('طلب حذف')`, 'rejected badge', 9000);
    await waitCard(NOM, 'الأوراق الصحيحة: 10');
  }, [sup, t1]);
  await check('M39-M41', 'Papers window lists papers; delete one; close', async () => {
    await waitCard(NOM, 'الأوراق الصحيحة: 10');
    await clickInCard(NOM, 'الأوراق');
    await sup.waitFor(`document.querySelector('dialog[open]') && document.querySelector('dialog[open]').textContent.includes('مكرر لا يحتسب')`, 'papers list');
    await sup.answers({ confirm: [true] });
    await sup.click('dialog[open] tr:first-child button', 'حذف');
    await sup.toast('تم حذف الورقة');
    await waitCard(NOM, 'الأوراق الصحيحة: 9');
    await clickInCard(NOM, 'الأوراق');
    await sup.click('button', 'إغلاق');
    await sup.waitFor(`!document.querySelector('dialog[open]')`, 'closed');
  }, [sup]);
  await check('M32', 'No edit button on a round that has papers', async () => {
    assert(!(await cardText(NOM)).includes('تعديل'), 'edit shown');
  }, [sup]);
  await check('M34', 'Close the round: it leaves the team screens', async () => {
    await clickInCard(NOM, 'إغلاق الإدخال');
    await waitCard(NOM, 'مغلقة');
    await t1.waitFor(`document.querySelector('#app').textContent.includes('لا توجد جولة مفتوحة')`, 'team 1 waiting', 9000);
  }, [sup, t1]);
  await pub.goto(BASE + '/');
  await check('M37', 'Publish: public page shows the 5 retained names only', async () => {
    assert((await pub.text('#app')).includes('لم تعلن أي نتيجة بعد'), 'not empty before publishing');
    await clickInCard(NOM, 'نشر النتيجة للعموم');
    await waitCard(NOM, 'منشورة للعموم');
    await pub.waitFor(`document.querySelectorAll('table.tally tbody tr').length === 5`, '5 rows on the public page', 9000);
    const t = await pub.text('#app');
    assert(!t.includes('حسن الغريب') && !t.includes('شخص مرفوض'), 'non-retained names shown');
  }, [sup, pub]);
  await check('M38', 'Hide: result leaves the public page', async () => {
    await clickInCard(NOM, 'إخفاء عن العموم');
    await pub.waitFor(`document.querySelector('#app').textContent.includes('لم تعلن أي نتيجة بعد')`, 'hidden', 9000);
  }, [sup, pub]);
  await check('M43', 'Next round button prefills the president vote with the 5 names; only retained names can be added', async () => {
    await clickInCard(NOM, 'إنشاء الجولة التالية');
    await sup.waitFor(`document.querySelector('dialog[open] select').value === 'president' && document.querySelectorAll('dialog[open] .chip').length === 5`, 'prefilled');
    assert(await sup.ev(`[...document.querySelectorAll('dialog[open] label')].some((l) => l.textContent.includes('من المحتفظ بهم في «الترشيح لرئاسة الجهة»'))`), 'label');
    await sup.click('dialog .picker-input');
    await sup.type('عمر'); // not retained by the nomination
    await sleep(300);
    assert(await sup.ev(`document.querySelectorAll('dialog .picker-item').length === 0`), 'a name not retained is offered');
    await sup.press('Escape');
    await sleep(200);
    assert(await sup.ev(`!!document.querySelector('dialog[open]') && document.querySelectorAll('dialog[open] .chip').length === 5`), 'Escape in the name field closed the window');
    await sup.click('button', 'حفظ');
    await sup.toast('تم حفظ الجولة');
  }, [sup]);

  // ---------- president vote ----------
  const PRES = 'انتخاب الرئيس - التصويت';
  await check('M60/M61', 'Number keys select, a second key moves the choice, Enter with none refused', async () => {
    await clickInCard(PRES, 'فتح الإدخال');
    await t1.waitFor(`document.querySelectorAll('.cand').length === 5`, 'candidates', 9000);
    await t1.keys([await keyFor(t1, A)]);
    await t1.waitFor(`document.querySelector('.cand.on') && document.querySelector('.cand.on').textContent.includes(${JSON.stringify(A)})`, 'A selected');
    const kb = await keyFor(t1, B);
    await t1.keys(['٠١٢٣٤٥٦٧٨٩'[Number(kb)]]); // Arabic digit
    await t1.waitFor(`document.querySelectorAll('.cand.on').length === 1 && document.querySelector('.cand.on').textContent.includes(${JSON.stringify(B)})`, 'moved to B (Arabic digit)');
    await t1.keys([kb]);
    await t1.waitFor(`document.querySelectorAll('.cand.on').length === 0`, 'deselected');
    await t1.press('Enter');
    await t1.errToast('ضع الورقة جانبا');
    assert(!/null|undefined/.test(await t1.text('#entry')), 'stray text: ' + (await t1.text('#entry')).slice(0, 200));
  }, [sup, t1]);
  await check('M56c', '«… مكرر» in a 1-name round: struck, paper cannot be saved', async () => {
    await t1.keys([await keyFor(t1, A)]);
    await t1.click('button', `${A} مكرر`);
    await t1.waitFor(`document.querySelector('.cand.dup')`, 'struck candidate');
    assert(await t1.ev(`document.querySelector('#save').disabled`), 'save enabled');
    await t1.click('button', 'مسح');
  }, [t1]);
  await check('M56d', 'Key 0 counts a name outside the list; «−» undoes it; saved paper shows it', async () => {
    await t1.keys(['0']);
    await t1.waitFor(`document.querySelector('#entry').textContent.includes('لا تحتسب: 1')`, 'counter 1');
    await t1.click('button', '−');
    await t1.waitFor(`!document.querySelector('#entry').textContent.includes('لا تحتسب: 1')`, 'counter 0');
    await listVote(t1, [A], { outside: 1 });
    assert((await t1.text('#side')).includes('أسماء خارج اللائحة لا تحتسب: 1'), 'not shown on the paper');
  }, [t1]);
  await check('S2a', 'President vote A 4, B 3, C 2: no majority, run-off announced', async () => {
    for (const n of [A, A, A, B, B, B, C, C]) await listVote(n === C ? t2 : t1, [n]);
    await waitCard(PRES, 'الأوراق الصحيحة: 9');
    const t = await cardText(PRES);
    assert(t.includes('لم يحصل أي مرشح على الأغلبية المطلوبة (6'), t.slice(0, 300));
    assert(t.includes(`يعاد التصويت بين الأول والثاني: ${A} ، ${B}`), 'run-off sentence');
  }, [sup]);
  await check('M49', 'Only one round open: the second is refused until the first is closed', async () => {
    const NEXT = 'انتخاب الرئيس - الدور الثاني';
    await clickInCard(PRES, 'إنشاء الجولة التالية');
    await sup.waitFor(`document.querySelector('dialog[open] select').value === 'runoff' && document.querySelectorAll('dialog[open] .chip').length === 2`, 'run-off prefilled with 2');
    await sup.click('button', 'حفظ');
    await sup.toast('تم حفظ الجولة');
    await waitCard(NEXT, 'لم تفتح بعد');
    await clickInCard(NEXT, 'فتح الإدخال');
    await sup.errToast('أغلق أولا الجولة المفتوحة');
    assert((await cardText(NEXT)).includes('لم تفتح بعد'), 'second round opened');
    await clickInCard(PRES, 'إغلاق الإدخال');
    await waitCard(PRES, 'مغلقة');
    await clickInCard(NEXT, 'فتح الإدخال');
    await waitCard(NEXT, 'مفتوحة للإدخال');
    await t1.waitFor(`document.querySelectorAll('.cand').length === 2`, 'only the run-off left', 9000);
    await t2.waitFor(`document.querySelectorAll('.cand').length === 2`, 'team 2 on the run-off', 9000);
  }, [sup, t1]);
  const RUN = 'انتخاب الرئيس - الدور الثاني';
  await check('M07b', 'Changing the present count moves the open round only', async () => {
    await sup.fill('input[name=present]', 7);
    await sup.click('button', 'تحديث');
    await sup.toast('تم تحديث عدد الحاضرين');
    await waitCard(RUN, 'تعتمد هذه الجولة العدد الحالي: الحاضرون 7');
    assert((await cardText(PRES)).includes('اعتمدت هذه الجولة عند إغلاقها: الحاضرون 9'), 'closed round moved');
  }, [sup]);
  await check('M07c', 'Reopening a round closed with another count asks first', async () => {
    await sup.answers({ confirm: [false] });
    await clickInCard(PRES, 'إعادة فتح الإدخال');
    await sup.waitFor(`__log.some((m) => m.includes('عند إعادة فتحها تعتمد العدد الحالي (7)'))`, 'question');
    await sleep(300);
    assert((await cardText(PRES)).includes('مغلقة'), 'reopened although cancelled');
    await sup.fill('input[name=present]', 9);
    await sup.click('button', 'تحديث');
    await waitCard(RUN, 'الحاضرون 9');
  }, [sup]);
  await check('S2b', 'Run-off A 5, B 4: «المنتخب: A» with majority 5; published', async () => {
    for (const [t, n] of [[t1, A], [t1, A], [t1, A], [t2, A], [t2, A], [t1, B], [t2, B], [t2, B], [t2, B]]) await listVote(t, [n]);
    await waitCard(RUN, `المنتخب: ${A}`);
    assert((await cardText(RUN)).includes('أغلبية الحاضرين (9): 5 صوتا'), 'majority 5');
    await clickInCard(RUN, 'إغلاق الإدخال');
    await clickInCard(RUN, 'نشر النتيجة للعموم');
    await pub.waitFor(`document.querySelector('#app').textContent.includes(${JSON.stringify('المنتخب: ' + A)})`, 'public winner', 9000);
    assert(!(await pub.text('#app')).includes('الفائز'), 'old word');
  }, [sup, pub]);
  await check('M35', 'Reopen a closed round, then close it again', async () => {
    await clickInCard(RUN, 'إعادة فتح الإدخال');
    await waitCard(RUN, 'مفتوحة للإدخال');
    await clickInCard(RUN, 'إغلاق الإدخال');
    await waitCard(RUN, 'مغلقة');
  }, [sup]);

  // ---------- bureau ----------
  const BUR = 'عضوية المكتب الجهوي - التصويت';
  await check('S7a', 'Bureau round with 6 candidates added through the picker', async () => {
    await sup.click('button', '＋ جولة جديدة');
    await sup.ev(`(() => { const s = document.querySelector('dialog[open] select'); s.value = 'bureau'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sup.click('dialog .picker-input');
    for (const n of [A, B, C, D, E, F]) { await sup.type(PREFIX[n]); await sup.waitFor(`document.querySelector('dialog .picker-item.active')`); await sup.press('Enter'); }
    await sup.waitFor(`document.querySelectorAll('dialog .chip').length === 6`, '6 chips');
    await sup.click('button', 'حفظ');
    await clickInCard(BUR, 'فتح الإدخال');
    await t1.waitFor(`document.querySelectorAll('.cand').length === 6`, 'bureau entry', 9000);
  }, [sup, t1]);
  await check('S8a', 'Bureau: A, B, C reach 6; D 5; paper with an outside name and one with a duplicate still count', async () => {
    await t2.waitFor(`document.querySelectorAll('.cand').length === 6`, 'bureau entry on team 2', 9000);
    await listVote(t1, [A, B, C, D]);
    await listVote(t1, [A, B, C, D]);
    await listVote(t1, [A, B, C], { outside: 1 });
    await listVote(t1, [A, B, C], { dup: [D] });
    await listVote(t2, [A, B, C]);
    await listVote(t2, [A, B, C]);
    for (let i = 0; i < 3; i++) await listVote(t2, [D, E, F]);
    await waitCard(BUR, 'الأوراق الصحيحة: 9');
    const t = await cardText(BUR);
    assert(t.includes(`الأعضاء المحتفظ بهم: ${A}`) || t.includes('الأعضاء المحتفظ بهم'), 'kept sentence');
    assert(t.includes('مقاعد لم تحسم بعد: 2'), 'seats left 2');
    assert(!t.includes('منتخب'), 'bureau says elected');
  }, [sup]);
  await check('S8b', 'Re-vote prefilled with D, E, F for 2 seats; D and E kept', async () => {
    await clickInCard(BUR, 'إغلاق الإدخال');
    await clickInCard(BUR, 'إنشاء الجولة التالية');
    await sup.waitFor(`document.querySelector('dialog[open] select').value === 'bureau2' && document.querySelectorAll('dialog[open] .chip').length === 3`, '3 candidates');
    const nums = await sup.ev(`[...document.querySelectorAll('dialog[open] input[type=number]')].map((i) => i.value)`);
    assert(JSON.stringify(nums) === JSON.stringify(['1', '2', '2']), JSON.stringify(nums));
    await sup.click('button', 'حفظ');
    const RE = 'عضوية المكتب الجهوي - إعادة التصويت';
    await clickInCard(RE, 'فتح الإدخال');
    await t1.waitFor(`document.querySelectorAll('.cand').length === 3`, 're-vote entry', 9000);
    await t2.waitFor(`document.querySelectorAll('.cand').length === 3`, 're-vote entry on team 2', 9000);
    for (let i = 0; i < 5; i++) await listVote(i < 3 ? t1 : t2, [D, E]);
    for (let i = 0; i < 4; i++) await listVote(t2, [F]);
    await waitCard(RE, 'الأوراق الصحيحة: 9');
    const t = await cardText(RE);
    assert(t.includes('الأعضاء المحتفظ بهم') && !t.includes('مقاعد لم تحسم'), t.slice(0, 300));
  }, [sup]);

  await check('M34b', 'Round closed while a team is entering a paper: the team is told the paper was not saved', async () => {
    const RE = 'عضوية المكتب الجهوي - إعادة التصويت';
    await t2.keys([await keyFor(t2, D)]);
    await clickInCard(RE, 'إغلاق الإدخال');
    await t2.errToast('الورقة الجارية لم تحفظ');
    await clickInCard(RE, 'إعادة فتح الإدخال');
    await t1.waitFor(`document.querySelectorAll('.cand').length === 3`, 'team 1 back on the re-vote', 9000);
  }, [sup, t2]);

  // ---------- remaining supervisor buttons ----------
  await check('M44', 'Print', async () => {
    await sup.click('button', 'طباعة النتائج');
    await sup.waitFor(`__log.includes('print')`, 'print called');
  }, [sup]);
  await check('M42', 'Delete a round: cancel keeps it, confirm removes it', async () => {
    await sup.click('button', '＋ جولة جديدة');
    await sup.fill('dialog input[type=text]', 'جولة للحذف');
    await sup.click('button', 'حفظ');
    await waitCard('جولة للحذف', 'لم تفتح بعد');
    await sup.answers({ confirm: [false] });
    await clickInCard('جولة للحذف', 'حذف');
    await sleep(400);
    assert(await sup.ev(`!!${card('جولة للحذف')}`), 'deleted although cancelled');
    await sup.answers({ confirm: [true] });
    await clickInCard('جولة للحذف', 'حذف');
    await sup.toast('تم الحذف');
    await sup.waitFor(`!${card('جولة للحذف')}`, 'gone');
  }, [sup]);

  // ---------- restart and network cut ----------
  await check('E5/E6', 'Server stopped: save fails with a message; after restart the team carries on, paper counted once', async () => {
    const RE = 'عضوية المكتب الجهوي - إعادة التصويت';
    await stopApp();
    await t1.keys([await keyFor(t1, F)]);
    await t1.press('Enter');
    await t1.errToast('');
    await startApp(port, data, certs);
    await t1.ev('document.activeElement.blur(), true');
    await t1.press('Enter');
    await t1.toast('تم حفظ الورقة');
    await waitCard(RE, 'الأوراق الصحيحة: 10', 9000);
    assert(!(await t1.ev(`!!document.querySelector('form.login')`)), 'team logged out by the restart');
  }, [sup, t1]);
  await check('M62b/M04t', 'Team log out', async () => {
    await t2.click('#logout');
    await t2.waitFor(`!!document.querySelector('form.login')`, 'login form');
  }, [t2]);
  await check('M63', 'New code: the team is logged out, the old code is refused, the new one works', async () => {
    await tab('teams');
    await sup.answers({ confirm: [true] });
    await rowClick('الفريق 1', 'رمز جديد');
    await sup.toast('تم إنشاء رمز جديد');
    const fresh = await codeOf('الفريق 1');
    assert(fresh !== code1, 'code unchanged');
    await t1.waitFor(`!!document.querySelector('form.login')`, 'team logged out', 9000);
    await t1.fill('input[type=password]', code1);
    await t1.click('button', 'دخول');
    await t1.errToast('الرمز غير صحيح');
    await t1.fill('input[type=password]', fresh);
    await t1.click('button', 'دخول');
    await t1.waitFor(`document.querySelector('#who').textContent === 'الفريق 1'`, 'back in with the new code');
  }, [sup, t1]);
  await check('M64', 'Delete: offered only for a team without papers', async () => {
    assert(!(await rowText('الفريق 1')).includes('حذف'), 'delete offered on a team with papers');
    await sup.click('button', '＋ إنشاء فريق');
    await sup.waitFor(`!!${row('الفريق 3')}`, 'team 3');
    await sup.answers({ confirm: [true] });
    await rowClick('الفريق 3', 'حذف');
    await sup.toast('تم حذف الفريق');
    await sup.waitFor(`!${row('الفريق 3')}`, 'team 3 gone');
    await tab('rounds');
  }, [sup]);
  await check('M66', 'History tab lists the changes', async () => {
    await tab('history');
    await sup.waitFor(`document.querySelector('#app').textContent.includes('سجل التغييرات') && document.querySelector('#app').textContent.includes('قبول طلب حذف الورقة') && document.querySelector('#app').textContent.includes('رفض طلب حذف الورقة')`, 'history lines', 6000);
    await tab('rounds');
  }, [sup]);
  await check('P1', 'Public page links lead to the team and supervisor pages', async () => {
    const l = await pub.ev(`[...document.querySelectorAll('header a')].map((a) => a.getAttribute('href'))`);
    assert(JSON.stringify(l) === JSON.stringify(['/team', '/admin']), JSON.stringify(l));
  }, [pub]);
  await check('TXT', 'No stray «null» or «undefined» text on any page', async () => {
    for (const p of all) {
      const t = await p.ev(`document.body.innerText`);
      assert(!/\bnull\b|\bundefined\b|NaN/.test(t), t.match(/.{0,40}(null|undefined|NaN).{0,40}/)?.[0]);
    }
  }, all);
  await check('JS', 'No script error on any page', async () => {
    for (const p of all) {
      const errs = await p.ev(`window.__errors || []`);
      assert(!errs.length, JSON.stringify(errs));
    }
  });

  ff.stop();
  await stopApp();
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed` + (failed.length ? ` (screenshots in ${OUT})` : ''));
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error(`stopped during ${current}: ${e.stack}`);
  await stopApp();
  process.exit(2);
});
