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
      HOME: home,
      USERPROFILE: home,
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
