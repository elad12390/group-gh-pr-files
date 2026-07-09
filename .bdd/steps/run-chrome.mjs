/*
 * Bulletproof E2E — runs the REAL extension in REAL Chrome (Playwright, MV3
 * --load-extension) against the new-experience fixture served under a
 * github.com PR URL so the content script activates. Proves the same code that
 * ships to Firefox also works in Chrome (browser/chrome shim, PNG icons,
 * shadow DOM, :has(), chrome.storage). No mocks.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newExperienceHtml, NEW_FILES } from '../fixtures/new-experience.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../')
const FIXTURE_URL = 'https://github.com/acme/widgets/pull/7/files'

// Stage a clean copy of the extension (no node_modules / test files).
const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'gpf-chrome-ext-'))
fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(STAGE, 'manifest.json'))
fs.cpSync(path.join(ROOT, 'src'), path.join(STAGE, 'src'), { recursive: true })
fs.cpSync(path.join(ROOT, 'icons'), path.join(STAGE, 'icons'), { recursive: true })

const results = []
async function scenario(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('PASS  ' + name)
  } catch (e) {
    results.push({ name, ok: false, err: e.message })
    console.log('FAIL  ' + name + '\n        ' + e.message)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpf-chrome-profile-'))
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    '--headless=new',
    `--disable-extensions-except=${STAGE}`,
    `--load-extension=${STAGE}`,
    '--no-first-run',
    '--no-default-browser-check'
  ],
  viewport: { width: 1400, height: 1000 }
})
const page = context.pages()[0] || (await context.newPage())

// ---- shadow-DOM helpers (page world) ----
const readPanel = () =>
  page.evaluate(() => {
    const host = document.getElementById('gpf-host')
    if (!host || !host.shadowRoot) return { ready: false }
    const r = host.shadowRoot
    const panel = r.querySelector('.panel')
    const launch = r.querySelector('.launch')
    const counts = (r.querySelector('.counts') || {}).textContent || ''
    const m = counts.match(/(\d+) selected . (\d+) files/)
    return {
      ready: true,
      open: !!(panel && getComputedStyle(panel).display !== 'none'),
      launchVisible: !!(launch && getComputedStyle(launch).display !== 'none'),
      selected: m ? +m[1] : 0,
      fileCount: m ? +m[2] : 0,
      rows: [...r.querySelectorAll('.list .row')].map((x) => ({
        path: x.dataset.path,
        sel: x.classList.contains('sel'),
        imp: x.classList.contains('imp'),
        viewed: x.classList.contains('viewed')
      })),
      dirs: [...r.querySelectorAll('.list .dir-row')].map((d) => ({
        path: d.dataset.dir,
        viewed: d.classList.contains('viewed')
      })),
      treeMode: ((r.querySelector('.toolbar button[data-act=view]') || {}).textContent || '') === 'Tree',
      widthVar: host.style.getPropertyValue('--gpf-w'),
      pageMargin: document.documentElement.style.marginRight
    }
  })

async function openPanel() {
  await page.waitForFunction(() => !!document.getElementById('gpf-host'), null, { timeout: 15000 })
  if (!(await readPanel()).open) {
    await page.evaluate(() => document.getElementById('gpf-host').shadowRoot.querySelector('.launch').click())
  }
  await page.waitForFunction(
    () => {
      const r = document.getElementById('gpf-host') && document.getElementById('gpf-host').shadowRoot
      const p = r && r.querySelector('.panel')
      return !!(p && getComputedStyle(p).display !== 'none' && r.querySelectorAll('.list .row, .list .dir-row').length > 0)
    },
    null,
    { timeout: 15000 }
  )
}
async function ensureTreeMode() {
  await openPanel()
  if (!(await readPanel()).treeMode) {
    await page.evaluate(() => document.getElementById('gpf-host').shadowRoot.querySelector('.toolbar button[data-act=view]').click())
    await sleep(150)
  }
}
const clickToolbar = (act) =>
  page.evaluate((a) => {
    const b = document.getElementById('gpf-host').shadowRoot.querySelector('.toolbar button[data-act="' + a + '"]')
    if (!b) throw new Error('no toolbar action ' + a)
    b.click()
  }, act)
async function typeFilter(text) {
  await page.evaluate((t) => {
    const s = document.getElementById('gpf-host').shadowRoot.querySelector('.search')
    s.value = t
    s.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
  await sleep(240)
}
const clickRow = (p, part) =>
  page.evaluate(
    ([p, part]) => {
      const row = [...document.getElementById('gpf-host').shadowRoot.querySelectorAll('.list .row')].find(
        (x) => x.dataset.path === p
      )
      if (!row) throw new Error('no row ' + p)
      row.querySelector(part === 'cb' ? '.cb' : part === 'star' ? '.star' : '.vtoggle').click()
    },
    [p, part]
  )
const clickDirCheckbox = (p) =>
  page.evaluate((p) => {
    const d = [...document.getElementById('gpf-host').shadowRoot.querySelectorAll('.dir-row')].find((x) => x.dataset.dir === p)
    if (!d) throw new Error('no folder ' + p)
    d.querySelector('.dir-cb').click()
  }, p)
const setFixtureViewed = (ids, on) =>
  page.evaluate(
    ([ids, on]) => {
      ids.forEach((id) => {
        const region = document.getElementById(id)
        if (!region) return
        const b = region.querySelector('button[aria-label]')
        if (b) {
          b.setAttribute('aria-pressed', on ? 'true' : 'false')
          b.setAttribute('aria-label', on ? 'Viewed' : 'Not Viewed')
        }
      })
      window.dispatchEvent(new Event('gpf:locationchange'))
    },
    [ids, on]
  )
async function wireViewed() {
  await page.evaluate(() => {
    ;[...document.querySelectorAll('[data-testid=progressive-diffs-list] button[aria-label]')].forEach((b) => {
      if (b.__w) return
      b.__w = true
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') === 'true'
        b.setAttribute('aria-pressed', on ? 'false' : 'true')
        b.setAttribute('aria-label', on ? 'Not Viewed' : 'Viewed')
      })
    })
  })
}
async function gotoFixture() {
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.querySelector('[data-testid=progressive-diffs-list]'), null, { timeout: 15000 })
  await wireViewed()
  await sleep(400)
}

try {
  await page.route('https://github.com/**/pull/**/files', async (route) => {
    if (route.request().resourceType() === 'document')
      await route.fulfill({ status: 200, contentType: 'text/html', body: newExperienceHtml() })
    else await route.continue()
  })
  await gotoFixture()

  await scenario('C1: extension loads in Chrome; panel starts closed', async () => {
    await page.waitForFunction(() => !!document.getElementById('gpf-host'), null, { timeout: 15000 })
    const st = await readPanel()
    assert(st.ready, 'extension host was not injected in Chrome')
    assert(st.open === false, 'panel auto-opened (should start closed)')
    assert(st.launchVisible, 'launch button not visible')
  })

  await scenario('C2: Alt+Shift+G opens the panel and all files are detected', async () => {
    await page.evaluate(() => document.body.focus && document.body.focus())
    await page.keyboard.press('Alt+Shift+G')
    const opened = await page
      .waitForFunction(
        () => {
          const r = document.getElementById('gpf-host') && document.getElementById('gpf-host').shadowRoot
          const p = r && r.querySelector('.panel')
          return !!(p && getComputedStyle(p).display !== 'none')
        },
        null,
        { timeout: 6000 }
      )
      .then(() => true)
      .catch(() => false)
    if (!opened) await page.evaluate(() => document.getElementById('gpf-host').shadowRoot.querySelector('.launch').click())
    assert(opened, 'Alt+Shift+G did not open the panel')
    await openPanel()
    assert((await readPanel()).fileCount === NEW_FILES.length, 'not all files detected in Chrome')
  })

  await scenario('C3: tree view with a top-level "pr" folder', async () => {
    await ensureTreeMode()
    const dirs = (await readPanel()).dirs.map((d) => d.path)
    assert(dirs.includes('::pr'), 'no top-level pr folder')
    assert(dirs.includes('src') && dirs.includes('src/api'), `folders missing: ${dirs.join(', ')}`)
  })

  await scenario('C4: substring filter narrows to the test files', async () => {
    await ensureTreeMode()
    await typeFilter('.test')
    const st = await readPanel()
    assert(st.rows.length === 3, `expected 3 test files, got ${st.rows.length}`)
    await typeFilter('')
  })

  await scenario('C5: a folder checkbox selects everything inside it', async () => {
    await ensureTreeMode()
    await clickToolbar('clear')
    await clickDirCheckbox('src/components')
    assert((await readPanel()).selected === 2, 'folder select did not pick 2 files')
    await clickToolbar('clear')
  })

  await scenario('C6: Show only isolates the selection via real :has()', async () => {
    await ensureTreeMode()
    await clickToolbar('clear')
    await clickRow('src/api/client.ts', 'cb')
    await clickToolbar('focus')
    await sleep(300)
    const map = await page.evaluate(() => {
      const list = document.querySelector('[data-testid=progressive-diffs-list]')
      return [...list.children]
        .filter((e) => e.querySelector && e.querySelector('[id^=diff-newfixture]'))
        .map((e) => {
          const region = e.querySelector('[id^=diff-newfixture]')
          const code = region.querySelector('h3 a code')
          return { path: (code ? code.textContent : '').replace(/[\u200e\u200f]/g, '').trim(), display: getComputedStyle(e).display }
        })
    })
    const visible = map.filter((m) => m.display !== 'none')
    assert(visible.length === 1 && visible[0].path === 'src/api/client.ts', `focus wrong: ${JSON.stringify(visible)}`)
    await clickToolbar('focus')
    await clickToolbar('clear')
  })

  await scenario('C7: the row viewed toggle marks a file viewed', async () => {
    await ensureTreeMode()
    await setFixtureViewed(['diff-newfixture4'], false)
    await sleep(150)
    await openPanel()
    await clickRow('src/utils/format.js', 'vtoggle')
    await sleep(300)
    const pressed = await page.evaluate(
      () => document.getElementById('diff-newfixture4').querySelector('button[aria-label]').getAttribute('aria-pressed')
    )
    assert(pressed === 'true', `row viewed toggle failed (aria-pressed=${pressed})`)
    assert(
      (await readPanel()).rows.find((r) => r.path === 'src/utils/format.js').viewed,
      'row not shown viewed after toggle'
    )
    await setFixtureViewed(['diff-newfixture4'], false)
    await sleep(150)
  })

  await scenario('C8: the "pr" folder shows viewed when the whole PR is viewed', async () => {
    await ensureTreeMode()
    await setFixtureViewed(NEW_FILES.map((_, i) => 'diff-newfixture' + i), true)
    await sleep(350)
    await openPanel()
    const pr = (await readPanel()).dirs.find((d) => d.path === '::pr')
    assert(pr && pr.viewed, 'pr folder not viewed when all files viewed')
    await setFixtureViewed(NEW_FILES.map((_, i) => 'diff-newfixture' + i), false)
    await sleep(300)
  })

  await scenario('C9: the sidebar is drag-resizable', async () => {
    await openPanel()
    await page.evaluate((t) => {
      const rez = document.getElementById('gpf-host').shadowRoot.querySelector('.resizer')
      rez.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: window.innerWidth - 360 }))
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: window.innerWidth - t }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    }, 480)
    await sleep(150)
    const st = await readPanel()
    assert(st.widthVar === '480px', `expected width 480px, got "${st.widthVar}"`)
    assert(st.pageMargin === '480px', `expected page pushed 480px, got "${st.pageMargin}"`)
  })

  await scenario('C10: starred file persists across reload (chrome.storage)', async () => {
    await ensureTreeMode()
    await clickToolbar('clear')
    const p0 = (await readPanel()).rows[0].path
    await clickRow(p0, 'star')
    await sleep(200)
    await gotoFixture()
    await openPanel()
    const row = (await readPanel()).rows.find((r) => r.path === p0)
    assert(row && row.imp, `star not persisted across reload in Chrome: ${p0}`)
  })
} finally {
  await context.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} Chrome scenarios passed`)
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
console.log('ALL GREEN — real Chrome, real extension, new-experience fixture')
