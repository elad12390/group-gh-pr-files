# PR File Grouper for GitHub (Firefox + Chrome)

A browser extension (works in **Firefox** and **Chrome**) that makes reviewing
large GitHub pull requests fast. It adds a side panel to a PR's
**Files changed / changes** view where you can:

- **Folder tree** view with collapsible folders and a folder checkbox that
  selects every file inside it — or toggle to a flat list any time.
- **Resizable** — drag the panel's left edge; the width is remembered and the
  page reflows to fit (it never overlays the diff).
- **Filter** files by name, `/regex/`, or space-separated terms (OR).
- **Quick-select by type** with one click — `Tests`, `__init__`, `.d.ts`,
  `Configs`, `Styles`, `Docs`, plus auto-generated chips per file extension.
- **Multi-select** with checkboxes, **Shift-click** for ranges, and
  **Select shown** for everything currently filtered.
- **Group** a selection under a name and re-apply it later (**focus** = select +
  show only). Groups are saved per pull request.
- **Star** important files — they get a gold accent in the diff view and can be
  isolated with **★ only**.
- **Show only** the selected files (hides every other diff and trims the file
  tree) so you can review a subset in isolation.
- **Mark selected as Viewed / Unviewed** using GitHub's own controls.

Works on both the classic `Files changed` tab and the new `changes` experience.

## Install (temporary, for development)

The same folder loads in both browsers (one MV3 manifest; Chrome ignores the
Firefox-only `browser_specific_settings` key).

**Firefox**

1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → select `manifest.json` in this folder.
3. (Removed on restart. To keep it, package + sign — see below.)

**Chrome / Edge / Brave**

1. Go to `chrome://extensions` and enable **Developer mode** (top-right).
2. **Load unpacked** → select this folder.

Then open any GitHub pull request's files view and click the **▤ Files** button
(bottom-right) or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>.

## Develop / lint / build / test

```bash
bun install              # dev tooling (web-ext, selenium-webdriver, playwright)

bun run lint             # web-ext lint  → 0 errors, 0 warnings
bun run build            # → web-ext-artifacts/pr_file_grouper_for_github-<v>.zip
bun run icons            # regenerate PNG icons from icons/icon.svg
bun run test:e2e:firefox # real-Firefox E2E (geckodriver)
bun run test:e2e:chrome  # real-Chrome E2E (Playwright --load-extension)

# run a scratch Firefox with the extension loaded
bunx web-ext run --source-dir .
```

> Icons are PNG (Chrome rejects SVG manifest icons; Firefox accepts PNG too), so
> one icon set + one manifest serves both browsers.

## Verification (Bulletproof E2E)

Behavior is defined in [`.idd/modules/pr-file-grouper/INTENT.md`](.idd/modules/pr-file-grouper/INTENT.md)
and specified as Gherkin scenarios in
[`.bdd/features/pr-file-grouper.feature`](.bdd/features/pr-file-grouper.feature).

These run against a **real system** — no mocks — driving the **real extension**
in a **real browser**.

`bun run test:e2e:firefox` ([`.bdd/steps/run.mjs`](.bdd/steps/run.mjs)) launches
**real Firefox** via `geckodriver` and installs the add-on as a temporary
extension (exactly like `about:debugging`):

- **Group A — live GitHub (classic view):** a real public PR — detection,
  filtering, "Show only" hide/restore, star surviving a real reload.
- **Group B — new "changes" view:** the live view is login-gated, so its
  captured DOM is served under a real `github.com` URL and the real content
  script runs against it — filters, presets, `:has()` focus in the real CSS
  engine, tree/folders/`pr` root, viewed toggles, groups, resize, persistence.

`bun run test:e2e:chrome` ([`.bdd/steps/run-chrome.mjs`](.bdd/steps/run-chrome.mjs))
loads the same extension into **real Chrome** with Playwright (`--load-extension`)
and runs the same feature set, proving cross-browser parity.

Requires Firefox + `geckodriver` (`brew install geckodriver`) for the Firefox
run, and Playwright's Chromium (`bunx playwright install chromium`) for Chrome.

## Usage tips

- **Filter syntax**: plain text is a case-insensitive substring. Wrap in slashes
  for regex, e.g. `/\.test\.tsx?$/`. Separate terms with spaces to OR them:
  `__init__ .test .spec`.
- **Build a group**: click type chips (they add to the selection), refine with
  checkboxes, type a name and **Save**. Later, click the group to re-select, or
  **focus** to select + show only.
- **Focus review**: select files (or a group) → **Show only**. Toggle again to
  restore all files.
- Data (groups + starred files) is stored locally per `owner/repo#PR`.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | One MV3 manifest for Firefox (140+) and Chrome |
| `src/content.js` | All logic + the shadow-DOM panel (`browser`/`chrome` shim) |
| `src/popup.html` / `src/popup.js` | Toolbar button that toggles the panel |
| `icons/icon.svg` | Icon source; `icons/icon-*.png` are generated (`bun run icons`) |
| `.idd/` | Intent spec (what the extension must do) |
| `.bdd/` | Gherkin features + real Firefox/Chrome E2E runners + fixtures |
| `package.json` | Dev scripts (`lint`, `build`, `icons`, `test:e2e:*`) |

## Notes on robustness

- The panel is rendered in a **shadow root**, so GitHub styles can't leak in and
  the extension's styles can't leak out.
- Diff hiding / starring is done with a single page-level `<style>` keyed by each
  file's stable diff id, so it survives GitHub's React re-renders and the new
  UI's `content-visibility` lazy rendering.
- The script re-scans on SPA navigation (Turbo/pushState) and on DOM mutations.
