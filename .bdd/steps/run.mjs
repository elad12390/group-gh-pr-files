/*
 * Bulletproof E2E — runs the REAL extension in REAL Firefox (via geckodriver,
 * temporary add-on install = same path as about:debugging) against:
 *   Group A: a live public GitHub PR (classic experience anon users get)
 *   Group B: the new "changes" experience DOM (login-gated live, so injected as
 *            a captured-structure fixture into a real github.com page)
 *
 * No mocks: real browser, real extension, real CSS/:has() engine, real
 * browser.storage. Maps 1:1 to .bdd/features/pr-file-grouper.feature.
 */
import { Builder, Key } from 'selenium-webdriver'
import firefox from 'selenium-webdriver/firefox.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { newExperienceBody, NEW_FILES } from '../fixtures/new-experience.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../')
const FIREFOX_BIN = '/Applications/Firefox.app/Contents/MacOS/firefox'
const GECKO = '/opt/homebrew/bin/geckodriver'
const CTRL_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/

const LIVE_PR = 'https://github.com/facebook/react/pull/28468/files'

// ---- build a clean temporary .xpi (no node_modules / test files) ----
function buildXpi() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gpf-xpi-'))
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(stage, 'manifest.json'))
  fs.cpSync(path.join(ROOT, 'src'), path.join(stage, 'src'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'icons'), path.join(stage, 'icons'), { recursive: true })
  const xpi = path.join(stage, 'ext.xpi')
  execSync(`zip -r -X -q "${xpi}" manifest.json src icons`, { cwd: stage })
  return xpi
}

// ---- tiny test harness ----
const results = []
let driver
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const js = (script, ...args) => driver.executeScript(script, ...args)
async function waitFor(fn, timeout, msg) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e.message
    }
    await sleep(200)
  }
  throw new Error('timeout waiting for: ' + msg + (last ? ' (last=' + JSON.stringify(last) + ')' : ''))
}

// ---- panel interaction (pierces the open shadow root) ----
const HOST = "document.getElementById('gpf-host')"
const SR = HOST + '.shadowRoot'

function readPanel() {
  return js(`
    var host=${HOST}; if(!host||!host.shadowRoot) return {ready:false};
    var r=host.shadowRoot; var panel=r.querySelector('.panel');
    var launch=r.querySelector('.launch');
    var counts=(r.querySelector('.counts')||{}).textContent||'';
    var m=counts.match(/(\\d+) selected . (\\d+) files/);
    return {
      ready:true,
      // observable visibility, NOT the hidden attribute
      open: !!(panel && getComputedStyle(panel).display !== 'none'),
      launchVisible: !!(launch && getComputedStyle(launch).display !== 'none'),
      selected: m?+m[1]:0,
      fileCount: m?+m[2]:0,
      rows: [].slice.call(r.querySelectorAll('.list .row')).map(function(x){return {
        path:x.dataset.path, sel:x.classList.contains('sel'),
        imp:x.classList.contains('imp'), viewed:x.classList.contains('viewed')};}),
      dirs: [].slice.call(r.querySelectorAll('.list .dir-row')).map(function(d){return {
        path:d.dataset.dir, twist:(d.querySelector('.twist')||{}).textContent, viewed:d.classList.contains('viewed')};}),
      treeMode: ((r.querySelector('.toolbar button[data-act=view]')||{}).textContent||'') === 'Tree',
      widthVar: host.style.getPropertyValue('--gpf-w'),
      pageMargin: document.documentElement.style.marginRight,
      presets: [].slice.call(r.querySelectorAll('.presets .chip')).map(function(c){return c.textContent.trim();}),
      groups: [].slice.call(r.querySelectorAll('.group-list [data-group]')).map(function(g){return g.getAttribute('data-group');})
    };
  `)
}
async function openPanel() {
  await waitFor(() => js(`return !!${HOST}`), 15000, 'extension host appears')
  const st = await readPanel()
  if (!st.open) await js(`${SR}.querySelector('.launch').click()`)
  await waitFor(async () => {
    const s = await readPanel()
    return s.open && s.rows.length > 0
  }, 15000, 'panel open with rows')
}
async function typeFilter(text) {
  await js(
    `var s=${SR}.querySelector('.search'); s.value=arguments[0]; s.dispatchEvent(new Event('input',{bubbles:true}));`,
    text
  )
  await sleep(240)
}
const clickToolbar = (act) =>
  js(`${SR}.querySelector('.toolbar button[data-act="'+arguments[0]+'"]').click();`, act)
const clickPreset = (label) =>
  js(
    `var label=arguments[0]; var c=[].slice.call(${SR}.querySelectorAll('.presets .chip')).find(function(x){return x.textContent.trim()===label}); if(!c) throw new Error('no preset '+label); c.click();`,
    label
  )
const clickRow = (i, part) =>
  js(
    `var row=${SR}.querySelectorAll('.list .row')[arguments[0]]; if(!row) throw new Error('no row '+arguments[0]); row.querySelector(arguments[1]==='cb'?'.cb':'.star').click();`,
    i,
    part
  )
const saveGroup = (name) =>
  js(`${SR}.querySelector('.group-name').value=arguments[0]; ${SR}.querySelector('.save-group').click();`, name)
const clickGroup = (name) =>
  js(
    `var name=arguments[0]; var g=[].slice.call(${SR}.querySelectorAll('.group-list [data-group]')).find(function(x){return x.getAttribute('data-group')===name}); if(!g) throw new Error('no group '+name); g.querySelector('.g-name').click();`,
    name
  )
const DIR_FIND = `[].slice.call(${SR}.querySelectorAll('.list .dir-row')).find(function(d){return d.dataset.dir===p})`
const clickDir = (path) =>
  js(`var p=arguments[0]; var d=${DIR_FIND}; if(!d) throw new Error('no folder '+p); d.querySelector('.dir-name').click();`, path)
const clickDirCheckbox = (path) =>
  js(`var p=arguments[0]; var d=${DIR_FIND}; if(!d) throw new Error('no folder '+p); d.querySelector('.dir-cb').click();`, path)
async function ensureTreeMode() {
  await openPanel()
  if (!(await readPanel()).treeMode) {
    await js(`${SR}.querySelector('.toolbar button[data-act=view]').click();`)
    await sleep(120)
  }
}
// Simulate a real drag on the resize handle to make the panel `target` px wide.
async function dragResizeTo(target) {
  await js(
    `var t=arguments[0]; var host=${HOST}; var rez=host.shadowRoot.querySelector('.resizer');
     rez.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:window.innerWidth-360}));
     document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:window.innerWidth-t}));
     document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));`,
    target
  )
  await sleep(120)
}

// Flip GitHub's "viewed" control on the fixture regions with the given diff ids.
const setFixtureViewed = (ids, on) =>
  js(
    `var ids=arguments[0]; var on=arguments[1]; ids.forEach(function(id){var region=document.getElementById(id); if(!region) return; var b=region.querySelector('button[aria-label]'); if(b){ b.setAttribute('aria-pressed', on?'true':'false'); b.setAttribute('aria-label', on?'Viewed':'Not Viewed'); }}); window.dispatchEvent(new Event('gpf:locationchange'));`,
    ids,
    on
  )

async function loadFixture() {
  await js(
    'document.body.innerHTML = arguments[0]; window.dispatchEvent(new Event("gpf:locationchange"));',
    newExperienceBody()
  )
  await waitFor(() => js('return !!document.querySelector("[data-testid=progressive-diffs-list]")'), 8000, 'fixture list')
  // Simulate GitHub's "viewed" control: clicking the button flips aria-pressed
  // (GitHub does this via a React handler; inline handlers are CSP-blocked on
  // github.com, so wire it with addEventListener here).
  await js(
    `[].slice.call(document.querySelectorAll('[data-testid=progressive-diffs-list] button[aria-label]')).forEach(function(b){ if(b.__gpfWired) return; b.__gpfWired=true; b.addEventListener('click', function(){ var on=b.getAttribute('aria-pressed')==='true'; b.setAttribute('aria-pressed', on?'false':'true'); b.setAttribute('aria-label', on?'Not Viewed':'Viewed'); }); });`
  )
  await sleep(500)
}

// ---- main ----
const xpi = buildXpi()
const options = new firefox.Options()
options.setBinary(FIREFOX_BIN)
options.addArguments('-headless')
const service = new firefox.ServiceBuilder(GECKO)
driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build()
await driver.manage().window().setRect({ width: 1400, height: 1000 })

try {
  await driver.installAddon(xpi, true)

  // =====================================================================
  // GROUP A — live GitHub PR (classic experience) in real Firefox
  // =====================================================================
  console.log('\n--- Group A: live GitHub (classic) ---')
  await driver.get(LIVE_PR)
  await waitFor(() => js('return document.querySelectorAll("#files .file").length'), 45000, 'live diff files load')

  await scenario('E13: panel does NOT auto-open on a fresh page', async () => {
    await waitFor(() => js(`return !!${HOST}`), 15000, 'host present')
    await sleep(400)
    const st = await readPanel()
    assert(st.ready, 'panel host not ready')
    assert(st.open === false, 'panel auto-opened (should start closed / not be visible)')
    assert(st.launchVisible, 'launch button not visible while closed')
  })

  await scenario('E11 live: Alt+Shift+G opens the panel (real keypress)', async () => {
    await waitFor(() => js(`return !!${HOST}`), 15000, 'host')
    await js('document.body.focus && document.body.focus();')
    await driver
      .actions()
      .keyDown(Key.ALT)
      .keyDown(Key.SHIFT)
      .sendKeys('g')
      .keyUp(Key.SHIFT)
      .keyUp(Key.ALT)
      .perform()
    const opened = await waitFor(async () => (await readPanel()).open, 6000, 'panel open via shortcut').catch(
      () => false
    )
    if (!opened) {
      // fall back so later scenarios can run; the shortcut assertion still fails
      await js(`${SR}.querySelector('.launch').click()`)
    }
    assert(opened, 'panel did not open from Alt+Shift+G')
  })

  await openPanel()

  await scenario('E1 live: detects every changed file, names cleaned', async () => {
    const expected = await js(`
      var s={}; [].slice.call(document.querySelectorAll('#files .file .file-header[data-path]'))
        .forEach(function(h){s[h.getAttribute('data-path')]=1;}); return Object.keys(s).length;`)
    const st = await readPanel()
    assert(expected > 0, 'no files on the live page')
    assert(st.fileCount === expected, `panel counted ${st.fileCount}, GitHub shows ${expected}`)
    assert(!st.rows.some((r) => CTRL_RE.test(r.path)), 'a file name still contains control chars')
  })

  await scenario('E2 live: substring filter narrows the list', async () => {
    const before = (await readPanel()).rows.length
    await typeFilter('test')
    const st = await readPanel()
    assert(st.rows.length > 0, 'filter "test" matched nothing')
    assert(st.rows.length < before, 'filter did not narrow the list')
    assert(
      st.rows.every((r) => r.path.toLowerCase().includes('test')),
      'a shown row does not contain "test"'
    )
    await typeFilter('')
  })

  await scenario('E6 live: Show only hides non-selected diffs, toggle restores', async () => {
    await clickToolbar('clear')
    await clickRow(0, 'cb')
    await clickRow(1, 'cb')
    const sel = (await readPanel()).rows.filter((r) => r.sel).map((r) => r.path)
    assert(sel.length === 2, `expected 2 selected, got ${sel.length}`)
    await clickToolbar('focus')
    await sleep(300)
    const vis = await js(`
      var map={}; [].slice.call(document.querySelectorAll('#files .file')).forEach(function(f){
        var h=f.querySelector('.file-header'); var p=h&&h.getAttribute('data-path'); if(!p) return;
        var entry=f.closest('copilot-diff-entry')||f; map[p]=getComputedStyle(entry).display;});
      return map;`)
    for (const p of sel) assert(vis[p] !== 'none', `selected file hidden: ${p}`)
    const hiddenOther = Object.keys(vis).some((p) => !sel.includes(p) && vis[p] === 'none')
    assert(hiddenOther, 'no non-selected diff was hidden')
    await clickToolbar('focus')
    await sleep(300)
    const vis2 = await js(`
      var any=false; [].slice.call(document.querySelectorAll('#files .file')).forEach(function(f){
        var entry=f.closest('copilot-diff-entry')||f; if(getComputedStyle(entry).display==='none') any=true;});
      return any;`)
    assert(!vis2, 'a diff stayed hidden after toggling focus off')
    await clickToolbar('clear')
  })

  await scenario('E9 live: starred file persists across reload (real storage)', async () => {
    await clickToolbar('clear')
    const p0 = (await readPanel()).rows[0].path
    await clickRow(0, 'star')
    await sleep(200)
    const accent = await js(
      `var st=document.getElementById('gpf-page-style'); return !!st && st.textContent.indexOf('#diff-')>=0;`
    )
    assert(accent, 'no accent CSS injected for starred file')
    await driver.get(LIVE_PR)
    await waitFor(() => js('return document.querySelectorAll("#files .file").length'), 45000, 'reload files')
    await openPanel()
    const row = (await readPanel()).rows.find((r) => r.path === p0)
    assert(row && row.imp, `starred file not persisted after reload: ${p0}`)
  })

  // =====================================================================
  // GROUP B — new "changes" experience (your env) in real Firefox
  // =====================================================================
  console.log('\n--- Group B: new experience (fixture injected into real github.com) ---')
  // Reuse the already-loaded, valid PR page (content script + host proven
  // present) and swap its body for the captured new-experience DOM, so the
  // real extension runs against it. The live new experience is login-gated.
  await waitFor(() => js(`return !!${HOST}`), 15000, 'host present before fixture')
  await loadFixture()
  await openPanel()

  await scenario('E1: new-experience detects all files, names cleaned', async () => {
    const st = await readPanel()
    assert(st.fileCount === NEW_FILES.length, `expected ${NEW_FILES.length} files, got ${st.fileCount}`)
    assert(!st.rows.some((r) => CTRL_RE.test(r.path)), 'control chars not stripped')
    assert(
      st.rows.some((r) => r.path === 'src/api/client.ts'),
      'expected fixture path missing'
    )
  })

  await scenario('E23: a compressed/stale tree leaf never duplicates a region file', async () => {
    // Reproduce the real bug: a file-tree leaf carrying a directory-like path but
    // pointing at the SAME diff id as an already-detected region file.
    await js(`
      var tree=document.querySelector('#pr-file-tree ul[role=tree]');
      var li=document.createElement('li'); li.id='app/application/integrations/crm';
      li.setAttribute('role','treeitem'); li.setAttribute('aria-label','crm'); li.setAttribute('data-gpf-stale','1');
      li.innerHTML='<div><a class="fgColor-default" href="#diff-newfixture0" role="presentation">crm</a></div>';
      tree.appendChild(li);
      window.dispatchEvent(new Event('gpf:locationchange'));
    `)
    await sleep(400)
    await openPanel()
    const st = await readPanel()
    assert(st.fileCount === NEW_FILES.length, `stale tree leaf duplicated a file: ${st.fileCount} != ${NEW_FILES.length}`)
    const bad = st.rows.some((r) => r.path === 'app/application/integrations/crm')
    assert(!bad, 'a bogus directory-path file entry appeared')
    await js(`var s=document.querySelector('[data-gpf-stale]'); if(s) s.remove(); window.dispatchEvent(new Event('gpf:locationchange'));`)
    await sleep(300)
  })

  await scenario('E2: substring filter ".test" → 3 files', async () => {
    await typeFilter('.test')
    const st = await readPanel()
    assert(st.rows.length === 3, `expected 3, got ${st.rows.length}`)
    assert(st.rows.every((r) => r.path.includes('.test')), 'non-test file shown')
    await typeFilter('')
  })

  await scenario('E3: regex filter "/__tests__/" → 1 file', async () => {
    await typeFilter('/__tests__/')
    const st = await readPanel()
    assert(st.rows.length === 1, `expected 1, got ${st.rows.length}`)
    assert(st.rows[0].path.includes('__tests__'), 'wrong file matched')
    await typeFilter('')
  })

  await scenario('E4: Tests preset selects the 3 test files', async () => {
    await clickToolbar('clear')
    await clickPreset('Tests')
    const st = await readPanel()
    assert(st.selected === 3, `expected 3 selected, got ${st.selected}`)
    const selPaths = st.rows.filter((r) => r.sel).map((r) => r.path)
    assert(
      selPaths.every((p) => /(\.|_)(test|spec)\.|\/__tests__\//.test(p)),
      'a non-test file was selected'
    )
  })

  await scenario('E5: ".ts (2)" extension chip selects both .ts files', async () => {
    await clickToolbar('clear')
    const st0 = await readPanel()
    assert(st0.presets.includes('.ts (2)'), `expected ".ts (2)" chip, got: ${st0.presets.join(', ')}`)
    await clickPreset('.ts (2)')
    const st = await readPanel()
    assert(st.selected === 2, `expected 2 selected, got ${st.selected}`)
    assert(
      st.rows.filter((r) => r.sel).every((r) => r.path.endsWith('.ts')),
      'a non-.ts file selected'
    )
  })

  await scenario('E6/E12: Show only isolates selection via real :has() engine', async () => {
    await clickToolbar('clear')
    await clickRow(0, 'cb')
    const selPath = (await readPanel()).rows.find((r) => r.sel).path
    await clickToolbar('focus')
    await sleep(300)
    const map = await js(`
      var out=[]; var list=document.querySelector('[data-testid=progressive-diffs-list]');
      [].slice.call(list.children).forEach(function(entry){
        var region=entry.querySelector && entry.querySelector('[id^=diff-newfixture]'); if(!region) return;
        var code=region.querySelector('h3 a code');
        var p=(code?code.textContent:'').replace(/[\\u200e\\u200f]/g,'').trim();
        out.push({path:p, display:getComputedStyle(entry).display});});
      return out;`)
    const visible = map.filter((m) => m.display !== 'none')
    assert(visible.length === 1, `expected exactly 1 visible region, got ${visible.length}`)
    assert(visible[0].path === selPath, `visible region ${visible[0].path} != selected ${selPath}`)
    await clickToolbar('focus')
    await sleep(300)
    const stillHidden = await js(`
      var list=document.querySelector('[data-testid=progressive-diffs-list]'); var any=false;
      [].slice.call(list.children).forEach(function(e){ if(e.querySelector && e.querySelector('[id^=diff-newfixture]') && getComputedStyle(e).display==='none') any=true;});
      return any;`)
    assert(!stillHidden, 'a region stayed hidden after toggling focus off')
  })

  await scenario('E8/E9: star persists across reload (new experience, real storage)', async () => {
    await clickToolbar('clear')
    const p0 = (await readPanel()).rows[0].path
    await clickRow(0, 'star')
    await sleep(200)
    const accent = await js(`
      var target=arguments[0];
      var region=[].slice.call(document.querySelectorAll('[id^=diff-newfixture]')).find(function(r){
        var c=r.querySelector('h3 a code'); return c && c.textContent.indexOf(target)>=0;});
      return region ? getComputedStyle(region).boxShadow : 'none';`, p0)
    assert(accent && accent !== 'none', `no box-shadow accent on starred region (got ${accent})`)
    await driver.get(LIVE_PR)
    await waitFor(() => js('return document.querySelectorAll("#files .file").length'), 45000, 'reload files')
    await waitFor(() => js(`return !!${HOST}`), 15000, 'host after reload')
    await loadFixture()
    await openPanel()
    const row = (await readPanel()).rows.find((r) => r.path === p0)
    assert(row && row.imp, `star not persisted after reload: ${p0}`)
  })

  await scenario('E10: save a group and re-apply it', async () => {
    await clickToolbar('clear')
    await clickRow(0, 'cb')
    await clickRow(2, 'cb')
    const picked = (await readPanel()).rows
      .filter((r) => r.sel)
      .map((r) => r.path)
      .sort()
    assert(picked.length === 2, `expected 2 picked, got ${picked.length}`)
    await saveGroup('batch-1')
    await sleep(150)
    assert((await readPanel()).groups.includes('batch-1'), 'group not listed after save')
    await clickToolbar('clear')
    assert((await readPanel()).selected === 0, 'selection not cleared')
    await clickGroup('batch-1')
    const after = (await readPanel()).rows
      .filter((r) => r.sel)
      .map((r) => r.path)
      .sort()
    assert(JSON.stringify(after) === JSON.stringify(picked), `group reselect mismatch: ${after} vs ${picked}`)
  })

  await scenario('E15: opening pushes the page left; closing restores it', async () => {
    await openPanel()
    const openMargin = await js('return document.documentElement.style.marginRight')
    assert(openMargin === '360px', `expected 360px margin when open, got "${openMargin}"`)
    await js(`${SR}.querySelector('.close').click()`)
    await sleep(250)
    assert(!(await readPanel()).open, 'panel did not close via ✕')
    const closedMargin = await js('return document.documentElement.style.marginRight')
    assert(closedMargin === '', `expected margin removed when closed, got "${closedMargin}"`)
  })

  await scenario('E14: a closed panel stays closed across DOM mutations', async () => {
    await openPanel()
    await js(`${SR}.querySelector('.close').click()`)
    await sleep(150)
    assert(!(await readPanel()).open, 'panel did not close')
    await js('for (var i=0;i<3;i++){var d=document.createElement("div");document.body.appendChild(d);d.remove();}')
    await sleep(500)
    assert(!(await readPanel()).open, 'panel re-opened after a DOM mutation')
  })

  await scenario('E16: filter keystrokes do not leak to the page', async () => {
    await openPanel()
    await js(
      'window.__gpfLeak=0; if(!window.__gpfLeakBound){window.__gpfLeakBound=true; document.addEventListener("keydown", function(){window.__gpfLeak++;});}'
    )
    await js(
      `var s=${SR}.querySelector('.search'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',bubbles:true,composed:true}));`
    )
    const leaked = await js('return window.__gpfLeak')
    assert(leaked === 0, `a panel keystroke leaked to the document (${leaked})`)
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true,composed:true}));`)
    assert((await js('return window.__gpfLeak')) > 0, 'control keystroke did not reach document (invalid test)')
  })

  await scenario('C2: panel lives in a shadow root', async () => {
    const inShadow = await js(`return !!(${HOST} && ${HOST}.shadowRoot && ${SR}.querySelector('.panel'));`)
    assert(inShadow, 'panel is not inside a shadow root')
  })

  await scenario('E24: nested files render indented under their folder', async () => {
    await ensureTreeMode()
    await clickToolbar('clear')
    const rects = await js(`
      var r=${SR};
      var folder=[].slice.call(r.querySelectorAll('.dir-row')).find(function(d){return d.dataset.dir==='src/api'});
      var file=[].slice.call(r.querySelectorAll('.row')).find(function(x){return x.dataset.path==='src/api/client.ts'});
      if(!folder||!file) return null;
      return { folder: folder.querySelector('.dir-cb').getBoundingClientRect().left,
               file: file.querySelector('.cb').getBoundingClientRect().left,
               spacer: !!file.querySelector('.twist') };
    `)
    assert(rects, 'src/api folder or client.ts row not found')
    assert(rects.spacer, 'file row is missing the alignment spacer column')
    assert(
      rects.file > rects.folder + 6,
      `file checkbox (${rects.file}) is not indented to the right of its folder checkbox (${rects.folder})`
    )
  })

  await scenario('E25: a folder is marked viewed when all its files are viewed', async () => {
    await ensureTreeMode()
    await setFixtureViewed(['diff-newfixture0', 'diff-newfixture1'], true)
    await sleep(400)
    await openPanel()
    let d = (await readPanel()).dirs.find((x) => x.path === 'src/api')
    assert(d && d.viewed, 'src/api not marked viewed after all its files were viewed')
    await setFixtureViewed(['diff-newfixture0'], false)
    await sleep(300)
    await openPanel()
    d = (await readPanel()).dirs.find((x) => x.path === 'src/api')
    assert(d && !d.viewed, 'src/api still marked viewed after un-viewing one file')
    await setFixtureViewed(['diff-newfixture1'], false)
    await sleep(300)
  })

  await scenario('E26: the row viewed toggle marks a file viewed on GitHub', async () => {
    await ensureTreeMode()
    await clickToolbar('clear')
    await setFixtureViewed(['diff-newfixture4'], false)
    await sleep(200)
    await openPanel()
    await js(
      `var row=[].slice.call(${SR}.querySelectorAll('.row')).find(function(x){return x.dataset.path==='src/utils/format.js'}); if(!row) throw new Error('no format.js row'); row.querySelector('.vtoggle').click();`
    )
    await sleep(350)
    const pressed = await js(
      `var b=document.getElementById('diff-newfixture4').querySelector('button[aria-label]'); return b.getAttribute('aria-pressed');`
    )
    assert(pressed === 'true', `row toggle did not mark GitHub's control viewed (aria-pressed=${pressed})`)
    const row = (await readPanel()).rows.find((r) => r.path === 'src/utils/format.js')
    assert(row && row.viewed, 'file row not shown as viewed after clicking its toggle')
    await setFixtureViewed(['diff-newfixture4'], false)
    await sleep(200)
  })

  await scenario('E27: everything sits under a top-level "pr" folder (full-PR viewed)', async () => {
    await ensureTreeMode()
    await clickToolbar('clear')
    const pr = (await readPanel()).dirs.find((d) => d.path === '::pr')
    assert(pr, 'no top-level "pr" folder present')
    await clickDirCheckbox('::pr')
    assert(
      (await readPanel()).selected === NEW_FILES.length,
      `the "pr" folder should select all ${NEW_FILES.length} files`
    )
    await clickToolbar('clear')
    const allIds = NEW_FILES.map((_, i) => 'diff-newfixture' + i)
    await setFixtureViewed(allIds, true)
    await sleep(400)
    await openPanel()
    const pr2 = (await readPanel()).dirs.find((d) => d.path === '::pr')
    assert(pr2 && pr2.viewed, 'the "pr" folder is not viewed even though every file is viewed')
    await setFixtureViewed(allIds, false)
    await sleep(300)
  })

  await scenario('E17: files detected from the tree when diffs are not rendered', async () => {
    await js(
      'var list=document.querySelector("[data-testid=progressive-diffs-list]"); if(list){[].slice.call(list.querySelectorAll("[id^=diff-newfixture]")).forEach(function(r){var e=r.parentElement; if(e&&e.parentElement===list) e.remove();});} window.dispatchEvent(new Event("gpf:locationchange"));'
    )
    await sleep(500)
    await openPanel()
    const st = await readPanel()
    assert(st.fileCount === NEW_FILES.length, `expected ${NEW_FILES.length} files from tree, got ${st.fileCount}`)
  })

  await scenario('E18: tree view groups files under folders', async () => {
    await ensureTreeMode()
    await clickToolbar('clear')
    const st = await readPanel()
    assert(st.treeMode, 'not in tree mode')
    const dirPaths = st.dirs.map((d) => d.path)
    assert(dirPaths.includes('src'), `expected a 'src' folder, got: ${dirPaths.join(', ')}`)
    assert(dirPaths.includes('src/api'), `expected a 'src/api' folder, got: ${dirPaths.join(', ')}`)
    assert(st.rows.length === NEW_FILES.length, `expected ${NEW_FILES.length} file rows, got ${st.rows.length}`)
  })

  await scenario('E19: folding a folder hides its files (E-fold)', async () => {
    await ensureTreeMode()
    assert((await readPanel()).rows.some((r) => r.path === 'src/api/client.ts'), 'client.ts not shown before folding')
    await clickDir('src/api')
    let st = await readPanel()
    assert(!st.rows.some((r) => r.path === 'src/api/client.ts'), 'client.ts still shown after folding src/api')
    const d = st.dirs.find((x) => x.path === 'src/api')
    assert(d && d.twist === '▸', 'twist did not switch to collapsed')
    await clickDir('src/api')
    st = await readPanel()
    assert(st.rows.some((r) => r.path === 'src/api/client.ts'), 'client.ts not restored after unfolding')
  })

  await scenario('E20: a folder checkbox selects every file inside it', async () => {
    await ensureTreeMode()
    await clickToolbar('clear')
    await clickDirCheckbox('src/components')
    assert((await readPanel()).selected === 2, `folder select should pick 2 files, got ${(await readPanel()).selected}`)
    await clickDirCheckbox('src/components')
    assert((await readPanel()).selected === 0, 'folder uncheck did not clear the selection')
  })

  await scenario('E21: toggle between tree and flat view', async () => {
    await ensureTreeMode()
    assert((await readPanel()).dirs.length > 0, 'tree mode should show folders')
    await js(`${SR}.querySelector('.toolbar button[data-act=view]').click();`)
    await sleep(150)
    let st = await readPanel()
    assert(!st.treeMode, 'did not switch to flat view')
    assert(st.dirs.length === 0, 'flat view should have no folder rows')
    assert(st.rows.length === NEW_FILES.length, `flat view should list all ${NEW_FILES.length} files`)
    assert(st.rows.some((r) => r.path === 'src/api/client.ts'), 'flat row missing full path')
    await js(`${SR}.querySelector('.toolbar button[data-act=view]').click();`)
    await sleep(150)
    assert((await readPanel()).treeMode, 'did not switch back to tree')
  })

  await scenario('E22: the sidebar width is drag-resizable and persists', async () => {
    await openPanel()
    await dragResizeTo(480)
    const st = await readPanel()
    assert(st.widthVar === '480px', `expected panel width 480px, got "${st.widthVar}"`)
    assert(st.pageMargin === '480px', `expected page pushed 480px, got "${st.pageMargin}"`)
    await driver.get(LIVE_PR)
    await waitFor(() => js('return document.querySelectorAll("#files .file").length'), 45000, 'reload')
    await openPanel()
    const w = await js(`return ${HOST}.style.getPropertyValue('--gpf-w')`)
    assert(w === '480px', `width not persisted across reload, got "${w}"`)
  })
} finally {
  if (driver) await driver.quit()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} scenarios passed`)
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
console.log('ALL GREEN — real Firefox, real extension, real GitHub + captured new-experience DOM')
