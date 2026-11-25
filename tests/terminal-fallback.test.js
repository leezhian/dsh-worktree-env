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
import { loadClientModule } from './_helpers.js'

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
  const fetchCalls = []
  const { loadedModule, renderAt } = await loadClientModule({
    defaultRectRef: true,
    fetchImpl: async (url, init) => {
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
  })

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

  const renderHeader = () => renderAt(0, () => headerSlot.component({ sessionId: 'sess-1', cwd: '/repo' }))

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
    renderOverlay: () => renderAt(100, () => overlaySlot.component()),
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

test('Reopened archived worktree session auto-shows floating Restore banner in conversation.input.dock and removes Archive button from session menu', async () => {
  let restored = false
  let rejectSlowRestore = null
  const fetchCalls = []
  const createdSessions = []
  const openedSessions = []
  const { loadedModule, renderAt } = await loadClientModule({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init })
      if (url.includes('/restore')) {
        if (url.includes('feat-slow')) {
          return await new Promise((_resolve, reject) => { rejectSlowRestore = reject })
        }
        restored = true
        return { ok: true, status: 200, text: async () => JSON.stringify({ restored: true }) }
      }
      if (url.includes('/session-actions')) {
        if (url.includes('sess-slow-1')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ cwd: '/repo', branch: 'feat-slow', inWorktree: true, archivedWorktree: { id: '/repo/.agents/worktrees/feat-slow', path: '/repo/.agents/worktrees/feat-slow', branch: 'feat-slow', hasSnapshot: true }, actions: [], activeOperations: [] }),
          }
        }
        if (url.includes('sess-arch-2')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ cwd: '/repo', branch: 'feat-2', inWorktree: true, archivedWorktree: { id: '/repo/.agents/worktrees/feat-2', path: '/repo/.agents/worktrees/feat-2', branch: 'feat-2', hasSnapshot: false }, actions: [], activeOperations: [] }),
          }
        }
        const isOther = url.includes('sess-other-2') || url.includes(encodeURIComponent('/repo-other'))
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(isOther
            ? { cwd: '/repo', branch: 'main', inWorktree: false, archivedWorktree: null, actions: [], activeOperations: [] }
            : restored
              ? { cwd: '/repo/.agents/worktrees/feat-1', branch: 'feat-1', inWorktree: true, archivedWorktree: null, actions: [{ name: 'dev', icon: 'run', command: 'npm run dev' }], activeOperations: [] }
              : { cwd: '/repo/.agents/worktrees/feat-1', branch: 'feat-1', inWorktree: true, archivedWorktree: { id: '/repo/.agents/worktrees/feat-1', path: '/repo/.agents/worktrees/feat-1', branch: 'feat-1', hasSnapshot: true }, actions: [], activeOperations: [] }),
        }
      }
      if (url.includes('/sessions/handoff-info')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ cwd: '/repo', repositoryRoot: '/repo', currentBranch: 'main', dirtyCount: 2, inWorktree: false, hasLiveAgent: false }),
        }
      }
      if (url.endsWith('/sessions/handoff')) {
        const body = JSON.parse(init?.body ?? '{}')
        if (body.name === 'main') {
          return { ok: false, status: 409, text: async () => JSON.stringify({ error: 'Branch already exists: main', code: 'BRANCH_ALREADY_EXISTS' }) }
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            switchedInPlace: false,
            carriedFiles: 2,
            conflicts: [],
            created: { path: `/repo/.agents/worktrees/${body.name || 'dsh-auto'}`, branch: body.name || 'dsh-auto' },
          }),
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
  })

  const registeredSlots = []
  const localeService = {
    register: () => () => {},
    bind: () => (k, p) => (p?.branch ? `${k}:${p.branch}` : k),
    getSnapshot: () => ({ active: 'zh', revision: 1 }),
    subscribe: () => () => {},
  }
  const sessionsService = {
    create: async (opts) => { createdSessions.push(opts); return 'sess-created-wt' },
  }
  const uiWorkspaceService = {
    openSession: (id) => { openedSessions.push(id) },
  }
  const ctx = {
    locale: localeService,
    get: (key) => {
      if (key === 'locale') return localeService
      if (key === 'sessions') return sessionsService
      if (key === 'uiWorkspace') return uiWorkspaceService
      return undefined
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    slots: {
      inject: (_n, fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      register: (meta, component) => { registeredSlots.push({ meta, component }); return () => {} },
    },
  }
  loadedModule.apply(ctx)

  const headerSlot = registeredSlots.find(s => s.meta.name === 'conversation.session.header.utilities')
  const dockSlot = registeredSlots.find(s => s.meta.name === 'conversation.input.dock')
  const menuSlot = registeredSlots.find(s => s.meta.name === 'sidebar.workspaces.session.menu.item')
  assert.ok(dockSlot, 'expected conversation.input.dock restore banner slot to be registered')

  const renderHeader = () => renderAt(0, () => headerSlot.component({ sessionId: 'sess-arch-1', cwd: '/repo/.agents/worktrees/feat-1' }))
  const renderBanner = (sid = 'sess-arch-1', cwd = '/repo/.agents/worktrees/feat-1') => renderAt(140, () => dockSlot.component({ sessionId: sid, cwd }))

  renderHeader()
  renderBanner()
  await new Promise(r => setTimeout(r, 10))
  const bannerTree = renderBanner()
  const restoreBtns = findNodes(bannerTree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dshwt-btn-primary'))
  assert.equal(restoreBtns.length, 1, 'archived worktree session should show floating Restore banner in conversation.input.dock')

  // Switching to another session must immediately hide the banner on the very first frame (zero bleed!)
  assert.equal(renderBanner('sess-other-2', '/repo'), null, 'banner must never bleed into another session on switch')

  // Switching cwd when sessionId is null must also clear on frame 0 (no stale cwd flash)
  renderBanner(null, '/repo/.agents/worktrees/feat-1')
  await new Promise(r => setTimeout(r, 10))
  assert.ok(renderBanner(null, '/repo/.agents/worktrees/feat-1') !== null)
  assert.equal(renderBanner(null, '/repo-other'), null, 'cwd-only switch must clear banner on frame 0')

  // Switching sessions while an async restore is in-flight must never bleed error/clear into the new session
  renderBanner('sess-slow-1', '/repo')
  await new Promise(r => setTimeout(r, 10))
  const slowBtn = findNodes(renderBanner('sess-slow-1', '/repo'), n => n.type === 'button' && String(n.props?.className ?? '').includes('dshwt-btn-primary'))[0]
  assert.ok(slowBtn)
  slowBtn.props.onClick()
  // Switch to another archived session before slow restore settles
  renderBanner('sess-arch-2', '/repo')
  await new Promise(r => setTimeout(r, 10))
  assert.ok(rejectSlowRestore, 'expected slow restore promise to be in-flight')
  rejectSlowRestore(new Error('slow restore failed'))
  await new Promise(r => setTimeout(r, 10))
  const arch2Tree = renderBanner('sess-arch-2', '/repo')
  assert.ok(arch2Tree !== null, 'switching mid-restore must keep new session banner intact')
  assert.equal(findNodes(arch2Tree, n => n.props?.role === 'alert').length, 0, 'in-flight restore error must not bleed into newly active session')

  // Switching back to the archived session re-fetches and displays the banner again
  renderBanner('sess-arch-1', '/repo/.agents/worktrees/feat-1')
  await new Promise(r => setTimeout(r, 10))
  const reenteredBtns = findNodes(renderBanner('sess-arch-1', '/repo/.agents/worktrees/feat-1'), n => n.type === 'button' && String(n.props?.className ?? '').includes('dshwt-btn-primary'))
  assert.equal(reenteredBtns.length, 1)

  const renderMenu = () => renderAt(50, () => menuSlot.component({ sessionId: 'sess-arch-1', cwd: '/repo/.agents/worktrees/feat-1' }))

  // Before restoring: session menu shows Restore worktree (no Archive button)
  renderMenu()
  await new Promise(r => setTimeout(r, 10))
  const archivedMenuButtons = findNodes(renderMenu(), n => n.type === 'button' && n.props?.role === 'menuitem')
  assert.equal(archivedMenuButtons.length, 1, 'archived worktree session menu should show only Restore worktree')
  assert.equal(archivedMenuButtons[0].children[1], '恢复工作树')

  // Click Restore inside banner -> calls POST .../restore, hides banner, and flips top bar to quick actions
  reenteredBtns[0].props.onClick()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(renderBanner('sess-arch-1', '/repo/.agents/worktrees/feat-1'), null, 'banner should disappear after restoring')
  renderHeader()
  await new Promise(r => setTimeout(r, 10))
  const restoredTree = renderHeader()
  assert.equal(findNodes(restoredTree, n => n.type === 'button' && n.props?.className === 'dshwt-hdr-btn').length, 1)
  assert.equal(fetchCalls.filter(c => c.url.includes('/restore') && !c.url.includes('feat-slow')).length, 1)

  // After restoring: notifyEnvChanged() updates the session menu automatically -> shows only Apply changes (no Archive button)
  renderMenu()
  await new Promise(r => setTimeout(r, 10))
  const activeMenuButtons = findNodes(renderMenu(), n => n.type === 'button' && n.props?.role === 'menuitem')
  assert.equal(activeMenuButtons.length, 1, 'active worktree session menu should only show Apply changes (no Archive button)')
  assert.equal(activeMenuButtons[0].children[1], '应用改动到主目录')

  // Clicking Apply opens the native ApplyBackflowModal in shell.overlay (branch selection modal)
  const overlaySlot = registeredSlots.find(s => s.meta.name === 'shell.overlay')
  assert.equal(renderAt(100, () => overlaySlot.component()), null)
  activeMenuButtons[0].props.onClick()
  const overlayTree = renderAt(100, () => overlaySlot.component())
  assert.ok(overlayTree !== null, 'clicking Apply changes should open ApplyBackflowModal in shell.overlay')

  // Clicking Handoff on a non-worktree session opens HandoffModal directly and supports full idle-session handoff + opening chat
  const renderLocalMenu = () => renderAt(80, () => menuSlot.component({ sessionId: 'sess-local-1', cwd: '/repo' }))
  renderLocalMenu()
  await new Promise(r => setTimeout(r, 10))
  const localMenuButtons = findNodes(renderLocalMenu(), n => n.type === 'button' && n.props?.role === 'menuitem')
  assert.equal(localMenuButtons.length, 1)
  assert.equal(localMenuButtons[0].children[1], '带改动转入 Worktree')
  localMenuButtons[0].props.onClick()

  const renderOverlay = () => renderAt(200, () => overlaySlot.component())
  const handoffInitial = renderOverlay()
  assert.ok(handoffInitial !== null, 'clicking Handoff should open HandoffModal in shell.overlay')
  const handoffNode = findNodes(handoffInitial, n => typeof n.type === 'function' && n.type.name === 'HandoffModal')[0]
  assert.ok(handoffNode, 'expected HandoffModal element inside WorktreeOverlays')
  const renderHandoff = () => renderAt(240, () => handoffNode.type(handoffNode.props))

  renderHandoff()
  await new Promise(r => setTimeout(r, 10))
  const handoffLoaded = renderHandoff()
  const branchInput = findNodes(handoffLoaded, n => n.type === 'input' && n.props?.className === 'dshwt-input')[0]
  assert.ok(branchInput, 'HandoffModal should render branch name input after loading handoff-info')

  // Existing branch error should use dedicated modal.handoff.branchExists copy (not apply modal dropdown copy)
  branchInput.props.onChange({ target: { value: 'main' } })
  const dupSubmitBtn = findNodes(renderHandoff(), n => n.type === 'button' && String(n.props?.className ?? '').includes('dshwt-btn-primary'))[0]
  dupSubmitBtn.props.onClick()
  await new Promise(r => setTimeout(r, 10))
  const dupAlert = findNodes(renderHandoff(), n => n.props?.role === 'alert')[0]
  assert.equal(dupAlert?.children?.[0], 'modal.handoff.branchExists:main')

  // Valid branch name -> POST /sessions/handoff -> offers "Open chat in worktree" -> creates & opens session in created path
  const input2 = findNodes(renderHandoff(), n => n.type === 'input' && n.props?.className === 'dshwt-input')[0]
  input2.props.onChange({ target: { value: 'feat/ui-handoff' } })
  const validSubmitBtn = findNodes(renderHandoff(), n => n.type === 'button' && String(n.props?.className ?? '').includes('dshwt-btn-primary'))[0]
  validSubmitBtn.props.onClick()
  await new Promise(r => setTimeout(r, 15))
  const doneTree = renderHandoff()
  const openChatBtn = findNodes(doneTree, n => n.type === 'button' && String(n.props?.className ?? '').includes('dshwt-btn-primary'))[0]
  assert.ok(openChatBtn, 'idle handoff completion should show Open chat in worktree button')
  openChatBtn.props.onClick()
  await new Promise(r => setTimeout(r, 10))
  assert.equal(createdSessions.length, 1)
  assert.equal(createdSessions[0].cwd, '/repo/.agents/worktrees/feat/ui-handoff')
  assert.deepEqual(openedSessions, ['sess-created-wt'])
})

test('Tier 1: injects DSH_* variables only (no CODEX_* leakage) when command references DSH_WORKTREE_PATH', async () => {
  const harness = await loadHeaderHarness({
    withTerminal: true,
    withSidebarRight: true,
    actions: [{ name: 'inspect', icon: 'tool', command: 'echo "$DSH_WORKTREE_PATH"' }],
  })
  await harness.triggerPrimary()
  assert.equal(harness.terminalWrites.length, 1)
  assert.match(harness.terminalWrites[0], /DSH_WORKTREE_PATH='\/repo'/)
  assert.doesNotMatch(harness.terminalWrites[0], /CODEX_/)
})
