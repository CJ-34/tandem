// Everything lives inside this function so its names can't collide with
// globals that Electron's preload bridge defines (such as window.api).
(() => {
'use strict';

const api = window.api;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

let INFO = { platform: 'win32', sep: '\\', home: 'C:\\', dark: true };
let SEP = '\\';
const STORE = 'tandem.state.v1';
const state = { theme: 'dark', hidden: false, split: 50, active: 0, hotlist: [], mask: '*.*', qv: false };
const panes = [];
let drives = [];
let modalOpen = false;
let drag = null;

/* ---------- file kinds ---------- */
const KINDS = {
  image: 'png jpg jpeg gif webp bmp svg ico tif tiff heic avif psd raw',
  video: 'mp4 mkv avi mov wmv webm m4v flv mpg mpeg',
  audio: 'mp3 wav flac ogg m4a aac wma opus mid',
  archive: 'zip rar 7z tar gz bz2 xz tgz cab iso zst',
  code: 'js mjs cjs ts jsx tsx py c cc cpp h hpp cs java go rs rb php html htm css scss less json xml yml yaml toml sh ps1 psm1 bat cmd sql lua kt swift ini cfg conf vue',
  doc: 'pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp log epub',
  app: 'exe msi dll com appx msix lnk sys scr',
};
const EXT_KIND = new Map();
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts.split(' ')) EXT_KIND.set(e, kind);
const KIND_LABEL = { folder: 'Folder', image: 'Image', video: 'Video', audio: 'Audio', archive: 'Archive', code: 'Code', doc: 'Document', app: 'Program' };

const ICON = {
  folder: '<svg viewBox="0 0 16 16"><path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.1l1.6 1.6H13A1.5 1.5 0 0 1 14.5 5.6v6.9A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z" fill="currentColor"/></svg>',
  up: '<svg viewBox="0 0 16 16"><path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg viewBox="0 0 16 16"><path d="M4 1.75h5.25L12.5 5v9.25H4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.25 1.75V5h3.25" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><rect class="band" x="2.25" y="9" width="7.5" height="3.5" rx="1"/></svg>',
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/* ---------- small helpers ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const kindOf = (e) => (e.up || e.isDir ? 'folder' : EXT_KIND.get(extOf(e.name)) || 'file');
function kindLabel(e) {
  const k = kindOf(e);
  if (k !== 'file') return KIND_LABEL[k];
  const x = extOf(e.name);
  return x ? `${x.toUpperCase()} file` : 'File';
}
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
const fmtDate = (ms) => (ms ? dateFmt.format(new Date(ms)) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const join = (dir, name) => (dir.endsWith(SEP) ? dir + name : dir + SEP + name);
function baseName(p) {
  const t = p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
  const i = t.lastIndexOf(SEP);
  return (i >= 0 ? t.slice(i + 1) : t) || t;
}
function parentOf(p) {
  const t = p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
  const i = t.lastIndexOf(SEP);
  if (i < 0) return null;
  const par = t.slice(0, i + 1);
  if (par === t) return null;
  return /^[A-Za-z]:\\$/.test(par) || par === '/' || par === '\\\\' ? par : par.slice(0, -1);
}
function samePath(a, b) {
  if (!a || !b) return false;
  const n = (s) => (SEP === '\\' ? s.toLowerCase() : s).replace(/[\\/]+$/, '');
  return n(a) === n(b);
}
function crumbsOf(p) {
  const out = [];
  if (SEP === '/') {
    out.push({ label: '/', path: '/' });
    let acc = '';
    for (const s of p.split('/').filter(Boolean)) { acc += `/${s}`; out.push({ label: s, path: acc }); }
    return out;
  }
  let rest;
  let acc;
  if (p.startsWith('\\\\')) {
    const parts = p.slice(2).split('\\').filter(Boolean);
    acc = `\\\\${parts.slice(0, 2).join('\\')}\\`;
    out.push({ label: acc.slice(0, -1), path: acc });
    rest = parts.slice(2);
  } else {
    const parts = p.split('\\').filter(Boolean);
    acc = `${parts[0]}\\`;
    out.push({ label: parts[0], path: acc });
    rest = parts.slice(1);
  }
  for (const s of rest) { acc = acc.endsWith('\\') ? acc + s : `${acc}\\${s}`; out.push({ label: s, path: acc }); }
  return out;
}

/* ---------- pane model ---------- */
const tabOf = (p) => p.tabs[p.tab];
const pathOf = (p) => tabOf(p).path;
const act = () => panes[state.active];
const otherOf = (p) => panes[1 - p.i];
const currentName = (p) => (p.rows[p.cursor] ? p.rows[p.cursor].name : null);

function makePane(i) {
  const el = $(`.pane[data-pane="${i}"]`);
  el.append($('#pane-tpl').content.cloneNode(true));
  const p = {
    i, el,
    tabs: [], tab: 0,
    listing: null, rows: [], cursor: 0, anchor: 0,
    selected: new Set(),
    sort: { key: 'name', dir: 1 },
    filter: '', req: 0, opening: 0, pendingClear: null,
    vbox: null, win: { start: 0, end: 0 },
    sizes: new Map(), stale: false,
    list: $('.list', el), crumbs: $('.crumbs', el), pathInput: $('.pathinput', el),
    filterInput: $('.filter-input', el), drive: $('.drive', el), tablist: $('.tablist', el),
    count: $('.count', el), free: $('.free', el),
    qv: $('.quickview', el), qvTitle: $('.qv-title', el), qvMeta: $('.qv-meta', el), qvBody: $('.qv-body', el),
  };
  bindPane(p);
  return p;
}

function setActive(i, focus = true) {
  state.active = i;
  for (const p of panes) p.el.classList.toggle('active', p.i === i);
  if (focus) panes[i].list.focus();
  scheduleQuickView();
  save();
}

const signature = (entries) => entries.map((e) => `${e.name}|${e.size}|${e.mtime}`).join('\n');

/* Resolves true when the folder opened, false when it couldn't be opened,
   and null when a newer navigation in the same pane took over. */
async function navigate(p, dir, { push = true, focusName = null, quiet = false, soft = false } = {}) {
  // A background refresh must not cancel a folder the user is still opening.
  if (soft && p.opening) return null;
  const req = ++p.req;
  if (!soft) p.opening = req;
  const res = await api.list(dir).finally(() => { if (p.opening === req) p.opening = 0; });
  if (req !== p.req) return null;
  if (!res || !res.ok) {
    const msg = (res && res.error) || 'Unknown error';
    if (!quiet) toast(msg, 'error');
    if (!p.listing) p.list.innerHTML = `<div class="empty">Couldn’t open ${esc(dir)}<br>${esc(msg)}</div>`;
    return false;
  }
  const tab = tabOf(p);
  const changed = !samePath(tab.path, res.path);
  // Background refreshes leave the list alone when nothing changed.
  if (soft && !changed && p.listing && signature(p.listing.entries) === signature(res.entries)) {
    p.listing.free = res.free;
    renderStatus(p);
    return true;
  }
  if (push && changed && tab.path) {
    tab.back.push(tab.path);
    if (tab.back.length > 60) tab.back.shift();
    tab.fwd = [];
  }
  tab.path = res.path;
  p.listing = res;
  if (changed) { p.selected.clear(); setFilter(p, '', false); p.cursor = 0; p.sizes = new Map(); }
  build(p, focusName);
  renderChrome(p);
  api.watch(p.i, res.path);
  save();
  return true;
}

async function refresh(p, focusName, soft = false) {
  const keep = focusName ?? currentName(p);
  const dir = pathOf(p);
  // Only a folder that is gone sends the pane up; a newer navigation wins as is.
  if (await navigate(p, dir, { push: false, focusName: keep, quiet: true, soft }) !== false) return;
  let cur = dir;
  for (let n = 0; n < 40; n++) {
    const up = parentOf(cur);
    if (!up) break;
    cur = up;
    if (await navigate(p, cur, { push: false, quiet: true }) !== false) return;
  }
  await navigate(p, INFO.home, { push: false });
}

function refreshAll(focusName) {
  const a = act();
  return Promise.all([refresh(a, focusName), refresh(otherOf(a))]);
}

/* Called when a watched folder changes on disk. */
function softRefresh(p) {
  if (!p.listing || !pathOf(p)) return;
  if (drag) { p.stale = true; return; }
  p.stale = false;
  refresh(p, null, true);
}

function goUp(p) {
  if (!p.listing || !p.listing.parent) return;
  navigate(p, p.listing.parent, { focusName: baseName(pathOf(p)) });
}

function goHistory(p, step) {
  const tab = tabOf(p);
  const from = step < 0 ? tab.back : tab.fwd;
  const to = step < 0 ? tab.fwd : tab.back;
  if (!from.length) return;
  const target = from.pop();
  to.push(tab.path);
  navigate(p, target, { push: false });
}

function openItem(p, i) {
  const e = p.rows[i];
  if (!e) return;
  if (e.up) { goUp(p); return; }
  const full = join(pathOf(p), e.name);
  if (e.isDir) { navigate(p, full); return; }
  api.open(full).then((err) => err && toast(err, 'error'));
}

/* ---------- list building ---------- */
function build(p, focusName, fallback = p.cursor) {
  const L = p.listing;
  if (!L) return;
  const q = p.filter.toLowerCase();
  const items = L.entries.filter((e) => (state.hidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)));
  const { key, dir } = p.sort;
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r = 0;
    if (key === 'size') r = (sizeOf(p, a) ?? -1) - (sizeOf(p, b) ?? -1);
    else if (key === 'mtime') r = a.mtime - b.mtime;
    else if (key === 'kind') r = collator.compare(extOf(a.name), extOf(b.name));
    if (r === 0) r = collator.compare(a.name, b.name);
    return r * dir;
  });
  if (L.parent && !q) items.unshift({ name: '..', up: true, isDir: true, size: null, mtime: 0 });
  p.rows = items;
  const names = new Set(items.map((e) => e.name));
  for (const n of [...p.selected]) if (!names.has(n)) p.selected.delete(n);
  let idx = focusName != null ? items.findIndex((e) => e.name === focusName) : -1;
  if (idx < 0) idx = Math.min(fallback, items.length - 1);
  p.cursor = Math.max(0, idx);
  renderRows(p);
  renderStatus(p);
  scheduleQuickView();
}

function rowHtml(p, e, i) {
  const k = kindOf(e);
  const cls = ['row', `k-${k}`];
  if (i === p.cursor) cls.push('cursor');
  if (p.selected.has(e.name)) cls.push('sel');
  if (e.hidden) cls.push('hid');
  let name;
  const x = !e.isDir ? extOf(e.name) : '';
  if (x) name = `<span class="nm">${esc(e.name.slice(0, -(x.length + 1)))}<span class="dot-ext">.${esc(e.name.slice(-x.length))}</span></span>`;
  else name = `<span class="nm">${esc(e.name)}</span>`;
  return `<div class="${cls.join(' ')}" data-i="${i}" role="option" aria-posinset="${i + 1}" aria-setsize="${p.rows.length}" draggable="${e.up ? 'false' : 'true'}" style="top:${i * ROW_H}px">`
    + `<span class="c-name"><span class="ico">${iconHtml(p, e, k)}</span>${name}</span>`
    + `<span class="c-kind">${e.up ? '' : esc(kindLabel(e))}</span>`
    + `<span class="c-size">${sizeText(p, e)}</span>`
    + `<span class="c-date">${e.up ? '' : fmtDate(e.mtime)}</span></div>`;
}

/* ---------- file icons ---------- */
/* Files show the system's own icon once it has loaded. Most types share one
   icon per extension; programs, shortcuts and icon files have their own. */
const OWN_ICON = new Set(['exe', 'lnk', 'ico', 'cur', 'ani', 'scr', 'url', 'msc', 'cpl', 'appref-ms']);
const icons = new Map(); // key -> data URL, or null while loading or when there is none
const iconKey = (p, e) => {
  const x = extOf(e.name);
  return OWN_ICON.has(x) ? join(pathOf(p), e.name) : `.${x}`;
};

function iconHtml(p, e, k) {
  if (e.up) return ICON.up;
  if (k === 'folder') return ICON.folder;
  const url = icons.get(iconKey(p, e));
  return url ? `<img src="${url}" alt="" draggable="false">` : ICON.file;
}

let iconTimer = null;
function requestIcons(p) {
  clearTimeout(iconTimer);
  iconTimer = setTimeout(async () => {
    const want = new Map(); // key -> a path to ask about
    for (const q of panes) {
      for (let i = q.win.start; i < q.win.end; i++) {
        const e = q.rows[i];
        if (!e || e.isDir) continue;
        const key = iconKey(q, e);
        if (!icons.has(key) && !want.has(key)) want.set(key, join(pathOf(q), e.name));
      }
    }
    if (!want.size) return;
    if (icons.size > 5000) icons.clear();
    const keys = [...want.keys()];
    for (const key of keys) icons.set(key, null);
    let urls;
    try { urls = await api.icons([...want.values()]); } catch { return; }
    let got = false;
    keys.forEach((key, n) => { if (urls[n]) { icons.set(key, urls[n]); got = true; } });
    if (got) for (const q of panes) paintWindow(q, true);
  }, 30);
}

/* The list only holds the rows in view, plus a few either side, laid out on
   a spacer as tall as the whole folder, so huge folders stay quick. */
const ROW_H = 26;
const OVERSCAN = 8;

function renderRows(p) {
  if (!p.rows.length) {
    p.list.innerHTML = `<div class="empty">${p.filter ? 'Nothing matches the filter. Press Esc to clear it.' : 'This folder is empty.'}</div>`;
    p.vbox = null;
    return;
  }
  if (!p.vbox || !p.vbox.isConnected) {
    p.list.innerHTML = '<div class="vbox"></div>';
    p.vbox = p.list.firstChild;
  }
  p.vbox.style.height = `${p.rows.length * ROW_H}px`;
  scrollToCursor(p);
  paintWindow(p, true);
}

function paintWindow(p, force = false) {
  if (!p.vbox) return;
  const top = p.list.scrollTop - p.vbox.offsetTop;
  const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const end = Math.min(p.rows.length, Math.ceil((top + p.list.clientHeight) / ROW_H) + OVERSCAN);
  if (!force && start === p.win.start && end === p.win.end) return;
  let html = '';
  for (let i = start; i < end; i++) html += rowHtml(p, p.rows[i], i);
  p.vbox.innerHTML = html;
  p.win = { start, end };
  requestIcons(p);
}

const rowEl = (p, i) => (p.vbox && i >= p.win.start && i < p.win.end ? p.vbox.children[i - p.win.start] || null : null);

function scrollToCursor(p) {
  if (!p.vbox) return;
  const top = p.vbox.offsetTop + p.cursor * ROW_H;
  const view = p.list.clientHeight;
  if (top < p.list.scrollTop) p.list.scrollTop = top - p.vbox.offsetTop;
  else if (top + ROW_H > p.list.scrollTop + view) p.list.scrollTop = top + ROW_H - view + p.vbox.offsetTop;
  paintWindow(p);
}

function setCursor(p, idx) {
  if (!p.rows.length) return;
  idx = Math.max(0, Math.min(p.rows.length - 1, idx));
  const old = rowEl(p, p.cursor);
  if (old) old.classList.remove('cursor');
  p.cursor = idx;
  scrollToCursor(p);
  const row = rowEl(p, idx);
  if (row) row.classList.add('cursor');
  tabOf(p).cursorName = p.rows[idx].name;
  scheduleQuickView();
}

function syncSel(p) {
  for (let i = p.win.start; i < p.win.end; i++) {
    const row = rowEl(p, i);
    if (row && p.rows[i]) row.classList.toggle('sel', p.selected.has(p.rows[i].name));
  }
  renderStatus(p);
}
function toggleSel(p, i) {
  const e = p.rows[i];
  if (!e || e.up) return;
  if (p.selected.has(e.name)) p.selected.delete(e.name); else p.selected.add(e.name);
  const row = rowEl(p, i);
  if (row) row.classList.toggle('sel', p.selected.has(e.name));
  renderStatus(p);
}
function selectRange(p, a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) if (p.rows[i] && !p.rows[i].up) p.selected.add(p.rows[i].name);
  syncSel(p);
}
function selectAll(p) {
  const all = p.rows.filter((e) => !e.up);
  if (all.length && all.every((e) => p.selected.has(e.name))) p.selected.clear();
  else for (const e of all) p.selected.add(e.name);
  syncSel(p);
}
function clearSel(p) { p.selected.clear(); syncSel(p); }
function targets(p) {
  if (p.selected.size) return p.rows.filter((e) => p.selected.has(e.name)).map((e) => e.name);
  const e = p.rows[p.cursor];
  return e && !e.up ? [e.name] : [];
}
const pageSize = (p) => Math.max(1, Math.floor(p.list.clientHeight / ROW_H) - 1);

/* ---------- folder sizes ---------- */
function sizeOf(p, e) {
  if (!e.isDir) return e.size;
  const s = p.sizes.get(e.name);
  return typeof s === 'number' ? s : null;
}
function sizeText(p, e) {
  if (e.up) return '';
  if (e.isDir && p.sizes.get(e.name) === 'busy') return '<span class="sizing">…</span>';
  const s = sizeOf(p, e);
  return s == null ? '' : fmtSize(s);
}
function paintSize(p, name) {
  const i = p.rows.findIndex((e) => e.name === name);
  const row = i >= 0 && rowEl(p, i);
  const cell = row && $('.c-size', row);
  if (cell) cell.innerHTML = sizeText(p, p.rows[i]);
}
async function calcSizes(p, names) {
  const map = p.sizes;
  const dir = pathOf(p);
  const todo = names.filter((n) => !map.has(n));
  for (const n of todo) { map.set(n, 'busy'); paintSize(p, n); }
  for (const n of todo) {
    const r = await api.dirSize(join(dir, n));
    if (r.ok) map.set(n, r.bytes); else map.delete(n);
    if (p.sizes !== map) return;
    paintSize(p, n);
    renderStatus(p);
  }
  if (p.sort.key === 'size' && todo.length) build(p, currentName(p));
  scheduleQuickView();
}
function spaceSelect(p) {
  const e = p.rows[p.cursor];
  if (!e || e.up) return;
  toggleSel(p, p.cursor);
  if (e.isDir) calcSizes(p, [e.name]);
}
function calcAllSizes(p) {
  const dirs = p.rows.filter((e) => e.isDir && !e.up).map((e) => e.name);
  if (dirs.length) calcSizes(p, dirs);
}

/* ---------- selecting by pattern ---------- */
/* Patterns work like Total Commander's: "*.jpg *.png" picks files, a
   trailing backslash ("src\") picks folders, and anything after | is left out. */
function maskMatcher(mask) {
  const [inc, exc = ''] = mask.split('|');
  const parse = (str) => [...str.matchAll(/"([^"]*)"|([^;\s]+)/g)].map((m) => {
    const raw = m[1] ?? m[2];
    const dir = /[\\/]$/.test(raw);
    let body = raw.replace(/[\\/]+$/, '') || '*';
    if (!/[*?]/.test(body)) body = `*${body}*`;
    const src = body === '*.*' ? '.*' : body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return { dir, re: new RegExp(`^${src}$`, 'i') };
  });
  const yes = parse(inc);
  const no = parse(exc);
  const hit = (list, e) => list.some((m) => m.dir === !!e.isDir && m.re.test(e.name));
  return (e) => !e.up && hit(yes, e) && !hit(no, e);
}
async function selectByMask(p, add) {
  const mask = await dialog({
    title: add ? 'Select by pattern' : 'Unselect by pattern',
    body: 'Separate patterns with spaces, end one with \\ to match folders, and put exclusions after |. Example: *.jpg *.png | thumb*',
    input: state.mask,
    validate: (v) => (!v.trim() ? 'Enter a pattern.' : null),
    buttons: [{ label: 'Cancel', cancel: true }, { label: add ? 'Select' : 'Unselect', primary: true }],
  });
  if (mask == null) return;
  state.mask = mask.trim();
  save();
  const match = maskMatcher(state.mask);
  let n = 0;
  for (const e of p.rows) {
    if (!match(e)) continue;
    n++;
    if (add) p.selected.add(e.name); else p.selected.delete(e.name);
  }
  syncSel(p);
  if (!n) toast('Nothing matches that pattern.', 'info');
}
function selectSameExt(p) {
  const e = p.rows[p.cursor];
  if (!e || e.up || e.isDir) return;
  const x = extOf(e.name);
  for (const r of p.rows) if (!r.isDir && extOf(r.name) === x) p.selected.add(r.name);
  syncSel(p);
}
function invertSel(p) {
  for (const e of p.rows) {
    if (e.up) continue;
    if (p.selected.has(e.name)) p.selected.delete(e.name); else p.selected.add(e.name);
  }
  syncSel(p);
}

function setFilter(p, value, rebuild = true) {
  p.filter = value;
  if (p.filterInput.value !== value) p.filterInput.value = value;
  p.el.classList.toggle('filtering', !!value);
  if (rebuild) build(p, currentName(p), 0);
}

/* ---------- chrome ---------- */
function renderChrome(p) {
  renderTabs(p);
  renderCrumbs(p);
  renderDrives(p);
  for (const b of $$('.head button', p.el)) {
    b.classList.toggle('sorted', b.dataset.sort === p.sort.key);
    b.dataset.dir = p.sort.dir > 0 ? 'asc' : 'desc';
  }
}

function renderTabs(p) {
  p.tablist.innerHTML = p.tabs.map((t, i) => `<div class="tab${i === p.tab ? ' on' : ''}" data-t="${i}" role="tab" aria-selected="${i === p.tab}" title="${esc(t.path || '')}">`
    + `<span class="tab-label">${esc(t.path ? baseName(t.path) : '…')}</span>`
    + (p.tabs.length > 1 ? `<button class="tab-x" data-x="${i}" tabindex="-1" title="Close tab (Ctrl+W)" aria-label="Close tab">×</button>` : '')
    + '</div>').join('');
  const on = $('.tab.on', p.tablist);
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderCrumbs(p) {
  const parts = crumbsOf(pathOf(p));
  p.crumbs.innerHTML = parts.map((c, i) => `<button class="crumb${i === parts.length - 1 ? ' last' : ''}" data-path="${esc(c.path)}" tabindex="-1">${esc(c.label)}</button>`).join('<span class="crumb-sep" aria-hidden="true">›</span>');
  p.crumbs.scrollLeft = p.crumbs.scrollWidth;
}

function renderDrives(p) {
  const cur = (pathOf(p) || '').toLowerCase();
  const match = drives.find((d) => cur.startsWith(d.path.toLowerCase()));
  p.drive.innerHTML = drives.map((d) => `<option value="${esc(d.path)}">${esc(d.label)}</option>`).join('')
    + `<option value="${esc(INFO.home)}">Home</option>`
    + (match ? '' : '<option value="" disabled>Other</option>');
  p.drive.value = match ? match.path : '';
}

function renderStatus(p) {
  const L = p.listing;
  if (!L) return;
  const vis = p.rows.filter((e) => !e.up);
  const dirs = vis.filter((e) => e.isDir).length;
  let text;
  if (p.selected.size) {
    const size = p.rows.filter((e) => p.selected.has(e.name)).reduce((s, e) => s + (sizeOf(p, e) || 0), 0);
    text = `${p.selected.size} of ${vis.length} selected${size ? `, ${fmtSize(size)}` : ''}`;
  } else {
    text = `${plural(dirs, 'folder', 'folders')}, ${plural(vis.length - dirs, 'file', 'files')}`;
    if (p.filter) text += ` matching “${p.filter}”`;
  }
  p.count.textContent = text;
  p.free.textContent = L.free != null ? `${fmtSize(L.free)} free` : '';
}

/* ---------- tabs ---------- */
function newTab(p, dir = pathOf(p)) {
  tabOf(p).cursorName = currentName(p);
  p.tabs.splice(p.tab + 1, 0, { path: null, back: [], fwd: [], cursorName: null });
  p.tab += 1;
  navigate(p, dir, { push: false });
  setActive(p.i);
}
function switchTab(p, i) {
  if (i === p.tab || !p.tabs[i]) return;
  tabOf(p).cursorName = currentName(p);
  p.tab = i;
  const t = tabOf(p);
  const target = t.path;
  t.path = null;
  navigate(p, target, { push: false, focusName: t.cursorName, quiet: true })
    .then((ok) => { if (ok === false) refreshMissing(p, target); });
  setActive(p.i);
}
async function refreshMissing(p, dir) {
  tabOf(p).path = dir;
  await refresh(p);
}
function closeTab(p, i) {
  if (p.tabs.length <= 1) return;
  const wasCurrent = i === p.tab;
  p.tabs.splice(i, 1);
  if (i < p.tab) p.tab -= 1;
  else if (wasCurrent) p.tab = Math.min(i, p.tabs.length - 1);
  if (wasCurrent) {
    const t = tabOf(p);
    const target = t.path;
    t.path = null;
    navigate(p, target, { push: false, focusName: t.cursorName, quiet: true })
      .then((ok) => { if (ok === false) refreshMissing(p, target); });
  } else {
    renderTabs(p);
    save();
  }
}
const cycleTab = (p, step) => switchTab(p, (p.tab + step + p.tabs.length) % p.tabs.length);

function swapPanes() {
  const [a, b] = panes;
  for (const k of ['tabs', 'tab', 'listing', 'rows', 'cursor', 'selected', 'sort', 'filter', 'sizes']) {
    const t = a[k]; a[k] = b[k]; b[k] = t;
  }
  for (const p of panes) { setFilter(p, p.filter, false); build(p, currentName(p)); renderChrome(p); api.watch(p.i, pathOf(p)); }
  save();
}

function openInPane(i) {
  const src = act();
  const e = src.rows[src.cursor];
  const dir = e && e.isDir && !e.up ? join(pathOf(src), e.name) : pathOf(src);
  navigate(panes[i], dir);
}

/* ---------- path editing ---------- */
function editPath(p) {
  p.crumbs.hidden = true;
  p.pathInput.hidden = false;
  p.pathInput.value = pathOf(p);
  p.pathInput.focus();
  p.pathInput.select();
}
function closePathEdit(p, focusList = true) {
  if (p.pathInput.hidden) return;
  p.pathInput.hidden = true;
  p.crumbs.hidden = false;
  if (focusList) p.list.focus();
}

/* ---------- operations ---------- */
const isAbsolute = (t) => (SEP === '\\' ? /^([A-Za-z]:[\\/]|\\\\)/.test(t) : t.startsWith('/'));

/* F5 / F6 / Shift+F5. The target can be a folder (the other pane by
   default) or, for a single item, a new name or full path, like Total Commander. */
async function transfer(mode, opts = {}) {
  const src = opts.src || act();
  const srcDir = pathOf(src);
  const names = opts.names || targets(src);
  if (!names.length) { toast('Put the cursor on a file or select some first.', 'info'); return; }
  const verb = mode === 'copy' ? 'Copy' : 'Move';
  const what = names.length === 1 ? `“${names[0]}”` : `${names.length} items`;
  let target = opts.destDir;
  if (!target) {
    const here = opts.here && names.length === 1;
    const cur = src.rows.find((e) => e.name === names[0]);
    const v = await dialog({
      title: here ? `Copy “${names[0]}” as` : `${verb} ${what}`,
      label: here ? 'New name' : names.length === 1 ? 'To folder, or a new name' : 'To folder',
      input: here ? names[0] : pathOf(otherOf(src)),
      selectBase: here && cur && !cur.isDir,
      buttons: [{ label: 'Cancel', cancel: true }, { label: verb, primary: true }],
    });
    if (v == null || !v.trim()) return;
    target = v.trim();
    if (!isAbsolute(target)) target = join(srcDir, target);
  }
  const st = await api.stat(target);
  let items;
  if (st.isDir || names.length > 1 || /[\\/]$/.test(target)) {
    const dir = target.length > 3 ? target.replace(/[\\/]+$/, '') : target;
    items = names.map((n) => ({ src: join(srcDir, n), dest: join(dir, n) }));
  } else {
    items = [{ src: join(srcDir, names[0]), dest: target }];
  }
  await runTransfer(mode, items, { src });
}

/* Shared by F5/F6, drag and drop, and paste: asks about name clashes, then
   runs the job with a progress card that can be cancelled. */
async function runTransfer(mode, items, { src = null, cut = false } = {}) {
  const what = items.length === 1 ? `“${baseName(items[0].src)}”` : `${items.length} items`;
  const clashes = await api.existing(items.filter((it) => !samePath(it.src, it.dest)).map((it) => it.dest));
  let overwrite = false;
  if (clashes.length) {
    const choice = await dialog({
      title: clashes.length === 1 ? `“${baseName(clashes[0])}” already exists there` : `${clashes.length} items already exist there`,
      body: 'Replace the existing items, or skip them and transfer the rest? Folders that exist in both places are merged when you replace.',
      buttons: [{ label: 'Cancel', cancel: true }, { label: 'Replace', value: 'replace', danger: true }, { label: 'Skip existing', value: 'skip', primary: true }],
    });
    if (!choice) return;
    overwrite = choice === 'replace';
  }
  if (src) clearSel(src);
  const card = progressCard(mode === 'copy' ? `Copying ${what}` : `Moving ${what}`);
  const res = await api.transfer({ id: card.id, mode, items, overwrite });
  card.close();
  if (cut && res.done && !res.cancelled && !res.errors.length) api.clipClear();
  const a = act();
  const landed = res.dests.find((d) => samePath(parentOf(d), pathOf(a)));
  await refreshAll(res.dests.length === 1 && landed ? baseName(landed) : undefined);
  if (res.cancelled) toast(`Cancelled. Anything already ${mode === 'copy' ? 'copied' : 'moved'} stays where it is.`, 'info');
  report(res, mode === 'copy' ? 'Copied' : 'Moved');
}

/* ---------- progress ---------- */
const jobs = new Map();
let jobSeq = 0;

function progressCard(title) {
  const id = `job-${Date.now()}-${++jobSeq}`;
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `<div class="job-head"><span class="job-title">${esc(title)}</span><button class="job-x">Cancel</button></div>
    <div class="job-bar indeterminate"><i></i></div>
    <div class="job-meta"><span class="job-file">Counting files…</span><span class="job-nums"></span></div>`;
  const job = { id, el, start: Date.now(), samples: [], shown: false };
  // Short jobs finish before the card appears, so it doesn't flash.
  job.timer = setTimeout(() => { job.shown = true; $('#toasts').append(el); }, 350);
  $('.job-x', el).addEventListener('click', () => {
    api.cancel(id);
    $('.job-x', el).disabled = true;
    $('.job-file', el).textContent = 'Cancelling…';
  });
  job.close = () => {
    clearTimeout(job.timer);
    jobs.delete(id);
    if (!job.shown) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  jobs.set(id, job);
  return job;
}

function fmtDuration(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function onProgress(pr) {
  const job = jobs.get(pr.id);
  if (!job || $('.job-x', job.el).disabled) return;
  const bar = $('.job-bar', job.el);
  const file = $('.job-file', job.el);
  const nums = $('.job-nums', job.el);
  if (pr.phase === 'scan') {
    bar.classList.add('indeterminate');
    file.textContent = 'Counting files…';
    nums.textContent = pr.totalFiles ? plural(pr.totalFiles, 'file', 'files') : '';
    return;
  }
  bar.classList.remove('indeterminate');
  const byBytes = pr.totalBytes > 0;
  const frac = byBytes ? pr.bytes / pr.totalBytes : pr.items / Math.max(1, pr.totalItems);
  $('i', bar).style.width = `${Math.min(100, frac * 100).toFixed(1)}%`;
  file.textContent = pr.current || '';
  if (!byBytes) { nums.textContent = `${pr.items} of ${pr.totalItems}`; return; }
  const now = Date.now();
  job.samples.push([now, pr.bytes]);
  while (job.samples.length > 2 && now - job.samples[0][0] > 3000) job.samples.shift();
  const [t0, b0] = job.samples[0];
  const speed = now > t0 ? ((pr.bytes - b0) / (now - t0)) * 1000 : 0;
  let text = `${fmtSize(pr.bytes)} of ${fmtSize(pr.totalBytes)}`;
  if (speed > 0 && now - job.start > 1500) text += ` · ${fmtSize(speed)}/s · ${fmtDuration((pr.totalBytes - pr.bytes) / speed)} left`;
  nums.textContent = text;
}

function report(res, pastVerb) {
  if (res.errors.length) {
    const more = res.errors.length > 3 ? `\n…and ${res.errors.length - 3} more` : '';
    toast(res.errors.slice(0, 3).join('\n') + more, 'error');
  }
  if (res.cancelled) return;
  if (res.done) toast(`${pastVerb} ${plural(res.done, 'item', 'items')}${res.skipped ? `, skipped ${res.skipped}` : ''}.`, 'ok');
  else if (res.skipped && !res.errors.length) toast(`Skipped ${plural(res.skipped, 'existing item', 'existing items')}.`, 'info');
}

/* ---------- clipboard ---------- */
/* Uses the same clipboard format as File Explorer, so files can be copied
   or cut here and pasted there, and the other way round. */
async function clipCopy(cut) {
  const p = act();
  const names = targets(p);
  if (!names.length) return;
  await api.clipWrite(names.map((n) => join(pathOf(p), n)), cut);
  const what = plural(names.length, 'item', 'items');
  toast(cut ? `Cut ${what}. Paste with Ctrl+V to move ${names.length === 1 ? 'it' : 'them'}.` : `Copied ${what} to the clipboard.`, 'ok');
}

async function clipPaste() {
  const p = act();
  const clip = await api.clipRead();
  const files = (clip && clip.files) || [];
  if (!files.length) { toast('There are no files on the clipboard.', 'info'); return; }
  const cut = (clip.effect & 2) !== 0 && (clip.effect & 1) === 0;
  const dir = pathOf(p);
  const items = files.map((f) => ({ src: f, dest: join(dir, baseName(f)) }));
  await runTransfer(cut ? 'move' : 'copy', items, { cut });
}

async function doNewFile() {
  const p = act();
  const name = await dialog({
    title: 'New file',
    label: `In ${baseName(pathOf(p))}. It opens in its default app once created.`,
    input: 'New text file.txt',
    selectBase: true,
    validate: (v) => (!v.trim() ? 'Enter a name.' : null),
    buttons: [{ label: 'Cancel', cancel: true }, { label: 'Create and open', primary: true }],
  });
  if (name == null) return;
  const r = await api.mkfile(pathOf(p), name.trim());
  if (!r.ok) { toast(r.error, 'error'); return; }
  await refreshAll(name.trim());
  if (!r.created) toast(`“${name.trim()}” already existed, so it was opened as is.`, 'info');
  api.open(r.path).then((err) => err && toast(err, 'error'));
}

async function doRename() {
  const p = act();
  const e = p.rows[p.cursor];
  if (!e || e.up) return;
  const name = await dialog({
    title: 'Rename',
    input: e.name,
    selectBase: !e.isDir,
    validate: (v) => (!v.trim() ? 'Enter a name.' : null),
    buttons: [{ label: 'Cancel', cancel: true }, { label: 'Rename', primary: true }],
  });
  if (name == null || name === e.name) return;
  const r = await api.rename(join(pathOf(p), e.name), name);
  if (!r.ok) { toast(r.error, 'error'); return; }
  if (p.selected.delete(e.name)) p.selected.add(name);
  await refreshAll(name);
}

async function doMkdir() {
  const p = act();
  const name = await dialog({
    title: 'New folder',
    label: `In ${baseName(pathOf(p))}`,
    input: 'New folder',
    validate: (v) => (!v.trim() ? 'Enter a name.' : null),
    buttons: [{ label: 'Cancel', cancel: true }, { label: 'Create folder', primary: true }],
  });
  if (name == null) return;
  const r = await api.mkdir(pathOf(p), name.trim());
  if (!r.ok) { toast(r.error, 'error'); return; }
  await refreshAll(name.trim());
}

async function doDelete() {
  const p = act();
  const names = targets(p);
  if (!names.length) return;
  const bin = INFO.platform === 'win32' ? 'Recycle Bin' : 'Trash';
  const ok = await dialog({
    title: names.length === 1 ? `Delete “${names[0]}”?` : `Delete ${names.length} items?`,
    body: `${names.length === 1 ? 'It' : 'They'} will be moved to the ${bin}, so you can restore ${names.length === 1 ? 'it' : 'them'} later.`,
    buttons: [{ label: 'Cancel', cancel: true }, { label: 'Delete', value: true, primary: true, danger: true }],
  });
  if (!ok) return;
  const gone = new Set(names);
  let next = null;
  for (let i = p.cursor; i < p.rows.length && !next; i++) if (!gone.has(p.rows[i].name)) next = p.rows[i].name;
  for (let i = p.cursor; i >= 0 && !next; i--) if (!gone.has(p.rows[i].name)) next = p.rows[i].name;
  const busy = toast(`Deleting ${plural(names.length, 'item', 'items')}…`, 'busy');
  const res = await api.trash(names.map((n) => join(pathOf(p), n)));
  busy.close();
  p.selected.clear();
  await refreshAll(next);
  report(res, 'Deleted');
}

function doOpen() {
  const p = act();
  const e = p.rows[p.cursor];
  if (!e) return;
  const full = e.up ? pathOf(p) : join(pathOf(p), e.name);
  api.open(full).then((err) => err && toast(err, 'error'));
}

async function doView() {
  const p = act();
  const e = p.rows[p.cursor];
  if (!e || e.isDir) { toast('Put the cursor on a file to view it.', 'info'); return; }
  const full = join(pathOf(p), e.name);
  const r = await api.preview(full);
  if (!r.ok) { toast(r.error, 'error'); return; }
  showViewer(e.name, full, r);
}

/* ---------- viewer ---------- */
function showViewer(name, full, r) {
  modalOpen = true;
  const prevFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'scrim';
  const meta = r.kind === 'text' && r.truncated ? `${fmtSize(r.size)}, showing the first 256 KB` : fmtSize(r.size);
  wrap.innerHTML = `<div class="viewer" role="dialog" aria-modal="true" aria-label="${esc(name)}">
    <header><h2>${esc(name)}</h2><span class="meta">${esc(meta)}</span>
    <button class="btn" data-open>Open</button><button class="btn" data-close>Close</button></header>
    <div class="viewer-body"></div></div>`;
  const body = $('.viewer-body', wrap);
  if (r.kind === 'image') {
    body.innerHTML = '<div class="viewer-img"><img alt=""></div>';
    $('img', body).src = r.src;
  } else if (r.kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = r.text;
    body.append(pre);
  } else {
    body.innerHTML = '<div class="viewer-note">This is a binary file, so there’s no text to show.</div>';
  }
  $('#modal-root').append(wrap);
  const close = () => {
    wrap.remove();
    modalOpen = false;
    document.removeEventListener('keydown', onKey, true);
    (prevFocus && prevFocus.isConnected ? prevFocus : act().list).focus();
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'F3' || e.key === 'q') { e.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === wrap) close();
    else if (e.target.closest('[data-open]')) { api.open(full).then((err) => err && toast(err, 'error')); close(); }
  });
  $('[data-close]', wrap).focus();
}

/* ---------- dialog ---------- */
function dialog({ title, body, label, input, selectBase, validate, buttons }) {
  return new Promise((resolve) => {
    modalOpen = true;
    hideMenu();
    const prevFocus = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'scrim';
    wrap.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <h2 id="dlg-title">${esc(title)}</h2>
      ${body ? `<p class="dlg-body">${esc(body)}</p>` : ''}
      ${input != null ? `<label class="dlg-field">${label ? `<span>${esc(label)}</span>` : ''}<input class="dlg-input" spellcheck="false"></label><p class="dlg-err" aria-live="polite"></p>` : ''}
      <div class="dlg-actions">${buttons.map((b, i) => `<button data-b="${i}" class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
    $('#modal-root').append(wrap);
    const inp = $('.dlg-input', wrap);
    const err = $('.dlg-err', wrap);
    const primary = buttons.findIndex((b) => b.primary);

    const done = (v) => {
      wrap.remove();
      modalOpen = false;
      document.removeEventListener('keydown', onKey, true);
      (prevFocus && prevFocus.isConnected && prevFocus !== document.body ? prevFocus : act().list).focus();
      resolve(v);
    };
    const choose = (i) => {
      const b = buttons[i];
      if (b.cancel) { done(null); return; }
      if (inp && b.value === undefined) {
        const msg = validate && validate(inp.value);
        if (msg) { err.textContent = msg; inp.focus(); return; }
        done(inp.value);
        return;
      }
      done(b.value === undefined ? true : b.value);
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); choose(primary >= 0 ? primary : buttons.length - 1); }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
    wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-b]'); if (b) choose(+b.dataset.b); });

    if (inp) {
      inp.value = input;
      inp.addEventListener('input', () => { err.textContent = ''; });
      inp.focus();
      const dot = input.lastIndexOf('.');
      if (selectBase && dot > 0) inp.setSelectionRange(0, dot); else inp.select();
    } else {
      $(`[data-b="${primary >= 0 ? primary : 0}"]`, wrap).focus();
    }
  });
}

/* ---------- menus ---------- */
/* One popup serves the right-click menu and the favorites list. Arrow keys
   move through it, Enter runs an item, and number or letter keys jump. */
const menuEl = $('#menu');
let menuItems = [];
function hideMenu(refocus = false) {
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  menuEl.innerHTML = '';
  menuItems = [];
  if (refocus && !modalOpen) act().list.focus();
}
function openMenu(items, x, y, { keyboard = false } = {}) {
  menuItems = items.filter(Boolean);
  menuEl.innerHTML = menuItems.map((it, i) => (it.sep ? '<hr>'
    : it.note ? `<div class="menu-note">${esc(it.note)}</div>`
      : `<button data-m="${i}" role="menuitem"${it.danger ? ' class="danger"' : ''}${it.title ? ` title="${esc(it.title)}"` : ''}>`
        + `<span class="ml">${esc(it.label)}</span>${it.hint ? `<span class="mh">${esc(it.hint)}</span>` : ''}<span class="mk">${esc(it.key || '')}</span></button>`)).join('');
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  if (keyboard) { const first = $('[data-m]', menuEl); if (first) first.focus(); }
}
function runMenuItem(i) {
  const it = menuItems[i];
  hideMenu(true);
  if (it && it.run) it.run();
}
menuEl.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-m]');
  if (b) runMenuItem(+b.dataset.m);
});
menuEl.addEventListener('mousedown', (ev) => ev.preventDefault());

/* Returns true when the key was used by the open menu. */
function menuKey(e) {
  const buttons = $$('[data-m]', menuEl);
  const at = buttons.indexOf(document.activeElement);
  const k = e.key;
  if (k === 'Escape') { hideMenu(true); return true; }
  if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
    let next;
    if (k === 'Home') next = 0;
    else if (k === 'End') next = buttons.length - 1;
    else next = (at + (k === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    if (at < 0 && k === 'ArrowUp') next = buttons.length - 1;
    if (buttons[next]) buttons[next].focus();
    return true;
  }
  if (k === 'Enter' || k === ' ') { if (at >= 0) runMenuItem(+buttons[at].dataset.m); return true; }
  if (k === 'Delete' && at >= 0) {
    const it = menuItems[+buttons[at].dataset.m];
    if (it && it.remove) { it.remove(); return true; }
  }
  if (k.length === 1 && !e.ctrlKey && !e.altKey) {
    const i = menuItems.findIndex((it) => it.accel && it.accel === k.toLowerCase());
    if (i >= 0) { runMenuItem(i); return true; }
  }
  if (k === 'Tab' || k === 'Shift' || k === 'Control' || k === 'Alt') return true;
  hideMenu(true);
  return false;
}

function showMenu(x, y, p, keyboard = false) {
  const e = p.rows[p.cursor];
  const real = e && !e.up;
  const full = real ? join(pathOf(p), e.name) : pathOf(p);
  const many = targets(p).length;
  openMenu([
    real && { label: 'Open', key: 'Enter', run: () => openItem(p, p.cursor) },
    real && !e.isDir && { label: 'View', key: 'F3', run: doView },
    real && e.isDir && { label: 'Open in new tab', run: () => newTab(p, full) },
    real && e.isDir && { label: 'Open in other pane', run: () => navigate(otherOf(p), full) },
    real && e.isDir && { label: 'Calculate size', key: 'Space', run: () => calcSizes(p, [e.name]) },
    real && { sep: true },
    many && { label: 'Copy', key: 'Ctrl+C', run: () => clipCopy(false) },
    many && { label: 'Cut', key: 'Ctrl+X', run: () => clipCopy(true) },
    { label: 'Paste', key: 'Ctrl+V', run: clipPaste },
    { sep: true },
    many && { label: 'Copy to other pane', key: 'F5', run: () => transfer('copy') },
    many && { label: 'Move to other pane', key: 'F6', run: () => transfer('move') },
    real && { label: 'Copy here as…', key: 'Shift+F5', run: () => transfer('copy', { here: true }) },
    real && { label: 'Rename', key: 'F2', run: doRename },
    { label: 'New folder', key: 'F7', run: doMkdir },
    { label: 'New file', key: 'Shift+F4', run: doNewFile },
    { sep: true },
    { label: 'Select by pattern…', key: 'Num +', run: () => selectByMask(p, true) },
    { label: 'Unselect by pattern…', key: 'Num −', run: () => selectByMask(p, false) },
    { label: 'Invert selection', key: 'Num *', run: () => invertSel(p) },
    { sep: true },
    { label: INFO.platform === 'win32' ? 'Show in File Explorer' : 'Show in file manager', run: () => (real ? api.reveal(full) : api.open(full)) },
    { label: many > 1 ? 'Copy paths' : 'Copy path', run: () => copyPaths(p) },
    many && { sep: true },
    many && { label: many > 1 ? `Delete ${many} items` : 'Delete', key: 'F8', danger: true, run: doDelete },
  ], x, y, { keyboard });
}

function showMenuAtCursor(p) {
  const row = rowEl(p, p.cursor);
  const r = (row || p.list).getBoundingClientRect();
  showMenu(r.left + 40, r.bottom, p, true);
}

function copyPaths(p) {
  const names = targets(p);
  const paths = names.length ? names.map((n) => join(pathOf(p), n)) : [pathOf(p)];
  navigator.clipboard.writeText(paths.join('\r\n')).then(() => toast(paths.length > 1 ? `${paths.length} paths copied.` : 'Path copied.', 'ok'));
}

/* ---------- favorite folders (Ctrl+D) ---------- */
function showHotlist(p, keyboard = false) {
  setActive(p.i, false);
  const here = pathOf(p);
  const has = state.hotlist.some((d) => samePath(d, here));
  const keys = '1234567890';
  const remove = (dir) => () => {
    state.hotlist = state.hotlist.filter((d) => !samePath(d, dir));
    save();
    showHotlist(p, true);
  };
  const items = state.hotlist.map((dir, i) => ({
    label: baseName(dir) || dir,
    hint: dir,
    title: `${dir}\nDelete removes it from the list`,
    key: keys[i] || '',
    accel: keys[i],
    run: () => navigate(p, dir),
    remove: remove(dir),
  }));
  if (!items.length) items.push({ note: 'No favorites yet. Add the folders you visit often.' });
  items.push({ sep: true });
  items.push(has
    ? { label: 'Remove this folder', key: 'R', accel: 'r', run: remove(here) }
    : { label: 'Add this folder', key: 'A', accel: 'a', run: () => { state.hotlist.push(here); save(); toast(`Added “${baseName(here)}” to favorites.`, 'ok'); } });
  const r = $('.star', p.el).getBoundingClientRect();
  openMenu(items, r.left, r.bottom + 4, { keyboard });
}

/* ---------- find files (Alt+F7) ---------- */
/* Searches the folder tree in the main process; matches stream in while it
   runs. Enter or a double-click opens the result's folder in the pane. */
const lastFind = { mask: '*', text: '', matchCase: false, hidden: false };
let findSeq = 0;
const finds = new Map(); // search id -> callback for matches as they arrive

function showFind(p) {
  modalOpen = true;
  hideMenu();
  const prevFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'scrim';
  wrap.innerHTML = `<div class="finder" role="dialog" aria-modal="true" aria-labelledby="find-title">
    <header><h2 id="find-title">Find files</h2><button class="btn" data-close>Close</button></header>
    <form class="find-form" autocomplete="off">
      <label class="dlg-field"><span>Name</span><input class="dlg-input" name="mask" spellcheck="false"></label>
      <label class="dlg-field"><span>Containing text</span><input class="dlg-input" name="text" spellcheck="false" placeholder="Optional"></label>
      <label class="dlg-field wide"><span>In</span><input class="dlg-input" name="root" spellcheck="false"></label>
      <div class="find-opts">
        <label><input type="checkbox" name="matchCase"> Match case</label>
        <label><input type="checkbox" name="includeHidden"> Include hidden</label>
        <span class="find-hint">*.jpg; report* finds either. Add | *.tmp to leave those out.</span>
        <button class="btn primary" data-go type="submit">Search</button>
      </div>
    </form>
    <div class="find-status" aria-live="polite"></div>
    <div class="find-results" tabindex="0" role="listbox" aria-label="Results"></div>
    <footer><span class="find-tip">Enter or double-click goes to the file. Esc stops, then closes.</span></footer>
  </div>`;
  $('#modal-root').append(wrap);
  const form = $('.find-form', wrap);
  const status = $('.find-status', wrap);
  const list = $('.find-results', wrap);
  const goBtn = $('[data-go]', wrap);
  const f = form.elements;
  f.mask.value = lastFind.mask;
  f.text.value = lastFind.text;
  f.root.value = pathOf(p);
  f.matchCase.checked = lastFind.matchCase;
  f.includeHidden.checked = lastFind.hidden;

  let results = [];
  let cursor = -1;
  let running = null; // id of the search in progress
  let root = '';

  const rel = (full) => {
    const dir = parentOf(full) || full;
    if (samePath(dir, root)) return '.';
    return dir.startsWith(root) ? dir.slice(root.length).replace(/^[\\/]+/, '') : dir;
  };
  const setCursor = (i) => {
    if (!results.length) return;
    i = Math.max(0, Math.min(results.length - 1, i));
    const old = list.children[cursor];
    if (old) old.classList.remove('cursor');
    cursor = i;
    const row = list.children[i];
    row.classList.add('cursor');
    row.scrollIntoView({ block: 'nearest' });
  };
  const add = (items) => {
    let html = '';
    for (const it of items) {
      const k = kindOf(it);
      html += `<div class="row k-${k}" role="option" data-i="${results.length}" title="${esc(it.path)}">`
        + `<span class="c-name"><span class="ico">${k === 'folder' ? ICON.folder : ICON.file}</span><span class="nm">${esc(it.name)}</span></span>`
        + `<span class="c-dir">${esc(rel(it.path))}</span>`
        + `<span class="c-size">${it.isDir ? '' : fmtSize(it.size)}</span>`
        + `<span class="c-date">${fmtDate(it.mtime)}</span></div>`;
      results.push(it);
    }
    list.insertAdjacentHTML('beforeend', html);
    if (cursor < 0 && results.length) setCursor(0);
  };
  const showStatus = (r, done) => {
    const found = plural(results.length, 'match', 'matches');
    const seen = `${plural(r.files || 0, 'file', 'files')} and ${plural(r.dirs || 0, 'folder', 'folders')} looked at`;
    if (!done) status.textContent = `Searching… ${found} so far, ${seen}`;
    else if (r.truncated) status.textContent = `Stopped at ${found}. Narrow the search to see the rest.`;
    else if (r.cancelled) status.textContent = `Stopped. ${found}, ${seen}.`;
    else status.textContent = results.length ? `${found}, ${seen}.` : `Nothing found. ${seen}.`;
  };

  const stop = () => { if (running) api.cancel(running); };
  const start = async () => {
    stop();
    const opts = {
      mask: f.mask.value.trim() || '*',
      text: f.text.value,
      matchCase: f.matchCase.checked,
      hidden: f.includeHidden.checked,
    };
    root = f.root.value.trim();
    if (!root) { f.root.focus(); return; }
    Object.assign(lastFind, opts);
    results = [];
    cursor = -1;
    list.innerHTML = '';
    const id = `find-${++findSeq}`;
    running = id;
    goBtn.textContent = 'Stop';
    wrap.classList.add('busy');
    showStatus({}, false);
    const res = await new Promise((resolve) => {
      finds.set(id, (r) => {
        if (running === id) { add(r.items); if (!r.done) showStatus(r, false); }
        if (r.done) resolve(r.done);
      });
      api.search({ id, root, ...opts });
    });
    finds.delete(id);
    if (running !== id) return;
    running = null;
    goBtn.textContent = 'Search';
    wrap.classList.remove('busy');
    if (!res.ok) { status.textContent = res.error; return; }
    showStatus(res, true);
    if (results.length) list.focus();
  };
  const goTo = async (i) => {
    const it = results[i];
    if (!it) return;
    close();
    const dir = parentOf(it.path);
    if (dir) await navigate(p, dir, { focusName: it.name });
    setActive(p.i);
  };
  const close = () => {
    stop();
    running = null;
    wrap.remove();
    modalOpen = false;
    document.removeEventListener('keydown', onKey, true);
    (prevFocus && prevFocus.isConnected && prevFocus !== document.body ? prevFocus : p.list).focus();
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (running) stop(); else close();
      return;
    }
    if (e.target !== list) return;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
    if (step) { e.preventDefault(); setCursor(cursor + step); }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
    else if (e.key === 'End') { e.preventDefault(); setCursor(results.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); goTo(cursor); }
  };
  document.addEventListener('keydown', onKey, true);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) stop(); else start();
  });
  list.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.row');
    if (row) setCursor(+row.dataset.i);
  });
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row) goTo(+row.dataset.i);
  });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  $('[data-close]', wrap).addEventListener('click', close);
  f.mask.focus();
  f.mask.select();
}

/* ---------- quick view (Ctrl+Q) ---------- */
/* While on, the pane you're not working in previews whatever is under the
   cursor in the pane you are working in. */
let qvTimer = null;
let qvReq = 0;
function scheduleQuickView() {
  if (!state.qv && !panes.some((p) => !p.qv.hidden)) return;
  clearTimeout(qvTimer);
  qvTimer = setTimeout(renderQuickView, 90);
}
function toggleQuickView() {
  state.qv = !state.qv;
  $('#btn-qv').setAttribute('aria-pressed', String(state.qv));
  renderQuickView();
}
async function renderQuickView() {
  if (panes.length < 2) return;
  const src = act();
  const view = otherOf(src);
  src.qv.hidden = true;
  view.qv.hidden = !state.qv;
  if (!state.qv) return;
  const req = ++qvReq;
  const e = src.rows[src.cursor];
  const body = view.qvBody;
  if (!e || e.up) {
    view.qvTitle.textContent = baseName(pathOf(src));
    view.qvMeta.textContent = '';
    body.innerHTML = '<div class="qv-note">Move the cursor onto a file or folder to preview it.</div>';
    return;
  }
  const full = join(pathOf(src), e.name);
  view.qvTitle.textContent = e.name;
  const size = sizeOf(src, e);
  view.qvMeta.textContent = [kindLabel(e), size != null ? fmtSize(size) : '', fmtDate(e.mtime)].filter(Boolean).join(' · ');
  if (e.isDir) {
    const res = await api.list(full);
    if (req !== qvReq) return;
    if (!res.ok) { body.innerHTML = `<div class="qv-note">${esc(res.error)}</div>`; return; }
    const shown = res.entries.filter((x) => state.hidden || !x.hidden)
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : collator.compare(a.name, b.name)));
    const dirs = shown.filter((x) => x.isDir).length;
    const head = `<div class="qv-sum">${plural(dirs, 'folder', 'folders')}, ${plural(shown.length - dirs, 'file', 'files')}${size == null ? ' · press Space in the other pane to measure its size' : ''}</div>`;
    body.innerHTML = head + (shown.length
      ? `<ul class="qv-list">${shown.slice(0, 300).map((x) => `<li class="k-${kindOf(x)}"><span class="ico">${x.isDir ? ICON.folder : ICON.file}</span><span class="nm">${esc(x.name)}</span><span class="qv-size">${x.isDir ? '' : fmtSize(x.size)}</span></li>`).join('')}</ul>`
        + (shown.length > 300 ? `<div class="qv-note">…and ${shown.length - 300} more</div>` : '')
      : '<div class="qv-note">This folder is empty.</div>');
    return;
  }
  const r = await api.preview(full, 128 * 1024);
  if (req !== qvReq) return;
  if (!r.ok) { body.innerHTML = `<div class="qv-note">${esc(r.error)}</div>`; return; }
  if (r.kind === 'image') {
    body.innerHTML = '<div class="qv-img"><img alt=""></div>';
    $('img', body).src = r.src;
  } else if (r.kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = r.truncated ? `${r.text}\n\n… (first 128 KB shown, press F3 for more)` : r.text;
    body.replaceChildren(pre);
  } else {
    body.innerHTML = '<div class="qv-note">No preview for this kind of file.</div>';
  }
}

/* ---------- toasts ---------- */
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  if (kind !== 'busy') setTimeout(close, kind === 'error' ? 7000 : 3200);
  el.addEventListener('click', close);
  return { close };
}

/* ---------- drag and drop between panes ---------- */
function dropTarget(p, e) {
  if (!drag) return null;
  const row = e.target.closest('.row');
  if (row) {
    const r = p.rows[+row.dataset.i];
    if (r && r.up && p.listing.parent) return { dir: p.listing.parent, row };
    if (r && r.isDir && !r.up && !(drag.from === p.i && drag.names.includes(r.name))) return { dir: join(pathOf(p), r.name), row };
  }
  return drag.from !== p.i ? { dir: pathOf(p), row: null } : null;
}
function clearDropMarks() {
  for (const el of $$('.drop-row')) el.classList.remove('drop-row');
  for (const el of $$('.list.drop')) el.classList.remove('drop');
}

/* ---------- per-pane events ---------- */
function bindPane(p) {
  p.el.addEventListener('mousedown', () => { if (state.active !== p.i) setActive(p.i, false); });

  p.list.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const i = +row.dataset.i;
    const ent = p.rows[i];
    if (e.button === 2) { if (!p.selected.has(ent.name)) setCursor(p, i); return; }
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) { toggleSel(p, i); setCursor(p, i); p.anchor = i; }
    else if (e.shiftKey) { p.selected.clear(); selectRange(p, p.anchor, i); setCursor(p, i); }
    else {
      if (p.selected.size && p.selected.has(ent.name)) p.pendingClear = i;
      else if (p.selected.size) clearSel(p);
      setCursor(p, i);
      p.anchor = i;
    }
  });
  p.list.addEventListener('click', (e) => {
    if (p.pendingClear == null) return;
    const row = e.target.closest('.row');
    if (row && +row.dataset.i === p.pendingClear) clearSel(p);
    p.pendingClear = null;
  });
  p.list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row) openItem(p, +row.dataset.i);
  });
  p.list.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setActive(p.i);
    showMenu(e.clientX, e.clientY, p);
  });
  // Reading or selecting text in the quick view shouldn't move the focus to this pane.
  p.qv.addEventListener('mousedown', (e) => e.stopPropagation());

  p.list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row');
    const ent = row && p.rows[+row.dataset.i];
    if (!ent || ent.up) { e.preventDefault(); return; }
    p.pendingClear = null;
    const names = p.selected.has(ent.name) ? targets(p) : [ent.name];
    drag = { from: p.i, names };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', names.join('\n'));
  });
  p.list.addEventListener('scroll', () => paintWindow(p));
  new ResizeObserver(() => paintWindow(p)).observe(p.list);
  p.list.addEventListener('dragover', (e) => {
    const t = dropTarget(p, e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
    clearDropMarks();
    if (t.row) t.row.classList.add('drop-row'); else p.list.classList.add('drop');
  });
  p.list.addEventListener('dragleave', (e) => { if (!p.list.contains(e.relatedTarget)) clearDropMarks(); });
  p.list.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = dropTarget(p, e);
    const d = drag;
    clearDropMarks();
    drag = null;
    if (!t || !d) return;
    setActive(d.from, false);
    transfer(e.shiftKey ? 'move' : 'copy', { src: panes[d.from], names: d.names, destDir: t.dir });
  });

  p.tablist.addEventListener('click', (e) => {
    const x = e.target.closest('[data-x]');
    if (x) { closeTab(p, +x.dataset.x); return; }
    const t = e.target.closest('.tab');
    if (t) switchTab(p, +t.dataset.t);
  });
  p.tablist.addEventListener('auxclick', (e) => {
    const t = e.target.closest('.tab');
    if (t && e.button === 1) closeTab(p, +t.dataset.t);
  });
  $('.tab-add', p.el).addEventListener('click', () => newTab(p));
  $('.up', p.el).addEventListener('click', () => { goUp(p); p.list.focus(); });
  $('.star', p.el).addEventListener('click', (e) => { e.stopPropagation(); showHotlist(p); });

  p.crumbs.addEventListener('click', (e) => {
    const c = e.target.closest('.crumb');
    if (c) { navigate(p, c.dataset.path); p.list.focus(); }
  });
  p.crumbs.addEventListener('dblclick', (e) => { if (!e.target.closest('.crumb')) editPath(p); });
  p.pathInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = p.pathInput.value.trim();
      if (v && await navigate(p, v)) closePathEdit(p);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePathEdit(p);
    }
  });
  p.pathInput.addEventListener('blur', () => closePathEdit(p, false));

  p.drive.addEventListener('change', async () => {
    if (p.drive.value) await navigate(p, p.drive.value);
    p.list.focus();
  });
  p.filterInput.addEventListener('input', () => setFilter(p, p.filterInput.value));

  for (const b of $$('.head button', p.el)) {
    b.addEventListener('click', () => {
      const key = b.dataset.sort;
      if (p.sort.key === key) p.sort.dir *= -1; else p.sort = { key, dir: 1 };
      build(p, currentName(p));
      renderChrome(p);
      save();
      p.list.focus();
    });
  }
}

/* ---------- keyboard ---------- */
function onKeyDown(e) {
  if (modalOpen) return;
  if (!menuEl.hidden && menuKey(e)) { e.preventDefault(); return; }
  const p = act();
  const t = e.target;
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (t.classList && t.classList.contains('pathinput')) return;
  if (t.tagName === 'SELECT') { if (k === 'Escape') p.list.focus(); return; }
  if (t.tagName === 'BUTTON' && !t.closest('.dialog')) p.list.focus();

  const inFilter = !!(t.classList && t.classList.contains('filter-input'));
  if (inFilter) {
    if (k === 'Escape') { e.preventDefault(); setFilter(p, ''); p.list.focus(); return; }
    if (k === 'Tab') { e.preventDefault(); setActive(1 - p.i); return; }
    const nav = ['ArrowDown', 'ArrowUp', 'Enter', 'PageDown', 'PageUp'].includes(k);
    const fkey = /^F\d{1,2}$/.test(k);
    const textEdit = ['a', 'c', 'v', 'x', 'z', 'y', 'backspace', 'delete', 'arrowleft', 'arrowright', 'home', 'end'].includes(k.toLowerCase());
    if (!nav && !fkey && !(ctrl && !textEdit)) return;
  }

  const handled = () => e.preventDefault();

  if (ctrl && !e.altKey) {
    switch (k.toLowerCase()) {
      case 't': handled(); newTab(p); return;
      case 'w': handled(); closeTab(p, p.tab); return;
      case 'r': handled(); refreshAll(); return;
      case 'l': handled(); editPath(p); return;
      case 'h': handled(); toggleHidden(); return;
      case 'f': handled(); p.filterInput.focus(); p.filterInput.select(); return;
      case 'a': handled(); selectAll(p); return;
      case 'c': if (e.shiftKey) { handled(); copyPaths(p); return; } handled(); clipCopy(false); return;
      case 'x': handled(); clipCopy(true); return;
      case 'v': handled(); clipPaste(); return;
      case 'd': handled(); showHotlist(p, true); return;
      case 'q': handled(); toggleQuickView(); return;
      case '=':
      case '+': handled(); selectByMask(p, true); return;
      case '-': handled(); selectByMask(p, false); return;
      case 'u': handled(); swapPanes(); return;
      case 'tab': handled(); cycleTab(p, e.shiftKey ? -1 : 1); return;
      case 'arrowleft': handled(); openInPane(0); return;
      case 'arrowright': handled(); openInPane(1); return;
      default: break;
    }
  }
  if (e.altKey && !ctrl) {
    if (k === 'ArrowLeft') { handled(); goHistory(p, -1); return; }
    if (k === 'ArrowRight') { handled(); goHistory(p, 1); return; }
    if (k === 'F1' || k === 'F2') { handled(); openDrivePicker(panes[k === 'F1' ? 0 : 1]); return; }
    if (k === 'Enter' && e.shiftKey) { handled(); calcAllSizes(p); return; }
    if (k === 'F7') { handled(); showFind(p); return; }
    if (e.code === 'NumpadAdd') { handled(); selectSameExt(p); return; }
  }
  if (!ctrl && !e.altKey) {
    if (e.code === 'NumpadAdd') { handled(); selectByMask(p, true); return; }
    if (e.code === 'NumpadSubtract') { handled(); selectByMask(p, false); return; }
    if (e.code === 'NumpadMultiply') { handled(); invertSel(p); return; }
  }

  switch (k) {
    case 'ArrowDown': handled(); if (e.shiftKey) toggleSel(p, p.cursor); setCursor(p, p.cursor + 1); return;
    case 'ArrowUp': handled(); if (e.shiftKey) toggleSel(p, p.cursor); setCursor(p, p.cursor - 1); return;
    case 'PageDown': handled(); setCursor(p, p.cursor + pageSize(p)); return;
    case 'PageUp': handled(); setCursor(p, p.cursor - pageSize(p)); return;
    case 'Home': handled(); setCursor(p, 0); return;
    case 'End': handled(); setCursor(p, p.rows.length - 1); return;
    case 'Enter': handled(); openItem(p, p.cursor); return;
    case 'Backspace': handled(); goUp(p); return;
    case 'Tab': handled(); setActive(1 - p.i); return;
    case 'Insert': handled(); toggleSel(p, p.cursor); setCursor(p, p.cursor + 1); return;
    case ' ': handled(); spaceSelect(p); return;
    case 'ContextMenu': handled(); showMenuAtCursor(p); return;
    case 'Escape':
      handled();
      if (p.filter) setFilter(p, '');
      else if (p.selected.size) clearSel(p);
      return;
    case 'F2': handled(); doRename(); return;
    case 'F3': handled(); doView(); return;
    case 'F4': handled(); if (e.shiftKey) doNewFile(); else doOpen(); return;
    case 'F5': handled(); transfer('copy', { here: e.shiftKey }); return;
    case 'F6': handled(); if (e.shiftKey) doRename(); else transfer('move'); return;
    case 'F7': handled(); doMkdir(); return;
    case 'F10': if (e.shiftKey) { handled(); showMenuAtCursor(p); } return;
    case 'F8':
    case 'Delete': handled(); doDelete(); return;
    default: break;
  }

  if (k.length === 1 && !ctrl && !e.altKey) {
    handled();
    setFilter(p, p.filter + k);
    p.filterInput.focus();
    p.filterInput.setSelectionRange(p.filter.length, p.filter.length);
  }
}

function openDrivePicker(p) {
  setActive(p.i, false);
  p.drive.focus();
  try { p.drive.showPicker(); } catch { /* focus is enough */ }
}

function toggleHidden() {
  state.hidden = !state.hidden;
  $('#btn-hidden').setAttribute('aria-pressed', String(state.hidden));
  for (const p of panes) build(p, currentName(p));
  toast(state.hidden ? 'Showing hidden files.' : 'Hiding hidden files.', 'info');
  save();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  api.setTheme(state.theme);
}

function applySplit() {
  $('#workspace').style.gridTemplateColumns = `minmax(0, ${state.split}fr) 6px minmax(0, ${100 - state.split}fr)`;
}

/* ---------- persistence ---------- */
function save() {
  if (panes.length < 2 || !panes[0].tabs.length || !panes[1].tabs.length) return;
  try {
    localStorage.setItem(STORE, JSON.stringify({
      theme: state.theme,
      hidden: state.hidden,
      split: state.split,
      active: state.active,
      hotlist: state.hotlist,
      mask: state.mask,
      panes: panes.map((p) => ({
        tab: p.tab,
        sort: p.sort,
        tabs: p.tabs.map((t) => ({ path: t.path, cursorName: t.cursorName || null })).filter((t) => t.path),
      })),
    }));
  } catch { /* storage full or unavailable */ }
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
}

/* ---------- global wiring ---------- */
function bindGlobal() {
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('mousedown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu(); });
  window.addEventListener('blur', () => { hideMenu(); document.body.classList.remove('shift'); });
  window.addEventListener('resize', () => hideMenu());
  // Holding Shift shows the Shift+F-key actions in the bar, as in Total Commander.
  const shiftLabels = (e) => document.body.classList.toggle('shift', e.shiftKey && !e.ctrlKey && !e.altKey);
  document.addEventListener('keydown', shiftLabels, true);
  document.addEventListener('keyup', shiftLabels, true);
  window.addEventListener('beforeunload', save);
  // On the document, not the list: scrolling can replace the dragged row.
  document.addEventListener('dragend', () => {
    drag = null;
    clearDropMarks();
    for (const q of panes) if (q.stale) softRefresh(q);
  });

  for (const b of $$('.actionbar button, .tb-btn, .tab-add, .icon-btn, .head button')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
  }
  const actions = {
    rename: doRename, view: doView, open: doOpen, copy: () => transfer('copy'),
    move: () => transfer('move'), mkdir: doMkdir, delete: doDelete,
    newfile: doNewFile, copyas: () => transfer('copy', { here: true }),
  };
  $('.actionbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) actions[(e.shiftKey && b.dataset.sact) || b.dataset.act]();
  });
  $('#btn-find').addEventListener('click', () => showFind(act()));
  $('#btn-qv').addEventListener('click', toggleQuickView);
  $('#btn-hidden').addEventListener('click', toggleHidden);
  $('#btn-theme').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    save();
  });

  const splitter = $('#splitter');
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const box = $('#workspace').getBoundingClientRect();
    const move = (ev) => {
      state.split = Math.min(80, Math.max(20, ((ev.clientX - box.left) / box.width) * 100));
      applySplit();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      save();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  splitter.addEventListener('dblclick', () => { state.split = 50; applySplit(); save(); });

  api.onFocus(() => { if (!drag) for (const p of panes) softRefresh(p); });
  api.onChanged((key) => { if (panes[key]) softRefresh(panes[key]); });
  api.onProgress(onProgress);
  api.onFound((r) => { const cb = finds.get(r.id); if (cb) cb(r); });
}

function showFatal(message) {
  $('#workspace').innerHTML = `<div class="fatal"><h2>Tandem couldn’t start</h2><p>${esc(message)}</p><p>Press F12 and open the Console tab for details.</p></div>`;
}

window.addEventListener('error', (e) => toast(`Something went wrong: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  toast(`Something went wrong: ${r && r.message ? r.message : r}`, 'error');
});

async function init() {
  if (!api) {
    showFatal('The part of the app that reads your files didn’t load.');
    return;
  }
  INFO = await api.info();
  SEP = INFO.sep;
  document.body.classList.add(`os-${INFO.platform}`);
  const saved = load();
  state.theme = saved && saved.theme ? saved.theme : (INFO.dark ? 'dark' : 'light');
  state.hidden = !!(saved && saved.hidden);
  state.split = (saved && saved.split) || 50;
  state.hotlist = saved && Array.isArray(saved.hotlist) ? saved.hotlist.filter((d) => typeof d === 'string') : [];
  state.mask = (saved && saved.mask) || '*.*';
  $('#btn-hidden').setAttribute('aria-pressed', String(state.hidden));
  applyTheme();
  applySplit();

  // Build the panes and hook up keys and buttons first, so the window always
  // responds even if a drive or folder is slow to answer.
  for (let i = 0; i < 2; i++) panes.push(makePane(i));
  for (const p of panes) {
    const sp = saved && saved.panes && saved.panes[p.i];
    const tabs = sp && sp.tabs && sp.tabs.length ? sp.tabs : [{ path: INFO.home }];
    p.tabs = tabs.map((t) => ({ path: t.path, cursorName: t.cursorName || null, back: [], fwd: [] }));
    p.tab = Math.min((sp && sp.tab) || 0, p.tabs.length - 1);
    if (sp && sp.sort) p.sort = sp.sort;
    p.list.innerHTML = '<div class="empty">Loading…</div>';
  }
  bindGlobal();
  setActive(saved && saved.active === 1 ? 1 : 0);

  api.drives()
    .then((list) => { drives = list || []; for (const p of panes) if (p.listing) renderDrives(p); })
    .catch(() => {});

  await Promise.all(panes.map(async (p) => {
    const t = tabOf(p);
    const target = t.path;
    t.path = null;
    if (await navigate(p, target, { push: false, focusName: t.cursorName, quiet: true }) !== false) return;
    if (await navigate(p, INFO.home, { push: false, quiet: true }) !== false) return;
    t.path = target;
    renderTabs(p);
  }));
}

init().catch((err) => {
  if (!panes.length) showFatal(err && err.message ? err.message : String(err));
  else toast(`Tandem couldn’t finish starting: ${err.message}`, 'error');
});
})();
