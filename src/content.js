/*
 * PR File Grouper for GitHub
 * ---------------------------
 * A content script that injects a side panel into GitHub pull-request pages
 * (both the classic "Files changed" tab and the new "changes" experience)
 * so you can filter, multi-select, group, star and focus on subsets of files.
 *
 * All UI lives inside a shadow root so GitHub's styles never leak in (and ours
 * never leak out). The only thing we write into the page's light DOM is a single
 * <style> element (keyed by the stable, per-file diff ids) used to hide/highlight
 * diffs. Because it is global CSS keyed by ids, it survives GitHub's React
 * re-renders and its content-visibility virtualization.
 */
(() => {
  'use strict'

  if (window.__gpfInit) return
  window.__gpfInit = true

  const api = typeof browser !== 'undefined' ? browser : chrome

  // Format / bidi control characters GitHub sprinkles around file names.
  const CTRL = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
  const HOST_ID = 'gpf-host'
  const PAGE_STYLE_ID = 'gpf-page-style'
  const NEW_LIST = '[data-testid="progressive-diffs-list"]'
  const PANEL_W = 360 // keep in sync with .panel width in PANEL_CSS
  const PR_ROOT = '::pr' // synthetic top-level folder holding every changed file

  // ---- state -------------------------------------------------------------
  let ctx = null // { owner, repo, pr, key }
  let files = [] // [{ path, id, regionEl, entryEl, classic }]
  let rendered = [] // filtered file list currently shown (for shift-range)
  let selected = new Set() // selected file paths
  let data = { groups: [], important: [] } // persisted, per PR
  const ui = { open: false, filter: '', importantOnly: false, focus: false, viewMode: 'tree', collapsed: new Set() }
  let lastIndex = -1
  let refs = {}
  let filterTimer = 0
  let refreshTimer = 0
  let panelWidth = PANEL_W // resizable; persisted in settings
  const PANEL_MIN = 280

  // ---- helpers -----------------------------------------------------------
  const clean = (s) => (s || '').replace(CTRL, '').trim()
  // CSS.escape exists in every modern browser; fall back just in case.
  const cssEsc = (s) =>
    window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c)

  // Tiny DOM builder so we never assign innerHTML with dynamic values.
  function el(tag, props, ...kids) {
    const node = document.createElement(tag)
    if (props)
      for (const k in props) {
        const v = props[k]
        if (v == null) continue
        if (k === 'class') node.className = v
        else if (k === 'text') node.textContent = v
        else if (k.slice(0, 2) === 'on' && typeof v === 'function')
          node.addEventListener(k.slice(2).toLowerCase(), v)
        else node.setAttribute(k, v)
      }
    for (const c of kids) {
      if (c == null || c === false) continue
      node.append(c.nodeType ? c : document.createTextNode(String(c)))
    }
    return node
  }

  function parseCtx() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!m) return null
    return { owner: m[1], repo: m[2], pr: m[3], key: `${m[1]}/${m[2]}#${m[3]}` }
  }

  function isNewUI() {
    return !!document.querySelector(NEW_LIST)
  }

  function collectFiles() {
    const byPath = new Map()
    const seenIds = new Set()

    // New "changes" experience: the rendered diff regions carry the authoritative
    // full file path. The file tree is a fallback for files whose diff is lazily
    // rendered / virtualized — but a tree leaf can carry a compressed/stale path
    // for a file a region already covered, so we dedupe by DIFF ID (not path) and
    // let the region's path win. Otherwise the same file appears twice, once with
    // a bogus directory-like path.
    const list = document.querySelector(NEW_LIST)
    if (list) {
      list.querySelectorAll('[id^="diff-"][role="region"]').forEach((region) => {
        const code = region.querySelector('h3 a code') || region.querySelector('h3 a')
        const path = clean(code && code.textContent)
        if (path && !byPath.has(path)) {
          byPath.set(path, { path, id: region.id, classic: false })
          seenIds.add(region.id)
        }
      })
      document
        .querySelectorAll('#pr-file-tree li[role="treeitem"]:not([aria-expanded]) a[href^="#diff-"]')
        .forEach((a) => {
          const id = (a.getAttribute('href') || '').slice(1)
          if (!id || seenIds.has(id)) return // a region already provided this file
          const li = a.closest('li[role="treeitem"]')
          const path = clean((li && (li.id || li.getAttribute('aria-label'))) || '')
          if (path && !byPath.has(path)) {
            byPath.set(path, { path, id, classic: false })
            seenIds.add(id)
          }
        })
      if (byPath.size) return [...byPath.values()]
    }

    // Classic "Files changed" tab -----------------------------------------
    document.querySelectorAll('#files .file').forEach((fileEl) => {
      const header = fileEl.querySelector('.file-header, .file-info')
      const path = clean(
        (header && header.getAttribute('data-path')) ||
          fileEl.getAttribute('data-tagsearch-path') ||
          (fileEl.querySelector('.file-info a[title]') || {}).title
      )
      const id = (header && header.getAttribute('data-anchor')) || fileEl.id || ''
      if (path && !byPath.has(path)) byPath.set(path, { path, id, classic: true })
    })
    return [...byPath.values()]
  }

  function fileByPath(p) {
    return files.find((f) => f.path === p)
  }

  // Resolve a file's live diff/entry element by its stable id (works whether or
  // not the diff was rendered when we scanned).
  function regionOf(f) {
    return f.id ? document.getElementById(f.id) : null
  }
  function entryOf(f) {
    const r = regionOf(f)
    if (!r) return null
    return f.classic ? r.closest('copilot-diff-entry') || r : r.parentElement
  }

  // ---- "viewed" integration ---------------------------------------------
  function viewedControl(file) {
    const region = regionOf(file)
    if (!region) return null
    if (file.classic) return region.querySelector('input.js-reviewed-checkbox')
    const btns = region.querySelectorAll('button')
    for (const b of btns) {
      const al = (b.getAttribute('aria-label') || '').trim()
      if (/^(not\s+)?viewed$/i.test(al)) return b
    }
    for (const b of btns) if (/(^|\s)viewed(\s|$)/i.test((b.textContent || '').trim())) return b
    return null
  }

  function isViewed(file) {
    const c = viewedControl(file)
    if (!c) return false
    return file.classic ? c.checked : c.getAttribute('aria-pressed') === 'true'
  }

  function setViewed(file, want) {
    const c = viewedControl(file)
    if (!c) return
    if (isViewed(file) !== want) c.click()
  }

  function toggleViewed(file) {
    setViewed(file, !isViewed(file))
    // GitHub updates its control asynchronously; re-render to reflect the new
    // state (row toggle + any folder that just became fully viewed).
    setTimeout(() => {
      if (ui.focus) injectPageStyle()
      renderList()
    }, 200)
  }

  // ---- persistence -------------------------------------------------------
  async function loadData() {
    data = { groups: [], important: [] }
    if (!ctx) return
    try {
      const key = 'data:' + ctx.key
      const res = await api.storage.local.get(key)
      const d = res[key]
      if (d && typeof d === 'object') {
        data.groups = Array.isArray(d.groups) ? d.groups : []
        data.important = Array.isArray(d.important) ? d.important : []
      }
    } catch (_) {}
  }

  function saveData() {
    if (!ctx) return
    try {
      api.storage.local.set({ ['data:' + ctx.key]: data })
    } catch (_) {}
  }

  const isImportant = (p) => data.important.includes(p)

  function toggleImportant(p) {
    const i = data.important.indexOf(p)
    if (i >= 0) data.important.splice(i, 1)
    else data.important.push(p)
    saveData()
    injectPageStyle()
    renderList()
  }

  // ---- filtering ---------------------------------------------------------
  function fileMatches(path) {
    if (ui.importantOnly && !isImportant(path)) return false
    const q = ui.filter.trim()
    if (!q) return true
    const rx = q.match(/^\/(.*)\/([gimsuy]*)$/)
    if (rx) {
      try {
        return new RegExp(rx[1], rx[2]).test(path)
      } catch (_) {
        return true
      }
    }
    const terms = q
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase())
    const lp = path.toLowerCase()
    return terms.some((t) => lp.includes(t))
  }

  function matchingPaths(query) {
    const rx = query.match(/^\/(.*)\/([gimsuy]*)$/)
    let test
    if (rx) {
      try {
        const re = new RegExp(rx[1], rx[2])
        test = (p) => re.test(p)
      } catch (_) {
        test = () => false
      }
    } else {
      const terms = query
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((t) => t.toLowerCase())
      test = (p) => terms.some((t) => p.toLowerCase().includes(t))
    }
    return files.filter((f) => test(f.path)).map((f) => f.path)
  }

  // ---- page style: focus (show only) + important accent -----------------
  function injectPageStyle() {
    let el = document.getElementById(PAGE_STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = PAGE_STYLE_ID
      ;(document.head || document.documentElement).appendChild(el)
    }
    const css = []

    // Gold accent on starred file diffs so they stand out while scrolling.
    const impIds = files.filter((f) => f.id && isImportant(f.path)).map((f) => f.id)
    if (impIds.length) {
      const sel = impIds.map((id) => `#${cssEsc(id)}`).join(',')
      css.push(`${sel}{box-shadow:inset 4px 0 0 #d29922 !important;border-radius:6px;scroll-margin-top:80px;}`)
    }

    // Focus mode: hide everything except the selected diffs.
    const showIds = [...selected].map(fileByPath).filter((f) => f && f.id).map((f) => f.id)
    if (ui.focus && showIds.length) {
      document.body.classList.add('gpf-focus')
      if (isNewUI()) {
        css.push(`body.gpf-focus ${NEW_LIST} > div{display:none !important;}`)
        css.push(
          showIds
            .map((id) => `body.gpf-focus ${NEW_LIST} > div:has(> #${cssEsc(id)})`)
            .join(',') + `{display:block !important;}`
        )
        // Trim the file-tree to the focused set (leaf nodes only).
        css.push(
          `body.gpf-focus #pr-file-tree li[role="treeitem"]:not([aria-expanded]):has(a[href^="#diff-"]){display:none !important;}`
        )
        css.push(
          showIds
            .map(
              (id) =>
                `body.gpf-focus #pr-file-tree li[role="treeitem"]:not([aria-expanded]):has(a[href="#${cssEsc(
                  id
                )}"])`
            )
            .join(',') + `{display:block !important;}`
        )
      }
    } else {
      document.body.classList.remove('gpf-focus')
    }

    // Classic UI cannot rely on stable structural :has(), so hide inline.
    if (!isNewUI()) {
      const show = new Set(showIds)
      files.forEach((f) => {
        const entry = entryOf(f)
        if (!entry) return
        entry.style.display = ui.focus && showIds.length && !show.has(f.id) ? 'none' : ''
      })
    }

    el.textContent = css.join('\n')
  }

  function scrollToFile(path) {
    const f = fileByPath(path)
    if (!f) return
    const target = regionOf(f)
    if (!target) {
      // Diff not rendered yet (lazy/virtualized) — jump via its anchor.
      if (f.id) location.hash = '#' + f.id
      return
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const prev = target.style.transition
    target.style.transition = 'outline .15s'
    target.style.outline = '2px solid #d29922'
    target.style.outlineOffset = '2px'
    setTimeout(() => {
      target.style.outline = ''
      target.style.transition = prev
    }, 1200)
  }

  // ---- selection actions -------------------------------------------------
  function afterSelectionChange() {
    if (ui.focus) injectPageStyle()
    renderList()
    updateCounts()
  }

  function selectShown() {
    rendered.forEach((f) => selected.add(f.path))
    afterSelectionChange()
  }

  function clearSelection() {
    selected.clear()
    lastIndex = -1
    afterSelectionChange()
  }

  function unionSelect(paths) {
    paths.forEach((p) => selected.add(p))
    afterSelectionChange()
  }

  function toggleFocus() {
    ui.focus = !ui.focus
    injectPageStyle()
    renderToolbar()
  }

  function toggleImportantOnly() {
    ui.importantOnly = !ui.importantOnly
    renderToolbar()
    renderList()
  }

  function markSelectedViewed(want) {
    ;[...selected]
      .map(fileByPath)
      .filter(Boolean)
      .forEach((f) => setViewed(f, want))
    setTimeout(renderList, 250)
  }

  // ---- groups ------------------------------------------------------------
  function saveGroup(name) {
    name = (name || '').trim()
    if (!name || selected.size === 0) return
    const paths = [...selected]
    const existing = data.groups.find((g) => g.name === name)
    if (existing) existing.paths = paths
    else data.groups.push({ name, paths })
    saveData()
    renderGroups()
  }

  function applyGroup(g, focus) {
    selected = new Set(g.paths.filter((p) => fileByPath(p)))
    lastIndex = -1
    if (focus) ui.focus = true
    injectPageStyle()
    renderAll()
  }

  function deleteGroup(name) {
    data.groups = data.groups.filter((g) => g.name !== name)
    saveData()
    renderGroups()
  }

  // ---- presets -----------------------------------------------------------
  const STATIC_PRESETS = [
    { label: 'Tests', q: '/(\\.|_)(test|spec)\\.|(^|/)(__tests__|tests?)\\//' },
    { label: '__init__', q: '/__init__\\./' },
    { label: 'Types .d.ts', q: '/\\.d\\.ts$/' },
    { label: 'Configs', q: '/\\.(json|ya?ml|toml|ini|cfg|conf|lock)$|(^|/)\\.[^/]+rc(\\.|$)/' },
    { label: 'Styles', q: '/\\.(css|scss|sass|less)$/' },
    { label: 'Docs', q: '/\\.(md|mdx|rst|txt)$/' }
  ]

  function extChips() {
    const counts = new Map()
    files.forEach((f) => {
      const base = f.path.split('/').pop()
      const dot = base.lastIndexOf('.')
      if (dot <= 0) return
      const ext = base.slice(dot + 1).toLowerCase()
      if (!/^[a-z0-9]+$/.test(ext)) return
      counts.set(ext, (counts.get(ext) || 0) + 1)
    })
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ext, n]) => ({ label: `.${ext} (${n})`, q: `/\\.${ext}$/` }))
  }

  // ---- rendering ---------------------------------------------------------
  function ensureUI() {
    if (document.getElementById(HOST_ID)) return
    const host = document.createElement('div')
    host.id = HOST_ID
    const root = host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = PANEL_CSS

    const launch = el(
      'button',
      { class: 'launch', title: 'Group PR files (Alt+Shift+G)', onClick: () => setOpen(true) },
      el('span', { class: 'launch-ico', text: '▤' }),
      el('span', { text: 'Files' })
    )

    const counts = el('span', { class: 'counts' })
    const closeBtn = el('button', { class: 'btn ghost close', title: 'Close (Esc)', text: '✕', onClick: () => setOpen(false) })
    const head = el('div', { class: 'head' }, el('span', { class: 'title', text: 'PR Files' }), counts, closeBtn)

    const search = el('input', {
      class: 'search',
      type: 'text',
      placeholder: 'Filter: text, /regex/, space = OR',
      spellcheck: 'false'
    })
    const presets = el('div', { class: 'presets' })
    const toolbar = el('div', { class: 'toolbar' })
    const list = el('div', { class: 'list', role: 'list' })

    const groupList = el('div', { class: 'group-list' })
    const groupName = el('input', {
      class: 'group-name',
      type: 'text',
      placeholder: 'Name current selection…',
      spellcheck: 'false'
    })
    const saveGroupBtn = el('button', { class: 'btn save-group', text: 'Save' })
    const groups = el(
      'div',
      { class: 'groups' },
      el('div', { class: 'groups-head', text: 'Groups' }),
      groupList,
      el('div', { class: 'group-add' }, groupName, saveGroupBtn)
    )

    const resizer = el('div', { class: 'resizer', title: 'Drag to resize', onMousedown: startResize })
    const panel = el(
      'section',
      { class: 'panel', hidden: '', 'aria-label': 'PR File Grouper' },
      resizer,
      head,
      el('div', { class: 'search-row' }, search),
      presets,
      toolbar,
      list,
      groups
    )

    root.append(style, launch, panel)
    ;(document.documentElement || document.body).appendChild(host)

    // Isolate keyboard events at the shadow boundary: keystrokes typed in the
    // panel never bubble out to GitHub's global hotkeys, and GitHub's key
    // handling never interferes with the panel's inputs.
    ;['keydown', 'keyup', 'keypress'].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()))

    refs = { host, root, launch, panel, counts, search, presets, toolbar, list, groupList, groupName }
    applyWidth()

    search.addEventListener('input', () => {
      clearTimeout(filterTimer)
      filterTimer = setTimeout(() => {
        ui.filter = search.value
        renderList()
      }, 110)
    })
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (search.value) {
          search.value = ''
          ui.filter = ''
          renderList()
        } else setOpen(false)
      }
    })

    toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]')
      if (!b) return
      const act = b.dataset.act
      if (act === 'selShown') selectShown()
      else if (act === 'clear') clearSelection()
      else if (act === 'focus') toggleFocus()
      else if (act === 'impOnly') toggleImportantOnly()
      else if (act === 'viewed') markSelectedViewed(true)
      else if (act === 'unviewed') markSelectedViewed(false)
      else if (act === 'view') {
        ui.viewMode = ui.viewMode === 'tree' ? 'flat' : 'tree'
        renderToolbar()
        renderList()
      } else if (act === 'foldAll') toggleFoldAll()
    })

    refs.presets.addEventListener('click', (e) => {
      const chip = e.target.closest('button[data-q]')
      if (!chip) return
      unionSelect(matchingPaths(chip.dataset.q))
    })

    refs.list.addEventListener('click', (e) => {
      const dirRowEl = e.target.closest('.dir-row')
      if (dirRowEl) {
        const dirPath = dirRowEl.dataset.dir
        if (e.target.classList.contains('dir-cb')) {
          const checked = e.target.checked
          files
            .filter((f) => fileMatches(f.path) && (dirPath === PR_ROOT || f.path.startsWith(dirPath + '/')))
            .forEach((f) => (checked ? selected.add(f.path) : selected.delete(f.path)))
          afterSelectionChange()
        } else {
          if (ui.collapsed.has(dirPath)) ui.collapsed.delete(dirPath)
          else ui.collapsed.add(dirPath)
          renderList()
        }
        return
      }
      const row = e.target.closest('.row')
      if (!row) return
      const path = row.dataset.path
      const idx = Number(row.dataset.index)
      if (e.target.classList.contains('cb')) {
        const checked = e.target.checked
        if (e.shiftKey && lastIndex >= 0 && rendered.length) {
          const [a, b] = [lastIndex, idx].sort((x, y) => x - y)
          for (let i = a; i <= b; i++) {
            const p = rendered[i] && rendered[i].path
            if (!p) continue
            if (checked) selected.add(p)
            else selected.delete(p)
          }
        } else if (checked) selected.add(path)
        else selected.delete(path)
        lastIndex = idx
        afterSelectionChange()
      } else if (e.target.closest('.star')) {
        toggleImportant(path)
      } else if (e.target.closest('.vtoggle')) {
        const f = fileByPath(path)
        if (f) toggleViewed(f)
      } else if (e.target.closest('.name')) {
        scrollToFile(path)
      }
    })

    saveGroupBtn.addEventListener('click', () => {
      saveGroup(refs.groupName.value)
      refs.groupName.value = ''
    })
    refs.groupName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        saveGroup(refs.groupName.value)
        refs.groupName.value = ''
      }
    })

    refs.groupList.addEventListener('click', (e) => {
      const item = e.target.closest('[data-group]')
      if (!item) return
      const name = item.dataset.group
      const g = data.groups.find((x) => x.name === name)
      if (!g) return
      if (e.target.closest('.g-del')) deleteGroup(name)
      else if (e.target.closest('.g-focus')) applyGroup(g, true)
      else applyGroup(g, false)
    })

    applyTheme()
  }

  function applyTheme() {
    const host = document.getElementById(HOST_ID)
    if (!host) return
    const mode = document.documentElement.getAttribute('data-color-mode')
    let dark
    if (mode === 'dark') dark = true
    else if (mode === 'light') dark = false
    else dark = matchMedia('(prefers-color-scheme: dark)').matches
    host.setAttribute('data-theme', dark ? 'dark' : 'light')
  }

  function updateCounts() {
    if (!refs.counts) return
    refs.counts.textContent = `${selected.size} selected · ${files.length} files`
  }

  function renderToolbar() {
    if (!refs.toolbar) return
    // "View" changes what/how files are shown; "Selection" acts on the selected
    // files. Chips above (Select by type) change the selection.
    const viewDefs = [
      ['view', ui.viewMode === 'tree' ? 'Tree' : 'List', ui.viewMode === 'tree', 'Toggle tree / flat view'],
      ...(ui.viewMode === 'tree' ? [['foldAll', 'Fold', false, 'Collapse / expand all folders']] : []),
      ['impOnly', '★ only', ui.importantOnly, 'Show only starred files']
    ]
    const selDefs = [
      ['selShown', 'Select shown', false, 'Select every file currently shown'],
      ['clear', 'Clear', false, 'Clear the selection'],
      ['focus', 'Show only', ui.focus, 'Show only the selected files in the diff'],
      ['viewed', 'Mark viewed', false, 'Mark selected files as viewed'],
      ['unviewed', 'Mark unviewed', false, 'Mark selected files as not viewed']
    ]
    const mkBtn = ([act, label, active, title]) =>
      el('button', { class: 'btn' + (active ? ' active' : ''), 'data-act': act, title, text: label })
    refs.toolbar.replaceChildren(
      el('div', { class: 'trow' }, el('span', { class: 'section-label', text: 'View' }), ...viewDefs.map(mkBtn)),
      el('div', { class: 'trow' }, el('span', { class: 'section-label', text: 'Selection' }), ...selDefs.map(mkBtn))
    )
  }

  function renderPresets() {
    if (!refs.presets) return
    const chips = [...STATIC_PRESETS, ...extChips()]
    refs.presets.replaceChildren(
      el('span', { class: 'section-label', text: 'Select by type' }),
      ...chips.map((c) => el('button', { class: 'chip', 'data-q': c.q, title: 'Click to select matching files', text: c.label }))
    )
  }

  function renderGroups() {
    if (!refs.groupList) return
    if (!data.groups.length) {
      refs.groupList.replaceChildren(
        el('div', { class: 'empty', text: 'No groups yet. Select files, name them, and Save.' })
      )
      return
    }
    refs.groupList.replaceChildren(
      ...data.groups.map((g) => {
        const present = g.paths.filter((p) => fileByPath(p)).length
        return el(
          'div',
          { class: 'group', 'data-group': g.name },
          el(
            'button',
            { class: 'g-name', title: 'Select this group', text: g.name + ' ' },
            el('span', { class: 'muted', text: `(${present}/${g.paths.length})` })
          ),
          el('button', { class: 'btn ghost g-focus', title: 'Select + show only', text: 'focus' }),
          el('button', { class: 'btn ghost g-del', title: 'Delete group', text: '✕' })
        )
      })
    )
  }

  // ---- tree model --------------------------------------------------------
  function buildTree(fileList) {
    const root = { name: '', path: '', children: new Map(), fileNodes: [] }
    for (const f of fileList) {
      const parts = f.path.split('/')
      let node = root
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]
        let child = node.children.get(seg)
        if (!child) {
          child = { name: seg, path: parts.slice(0, i + 1).join('/'), children: new Map(), fileNodes: [] }
          node.children.set(seg, child)
        }
        node = child
      }
      node.fileNodes.push(f)
    }
    return root
  }

  function descendantFiles(node) {
    const out = node.fileNodes.slice()
    node.children.forEach((c) => out.push(...descendantFiles(c)))
    return out
  }

  // Flatten the tree into ordered render items, respecting collapsed folders
  // (unless a filter is active, in which case everything is expanded so matches
  // are always visible).
  // Flatten the tree into ordered render items. The passed node is rendered as a
  // folder row itself (used for the synthetic "pr" root), with its contents one
  // level deeper. Respects collapsed folders unless a filter forces expand-all.
  function treeItems(root, expandAll) {
    const items = []
    const walk = (node, depth) => {
      const collapsed = !expandAll && ui.collapsed.has(node.path)
      items.push({ kind: 'dir', node, depth, collapsed })
      if (collapsed) return
      ;[...node.children.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((d) => walk(d, depth + 1))
      node.fileNodes
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .forEach((f) => items.push({ kind: 'file', file: f, depth: depth + 1 }))
    }
    walk(root, 0)
    return items
  }

  function allDirPaths() {
    const set = new Set([PR_ROOT])
    files
      .filter((f) => fileMatches(f.path))
      .forEach((f) => {
        const parts = f.path.split('/')
        parts.pop()
        for (let i = 0; i < parts.length; i++) set.add(parts.slice(0, i + 1).join('/'))
      })
    return [...set]
  }

  function toggleFoldAll() {
    const dirs = allDirPaths()
    const allCollapsed = dirs.length > 0 && dirs.every((d) => ui.collapsed.has(d))
    if (allCollapsed) ui.collapsed.clear()
    else dirs.forEach((d) => ui.collapsed.add(d))
    renderList()
  }

  // ---- row builders ------------------------------------------------------
  function fileRow(f, depth, index) {
    const row = el('div', { class: 'row', 'data-path': f.path, 'data-index': String(index) })
    row.style.paddingLeft = 6 + depth * 14 + 'px'
    if (selected.has(f.path)) row.classList.add('sel')
    if (isImportant(f.path)) row.classList.add('imp')
    if (isViewed(f)) row.classList.add('viewed')

    // Empty spacer occupying the folder expand-arrow column, so a file's
    // checkbox aligns one level in under its parent folder (proper nesting).
    if (ui.viewMode === 'tree') row.appendChild(el('span', { class: 'twist' }))
    const cb = el('input', { type: 'checkbox', class: 'cb' })
    cb.checked = selected.has(f.path)
    row.append(cb, el('button', { class: 'star', title: 'Mark important', text: isImportant(f.path) ? '★' : '☆' }))

    const name = el('span', { class: 'name', title: f.path })
    if (ui.viewMode === 'flat') {
      const parts = f.path.split('/')
      const base = parts.pop()
      if (parts.length) name.appendChild(el('span', { class: 'dir', text: parts.join('/') + '/' }))
      name.appendChild(el('span', { class: 'base', text: base }))
    } else {
      name.appendChild(el('span', { class: 'base', text: f.path.split('/').pop() }))
    }
    row.appendChild(name)
    const viewed = isViewed(f)
    row.appendChild(
      el('button', {
        class: 'vtoggle' + (viewed ? ' on' : ''),
        title: viewed ? 'Mark not viewed' : 'Mark viewed',
        text: viewed ? '✓' : '○'
      })
    )
    return row
  }

  function dirRow(node, depth, collapsed) {
    const kids = descendantFiles(node)
    const selCount = kids.reduce((n, f) => n + (selected.has(f.path) ? 1 : 0), 0)
    const viewedCount = kids.reduce((n, f) => n + (isViewed(f) ? 1 : 0), 0)
    const allViewed = kids.length > 0 && viewedCount === kids.length
    const row = el('div', { class: 'dir-row', 'data-dir': node.path, title: node.path })
    row.style.paddingLeft = 6 + depth * 14 + 'px'
    if (allViewed) row.classList.add('viewed')
    row.appendChild(el('span', { class: 'twist', text: collapsed ? '▸' : '▾' }))
    const cb = el('input', { type: 'checkbox', class: 'dir-cb', title: 'Select all files in this folder' })
    cb.checked = kids.length > 0 && selCount === kids.length
    cb.indeterminate = selCount > 0 && selCount < kids.length
    row.append(cb, el('span', { class: 'dir-name', text: node.name }))
    if (allViewed) row.appendChild(el('span', { class: 'vdot', title: 'All files viewed', text: '✓' }))
    row.appendChild(el('span', { class: 'dir-count', text: String(kids.length) }))
    return row
  }

  function renderList() {
    if (!refs.list) return
    const filtered = files.filter((f) => fileMatches(f.path))

    if (!files.length) {
      rendered = []
      refs.list.replaceChildren(
        el('div', { class: 'empty', text: 'No files detected. Open a pull request\u2019s "Files changed" / "changes" view.' })
      )
      updateCounts()
      return
    }
    if (!filtered.length) {
      rendered = []
      refs.list.replaceChildren(el('div', { class: 'empty', text: 'No files match this filter.' }))
      updateCounts()
      return
    }

    const frag = document.createDocumentFragment()
    if (ui.viewMode === 'flat') {
      rendered = filtered
      filtered.forEach((f, i) => frag.appendChild(fileRow(f, 0, i)))
    } else {
      const expandAll = !!ui.filter.trim() || ui.importantOnly
      const realRoot = buildTree(filtered)
      // Wrap everything under a single "pr" folder so the whole PR can be
      // folded and shows viewed once every file is viewed.
      const prRoot = { name: 'pr', path: PR_ROOT, children: realRoot.children, fileNodes: realRoot.fileNodes }
      const items = treeItems(prRoot, expandAll)
      rendered = items.filter((it) => it.kind === 'file').map((it) => it.file)
      let fi = 0
      for (const it of items) {
        frag.appendChild(it.kind === 'dir' ? dirRow(it.node, it.depth, it.collapsed) : fileRow(it.file, it.depth, fi++))
      }
    }
    refs.list.replaceChildren(frag)
    updateCounts()
  }

  function renderAll() {
    ensureUI()
    applyTheme()
    renderPresets()
    renderToolbar()
    renderGroups()
    refs.search.value = ui.filter
    renderList()
  }

  // ---- open / close ------------------------------------------------------
  // Push the page content left (instead of overlaying it) while the panel is open.
  function applyLayout() {
    const el = document.documentElement
    if (!el) return
    if (ui.open && parseCtx()) {
      el.style.transition = 'margin-right .15s ease'
      el.style.marginRight = panelWidth + 'px'
    } else {
      el.style.marginRight = ''
    }
  }

  // Resizable width ---------------------------------------------------------
  function maxWidth() {
    return Math.max(PANEL_MIN, Math.min(800, Math.round(window.innerWidth * 0.7)))
  }
  function applyWidth() {
    if (refs.host) refs.host.style.setProperty('--gpf-w', panelWidth + 'px')
    if (ui.open) applyLayout()
  }
  function saveWidth() {
    try {
      api.storage.local.set({ settings: { width: panelWidth } })
    } catch (_) {}
  }
  async function loadWidth() {
    try {
      const r = await api.storage.local.get('settings')
      const w = r.settings && r.settings.width
      if (typeof w === 'number' && w >= PANEL_MIN) panelWidth = Math.min(w, maxWidth())
    } catch (_) {}
    applyWidth()
  }
  function startResize(e) {
    e.preventDefault()
    const el = document.documentElement
    const prevTransition = el.style.transition
    el.style.transition = 'none'
    document.body && (document.body.style.userSelect = 'none')
    const move = (ev) => {
      panelWidth = Math.max(PANEL_MIN, Math.min(Math.round(window.innerWidth - ev.clientX), maxWidth()))
      if (refs.host) refs.host.style.setProperty('--gpf-w', panelWidth + 'px')
      if (ui.open && parseCtx()) el.style.marginRight = panelWidth + 'px'
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      el.style.transition = prevTransition
      document.body && (document.body.style.userSelect = '')
      saveWidth()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  function setOpen(open) {
    ensureUI()
    ui.open = open
    refs.panel.hidden = !open
    refs.launch.hidden = open
    applyLayout()
    if (open) {
      files = collectFiles()
      injectPageStyle()
      renderAll()
    }
  }

  function togglePanel() {
    setOpen(!ui.open)
  }

  // ---- lifecycle ---------------------------------------------------------
  function refresh() {
    const next = parseCtx()
    if (!next) {
      teardown()
      return
    }
    if (!ctx || ctx.key !== next.key) {
      ctx = next
      selected = new Set()
      ui.focus = false
      ui.filter = ''
      ui.importantOnly = false
      ui.collapsed = new Set()
      lastIndex = -1
      loadData().then(() => {
        files = collectFiles()
        injectPageStyle()
        if (ui.open) renderAll()
      })
      return
    }
    files = collectFiles()
    injectPageStyle()
    if (ui.open) {
      renderPresets()
      renderGroups()
      renderList()
    }
  }

  function teardown() {
    ctx = null
    files = []
    const st = document.getElementById(PAGE_STYLE_ID)
    if (st) st.textContent = ''
    document.body && document.body.classList.remove('gpf-focus')
    if (document.documentElement) document.documentElement.style.marginRight = ''
    if (refs.launch) refs.launch.hidden = true
    if (refs.panel) refs.panel.hidden = true
  }

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, 250)
  }

  function boot() {
    if (parseCtx()) {
      ensureUI()
      // Panel always starts closed on a fresh page; the user opens it on demand.
      refs.launch.hidden = ui.open
      refs.panel.hidden = !ui.open
      applyLayout()
      refresh()
    } else {
      teardown()
    }
  }

  // React re-renders, lazy diff loading, "load more files" → re-scan.
  const mo = new MutationObserver(() => {
    if (parseCtx()) {
      if (!document.getElementById(HOST_ID)) {
        boot()
        return
      }
      // Do NOT touch panel/launch visibility here — setOpen is the sole owner of
      // open/close, so a page mutation can never re-open a panel the user closed.
      scheduleRefresh()
    } else {
      teardown()
    }
  })

  // SPA navigation (Turbo / soft nav) → re-evaluate context.
  const wrap = (type) => {
    const orig = history[type]
    history[type] = function () {
      const r = orig.apply(this, arguments)
      window.dispatchEvent(new Event('gpf:locationchange'))
      return r
    }
  }
  wrap('pushState')
  wrap('replaceState')
  window.addEventListener('popstate', () => window.dispatchEvent(new Event('gpf:locationchange')))
  window.addEventListener('gpf:locationchange', () => setTimeout(boot, 60))

  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyG') {
      e.preventDefault()
      if (parseCtx()) togglePanel()
    }
  })

  if (api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'gpf-toggle' && parseCtx()) togglePanel()
    })
  }

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)

  // Start — deferred to a microtask so the PANEL_CSS const declared below this
  // point is initialized before boot() → ensureUI() reads it.
  Promise.resolve().then(() => {
    boot()
    loadWidth()
    mo.observe(document.documentElement, { childList: true, subtree: true })
  })

  // ---- panel stylesheet (shadow DOM) ------------------------------------
  const PANEL_CSS = `
    :host{ all: initial; }
    /* The class selectors below set display; without this, the [hidden] attribute
       (a low-specificity UA rule) is overridden and .panel/.launch never hide. */
    [hidden]{ display: none !important; }
    *{ box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    :host{
      --bg:#fff; --fg:#1f2328; --muted:#656d76; --border:#d0d7de; --subtle:#f6f8fa;
      --accent:#0969da; --accentfg:#fff; --star:#bf8700; --add:#1a7f37; --del:#cf222e;
      --selbg:#ddf4ff; --shadow: 0 8px 24px rgba(31,35,40,.2);
    }
    :host([data-theme="dark"]){
      --bg:#0d1117; --fg:#e6edf3; --muted:#7d8590; --border:#30363d; --subtle:#161b22;
      --accent:#2f81f7; --accentfg:#fff; --star:#d29922; --add:#3fb950; --del:#f85149;
      --selbg:#132b45; --shadow: 0 8px 24px rgba(1,4,9,.7);
    }
    .launch{
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      display: inline-flex; align-items: center; gap: 6px;
      background: var(--accent); color: var(--accentfg); border: 0; border-radius: 999px;
      padding: 9px 14px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: var(--shadow);
    }
    .launch:hover{ filter: brightness(1.05); }
    .launch-ico{ font-size: 14px; }
    .panel{
      position: fixed; top: 0; right: 0; z-index: 2147483000;
      width: var(--gpf-w, 360px); max-width: 95vw; height: 100vh;
      background: var(--bg); color: var(--fg); border-left: 1px solid var(--border);
      box-shadow: var(--shadow); display: flex; flex-direction: column; font-size: 13px;
    }
    .resizer{
      position: absolute; left: 0; top: 0; bottom: 0; width: 7px; margin-left: -3px;
      cursor: ew-resize; z-index: 3;
    }
    .resizer:hover, .resizer:active{ background: var(--accent); opacity: .35; }
    .head{ display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border); }
    .title{ font-weight:700; }
    .counts{ color:var(--muted); font-size:12px; margin-left:auto; }
    .search-row{ padding:10px 12px 6px; }
    .search{
      width:100%; padding:7px 10px; border:1px solid var(--border); border-radius:6px;
      background:var(--subtle); color:var(--fg); font-size:13px; outline:none;
    }
    .search:focus{ border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }
    .presets{ display:flex; flex-wrap:wrap; gap:6px; padding:6px 12px; }
    .chip{
      border:1px solid var(--border); background:var(--subtle); color:var(--fg);
      border-radius:999px; padding:3px 9px; font-size:11.5px; cursor:pointer;
    }
    .chip:hover{ border-color:var(--accent); color:var(--accent); }
    .toolbar{ display:flex; flex-direction:column; align-items:stretch; gap:6px; padding:6px 12px 8px; border-bottom:1px solid var(--border); }
    .trow{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
    .section-label{ font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); flex:0 0 auto; min-width:56px; }
    .btn{
      border:1px solid var(--border); background:var(--bg); color:var(--fg);
      border-radius:6px; padding:4px 9px; font-size:12px; cursor:pointer;
    }
    .btn:hover{ background:var(--subtle); }
    .btn.active{ background:var(--accent); color:var(--accentfg); border-color:var(--accent); }
    .btn.ghost{ border-color:transparent; background:transparent; }
    .btn.ghost:hover{ background:var(--subtle); }
    .list{ flex:1; overflow-y:auto; padding:4px 6px; }
    .row{
      display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:6px; cursor:default;
      border-left:3px solid transparent;
    }
    .row:hover{ background:var(--subtle); }
    .row.sel{ background:var(--selbg); }
    .row.imp{ border-left-color:var(--star); }
    .cb{ width:15px; height:15px; accent-color:var(--accent); cursor:pointer; flex:0 0 auto; }
    .star{ border:0; background:transparent; color:var(--star); font-size:14px; cursor:pointer; padding:0 2px; line-height:1; flex:0 0 auto; }
    .name{ flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; }
    .name:hover .base{ text-decoration:underline; color:var(--accent); }
    .dir{ color:var(--muted); }
    .base{ font-weight:600; }
    .row.viewed .name{ opacity:.55; }
    .vdot{ color:var(--add); font-size:12px; flex:0 0 auto; }
    .vtoggle{ border:0; background:transparent; color:var(--muted); font-size:13px; line-height:1; cursor:pointer; padding:0 3px; flex:0 0 auto; }
    .vtoggle:hover{ color:var(--fg); }
    .vtoggle.on{ color:var(--add); }
    .dir-row{ display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:6px; cursor:pointer; user-select:none; }
    .dir-row:hover{ background:var(--subtle); }
    .twist{ width:12px; text-align:center; color:var(--muted); font-size:10px; flex:0 0 auto; }
    .dir-cb{ width:15px; height:15px; accent-color:var(--accent); cursor:pointer; flex:0 0 auto; }
    .dir-name{ flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-weight:600; }
    .dir-count{ color:var(--muted); font-size:11px; flex:0 0 auto; }
    .dir-row.viewed .dir-name{ opacity:.55; }
    .groups{ border-top:1px solid var(--border); padding:8px 12px; max-height:34%; overflow-y:auto; }
    .groups-head{ font-weight:700; font-size:12px; margin-bottom:6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
    .group{ display:flex; align-items:center; gap:6px; padding:2px 0; }
    .g-name{ flex:1; text-align:left; border:0; background:transparent; color:var(--fg); cursor:pointer; padding:4px 6px; border-radius:6px; font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .g-name:hover{ background:var(--subtle); color:var(--accent); }
    .muted{ color:var(--muted); font-weight:400; }
    .group-add{ display:flex; gap:6px; margin-top:6px; }
    .group-name{ flex:1; padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:var(--subtle); color:var(--fg); font-size:12px; outline:none; }
    .empty{ color:var(--muted); font-size:12px; padding:12px 8px; text-align:center; }
  `
})()
