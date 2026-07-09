// A faithful reproduction of GitHub's NEW "changes" experience DOM structure
// (as captured from a live logged-in PR). Served under a github.com/pull/.../files
// URL in the E2E so the real extension content script activates against it. The
// live new experience is login-gated, so this fixture is how we exercise the
// new-experience adapter + :has() focus CSS in a real rendering engine.

const LRM = '\u200e'

export const NEW_FILES = [
  'src/api/client.ts',
  'src/api/client.test.ts',
  'src/components/Button.tsx',
  'src/components/Button.test.tsx',
  'src/utils/format.js',
  'src/__tests__/integration.test.js',
  'README.md',
  'package.json'
]

const idOf = (i) => `diff-newfixture${i}`

const region = (i, p) => `
  <div class="PullRequestDiffsList-module__diffEntry__djnVa">
    <div role="region" id="${idOf(i)}" aria-labelledby="h${i}" class="Diff-module__diffTargetable Diff-module__diff">
      <div class="Diff-module__diffHeaderWrapper">
        <div class="DiffFileHeader-module__diff-file-header">
          <h3 id="h${i}" class="DiffFileHeader-module__file-name">
            <a class="Link--primary" href="#${idOf(i)}"><code>${LRM}${p}${LRM}</code></a>
          </h3>
          <button type="button" aria-pressed="false" aria-label="Not Viewed"><span>Viewed</span></button>
        </div>
      </div>
      <div class="diff-body" style="min-height:140px;padding:8px;">diff table for ${p}</div>
    </div>
  </div>`

const leaf = (i, p) => {
  const base = p.split('/').pop()
  return `<li role="treeitem" id="${p}" aria-label="${base}"><div><a class="fgColor-default" href="#${idOf(
    i
  )}" role="presentation" tabindex="-1">${base}</a></div></li>`
}

// Inner body markup only — injected into a live github.com page during the
// real-Firefox E2E so the extension's content script runs against it.
export function newExperienceBody() {
  const regions = NEW_FILES.map((p, i) => region(i, p)).join('\n')
  const leaves = NEW_FILES.map((p, i) => leaf(i, p)).join('\n')
  return `
  <div id="pr-file-tree">
    <ul role="tree" aria-label="File Tree">
      <li role="treeitem" id="src" aria-expanded="true"><div>src</div>
        <ul role="group">${leaves}</ul>
      </li>
    </ul>
  </div>
  <div data-testid="diff-content">
    <div data-hpc="true" data-testid="progressive-diffs-list" class="d-flex flex-column gap-3">
      ${regions}
      <svg class="DiffPlaceholder-module__svg" aria-hidden="true"></svg>
    </div>
  </div>`
}

export function newExperienceHtml() {
  return `<!doctype html>
<html lang="en" data-color-mode="light">
<head><meta charset="utf-8"><title>New experience fixture · Pull Request · GitHub</title></head>
<body>${newExperienceBody()}</body>
</html>`
}
