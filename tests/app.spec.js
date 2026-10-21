'use strict';
/* global KeyboardEvent -- used inside evaluate(), which runs in the window */
/* End-to-end smoke tests: they start the real app against a throwaway home
   folder and drive it with the keyboard, the way a user would. */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

let root, home, app, win;

test.beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-test-'));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'alpha.txt'), 'hello from alpha\n');
  fs.writeFileSync(path.join(home, 'beta.jpg'), '');
  fs.writeFileSync(path.join(home, 'docs', 'readme.md'), '# readme\n');

  app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: {
      ...process.env,
      // Only Tandem's start folder: faking the real profile makes Windows
      // write its own AppData folder into the test's home.
      TANDEM_HOME: home,
      TANDEM_USER_DATA: path.join(root, 'profile'),
    },
  });
  win = await app.firstWindow();
  await expect(rows(0)).not.toHaveCount(0);
});

test.afterEach(async () => {
  if (app) await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const pane = (i) => win.locator(`.pane[data-pane="${i}"]`);
const rows = (i) => pane(i).locator('.list .row');
const row = (i, name) => rows(i).filter({ has: win.locator('.nm', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) });

async function cursorTo(i, name) {
  await row(i, name).click();
  await expect(row(i, name)).toHaveClass(/cursor/);
}

async function answerDialog(value) {
  const input = win.locator('.dialog .dlg-input');
  await expect(input).toBeVisible();
  if (value != null) await input.fill(value);
  await input.press('Enter');
  await expect(win.locator('.dialog')).toHaveCount(0);
}

test('opens both panes on the home folder', async () => {
  await expect(win).toHaveTitle('Tandem');
  for (const i of [0, 1]) {
    await expect(row(i, 'docs')).toBeVisible();
    await expect(row(i, 'alpha.txt')).toBeVisible();
    await expect(row(i, 'beta.jpg')).toBeVisible();
    await expect(pane(i).locator('.status .count')).toHaveText('1 folder, 2 files');
  }
});

test('typing filters the folder and Esc clears it', async () => {
  await pane(0).locator('.list').focus();
  await win.keyboard.type('alp');
  await expect(rows(0)).toHaveCount(1);
  await expect(pane(0).locator('.status .count')).toContainText('matching “alp”');
  await win.keyboard.press('Escape');
  await expect(row(0, 'beta.jpg')).toBeVisible();
});

test('Enter opens a folder and Backspace goes back up', async () => {
  await cursorTo(0, 'docs');
  await win.keyboard.press('Enter');
  await expect(row(0, 'readme.md')).toBeVisible();
  await win.keyboard.press('Backspace');
  await expect(row(0, 'docs')).toHaveClass(/cursor/);
});

test('F7 creates a folder', async () => {
  await cursorTo(0, 'alpha.txt');
  await win.keyboard.press('F7');
  await answerDialog('made by test');
  await expect(row(0, 'made by test')).toBeVisible();
  expect(fs.statSync(path.join(home, 'made by test')).isDirectory()).toBe(true);
});

test('F2 renames a file', async () => {
  await cursorTo(0, 'alpha.txt');
  await win.keyboard.press('F2');
  await answerDialog('gamma.txt');
  await expect(row(0, 'gamma.txt')).toBeVisible();
  expect(fs.existsSync(path.join(home, 'alpha.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(home, 'gamma.txt'), 'utf8')).toBe('hello from alpha\n');
});

test('F5 copies to the folder open in the other pane', async () => {
  await cursorTo(1, 'docs');
  await win.keyboard.press('Enter');
  await expect(row(1, 'readme.md')).toBeVisible();
  await cursorTo(0, 'alpha.txt');
  await win.keyboard.press('F5');
  await answerDialog(null);
  await expect(row(1, 'alpha.txt')).toBeVisible();
  expect(fs.readFileSync(path.join(home, 'docs', 'alpha.txt'), 'utf8')).toBe('hello from alpha\n');
  expect(fs.existsSync(path.join(home, 'alpha.txt'))).toBe(true);
});

test('F6 moves to the folder open in the other pane', async () => {
  await cursorTo(1, 'docs');
  await win.keyboard.press('Enter');
  await cursorTo(0, 'beta.jpg');
  await win.keyboard.press('F6');
  await answerDialog(null);
  await expect(row(1, 'beta.jpg')).toBeVisible();
  await expect(row(0, 'beta.jpg')).toHaveCount(0);
  expect(fs.existsSync(path.join(home, 'docs', 'beta.jpg'))).toBe(true);
});

test('F3 shows a text file', async () => {
  await cursorTo(0, 'alpha.txt');
  await win.keyboard.press('F3');
  await expect(win.locator('#modal-root')).toContainText('hello from alpha');
});

test('the theme button switches between light and dark', async () => {
  const theme = () => win.locator('html').getAttribute('data-theme');
  const before = await theme();
  await win.locator('#btn-theme').click();
  await expect.poll(theme).not.toBe(before);
});

test('logs no errors from the window', async () => {
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await cursorTo(0, 'docs');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Tab');
  await expect(row(1, 'docs')).toBeVisible();
  expect(errors).toEqual([]);
});

test('opening a folder while a refresh is still loading opens that folder', async () => {
  await cursorTo(0, 'docs');
  // In the same instant, so the refresh is still loading when Enter opens docs.
  await pane(0).locator('.list').evaluate((list) => {
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await win.waitForTimeout(1000); // let the refresh finish too
  await expect(pane(0).locator('.tab.on')).toHaveText('docs');
  await expect(row(0, 'readme.md')).toBeVisible();
});

test('refreshing quickly several times stays in the same folder', async () => {
  await pane(0).locator('.list').evaluate((list) => {
    for (let n = 0; n < 6; n++) list.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
  });
  await win.waitForTimeout(1000);
  await expect(pane(0).locator('.tab.on')).toHaveText('home');
  await expect(pane(1).locator('.tab.on')).toHaveText('home');
});

test.describe('a folder with 5000 files', () => {
  const big = () => path.join(home, 'big');
  const name = (n) => `f${String(n).padStart(4, '0')}.txt`;

  test.beforeEach(async () => {
    fs.mkdirSync(big());
    for (let n = 1; n <= 5000; n++) fs.writeFileSync(path.join(big(), name(n)), '');
    await win.keyboard.press('Control+r');
    await cursorTo(0, 'big');
    await win.keyboard.press('Enter');
    await expect(pane(0).locator('.status .count')).toHaveText('0 folders, 5000 files');
  });

  test('only creates the rows in view', async () => {
    await expect(row(0, name(1))).toBeVisible();
    expect(await rows(0).count()).toBeLessThan(80);
  });

  test('End and Home move to the last and first file', async () => {
    await win.keyboard.press('End');
    await expect(row(0, name(5000))).toHaveClass(/cursor/);
    await expect(row(0, name(5000))).toBeInViewport();
    expect(await rows(0).count()).toBeLessThan(80);
    await win.keyboard.press('Home');
    await expect(rows(0).first()).toHaveClass(/cursor/);
    await expect(rows(0).first()).toBeInViewport();
  });

  test('scrolling shows the rows further down', async () => {
    await pane(0).locator('.list').evaluate((el) => { el.scrollTop = 26 * 2500; });
    await expect(row(0, name(2500))).toBeInViewport();
    await expect(row(0, name(1))).toHaveCount(0);
  });

  test('select all counts every file, not just the ones in view', async () => {
    await win.keyboard.press('Control+a');
    await expect(pane(0).locator('.status .count')).toHaveText('5000 of 5000 selected');
    await win.keyboard.press('End');
    await expect(row(0, name(5000))).toHaveClass(/sel/);
  });

  test('typing filters across the whole folder', async () => {
    await win.keyboard.type('f4999');
    await expect(rows(0)).toHaveCount(1);
    await expect(row(0, name(4999))).toBeVisible();
  });
});

test('files show the system icon when there is one', async () => {
  const hasIcon = await app.evaluate(async ({ app: a }, p) => !(await a.getFileIcon(p, { size: 'normal' })).isEmpty(), path.join(home, 'alpha.txt'));
  const img = row(0, 'alpha.txt').locator('.ico img');
  if (hasIcon) await expect(img).toBeVisible();
  else await expect(row(0, 'alpha.txt').locator('.ico svg')).toBeVisible();
  await expect(row(0, 'docs').locator('.ico svg')).toBeVisible();
});

test.describe('find files', () => {
  const finder = () => win.locator('.finder');
  const results = () => finder().locator('.find-results .row');
  const field = (name) => finder().locator(`[name="${name}"]`);

  async function search({ name = '*', text = '' } = {}) {
    await field('mask').fill(name);
    await field('text').fill(text);
    await field('mask').press('Enter');
    await expect(finder().locator('.find-status')).not.toContainText('Searching');
  }

  test.beforeEach(async () => {
    fs.mkdirSync(path.join(home, 'docs', 'deep', 'er'), { recursive: true });
    fs.writeFileSync(path.join(home, 'docs', 'deep', 'er', 'notes.md'), 'nothing to see\n');
    fs.writeFileSync(path.join(home, 'docs', 'deep', 'readme.txt'), 'Hello From Deep\n');
    await pane(0).locator('.list').focus();
    await win.keyboard.press('Alt+F7');
    await expect(finder()).toBeVisible();
  });

  test('finds files by name in subfolders and goes to one', async () => {
    await search({ name: 'readme' });
    await expect(results()).toHaveCount(2);
    await expect(finder().locator('.find-status')).toContainText('2 matches');
    const deep = results().filter({ hasText: 'readme.txt' });
    await expect(deep.locator('.c-dir')).toHaveText(path.join('docs', 'deep'));
    await deep.click();
    await win.keyboard.press('Enter');
    await expect(finder()).toHaveCount(0);
    await expect(row(0, 'readme.txt')).toHaveClass(/cursor/);
    await expect(row(0, 'er')).toBeVisible();
  });

  test('wildcards and exclusions', async () => {
    await search({ name: '*.md; *.txt | readme*' });
    await expect(results()).toHaveCount(2);
    await expect(results().filter({ hasText: 'notes.md' })).toHaveCount(1);
    await expect(results().filter({ hasText: 'alpha.txt' })).toHaveCount(1);
  });

  test('finds files by their contents, ignoring case unless asked', async () => {
    await search({ text: 'hello from' });
    await expect(results()).toHaveCount(2);
    await field('matchCase').check();
    await search({ text: 'hello from' });
    await expect(results()).toHaveCount(1);
    await expect(results().first()).toContainText('alpha.txt');
  });

  test('says when nothing is found, and Esc closes', async () => {
    await search({ name: 'no-such-file' });
    await expect(finder().locator('.find-status')).toContainText('Nothing found');
    await win.keyboard.press('Escape');
    await expect(finder()).toHaveCount(0);
    await expect(pane(0).locator('.list')).toBeFocused();
  });

  test('can be stopped while it runs', async () => {
    const wide = path.join(home, 'wide');
    for (let d = 0; d < 300; d++) {
      fs.mkdirSync(path.join(wide, `d${d}`), { recursive: true });
      for (let n = 0; n < 20; n++) fs.writeFileSync(path.join(wide, `d${d}`, `f${n}.txt`), 'x'.repeat(2000));
    }
    await field('mask').fill('*');
    await field('text').fill('not in any file');
    await field('mask').press('Enter');
    await expect(finder().locator('[data-go]')).toHaveText('Stop');
    await win.keyboard.press('Escape');
    await expect(finder().locator('.find-status')).toContainText('Stopped');
    await expect(finder()).toBeVisible();
  });
});

test('the title bar button opens Find files', async () => {
  await win.locator('#btn-find').click();
  await expect(win.locator('.finder')).toBeVisible();
  await expect(win.locator('.finder [name="root"]')).toHaveValue(home);
});

async function openIn(i, dir) {
  await pane(i).locator('.status').click();
  await expect(pane(i)).toHaveClass(/active/);
  await win.keyboard.press('Control+l');
  await pane(i).locator('.pathinput').fill(dir);
  await pane(i).locator('.pathinput').press('Enter');
  await expect(pane(i).locator('.crumb.last')).toHaveText(path.basename(dir));
}

async function selectNames(i, names) {
  for (const n of names) {
    await row(i, n).click({ modifiers: ['Control'] });
    await expect(row(i, n)).toHaveClass(/sel/);
  }
}

test.describe('multi-rename', () => {
  const renamer = () => win.locator('.renamer');
  const field = (name) => renamer().locator(`[name="${name}"]`);
  const preview = () => renamer().locator('.rn-row');

  test('renames with a counter mask and can undo it', async () => {
    await selectNames(0, ['alpha.txt', 'beta.jpg']);
    await win.keyboard.press('Control+m');
    await expect(renamer()).toBeVisible();
    await field('name').fill('photo-[C]');
    await field('digits').fill('2');
    await expect(preview().nth(0).locator('.rn-new')).toHaveText('photo-01.txt');
    await expect(preview().nth(1).locator('.rn-new')).toHaveText('photo-02.jpg');
    await field('name').press('Enter');
    await expect(renamer()).toHaveCount(0);
    await expect(row(0, 'photo-01.txt')).toHaveClass(/sel/);
    expect(fs.readFileSync(path.join(home, 'photo-01.txt'), 'utf8')).toBe('hello from alpha\n');
    expect(fs.existsSync(path.join(home, 'photo-02.jpg'))).toBe(true);

    await win.keyboard.press('Control+m');
    await renamer().locator('[data-undo]').click();
    await expect(row(0, 'alpha.txt')).toBeVisible();
    expect(fs.existsSync(path.join(home, 'alpha.txt'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'photo-01.txt'))).toBe(false);
  });

  test('find and replace, ranges and case', async () => {
    await selectNames(0, ['alpha.txt', 'beta.jpg']);
    await win.keyboard.press('Control+m');
    await field('name').fill('[N1-3]_[YMD]');
    await field('search').fill('_\\d+');
    await field('regex').check();
    await field('replace').fill('-x');
    await field('caseMode').selectOption('upper');
    await expect(preview().nth(0).locator('.rn-new')).toHaveText('ALP-X.TXT');
    await expect(preview().nth(1).locator('.rn-new')).toHaveText('BET-X.JPG');
  });

  test('refuses names that clash and changes nothing', async () => {
    await selectNames(0, ['alpha.txt', 'beta.jpg']);
    await win.keyboard.press('Control+m');
    await field('name').fill('same');
    await field('ext').fill('txt');
    await expect(renamer().locator('.rn-row.bad')).toHaveCount(2);
    await expect(renamer().locator('.rn-status')).toContainText('problem');
    await field('name').press('Enter');
    await expect(renamer()).toBeVisible();
    expect(fs.existsSync(path.join(home, 'alpha.txt'))).toBe(true);
  });

  test('shifts names that are taken by other items in the batch', async () => {
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(home, `f${n}.txt`), `file ${n}`);
    await win.keyboard.press('Control+r');
    await selectNames(0, ['f1.txt', 'f2.txt', 'f3.txt']);
    await win.keyboard.press('Control+m');
    await field('name').fill('f[C]');
    await field('start').fill('2');
    await expect(renamer().locator('.rn-row.bad')).toHaveCount(0);
    await field('name').press('Enter');
    await expect(row(0, 'f4.txt')).toBeVisible();
    expect(fs.existsSync(path.join(home, 'f1.txt'))).toBe(false);
    for (const n of [1, 2, 3]) expect(fs.readFileSync(path.join(home, `f${n + 1}.txt`), 'utf8')).toBe(`file ${n}`);
  });
});

test.describe('comparing folders', () => {
  const L = () => path.join(home, 'left');
  const R = () => path.join(home, 'right');
  const old = new Date('2024-01-01T10:00:00Z');
  const recent = new Date('2025-06-01T10:00:00Z');

  test.beforeEach(async () => {
    fs.mkdirSync(path.join(L(), 'sub'), { recursive: true });
    fs.mkdirSync(path.join(R(), 'sub'), { recursive: true });
    const put = (file, text, when) => { fs.writeFileSync(file, text); fs.utimesSync(file, when, when); };
    put(path.join(L(), 'same.txt'), 'same', old);
    put(path.join(R(), 'same.txt'), 'same', old);
    put(path.join(L(), 'only-left.txt'), 'L', old);
    put(path.join(R(), 'only-right.txt'), 'R', old);
    put(path.join(L(), 'changed.txt'), 'new version', recent);
    put(path.join(R(), 'changed.txt'), 'old', old);
    put(path.join(R(), 'sub', 'deep.txt'), 'deep', recent);
    await openIn(0, L());
    await openIn(1, R());
  });

  test('Shift+F2 selects what the other side is missing or has older', async () => {
    await pane(0).locator('.list').focus();
    await win.keyboard.press('Shift+F2');
    await expect(row(0, 'only-left.txt')).toHaveClass(/sel/);
    await expect(row(0, 'changed.txt')).toHaveClass(/sel/);
    await expect(row(0, 'same.txt')).not.toHaveClass(/sel/);
    await expect(row(1, 'only-right.txt')).toHaveClass(/sel/);
    await expect(row(1, 'changed.txt')).not.toHaveClass(/sel/);
    await expect(pane(0).locator('.status .count')).toContainText('2 of');
  });

  test('Synchronize copies the differences both ways, including subfolders', async () => {
    const syncer = () => win.locator('.syncer');
    await pane(0).locator('.list').focus();
    await win.keyboard.press('Control+Shift+S');
    await expect(syncer()).toBeVisible();
    await expect(syncer().locator('.sync-status')).toContainText('4 differences');
    await expect(syncer().locator('.sync-row')).toHaveCount(4);
    await expect(syncer().locator('[data-sync]')).toHaveText('Synchronize 4');
    await syncer().locator('[data-sync]').click();
    await expect(syncer().locator('.sync-status')).toContainText('identical');
    expect(fs.readFileSync(path.join(R(), 'only-left.txt'), 'utf8')).toBe('L');
    expect(fs.readFileSync(path.join(L(), 'only-right.txt'), 'utf8')).toBe('R');
    expect(fs.readFileSync(path.join(R(), 'changed.txt'), 'utf8')).toBe('new version');
    expect(fs.readFileSync(path.join(L(), 'sub', 'deep.txt'), 'utf8')).toBe('deep');
  });

  test('one-way sync leaves the other side alone', async () => {
    const syncer = () => win.locator('.syncer');
    await win.locator('#btn-sync').click();
    await expect(syncer().locator('.sync-status')).toContainText('4 differences');
    await syncer().locator('[name="direction"]').selectOption('lr');
    await expect(syncer().locator('[data-sync]')).toHaveText('Synchronize 2');
    await syncer().locator('[data-sync]').click();
    await expect(syncer().locator('.sync-status')).toContainText('2 differences');
    expect(fs.existsSync(path.join(R(), 'only-left.txt'))).toBe(true);
    expect(fs.existsSync(path.join(L(), 'only-right.txt'))).toBe(false);
  });
});
