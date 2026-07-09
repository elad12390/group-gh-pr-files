# INTENT — PR File Grouper

## Layer 1 — Purpose

A browser extension that overlays a control panel on a GitHub pull request's
changed-files view so a reviewer can **filter, multi-select, group, star, and
focus** the file list — turning a large, flat diff into small, reviewable
subsets. It exists because reviewing big PRs by scrolling one long page is slow;
the reviewer needs to isolate "just the tests", "just the API layer", etc.

## Layer 2 — Constraints (runtime invariants)

| # | Constraint |
|---|---|
| C1 | Works on GitHub's **classic** (`#files .file`) AND **new** (`[data-testid="progressive-diffs-list"]`) files views. |
| C2 | The panel renders in a **shadow root**; GitHub styles must not leak in, extension styles must not leak out. |
| C3 | Diff hiding/highlighting uses a single page-level `<style>` keyed by each file's stable `diff-<hash>` id, so it survives GitHub re-renders. |
| C4 | File names are cleaned of bidi/format control chars (`\u200e` etc.) before display or matching. |
| C5 | State (groups, starred files) is persisted in extension storage, scoped per `owner/repo#PR`, and survives a page reload. |
| C6 | Nothing is transmitted off-device; no network calls; no data collection. |
| C7 | The panel activates only on `/pull/<n>` pages and re-scans on SPA navigation + DOM mutation. |
| C8 | The panel **never auto-opens**. It starts closed on every page load; only the user opens it (launch button / `Alt+Shift+G`) and closes it (✕ / `Esc` / toggle). A page mutation must never re-open a closed panel. |
| C9 | An open panel **reflows the page to the left** (sets `margin-right` on the document) instead of overlaying and hiding content. Closing restores it. |
| C10 | Keyboard events are isolated at the shadow boundary: keystrokes typed in the panel never bubble to GitHub's global hotkeys, and page typing never lands in the panel filter (no auto-focus). |
| C11 | File detection uses the diff regions **and** the file tree, so files are found even while diffs are lazily rendered / virtualized. |
| C12 | The list renders as a **foldable folder tree** (default) or a flat list; folders collapse/expand, and a folder checkbox selects/deselects every file under it. |
| C13 | The panel width is **drag-resizable** and persisted globally; the page-push margin tracks the current width. |
| C14 | In tree view, a file's checkbox is **indented under its parent folder** (file rows carry the folder expand-arrow spacer column so columns align). |
| C15 | A folder is shown as **viewed** when every file under it is viewed. |
| C16 | The same file is never listed twice: regions and the file tree are de-duplicated by **diff id**, so a stale/compressed tree path can't create a phantom entry. |
| C17 | Each file row has a **viewed toggle** that marks the file viewed / not-viewed on GitHub directly from the panel. |
| C18 | In tree view, everything sits under a single top-level **`pr`** folder, so the whole PR can be folded and shows viewed once every file is viewed. |
| C19 | Toolbar controls are grouped and labelled so it's clear what selects (**Select by type** chips), what changes the view (**View**), and what acts on the selection (**Selection**). |

## Layer 3 — Examples (behavior the E2E must prove)

| # | Given | When | Then |
|---|---|---|---|
| E1 | A PR files page with N changed files | the panel opens | it lists exactly N files (deduped by path), names free of control chars |
| E2 | The file list | typing `.test` in the filter | only files whose path contains `.test` remain shown |
| E3 | The file list | typing `/__tests__/` (regex) in the filter | only files under a `__tests__` dir remain shown |
| E4 | Files including tests | clicking the **Tests** preset | every test/spec/`__tests__` file becomes selected |
| E5 | Files of mixed extensions | clicking a `.js (n)` extension chip | all `.js` files become selected (added to selection) |
| E6 | Some files selected | clicking **Show only** | non-selected file diffs are visually hidden; selected ones remain visible |
| E7 | Focus mode active | clicking **Show only** again | all file diffs are visible again |
| E8 | A file row | clicking its ★ star | the file's diff shows a persistent accent and the star state is stored |
| E9 | A starred file | reloading the page | the file is still starred (persisted per PR) |
| E10 | A selection of files + a name | clicking **Save** | a reusable group is stored and listed; re-applying it re-selects those files |
| E11 | Panel closed | pressing `Alt+Shift+G` | the panel toggles open |
| E12 | New-experience DOM, files selected | **Show only** | `:has()` page CSS hides the non-selected `progressive-diffs-list` entries in a real engine |
| E13 | A freshly loaded PR page | (nothing) | the panel is **closed**; only the launch button shows |
| E14 | An open panel | clicking ✕ (then the page mutates) | the panel closes and **stays closed** |
| E15 | The panel | opening it | the document gets `margin-right: 360px` (page pushed left); closing removes it |
| E16 | The panel is open | typing in the filter | the keystrokes do **not** reach a document-level key listener (no hotkey leakage) |
| E17 | New-experience page where diff regions are absent but the file tree is present | the panel opens | files are still detected from the tree |
| E18 | Files across several folders | tree view | files are grouped under collapsible folder rows |
| E19 | A folder in the tree | clicking it | its files hide (fold); clicking again shows them (unfold) |
| E20 | A folder | ticking its checkbox | every file under it becomes selected; unticking clears them |
| E21 | The list | clicking the view toggle | it switches between tree and flat (full-path) views |
| E22 | The panel | dragging its left edge | the width changes, the page reflow tracks it, and the width persists across reload |
| E23 | A tree leaf carrying a directory-like path but the same diff id as a real file | the panel scans | the file is listed once with its real path — no phantom directory entry |
| E24 | A file nested inside a folder in tree view | rendering | its checkbox is indented to the right of the folder's checkbox |
| E25 | A folder whose files are all viewed | rendering | the folder row shows the viewed state |
| E26 | A file row | clicking its viewed toggle | the file is marked viewed on GitHub and the row reflects it |
| E27 | Tree view | (rendering) | a single top-level `pr` folder holds every file; its checkbox selects all and it shows viewed when the whole PR is viewed |
