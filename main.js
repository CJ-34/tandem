'use strict';
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { StringDecoder } = require('string_decoder');

const isWin = process.platform === 'win32';
const BG = { dark: '#1E232C', light: '#E9EDF2' };
const OVERLAY = {
  dark: { color: BG.dark, symbolColor: '#D7DDE8', height: 40 },
  light: { color: BG.light, symbolColor: '#1F2632', height: 40 },
};
const SYSTEM_NAMES = new Set([
  '$recycle.bin', 'system volume information', 'pagefile.sys', 'hiberfil.sys',
  'swapfile.sys', 'dumpstack.log.tmp', 'dumpstack.log', 'config.msi', 'recovery',
  'documents and settings', '$windows.~ws', '$winreagent', '$sysreset',
]);
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
};

let win = null;

// Let the automated tests run with a throwaway profile and home folder.
if (process.env.TANDEM_USER_DATA) app.setPath('userData', process.env.TANDEM_USER_DATA);
const HOME = process.env.TANDEM_HOME || os.homedir();

/* Problems are written to tandem.log in the app's data folder
   (%APPDATA%\Tandem on Windows) so they can be diagnosed after the fact. */
function logPath() {
  try { return path.join(app.getPath('userData'), 'tandem.log'); } catch { return null; }
}
function log(...parts) {
  const file = logPath();
  if (!file) return;
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(' ')}\n`;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, line); } catch { /* ignore */ }
}
process.on('uncaughtException', (err) => log('main error:', err));
process.on('unhandledRejection', (err) => log('main rejection:', err));

function createWindow() {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  win = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 860,
    minHeight: 520,
    title: 'Tandem',
    backgroundColor: BG[theme],
    show: false,
    titleBarStyle: isWin ? 'hidden' : 'default',
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, 'build', 'icon.png') }),
    ...(isWin ? { titleBarOverlay: OVERLAY[theme] } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.webContents.send('window-focus'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (e, input) => {
    const devtools = input.type === 'keyDown'
      && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'));
    if (devtools) { e.preventDefault(); win.webContents.toggleDevTools(); }
  });
  win.webContents.on('preload-error', (_e, preloadPath, err) => log('preload failed:', preloadPath, err));
  win.webContents.on('render-process-gone', (_e, details) => log('window process ended:', JSON.stringify(details)));
  win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'warning' || level === 'error') log(`window ${level}:`, message, `(${sourceId}:${lineNumber})`);
  });
  log('started', app.getVersion(), process.platform, os.release());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}

/* ---------- helpers ---------- */

const norm = (p) => { const r = path.resolve(p); return isWin ? r.toLowerCase() : r; };

function isSameOrInside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

function friendly(message) { const e = new Error(message); e.friendly = true; return e; }

function describe(err, p) {
  const name = p ? (path.basename(p) || p) : '';
  if (err && err.friendly) return err.message;
  switch (err && err.code) {
    case 'EACCES':
    case 'EPERM': return `Access denied: ${name}`;
    case 'ENOENT': return `Not found: ${name}`;
    case 'EBUSY': return `In use by another program: ${name}`;
    case 'ENOSPC': return `Not enough disk space for ${name}`;
    case 'ENOTDIR': return `Not a folder: ${name}`;
    case 'EEXIST': return `Already exists: ${name}`;
    case 'ENAMETOOLONG': return `Path too long: ${name}`;
    case 'ENOTEMPTY': return `Folder isn’t empty: ${name}`;
    default: return `${name}: ${err && err.message ? err.message : 'Unknown error'}`;
  }
}

function nameProblem(n) {
  if (!n || !n.trim()) return 'Enter a name.';
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n)) return 'Names can’t contain \\ / : * ? " < > |';
  if (n === '.' || n === '..') return 'That name is reserved.';
  if (isWin && /[ .]$/.test(n)) return 'Names can’t end with a space or period.';
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- IPC ---------- */

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  sep: path.sep,
  home: HOME,
  dark: nativeTheme.shouldUseDarkColors,
}));

ipcMain.on('app:theme', (_e, theme) => {
  if (!win || !BG[theme]) return;
  win.setBackgroundColor(BG[theme]);
  if (isWin) { try { win.setTitleBarOverlay(OVERLAY[theme]); } catch { /* older Windows */ } }
});

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/* Lists drive letters without touching the drives themselves, so a
   disconnected network drive or an empty card reader can't stall the app. */
function windowsDrives() {
  const script = "[IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name + '|' + $_.DriveType }";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) { log('drive list via PowerShell failed:', err); resolve(null); return; }
      const drives = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [root, type] = l.split('|');
        const label = root.slice(0, 2) + (type === 'Network' ? ' (network)' : type === 'CDRom' ? ' (disc)' : '');
        return { path: root, label };
      }).filter((d) => /^[A-Za-z]:\\$/.test(d.path));
      resolve(drives.length ? drives : null);
    });
  });
}

ipcMain.handle('fs:drives', async () => {
  if (!isWin) return [{ path: '/', label: '/' }];
  const listed = await windowsDrives();
  if (listed) return listed;
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map((L) => {
    const root = `${L}:\\`;
    return withTimeout(fsp.access(root).then(() => root, () => null), 1500, null);
  }));
  return found.filter(Boolean).map((root) => ({ path: root, label: root.slice(0, 2) }));
});

ipcMain.handle('fs:list', async (_e, dir) => {
  try {
    const resolved = path.resolve(dir);
    const dirents = await fsp.readdir(resolved, { withFileTypes: true });
    const entries = await mapLimit(dirents, 64, async (d) => {
      const full = path.join(resolved, d.name);
      let st = null;
      try { st = await fsp.stat(full); } catch { try { st = await fsp.lstat(full); } catch { /* unreadable */ } }
      const isDir = st ? st.isDirectory() : d.isDirectory();
      return {
        name: d.name,
        isDir,
        size: isDir ? null : (st ? st.size : 0),
        mtime: st ? st.mtimeMs : 0,
        isLink: d.isSymbolicLink(),
        hidden: d.name.startsWith('.') || (isWin && SYSTEM_NAMES.has(d.name.toLowerCase())),
      };
    });
    let free = null;
    try { const s = await fsp.statfs(resolved); free = s.bavail * s.bsize; } catch { /* not supported */ }
    const parent = path.dirname(resolved);
    return { ok: true, path: resolved, parent: parent !== resolved ? parent : null, entries, free };
  } catch (err) {
    log('list failed:', dir, err);
    return { ok: false, error: describe(err, dir) };
  }
});

ipcMain.handle('fs:stat', async (_e, p) => {
  try { const st = await fsp.stat(p); return { exists: true, isDir: st.isDirectory() }; } catch { return { exists: false, isDir: false }; }
});

ipcMain.handle('fs:existing', async (_e, paths) => {
  const out = [];
  for (const p of paths) if (await exists(p)) out.push(p);
  return out;
});

/* Walks folder trees with a fixed number of parallel reads. Links and
   junctions are not followed, so loops like "Application Data" can't trap it.
   visit may be async, and returning false skips what's inside a folder. */
function walk(roots, visit, signal, limit = 16) {
  return new Promise((resolve, reject) => {
    const queue = roots.slice();
    let running = 0;
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (signal && signal.aborted) { failed = true; reject(abortError()); return; }
      if (!queue.length && !running) { resolve(); return; }
      while (running < limit && queue.length) {
        const p = queue.shift();
        running++;
        (async () => {
          let st = null;
          try { st = await fsp.lstat(p); } catch { /* unreadable */ }
          if (!st) return;
          if ((await visit(p, st)) === false) return;
          if (st.isDirectory()) {
            try { for (const n of await fsp.readdir(p)) queue.push(path.join(p, n)); } catch { /* unreadable */ }
          }
        })().then(() => { running--; pump(); }, (err) => { failed = true; reject(err); });
      }
    };
    pump();
  });
}

ipcMain.handle('fs:dirsize', async (_e, p) => {
  let bytes = 0;
  let files = 0;
  let dirs = -1;
  try {
    await walk([p], (_p, st) => { if (st.isDirectory()) dirs++; else { files++; bytes += st.size; } });
    return { ok: true, bytes, files, dirs: Math.max(0, dirs) };
  } catch (err) {
    return { ok: false, error: describe(err, p) };
  }
});

/* ---------- search ---------- */

const SEARCH_LIMIT = 10000;
const TEXT_SEARCH_MAX = 256 * 1024 * 1024;
const isHiddenName = (n) => n.startsWith('.') || (isWin && SYSTEM_NAMES.has(n.toLowerCase()));

/* "*.jpg; report*" matches either, "| *.tmp" leaves those out, and a name
   without wildcards matches anywhere in the name. */
function nameMatcher(mask) {
  const [inc, exc = ''] = String(mask || '*').split('|');
  const parse = (str) => [...str.matchAll(/"([^"]*)"|([^;\s]+)/g)].map((m) => {
    let body = m[1] ?? m[2];
    if (!/[*?]/.test(body)) body = `*${body}*`;
    const src = body === '*.*' ? '.*' : body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${src}$`, 'i');
  });
  const yes = parse(inc);
  const no = parse(exc);
  return (name) => (!yes.length || yes.some((re) => re.test(name))) && !no.some((re) => re.test(name));
}

/* Reads in chunks, keeping the end of each one so a match can span two. */
async function fileContains(p, needle, matchCase, signal) {
  const want = matchCase ? needle : needle.toLowerCase();
  const decoder = new StringDecoder('utf8');
  let tail = '';
  const stream = fs.createReadStream(p, { highWaterMark: 1024 * 1024, signal });
  try {
    for await (const chunk of stream) {
      const text = tail + decoder.write(chunk);
      if ((matchCase ? text : text.toLowerCase()).includes(want)) return true;
      tail = text.slice(-(want.length - 1) || text.length);
    }
    return false;
  } finally {
    stream.destroy();
  }
}

/* Matches go to the window in batches on one channel, ending with a batch
   marked done, so none can arrive after the search has been reported over. */
ipcMain.handle('search:run', async (e, { id, root, mask, text, matchCase, hidden }) => {
  const ac = new AbortController();
  ops.set(id, ac);
  const matches = nameMatcher(mask);
  const sender = e.sender;
  let found = [];
  let count = 0;
  let dirs = 0;
  let files = 0;
  let truncated = false;
  let last = 0;
  const send = (done) => {
    if (!sender.isDestroyed()) sender.send('search:found', { id, items: found, dirs, files, done });
    found = [];
  };
  let result;
  try {
    const base = path.resolve(root);
    await walk([base], async (p, st) => {
      if (p === base) return true;
      const name = path.basename(p);
      if (!hidden && isHiddenName(name)) return false;
      const isDir = st.isDirectory();
      if (isDir) dirs++; else files++;
      let hit = matches(name);
      if (hit && text) {
        hit = !isDir && st.size <= TEXT_SEARCH_MAX;
        if (hit) { try { hit = await fileContains(p, text, matchCase, ac.signal); } catch { hit = false; } }
      }
      if (hit) {
        found.push({ path: p, name, isDir, size: isDir ? null : st.size, mtime: st.mtimeMs });
        if (++count >= SEARCH_LIMIT) { truncated = true; ac.abort(); }
      }
      const now = Date.now();
      if (now - last >= 150) { last = now; send(null); }
      return true;
    }, ac.signal, 8);
    result = { ok: true, count, dirs, files };
  } catch (err) {
    result = isAbort(err, { signal: ac.signal })
      ? { ok: true, count, dirs, files, cancelled: !truncated, truncated }
      : { ok: false, error: describe(err, root) };
  } finally {
    ops.delete(id);
  }
  send(result);
  return result;
});

/* ---------- folder watching ---------- */

/* One watcher per pane. Changes are batched so a big copy refreshes the
   pane about once a second instead of on every file. */
const watchers = new Map();

function closeWatcher(entry) {
  clearTimeout(entry.timer);
  if (entry.w) { try { entry.w.close(); } catch { /* already closed */ } }
  entry.w = null;
}

function openWatcher(entry) {
  try {
    entry.w = fs.watch(entry.dir, { persistent: false }, () => {
      const now = Date.now();
      if (!entry.first) entry.first = now;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.first = 0;
        if (!entry.sender.isDestroyed()) entry.sender.send('fs:changed', entry.key);
      }, now - entry.first > 1000 ? 0 : 250);
    });
    entry.w.on('error', () => closeWatcher(entry));
  } catch {
    entry.w = null;
  }
}

ipcMain.on('fs:watch', (e, key, dir) => {
  const cur = watchers.get(key);
  if (cur && cur.w && dir && norm(cur.dir) === norm(dir)) return;
  if (cur) closeWatcher(cur);
  if (!dir) { watchers.delete(key); return; }
  const entry = { key, dir, sender: e.sender, w: null, timer: null, first: 0 };
  watchers.set(key, entry);
  openWatcher(entry);
});

/* Windows won't rename or delete a folder while something watches it or a
   folder inside it, so watchers in the way are paused during our own work. */
async function withReleased(paths, fn) {
  const paused = [];
  for (const entry of watchers.values()) {
    if (entry.w && paths.some((p) => isSameOrInside(entry.dir, p))) { closeWatcher(entry); paused.push(entry); }
  }
  try {
    return await fn();
  } finally {
    for (const entry of paused) {
      if (watchers.get(entry.key) === entry && !entry.w && await exists(entry.dir)) openWatcher(entry);
    }
  }
}

/* ---------- copy and move ---------- */

const ops = new Map();
const SMALL_FILE = 4 * 1024 * 1024;

function abortError() { const e = new Error('Cancelled'); e.name = 'AbortError'; return e; }
const isAbort = (err, ctx) => ctx.signal.aborted || (err && err.name === 'AbortError');
const driveOf = (p) => norm(path.parse(path.resolve(p)).root);

ipcMain.on('op:cancel', (_e, id) => { const ac = ops.get(id); if (ac) ac.abort(); });

function tick(ctx, force) {
  const now = Date.now();
  if (!force && now - ctx.last < 120) return;
  ctx.last = now;
  if (ctx.sender.isDestroyed()) return;
  ctx.sender.send('op:progress', {
    id: ctx.id,
    phase: ctx.phase,
    bytes: ctx.bytes,
    totalBytes: ctx.totalBytes,
    files: ctx.files,
    totalFiles: ctx.totalFiles,
    items: ctx.items,
    totalItems: ctx.totalItems,
    current: ctx.current ? path.basename(ctx.current) : '',
  });
}

async function uniqueCopyPath(p, isDir) {
  const dir = path.dirname(p);
  const name = path.basename(p);
  const ext = isDir ? '' : path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, `${stem} - Copy${n > 1 ? ` (${n})` : ''}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw friendly(`Couldn’t find a free name for ${name}`);
}

async function copyFile(src, dest, st, ctx) {
  ctx.current = src;
  if (st.size < SMALL_FILE) {
    await fsp.copyFile(src, dest);
    ctx.bytes += st.size;
  } else {
    let done = 0;
    const count = new Transform({
      transform(chunk, _enc, cb) { done += chunk.length; ctx.bytes += chunk.length; tick(ctx); cb(null, chunk); },
    });
    try {
      await pipeline(fs.createReadStream(src, { highWaterMark: 1 << 20 }), count, fs.createWriteStream(dest), { signal: ctx.signal });
    } catch (err) {
      ctx.bytes -= done;
      await fsp.rm(dest, { force: true }).catch(() => {});
      throw err;
    }
  }
  await fsp.utimes(dest, st.atime, st.mtime).catch(() => {});
  ctx.files++;
  tick(ctx);
}

async function copyLink(src, dest, there) {
  const target = await fsp.readlink(src);
  let type = 'file';
  try { if ((await fsp.stat(src)).isDirectory()) type = isWin ? 'junction' : 'dir'; } catch { /* dangling link */ }
  if (there) await fsp.rm(dest, { force: true });
  await fsp.symlink(target, dest, type);
}

/* Copies a file or folder tree. Problems with single items inside a folder
   are collected so one locked file doesn't stop the rest. */
async function copyEntry(src, dest, ctx) {
  if (ctx.signal.aborted) throw abortError();
  const st = await fsp.lstat(src);
  const there = await fsp.lstat(dest).catch(() => null);
  if (st.isDirectory()) {
    if (there && !there.isDirectory()) await fsp.rm(dest, { force: true });
    if (!there || !there.isDirectory()) await fsp.mkdir(dest);
    for (const name of await fsp.readdir(src)) {
      try {
        await copyEntry(path.join(src, name), path.join(dest, name), ctx);
      } catch (err) {
        if (isAbort(err, ctx)) throw err;
        ctx.errors.push(describe(err, path.join(src, name)));
      }
    }
    await fsp.utimes(dest, st.atime, st.mtime).catch(() => {});
    return;
  }
  if (there && there.isDirectory()) await fsp.rm(dest, { recursive: true, force: true });
  if (st.isSymbolicLink()) { await copyLink(src, dest, there); return; }
  await copyFile(src, dest, st, ctx);
}

/* Moves by renaming where possible. Folders that already exist at the
   destination are merged; other drives fall back to copy then delete. */
async function moveEntry(src, dest, ctx) {
  if (ctx.signal.aborted) throw abortError();
  const there = await fsp.lstat(dest).catch(() => null);
  if (there) {
    const st = await fsp.lstat(src);
    if (st.isDirectory() && there.isDirectory()) {
      for (const name of await fsp.readdir(src)) {
        try {
          await moveEntry(path.join(src, name), path.join(dest, name), ctx);
        } catch (err) {
          if (isAbort(err, ctx)) throw err;
          ctx.errors.push(describe(err, path.join(src, name)));
        }
      }
      await fsp.rmdir(src).catch(() => {});
      return;
    }
    await fsp.rm(dest, { recursive: true, force: true });
  }
  ctx.current = src;
  try {
    await fsp.rename(src, dest);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  const before = ctx.errors.length;
  await copyEntry(src, dest, ctx);
  if (ctx.errors.length === before) await fsp.rm(src, { recursive: true, force: true });
  else ctx.errors.push(`Kept the original “${path.basename(src)}” because some items inside couldn’t be copied.`);
}

ipcMain.handle('fs:transfer', async (e, { id, mode, items, overwrite }) => {
  const result = { done: 0, skipped: 0, errors: [], cancelled: false, dests: [] };
  const ac = new AbortController();
  ops.set(id, ac);
  const ctx = {
    id, sender: e.sender, signal: ac.signal, phase: 'scan', last: 0, current: '', errors: [],
    bytes: 0, totalBytes: 0, files: 0, totalFiles: 0, items: 0, totalItems: items.length,
  };
  try {
    // Count what will actually be copied so progress can be shown in bytes.
    // Moves on the same drive are renames and finish instantly.
    tick(ctx, true);
    const itemBytes = new Map();
    for (const it of items) {
      if (mode === 'move' && driveOf(it.src) === driveOf(it.dest)) continue;
      let bytes = 0;
      await walk([it.src], (_p, st) => { if (!st.isDirectory()) { ctx.totalFiles++; bytes += st.size; } }, ac.signal);
      itemBytes.set(it, bytes);
      ctx.totalBytes += bytes;
    }
    ctx.phase = 'run';
    tick(ctx, true);
    await withReleased(mode === 'move' ? items.map((it) => it.src) : [], async () => {
      for (const it of items) {
        if (ac.signal.aborted) throw abortError();
        const { src } = it;
        let { dest } = it;
        try {
          const same = norm(src) === norm(dest);
          if (same && mode === 'move') throw friendly(`“${path.basename(src)}” is already there.`);
          if (!same && isSameOrInside(dest, src)) throw friendly(`Can’t ${mode} “${path.basename(src)}” into itself.`);
          const st = await fsp.lstat(src);
          if (same) {
            dest = await uniqueCopyPath(src, st.isDirectory());
          } else if (await exists(dest) && !overwrite) {
            result.skipped++;
            ctx.totalBytes -= itemBytes.get(it) || 0;
            continue;
          }
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          if (mode === 'copy') await copyEntry(src, dest, ctx);
          else await moveEntry(src, dest, ctx);
          result.done++;
          result.dests.push(dest);
        } catch (err) {
          if (isAbort(err, ctx)) throw err;
          result.errors.push(describe(err, src));
        } finally {
          ctx.items++;
          tick(ctx);
        }
      }
    });
  } catch (err) {
    if (isAbort(err, ctx)) result.cancelled = true;
    else result.errors.push(describe(err));
  } finally {
    ops.delete(id);
  }
  result.errors.push(...ctx.errors);
  return result;
});

ipcMain.handle('fs:trash', async (_e, paths) => {
  const result = { done: 0, skipped: 0, errors: [] };
  await withReleased(paths, async () => {
    for (const p of paths) {
      try { await shell.trashItem(p); result.done++; } catch (err) { result.errors.push(describe(err, p)); }
    }
  });
  return result;
});

ipcMain.handle('fs:mkfile', async (_e, dir, name) => {
  const problem = nameProblem(name);
  if (problem) return { ok: false, error: problem };
  const full = path.join(dir, name);
  try {
    const fh = await fsp.open(full, 'wx');
    await fh.close();
    return { ok: true, path: full, created: true };
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: true, path: full, created: false };
    return { ok: false, error: describe(err, name) };
  }
});

/* ---------- clipboard ---------- */

/* Files go on the Windows clipboard in the same format File Explorer uses,
   so Ctrl+C / Ctrl+X / Ctrl+V work in both directions. Electron can't write
   that format itself, so a short PowerShell script does it. */
const CLIP_WRITE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$j = Get-Content -LiteralPath $env:TANDEM_CLIP -Raw -Encoding UTF8 | ConvertFrom-Json
$list = New-Object System.Collections.Specialized.StringCollection
foreach ($f in $j.files) { [void]$list.Add([string]$f) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($list)
$data.SetData('Preferred DropEffect', (New-Object System.IO.MemoryStream(,[byte[]]@([byte]$j.effect, 0, 0, 0))))
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 5, 100)
`;
const CLIP_READ = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$files = @([System.Windows.Forms.Clipboard]::GetFileDropList())
$effect = 5
$o = [System.Windows.Forms.Clipboard]::GetData('Preferred DropEffect')
if ($o -is [System.IO.MemoryStream]) { $b = New-Object byte[] 4; [void]$o.Read($b, 0, 4); $effect = [BitConverter]::ToInt32($b, 0) }
ConvertTo-Json -Compress @{ files = $files; effect = $effect }
`;
const CLIP_CLEAR = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::Clear()
`;
let internalClip = { files: [], effect: 5 };

function powershell(script, env = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encoded], {
      windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...env },
    }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

ipcMain.handle('clip:write', async (_e, files, cut) => {
  internalClip = { files, effect: cut ? 2 : 5 };
  if (!isWin) return { ok: true };
  const tmp = path.join(os.tmpdir(), `tandem-clip-${process.pid}-${Date.now()}.json`);
  try {
    await fsp.writeFile(tmp, JSON.stringify(internalClip), 'utf8');
    await powershell(CLIP_WRITE, { TANDEM_CLIP: tmp });
    return { ok: true };
  } catch (err) {
    log('clipboard write failed:', err);
    return { ok: true, internalOnly: true };
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

ipcMain.handle('clip:read', async () => {
  if (!isWin) return internalClip;
  try {
    const out = JSON.parse((await powershell(CLIP_READ)).trim() || '{}');
    const files = Array.isArray(out.files) ? out.files : out.files ? [out.files] : [];
    return { files: files.map(String), effect: Number(out.effect) || 5 };
  } catch (err) {
    log('clipboard read failed:', err);
    return internalClip;
  }
});

ipcMain.handle('clip:clear', async () => {
  internalClip = { files: [], effect: 5 };
  if (isWin) await powershell(CLIP_CLEAR).catch((err) => log('clipboard clear failed:', err));
});

ipcMain.handle('fs:mkdir', async (_e, dir, name) => {
  const problem = nameProblem(name);
  if (problem) return { ok: false, error: problem };
  try { await fsp.mkdir(path.join(dir, name)); return { ok: true }; } catch (err) { return { ok: false, error: describe(err, name) }; }
});

ipcMain.handle('fs:rename', async (_e, from, name) => {
  const problem = nameProblem(name);
  if (problem) return { ok: false, error: problem };
  const to = path.join(path.dirname(from), name);
  try {
    if (norm(to) !== norm(from) && await exists(to)) throw friendly(`“${name}” already exists here.`);
    await withReleased([from], () => fsp.rename(from, to));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, from) };
  }
});

/* Multi-rename. Names inside one folder can be swapped or shifted (a→b,
   b→c), so when a new name is still taken by another item in the batch,
   everything goes through temporary names first. */
ipcMain.handle('fs:renameMany', async (_e, dir, pairs) => {
  const result = { done: [], errors: [] };
  const changed = pairs.filter((pr) => pr.from !== pr.to);
  for (const pr of changed) {
    const problem = nameProblem(pr.to);
    if (problem) result.errors.push(`${pr.to}: ${problem}`);
  }
  const targets = new Set();
  for (const pr of pairs) {
    const key = norm(path.join(dir, pr.to));
    if (targets.has(key)) result.errors.push(`Two items would both be named “${pr.to}”.`);
    targets.add(key);
  }
  const sources = new Set(pairs.map((pr) => norm(path.join(dir, pr.from))));
  for (const pr of changed) {
    const to = path.join(dir, pr.to);
    if (!sources.has(norm(to)) && await exists(to)) result.errors.push(`“${pr.to}” already exists here.`);
  }
  if (result.errors.length) return result;

  const viaTemp = changed.some((pr) => {
    const to = norm(path.join(dir, pr.to));
    return sources.has(to) && to !== norm(path.join(dir, pr.from));
  });
  await withReleased(changed.map((pr) => path.join(dir, pr.from)), async () => {
    const steps = [];
    for (const [i, pr] of changed.entries()) {
      const from = path.join(dir, pr.from);
      if (!viaTemp) { steps.push({ pr, from, cur: from }); continue; }
      const tmp = path.join(dir, `.tandem-rename-${process.pid}-${Date.now()}-${i}`);
      try {
        await fsp.rename(from, tmp);
        steps.push({ pr, from, cur: tmp });
      } catch (err) {
        result.errors.push(describe(err, from));
      }
    }
    for (const s of steps) {
      try {
        await fsp.rename(s.cur, path.join(dir, s.pr.to));
        result.done.push(s.pr);
      } catch (err) {
        result.errors.push(describe(err, s.from));
        if (s.cur !== s.from) await fsp.rename(s.cur, s.from).catch(() => {});
      }
    }
  });
  return result;
});

/* ---------- folder sync ---------- */

/* Compares two folder trees by relative path. A folder that exists on only
   one side is reported once, without looking inside it. */
async function sameContent(a, b, signal) {
  const CHUNK = 1 << 20;
  const [fa, fb] = await Promise.all([fsp.open(a, 'r'), fsp.open(b, 'r')]);
  try {
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    for (let pos = 0; ; pos += CHUNK) {
      if (signal.aborted) throw abortError();
      const [ra, rb] = await Promise.all([fa.read(ba, 0, CHUNK, pos), fb.read(bb, 0, CHUNK, pos)]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (!ra.bytesRead) return true;
      if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false;
    }
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}

ipcMain.handle('sync:scan', async (e, { id, left, right, content, hidden }) => {
  const ac = new AbortController();
  ops.set(id, ac);
  const items = [];
  let seen = 0;
  let last = 0;
  const progress = () => {
    const now = Date.now();
    if (now - last < 150 || e.sender.isDestroyed()) return;
    last = now;
    e.sender.send('op:progress', { id, phase: 'scan', totalFiles: seen, current: '' });
  };
  const info = (st) => (st ? { isDir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: st.mtimeMs } : null);
  const isHidden = (name) => name.startsWith('.') || (isWin && SYSTEM_NAMES.has(name.toLowerCase()));
  async function compare(rel) {
    if (ac.signal.aborted) throw abortError();
    const names = new Set();
    const read = async (root) => { try { return await fsp.readdir(path.join(root, rel)); } catch { return []; } };
    for (const n of await read(left)) names.add(n);
    for (const n of await read(right)) names.add(n);
    for (const name of [...names].sort()) {
      if (!hidden && isHidden(name)) continue;
      const r = rel ? path.join(rel, name) : name;
      const [ls, rs] = await Promise.all([fsp.lstat(path.join(left, r)).catch(() => null), fsp.lstat(path.join(right, r)).catch(() => null)]);
      seen++;
      progress();
      const L = info(ls);
      const R = info(rs);
      if (L && R && L.isDir && R.isDir) { await compare(r); continue; }
      const it = { rel: r, left: L, right: R, state: 'equal' };
      if (!L) it.state = 'right-only';
      else if (!R) it.state = 'left-only';
      else if (L.isDir !== R.isDir) it.state = 'conflict';
      else if (L.size === R.size && Math.abs(L.mtime - R.mtime) < 2000) it.state = 'equal';
      else if (content && L.size === R.size && await sameContent(path.join(left, r), path.join(right, r), ac.signal)) it.state = 'equal';
      else if (Math.abs(L.mtime - R.mtime) < 2000) it.state = 'conflict';
      else it.state = L.mtime > R.mtime ? 'left-newer' : 'right-newer';
      items.push(it);
    }
  }
  try {
    for (const root of [left, right]) {
      const st = await fsp.stat(root);
      if (!st.isDirectory()) throw friendly(`Not a folder: ${root}`);
    }
    if (isSameOrInside(left, right) || isSameOrInside(right, left)) throw friendly('One folder is inside the other, so they can’t be synchronized.');
    await compare('');
    return { ok: true, items };
  } catch (err) {
    if (ac.signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, error: describe(err, err.path || left) };
  } finally {
    ops.delete(id);
  }
});

ipcMain.handle('fs:preview', async (_e, p, maxText = 256 * 1024) => {
  try {
    const st = await fsp.stat(p);
    const ext = path.extname(p).slice(1).toLowerCase();
    if (IMAGE_MIME[ext] && st.size <= 25 * 1024 * 1024) {
      const buf = await fsp.readFile(p);
      return { ok: true, kind: 'image', size: st.size, src: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}` };
    }
    const length = Math.min(st.size, maxText);
    const buf = Buffer.alloc(length);
    const fh = await fsp.open(p, 'r');
    try { await fh.read(buf, 0, length, 0); } finally { await fh.close(); }
    if (buf.includes(0)) return { ok: true, kind: 'binary', size: st.size };
    return { ok: true, kind: 'text', size: st.size, text: buf.toString('utf8'), truncated: st.size > length };
  } catch (err) {
    return { ok: false, error: describe(err, p) };
  }
});

/* System icons for files, as data URLs (null when the system has none). */
ipcMain.handle('fs:icons', async (_e, paths) => mapLimit(paths, 8, async (p) => {
  try {
    const img = await withTimeout(app.getFileIcon(p, { size: 'normal' }), 3000, null);
    return img && !img.isEmpty() ? img.toDataURL() : null;
  } catch {
    return null;
  }
}));

ipcMain.handle('shell:open', async (_e, p) => {
  const err = await shell.openPath(p);
  return err || null;
});

ipcMain.on('shell:reveal', (_e, p) => shell.showItemInFolder(p));
