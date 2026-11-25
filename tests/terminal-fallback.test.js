/**
 * Verifies the 3-tier quick action execution waterfall & native terminal tracking in client.js:
 * 1. Native DSH interactive terminal (`webTerminals` + `sidebarRight` + `'terminal'` tab)
 *    - Running indicator dot (`.dshwt-hdr-dot`) while terminal tab is open & shell running
 *    - Click-to-focus existing terminal tab (expanding collapsed sidebarRight) without duplicates
 *    - Secondary `+` button in dropdown menu to spawn a fresh terminal instance (`forceNew`)
 *    - Automatic dot cleanup on tab close (`sidebarRight.openTabs`) or shell exit (`termView.state`)
 * 2. Fallback to plugin EnvRunner + on-demand right-sidebar log tab (`dsh-worktree-env-logs`)
 * 3. Fallback to plugin EnvRunner + floating `shell.overlay` LogDrawer when right sidebar is absent
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function findNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findNodes(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findNodes(child, predicate, out)
  return out
}

async function loadHeaderHarness({
  withTerminal = false,
  withSidebarRight = false,
  actions = [{ name: 'dev', icon: 'run', command: 'npm run dev' }],
  envFile = null,
} = {}) {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const stateSlots = []
  const effectSlots = []
  const refSlots = []
  let cursor = 0
  let effectCursor = 0
  let refCursor = 0
  let loadedModule = null

  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => {
      const idx = cursor++
      if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init
      const setter = (next) => {
        stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next
      }
      return [stateSlots[idx], setter]
    },
    useEffect: (fn, deps) => {
      const idx = effectCursor++
      const prev = effectSlots[idx]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => d !== prev.deps[i])
      if (changed) {
        if (typeof prev?.cleanup === 'function') prev.cleanup()
        const cleanup = fn()
        effectSlots[idx] = { deps, cleanup }
      }
    },
    useMemo: (fn) => fn(),
    useRef: (init) => {
      const idx = refCursor++
      if (!(idx in refSlots)) {
        refSlots[idx] = {
          current: init ?? {
            getBoundingClientRect: () => ({ top: 10, bottom: 38, right: 600, left: 500 }),
            contains: () => false,
          },
        }
      }
      return refSlots[idx]
    },
    useCallback: (fn) => fn,
  }

  const fetchCalls = []
  const sandbox = {
    window: {
      innerWidth: 1200,
      __ModuleLoader__: {
        load(spec) {
          loadedModule = spec.factory((id) => {
            if (id === 'react') return mockReact
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init })
      if (url.includes('/actions/run')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ operationId: 'op-fallback-1' }) }
      }
      if (url.includes('/session-actions')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            cwd: '/repo',
            repositoryRoot: '/repo',
            branch: 'main',
            envFile,
            actions,
            activeOperations: [],
          }),
        }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({}) }
    },
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    document: {
      documentElement: { lang: 'zh-CN' },
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })

  const registeredSlots = []
  const openedTabs = []
  const sessionTabs = []
  const focusedTabs = []
  const openTabSubscribers = new Set()
  const terminalWrites = []
  const terminalRenames = []
  const terminalControllers = new Map()
  const tabDefs = new Map()
  let expanded = true
  let toggleExpandCount = 0
  let nextTabSeq = 0
  if (withTerminal) tabDefs.set('terminal', { id: 'builtin-terminal', kind: 'terminal', multiple: true })

  const emitOpenTabs = () => {
    for (const fn of [...openTabSubscribers]) fn()
  }

  const sidebarRightTabs = withSidebarRight ? {
    register(def) {
      tabDefs.set(def.kind, def)
      return () => tabDefs.delete(def.kind)
    },
    get: (kind) => tabDefs.get(kind),
  } : undefined

  const sidebarRight = withSidebarRight ? {
    tabsIn: () => [...sessionTabs],
    openTabs: {
      getSnapshot: () => [...sessionTabs],
      subscribe: (fn) => {
        openTabSubscribers.add(fn)
        return () => openTabSubscribers.delete(fn)
      },
    },
    isExpanded: () => expanded,
    toggleExpanded: () => {
      expanded = !expanded
      toggleExpandCount += 1
    },
    focus: (tabId) => {
      focusedTabs.push(tabId)
    },
    openTab: (kind) => {
      nextTabSeq += 1
      const tab = { id: `tab-${nextTabSeq}`, kind, contentId: `cid-${nextTabSeq}` }
      sessionTabs.push(tab)
      openedTabs.push(tab)
      emitOpenTabs()
    },
    openTabIn: (_sid, kind) => {
      nextTabSeq += 1
      const tab = { id: `tab-${nextTabSeq}`, kind, contentId: `cid-${nextTabSeq}` }
      sessionTabs.push(tab)
      openedTabs.push(tab)
      emitOpenTabs()
    },
    closeIn: (_sid, tabId) => {
      const idx = sessionTabs.findIndex(t => t.id === tabId)
      if (idx !== -1) {
        sessionTabs.splice(idx, 1)
        emitOpenTabs()
      }
    },
  } : undefined

  const webTerminals = withTerminal ? {
    view: (_sid, tabId) => {
      if (!terminalControllers.has(tabId)) {
        let snap = { phase: 'connected', writable: true, info: { cwd: '/repo', state: 'running', shell: { name: 'zsh' } } }
        const subs = new Set()
        terminalControllers.set(tabId, {
          setSnapshot(next) {
            snap = next
            for (const fn of [...subs]) fn()
          },
          view: {
            state: {
              getSnapshot: () => snap,
              subscribe: (fn) => {
                subs.add(fn)
                return () => subs.delete(fn)
              },
            },
            rename: async (title) => { terminalRenames.push(title) },
            write: (data) => { terminalWrites.push(data) },
          },
        })
      }
      return terminalControllers.get(tabId).view
    },
  } : undefined

  const localeService = {
    register: () => () => {},
    bind: () => (k, p) => (p?.name ? `${k}:${p.name}` : k),
    getSnapshot: () => ({ active: 'zh', revision: 1 }),
    subscribe: () => () => {},
  }

  const ctx = {
    locale: localeService,
    get(key) {
      if (key === 'locale') return localeService
      if (key === 'sidebarRightTabs') return sidebarRightTabs
      if (key === 'sidebarRight') return sidebarRight
      if (key === 'webTerminals') return webTerminals
      return undefined
    },
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: () => () => {},
    slots: {
      inject: (_n, fn) => {
        const d = fn()
        return typeof d === 'function' ? d : () => {}
      },
      register: (meta, component) => {
        registeredSlots.push({ meta, component })
        return () => {}
      },
    },
  }

  loadedModule.apply(ctx)
  const headerSlot = registeredSlots.find(s => s.meta.name === 'conversation.session.header.utilities')
  const overlaySlot = registeredSlots.find(s => s.meta.name === 'shell.overlay')

  const renderHeader = () => {
    cursor = 0
    effectCursor = 0
    refCursor = 0
    return headerSlot.component({ sessionId: 'sess-1', cwd: '/repo' })
  }

  // Initial render triggers useEffect -> /session-actions fetch; await flush and re-render
  renderHeader()
  await new Promise(r => setTimeout(r, 10))
  const initialTree = renderHeader()
  assert.ok(findNodes(initialTree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-btn').length === 1, 'expected primary action button to render')

  return {
    renderHeader,
    triggerPrimary: async () => {
      const tree = renderHeader()
      const btn = findNodes(tree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-btn')[0]
      assert.ok(btn, 'expected primary action button')
      btn.props.onClick()
      await new Promise(r => setTimeout(r, 220))
    },
    openMenu: () => {
      const tree = renderHeader()
      const caret = findNodes(tree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-caret')[0]
      assert.ok(caret, 'expected dropdown caret button')
      caret.props.onClick()
      renderHeader() // runs useEffect([menuOpen]) -> setMenuPos(...)
      return renderHeader()
    },
    closeTerminalTab: (tabId) => {
      sidebarRight.closeIn('sess-1', tabId)
    },
    setTerminalState: (tabId, nextSnapshot) => {
      terminalControllers.get(tabId)?.setSnapshot(nextSnapshot)
    },
    setSidebarExpanded: (val) => { expanded = val },
    getToggleExpandCount: () => toggleExpandCount,
    renderOverlay: () => {
      cursor = 100
      effectCursor = 100
      refCursor = 100
      return overlaySlot.component()
    },
    fetchCalls,
    openedTabs,
    focusedTabs,
    terminalWrites,
    terminalRenames,
  }
}

test('Tier 1: prefers DSH native interactive terminal, shows running dot, focuses on re-click, and clears on close', async () => {
  const harness = await loadHeaderHarness({
    withTerminal: true,
    withSidebarRight: true,
    envFile: '/repo/.git/dsh-worktree.env',
    actions: [{ name: 'dev', icon: 'run', command: 'npm run dev' }],
  })

  // Before running: no green dot
  assert.equal(findNodes(harness.renderHeader(), n => n.props?.className === 'dshwt-hdr-dot').length, 0)

  await harness.triggerPrimary()
  assert.equal(harness.openedTabs.length, 1)
  assert.equal(harness.openedTabs[0].kind, 'terminal')
  assert.deepEqual(harness.terminalRenames, ['dev'])
  assert.equal(harness.terminalWrites.length, 1)
  assert.equal(harness.terminalWrites[0], ". '/repo/.git/dsh-worktree.env' && npm run dev\r")
  assert.equal(harness.fetchCalls.filter(c => c.url.endsWith('/actions/run')).length, 0)

  // While native terminal tab is open & running: green dot visible and tooltip offers focusing terminal
  const runningTree = harness.renderHeader()
  assert.equal(findNodes(runningTree, n => n.props?.className === 'dshwt-hdr-dot').length, 1)
  const primaryBtn = findNodes(runningTree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-btn')[0]
  assert.equal(primaryBtn.props['aria-label'], 'header.actions.focusTerminal:dev')

  // Collapse right sidebar and click primary button again -> expands & focuses existing terminal instead of spawning a second one
  harness.setSidebarExpanded(false)
  await harness.triggerPrimary()
  assert.equal(harness.openedTabs.length, 1, 'should not open a duplicate terminal tab')
  assert.equal(harness.getToggleExpandCount(), 1, 'should expand collapsed right sidebar')
  assert.deepEqual(harness.focusedTabs, ['tab-1'])

  // Closing the native terminal tab clears the running dot immediately
  harness.closeTerminalTab('tab-1')
  assert.equal(findNodes(harness.renderHeader(), n => n.props?.className === 'dshwt-hdr-dot').length, 0)

  // Clicking again after tab close spawns a fresh native terminal tab
  await harness.triggerPrimary()
  assert.equal(harness.openedTabs.length, 2)
  assert.equal(findNodes(harness.renderHeader(), n => n.props?.className === 'dshwt-hdr-dot').length, 1)
})

test('Tier 1: clears running dot when native terminal shell exits', async () => {
  const harness = await loadHeaderHarness({
    withTerminal: true,
    withSidebarRight: true,
    actions: [{ name: 'dev', icon: 'run', command: 'npm run dev' }],
  })
  await harness.triggerPrimary()
  assert.equal(findNodes(harness.renderHeader(), n => n.props?.className === 'dshwt-hdr-dot').length, 1)

  // Shell exits inside still-open tab
  harness.setTerminalState('tab-1', { phase: 'connected', writable: false, info: { cwd: '/repo', state: 'exited', shell: { name: 'zsh' } } })
  assert.equal(findNodes(harness.renderHeader(), n => n.props?.className === 'dshwt-hdr-dot').length, 0)
})

test('Tier 1: dropdown shows running dot + new-terminal button and supports multiple instances', async () => {
  const harness = await loadHeaderHarness({
    withTerminal: true,
    withSidebarRight: true,
    actions: [
      { name: 'dev', icon: 'run', command: 'npm run dev' },
      { name: 'test', icon: 'test', command: 'npm test' },
    ],
  })

  await harness.triggerPrimary()
  const menuTree = harness.openMenu()
  const newButtons = findNodes(menuTree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-menu-new')
  assert.equal(newButtons.length, 1, 'only the running action row should show the new-terminal button')

  // Clicking '+' spawns a second native terminal for the same action
  newButtons[0].props.onClick({ stopPropagation() {} })
  await new Promise(r => setTimeout(r, 220))
  assert.equal(harness.openedTabs.length, 2)

  // Closing only the second tab keeps the running dot active while tab-1 is still alive
  harness.closeTerminalTab('tab-2')
  assert.equal(findNodes(harness.renderHeader(), n => n.props?.className === 'dshwt-hdr-dot').length, 1)

  // Running 'test' then closing its terminal leaves 'dev' (non-primary) running -> caret shows dot, primary 'test' does not
  const menuTree2 = harness.openMenu()
  const menuItems = findNodes(menuTree2, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-menu-item')
  assert.equal(menuItems.length, 2)
  menuItems[1].props.onClick()
  await new Promise(r => setTimeout(r, 220))
  assert.equal(harness.openedTabs.length, 3)
  harness.closeTerminalTab('tab-3')
  const splitTree = harness.renderHeader()
  const primaryBtn = findNodes(splitTree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-btn')[0]
  const caretBtn = findNodes(splitTree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-caret')[0]
  assert.equal(findNodes(primaryBtn, n => n.props?.className === 'dshwt-hdr-dot').length, 0, 'non-running primary button should not show dot')
  assert.equal(findNodes(caretBtn, n => n.props?.className === 'dshwt-hdr-dot').length, 1, 'caret button should indicate another action is running')

  // Closing the first tab removes the last instance and clears the dot
  harness.closeTerminalTab('tab-1')
  assert.equal(findNodes(harness.renderHeader(), n => n.props?.className === 'dshwt-hdr-dot').length, 0)
})

test('Tier 2: falls back to plugin EnvRunner + right-sidebar log tab when native terminal is disabled', async () => {
  const harness = await loadHeaderHarness({ withTerminal: false, withSidebarRight: true })
  await harness.triggerPrimary()
  const runCalls = harness.fetchCalls.filter(c => c.url.endsWith('/actions/run'))
  assert.equal(runCalls.length, 1)
  assert.equal(harness.openedTabs.length, 1)
  assert.equal(harness.openedTabs[0].kind, 'dsh-worktree-env-logs')
  assert.equal(harness.renderOverlay(), null, 'floating overlay must remain closed when docked in right sidebar')
})

test('Tier 3: falls back to floating shell.overlay LogDrawer when both terminal and right sidebar are absent', async () => {
  const harness = await loadHeaderHarness({ withTerminal: false, withSidebarRight: false })
  await harness.triggerPrimary()
  const runCalls = harness.fetchCalls.filter(c => c.url.endsWith('/actions/run'))
  assert.equal(runCalls.length, 1)
  const overlay = harness.renderOverlay()
  assert.ok(overlay !== null, 'floating overlay should open as final fallback')
})

test('Reopened archived worktree session auto-shows Restore button in top bar and removes Archive button from session menu', async () => {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const stateSlots = []
  const effectSlots = []
  const refSlots = []
  let cursor = 0
  let effectCursor = 0
  let refCursor = 0
  let loadedModule = null

  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => {
      const idx = cursor++
      if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init
      const setter = (next) => {
        stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next
      }
      return [stateSlots[idx], setter]
    },
    useEffect: (fn, deps) => {
      const idx = effectCursor++
      const prev = effectSlots[idx]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => d !== prev.deps[i])
      if (changed) {
        if (typeof prev?.cleanup === 'function') prev.cleanup()
        effectSlots[idx] = { deps, cleanup: fn() }
      }
    },
    useMemo: (fn) => fn(),
    useRef: (init) => {
      const idx = refCursor++
      if (!(idx in refSlots)) refSlots[idx] = { current: init }
      return refSlots[idx]
    },
    useCallback: (fn) => fn,
  }

  let restored = false
  const fetchCalls = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          loadedModule = spec.factory((id) => {
            if (id === 'react') return mockReact
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init })
      if (url.includes('/restore')) {
        restored = true
        return { ok: true, status: 200, text: async () => JSON.stringify({ restored: true }) }
      }
      if (url.includes('/session-actions')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(restored
            ? { cwd: '/repo/.agents/worktrees/feat-1', branch: 'feat-1', inWorktree: true, archivedWorktree: null, actions: [{ name: 'dev', icon: 'run', command: 'npm run dev' }], activeOperations: [] }
            : { cwd: '/repo/.agents/worktrees/feat-1', branch: 'feat-1', inWorktree: true, archivedWorktree: { id: '/repo/.agents/worktrees/feat-1', path: '/repo/.agents/worktrees/feat-1', branch: 'feat-1', hasSnapshot: true }, actions: [], activeOperations: [] }),
        }
      }
      if (url.endsWith('/worktrees')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            items: [{
              id: '/repo/.agents/worktrees/feat-1',
              path: '/repo/.agents/worktrees/feat-1',
              branch: 'feat-1',
              status: restored ? 'active' : 'archived',
              createdSessionId: 'sess-arch-1',
              sessions: restored ? [{ sessionId: 'sess-arch-1' }] : [],
            }],
          }),
        }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({}) }
    },
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    document: { documentElement: { lang: 'zh-CN' }, addEventListener() {}, removeEventListener() {} },
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })

  const registeredSlots = []
  const localeService = {
    register: () => () => {},
    bind: () => (k, p) => (p?.branch ? `${k}:${p.branch}` : k),
    getSnapshot: () => ({ active: 'zh', revision: 1 }),
    subscribe: () => () => {},
  }
  const ctx = {
    locale: localeService,
    get: (key) => (key === 'locale' ? localeService : undefined),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    slots: {
      inject: (_n, fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      register: (meta, component) => { registeredSlots.push({ meta, component }); return () => {} },
    },
  }
  loadedModule.apply(ctx)

  const headerSlot = registeredSlots.find(s => s.meta.name === 'conversation.session.header.utilities')
  const menuSlot = registeredSlots.find(s => s.meta.name === 'sidebar.workspaces.session.menu.item')

  const renderHeader = () => {
    cursor = 0; effectCursor = 0; refCursor = 0
    return headerSlot.component({ sessionId: 'sess-arch-1', cwd: '/repo/.agents/worktrees/feat-1' })
  }
  renderHeader()
  await new Promise(r => setTimeout(r, 10))
  const archivedTree = renderHeader()
  const restoreBtns = findNodes(archivedTree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dshwt-hdr-restore'))
  assert.equal(restoreBtns.length, 1, 'archived worktree session should auto-show Restore button in top bar')

  const renderMenu = () => {
    cursor = 50; effectCursor = 50; refCursor = 50
    return menuSlot.component({ sessionId: 'sess-arch-1', cwd: '/repo/.agents/worktrees/feat-1' })
  }

  // Before restoring: session menu shows Restore worktree (no Archive button)
  renderMenu()
  await new Promise(r => setTimeout(r, 10))
  const archivedMenuButtons = findNodes(renderMenu(), n => n.type === 'button' && n.props?.role === 'menuitem')
  assert.equal(archivedMenuButtons.length, 1, 'archived worktree session menu should show only Restore worktree')
  assert.equal(archivedMenuButtons[0].children[1], '恢复工作树')

  // Click Restore -> calls POST .../restore and flips back to quick actions
  restoreBtns[0].props.onClick()
  await new Promise(r => setTimeout(r, 20))
  const restoredTree = renderHeader()
  assert.equal(findNodes(restoredTree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dshwt-hdr-restore')).length, 0)
  assert.equal(findNodes(restoredTree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-btn').length, 1)
  assert.equal(fetchCalls.filter(c => c.url.includes('/restore')).length, 1)

  // After restoring: notifyEnvChanged() updates the session menu automatically -> shows only Apply changes (no Archive button)
  renderMenu()
  await new Promise(r => setTimeout(r, 10))
  const activeMenuButtons = findNodes(renderMenu(), n => n.type === 'button' && n.props?.role === 'menuitem')
  assert.equal(activeMenuButtons.length, 1, 'active worktree session menu should only show Apply changes (no Archive button)')
  assert.equal(activeMenuButtons[0].children[1], '应用改动到主目录')

  // Clicking Apply opens the native ApplyBackflowModal in shell.overlay (branch selection modal)
  const overlaySlot = registeredSlots.find(s => s.meta.name === 'shell.overlay')
  cursor = 100; effectCursor = 100; refCursor = 100
  assert.equal(overlaySlot.component(), null)
  activeMenuButtons[0].props.onClick()
  cursor = 100; effectCursor = 100; refCursor = 100
  const overlayTree = overlaySlot.component()
  assert.ok(overlayTree !== null, 'clicking Apply changes should open ApplyBackflowModal in shell.overlay')
})
