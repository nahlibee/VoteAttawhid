'use strict';
// Helpers shared by the three pages.

const $ = (sel, root = document) => root.querySelector(sel);

// Tiny element builder. Text is always inserted as text, never as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

let TOKEN_KEY = 'tok';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} };

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-token': getToken() || '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'خطأ في الاتصال');
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, kind = 'ok') {
  let box = $('#toast');
  if (!box) { box = h('div', { id: 'toast' }); document.body.append(box); }
  box.textContent = msg;
  box.className = 'show ' + kind;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { box.className = ''; }, kind === 'err' ? 5000 : 2200);
}

function norm(s) {
  return String(s)
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// People whose name contains a word starting with every typed word.
function searchPeople(people, text, limit = 8) {
  const words = norm(text).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const p of people) {
    const key = p._k || (p._k = ' ' + norm(p.name));
    if (words.every((w) => key.includes(' ' + w))) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Autocomplete name input.
 * opts: people() -> list, exclude() -> Set of ids, onPick(person),
 *       onCreate(text) (optional), onEmptyEnter(), onEmptyBackspace(), placeholder
 */
function namePicker(opts) {
  const input = h('input', { type: 'text', class: 'picker-input', placeholder: opts.placeholder || 'اكتب الحروف الأولى من الاسم…', autocomplete: 'off' });
  const list = h('div', { class: 'picker-list' });
  const wrap = h('div', { class: 'picker' }, input, list);
  let items = [];
  let active = 0;

  function render() {
    const text = input.value.trim();
    const skip = opts.exclude ? opts.exclude() : new Set();
    items = searchPeople(opts.people(), text).filter((p) => !skip.has(p.id)).map((p) => ({ p }));
    const exact = opts.people().some((p) => norm(p.name) === norm(text));
    if (opts.onCreate && text.length >= 3 && !exact) items.push({ create: text });
    active = Math.min(active, Math.max(items.length - 1, 0));
    list.replaceChildren(...items.map((it, i) => h('div', {
      class: 'picker-item' + (i === active ? ' active' : '') + (it.create ? ' create' : ''),
      onmousedown: (e) => { e.preventDefault(); choose(i); },
    }, it.create ? `➕ إضافة «${it.create}» كاسم جديد` : [it.p.name, !it.p.isMember && h('span', { class: 'badge warn' }, it.p.pending ? 'في انتظار المصادقة' : 'غير عضو')])));
    list.style.display = items.length ? 'block' : 'none';
  }

  function choose(i) {
    const it = items[i];
    if (!it) return;
    input.value = '';
    active = 0;
    render();
    if (it.create) opts.onCreate(it.create); else opts.onPick(it.p);
  }

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('blur', () => { list.style.display = 'none'; });
  input.addEventListener('focus', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (items.length) choose(active);
      else if (!input.value.trim() && opts.onEmptyEnter) opts.onEmptyEnter();
    } else if (e.key === 'Backspace' && !input.value && opts.onEmptyBackspace) opts.onEmptyBackspace();
    // Escape clears the field only; without preventDefault it would also close a window around it.
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = ''; render(); }
  });

  return { el: wrap, input, focus: () => input.focus() };
}

const names = (rows) => rows.map((r) => r.name).join(' ، ');

// President vote and run-off elect someone; the other rounds keep (retain) names.
const isElection = (round) => round.kind === 'president' || round.kind === 'runoff';

// Plain-language outcome of a round, as a list of {kind, text}.
function verdict(round, res) {
  const out = [];
  const elected = res.rows.filter((r) => r.status === 'elected');
  const tied = res.rows.filter((r) => r.status === 'tied');
  if (!res.valid) return [{ kind: 'info', text: 'لم يتم إدخال أي ورقة بعد.' }];
  if (res.thresholdMissing) return [{ kind: 'warn', text: 'عدد الحاضرين غير محدد: لا يمكن حساب أغلبية الحاضرين.' }];
  if (elected.length) {
    const label = round.kind === 'nomination' ? 'المرشحون المحتفظ بهم'
      : isElection(round) ? 'المنتخب' : round.seats === 1 ? 'المحتفظ به' : 'الأعضاء المحتفظ بهم';
    out.push({ kind: 'ok', text: `${label}: ${names(elected)}` });
  }
  if (tied.length) {
    out.push({ kind: 'warn', text: `تعادل (${tied[0].votes} صوتا) على ${res.seatsLeft} من المقاعد بين: ${names(tied)}` });
  } else if (res.seatsLeft > 0 && res.threshold !== null) {
    out.push({ kind: 'warn', text: elected.length
      ? `مقاعد لم تحسم بعد: ${res.seatsLeft} (لم يحصل باقي المرشحين على الأغلبية المطلوبة: ${res.threshold})`
      : `لم يحصل أي مرشح على الأغلبية المطلوبة (${res.threshold} صوتا).` });
    const voted = res.rows.filter((r) => r.votes > 0);
    if (round.kind !== 'president' && round.seats === 1 && voted.length > 1 && voted[0].votes === voted[1].votes) {
      out.push({ kind: 'warn', text: `تعادل (${voted[0].votes} صوتا) بين: ${names(voted.filter((r) => r.votes === voted[0].votes))}` });
    }
    if (round.kind === 'president' && !elected.length) {
      const top = runoffCandidates(res);
      out.push({ kind: top.length === 2 ? 'info' : 'warn', text: top.length === 2
        ? `يعاد التصويت بين الأول والثاني: ${names(top)}`
        : `تعادل في المراتب الأولى بين: ${names(top)}` });
    }
  }
  return out;
}

// The first two of a president vote; more than two when there is a draw.
function runoffCandidates(res) {
  const rows = res.rows.filter((r) => r.votes > 0);
  if (rows.length <= 2) return rows;
  return rows.filter((r) => r.votes >= rows[1].votes);
}

// Suggest the follow-up round from the results; the supervisor can still edit everything.
function nextRound(r) {
  const rows = r.results.rows;
  const elected = rows.filter((x) => x.status === 'elected');
  const tied = rows.filter((x) => x.status === 'tied');
  const ids = (list) => list.map((x) => x.id);
  if (r.kind === 'nomination') return { kind: 'president', candidates: ids([...elected, ...tied]) };
  if (r.kind === 'president' && !elected.length) return { kind: 'runoff', candidates: ids(runoffCandidates(r.results)) };
  if ((r.kind === 'bureau' || r.kind === 'bureau2') && r.results.seatsLeft > 0) {
    const n = r.results.seatsLeft;
    const pool = tied.length ? tied : rows.filter((x) => x.status !== 'elected');
    return { kind: 'bureau2', candidates: ids(pool), seats: n, max: Math.min(n, Math.max(pool.length, 1)) };
  }
  return null;
}

// Same rule as the server: who may be a candidate of a president vote or run-off.
function allowedCandidates(rounds, kind, exceptId) {
  const source = { president: 'nomination', runoff: 'president' }[kind];
  if (!source) return null;
  const prev = rounds.filter((r) => r.kind === source && r.id !== exceptId).sort((a, b) => b.id - a.id)[0];
  if (!prev) return null;
  const ids = kind === 'president'
    ? prev.results.rows.filter((x) => x.status === 'elected' || x.status === 'tied').map((x) => x.id)
    : prev.candidates;
  return { ids, title: prev.title };
}

const STATUS_LABEL = { elected: 'محتفظ به', tied: 'تعادل', nonmember: 'غير عضو', below: '' };

function resultsView(round, res) {
  const thresholdText = res.threshold === null ? null
    : `${res.thresholdType === 'present' ? `أغلبية الحاضرين (${res.present})` : `الأغلبية المطلقة (${res.expected})`}: ${res.threshold} صوتا`;
  const max = Math.max(1, ...res.rows.map((r) => r.votes));
  return h('div', { class: 'results' },
    h('div', { class: 'stats' },
      h('span', {}, `الأوراق الصحيحة: ${res.valid}`),
      h('span', {}, `الملغاة: ${res.void}` + (res.voidManual ? ` (الفرق: ${res.voidTeams}، المشرف: ${res.voidManual})` : '')),
      h('span', {}, `المجموع: ${res.total}`),
      thresholdText && h('span', { class: 'strong' }, thresholdText)),
    h('div', { class: 'verdicts' }, verdict(round, res).map((v) => h('div', { class: 'verdict ' + v.kind }, v.text))),
    res.rows.length ? h('table', { class: 'tally' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'الاسم'), h('th', {}, 'الأصوات'), h('th', {}, ''))),
      h('tbody', {}, res.rows.map((r, i) => h('tr', { class: r.status },
        h('td', {}, i + 1),
        h('td', {}, r.name, STATUS_LABEL[r.status] && h('span', { class: 'badge ' + r.status }, isElection(round) && r.status === 'elected' ? 'منتخب' : r.pending ? 'في انتظار المصادقة' : STATUS_LABEL[r.status])),
        h('td', { class: 'num' }, r.votes),
        h('td', { class: 'barcell' }, h('div', { class: 'bar', style: `width:${(r.votes / max) * 100}%` })))))) : null);
}
