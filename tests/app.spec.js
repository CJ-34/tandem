'use strict';
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
