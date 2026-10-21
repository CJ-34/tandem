# Tandem

A modern dual-pane file manager in the spirit of the classic commanders: keyboard first, two panes, tabs, and F-key operations, with a clean light and dark interface.

## Build the installer (easiest)

1. Install Node.js 20 or newer from https://nodejs.org (the LTS installer, default options).
2. Double-click `build-installer.bat` in this folder.

It downloads the build tools, builds everything, and opens the `dist` folder with two files:

- `Tandem-Setup-1.0.0.exe`: the installer. It lets you choose “just me” or “all users” and the install folder. It shows the license, adds Start menu and desktop shortcuts, and registers an uninstaller in Windows Settings > Apps.
- `Tandem-Portable-1.0.0.exe`: a single file that runs without installing, handy for a USB stick.

Windows SmartScreen may warn the first time you run them because they aren’t code-signed. Choose “More info”, then “Run anyway”. Removing the warning for everyone requires buying a code-signing certificate.

### If the build fails with “Cannot create symbolic link”

`build-installer.bat` handles this automatically. If you run `npm run dist` by hand and see it, either run the terminal as administrator once or turn on Developer Mode in Windows Settings (For developers). It comes from two macOS-only files in electron-builder’s toolkit that Windows won’t create without those rights.

## Build in the cloud instead (no Node.js needed)

1. Create a GitHub repository and upload this folder’s contents, including the hidden `.github` folder.
2. On GitHub, open the Actions tab, choose “Build Windows installer”, and click “Run workflow”. It runs the checks first, then builds.
3. When it finishes (about 5 minutes), download the `Tandem-Windows` artifact from the run page. It contains both .exe files.

Pushing a tag such as `v1.0.1` also triggers a build.

## Run from source while developing

```
npm install
npm start
```

## Checks and tests

```
npm run lint   # ESLint
npm test       # end-to-end smoke tests: starts the real app and drives it with the keyboard
npm run check  # both
```

The tests live in `tests/` and use Playwright to launch Tandem against a throwaway home folder, so they never touch your own files or settings. On Linux without a display, run them as `xvfb-run -a npm test`.

## Continuous integration and releases

- **CI** (`.github/workflows/ci.yml`) runs lint and the smoke tests on Windows and Linux for every push and pull request. If a test fails, the report is attached to the run.
- **Build** (`.github/workflows/build.yml`) runs CI first, then builds the installer and portable .exe. It runs on every push to `main` (download them from the run’s `Tandem-Windows` artifact) and can be started by hand from the Actions tab.
- **Releases**: change `"version"` in `package.json`, commit, then push a matching tag, e.g. `git tag v1.0.1 && git push origin v1.0.1`. The Build workflow checks the tag matches the version, then publishes a GitHub Release with both .exe files and generated release notes.
- **Dependabot** (`.github/dependabot.yml`) opens weekly pull requests to update npm packages and GitHub Actions. Electron updates come one at a time so each can be tested on its own.

## Releasing a new version

Change `"version"` in `package.json`, then build again, or push a tag as described above. The installer upgrades an existing installation in place and keeps the user’s tabs and settings.

## Keyboard

| Keys | Action |
| --- | --- |
| Tab | Switch pane |
| Arrows, PgUp/PgDn, Home/End | Move the cursor |
| Enter | Open folder or file |
| Backspace | Parent folder |
| Alt+Left / Alt+Right | Back / forward |
| Insert | Select and move down |
| Space | Select the current item (on a folder, also measures its size) |
| Alt+Shift+Enter | Measure the size of every folder here |
| Shift+Up/Down | Extend the selection |
| Ctrl+A | Select all (press again to clear) |
| Num + / Ctrl+= | Select by pattern, e.g. `*.jpg *.png \| thumb*` (end with `\` for folders) |
| Num − / Ctrl+- | Unselect by pattern |
| Num * | Invert the selection |
| Alt+Num + | Select all files with the same extension |
| Esc | Clear the filter, then the selection |
| Start typing | Filter the current folder |
| F2 or Shift+F6 | Rename |
| F3 | View text or image |
| F4 | Open with the default app |
| Shift+F4 | New file, then open it |
| F5 / F6 | Copy / move to the other pane (type a name instead of a folder to copy or move under a new name) |
| Shift+F5 | Copy in the same folder under a new name |
| F7 | New folder |
| Alt+F7 | Find files by name or contents in this folder and the ones inside it. Enter goes to the result |
| F8 or Delete | Move to the Recycle Bin |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy, cut, and paste files, shared with File Explorer |
| Ctrl+Shift+C | Copy the full paths of the selected items as text |
| Ctrl+D | Favorite folders: 1–9 jump, A adds this folder, Delete removes the highlighted one |
| Ctrl+Q | Quick view: the other pane previews the item under the cursor |
| Shift+F10 or the Menu key | Context menu (arrow keys and Enter work inside it) |
| Ctrl+T / Ctrl+W | New tab / close tab |
| Ctrl+Tab | Next tab |
| Ctrl+Left / Ctrl+Right | Open the folder under the cursor in the left / right pane |
| Ctrl+U | Swap panes |
| Ctrl+L | Type a path |
| Ctrl+H | Show or hide hidden files |
| Ctrl+R | Refresh |
| Alt+F1 / Alt+F2 | Choose a drive for the left / right pane |

With the mouse: drag files to the other pane to copy them (hold Shift to move), drop onto a folder to put them inside it, right-click for a context menu, middle-click a tab to close it, and drag the gap between panes to resize. Hold Shift to see the Shift+F-key actions in the bottom bar.

Copies and moves show a progress card with speed and time left, and can be cancelled. You can keep working while they run. Both panes refresh by themselves when files change on disk.

Tabs, folders, favorites, sort order, theme and pane sizes are remembered between sessions.

## Project layout

- `main.js`: window setup and all file system work (listing, copy and move with progress, delete to Recycle Bin, rename, preview, folder sizes, file search, file icons, folder watching, clipboard).
- `preload.js`: the small, safe bridge between the window and the file system code.
- `renderer/`: the interface (`index.html`, `styles.css`, `app.js`).
- `build/`: the app icon and installer artwork.
- `build-installer.bat`: one-click build on Windows.
- `tests/`: end-to-end smoke tests (Playwright).
- `.github/workflows/`: CI (`ci.yml`) and the installer build and release (`build.yml`).

## Not included yet

Browsing inside archives, FTP/SFTP, plugins, multi-rename, and folder compare/sync. The code is structured so each of these can be added as another handler in `main.js` plus a command in `app.js`.
