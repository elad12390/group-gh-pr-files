# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-09

### Added

- Initial release of **PR File Grouper for GitHub** for Firefox and Chrome.
- Side panel on GitHub PR **Files changed / changes** views, rendered in a
  shadow root so page and extension styles never leak into each other.
- **Folder tree** view with collapsible folders and folder-level select, plus a
  flat-list toggle.
- **Filter** by name, `/regex/`, or space-separated OR terms.
- **Quick-select by type** chips (`Tests`, `__init__`, `.d.ts`, `Configs`,
  `Styles`, `Docs`) plus auto-generated per-extension chips.
- **Multi-select** with checkboxes, shift-click ranges, and *Select shown*.
- **Groups** — save a selection per pull request and re-apply or *focus* it.
- **Star** files (gold accent in the diff) with a *★ only* isolation toggle.
- **Show only** selected files to review a subset in isolation.
- **Mark selected as Viewed / Unviewed** via GitHub's own controls.
- **Resizable** panel with remembered width; the page reflows to fit (never
  overlaps the diff).
- Support for both the classic `Files changed` tab and the new `changes`
  experience, driven by stable diff ids that survive React re-renders and the
  new UI's lazy rendering.
- Real-browser E2E suites (Firefox via geckodriver, Chrome via Playwright) plus
  intent (`.idd`) and Gherkin (`.bdd`) specifications.

[Unreleased]: https://github.com/elad12390/group-gh-pr-files/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/elad12390/group-gh-pr-files/releases/tag/v1.0.0
