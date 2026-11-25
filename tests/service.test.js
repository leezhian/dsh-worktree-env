/**
 * Regression tests for WorktreeEnhanceService:
 * - listAll preserves recorded baseCommit after new branch commits
 * - per-repository preference persists across RepoStore reloads
 * - setup failure does not capture partial env delta
 * - restore resets setupState rather than hardcoding 'succeeded'
 * - per-repository git write serialization
 * - session-stop cancels only operations belonging to that session's worktree
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeEnhanceService } from '../src/service.js'
import { normalizeConfig } from '../src/index.js'
import { writeEnvConfig } from '../src/env-config.js'
import { storeOf } from '../src/store.js'

const run = promisify(execFile)

function makeCtx(extra = {}) {
  return {
    get: (key) => extra[key],
    subprocess: {
      resolveExecutable: async (command) => command,
      spawn: (spec) => {
        const env = { ...process.env }
        for (const [key, value] of Object.entries(spec.env ?? {})) {
          if (value === undefined) delete env[key]
          else env[key] = value
        }
        const child = execFile(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, signal: spec.signal, maxBuffer: 64 * 1024 * 1024 }, () => {})
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          collected: {},
          done: new Promise((resolve, reject) => {
            child.on('error', reject)
            child.on('close', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }))
          }),
          terminate: () => { if (child.exitCode === null) child.kill('SIGTERM') },
          waitForExit: async () => true,
        }
      },
    },
    workingDirectory: {
      get: () => undefined,
      ensure: async () => undefined,
      set: async (_agent, path) => path,
    },
  }
}

async function initRepo(dir) {
  await run('git', ['init', '-q', '-b', 'main', dir])
  await run('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  await writeFile(join(dir, 'file.txt'), 'v1\n', 'utf8')
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init'])
}

test('listAll preserves baseCommit after new commits so branch backflow still works', async () => {
  const rawDir = await mkdtemp(join(tmpdir(), 'dsh-wtenv-base-'))
  const dir = await realpath(rawDir)
  try {
    await initRepo(dir)
    const baseCommit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    const wtPath = join(dir, '.agents', 'worktrees', 'feat-1')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feat-1', wtPath])

    const service = new WorktreeEnhanceService(makeCtx(), normalizeConfig({ autoRunSetup: false }))
    await service.registerCreated({ path: wtPath, branch: 'feat-1', baseCommit, repositoryRoot: dir }, { runSetup: false })

    // Commit a change inside the worktree so HEAD advances beyond baseCommit
    await writeFile(join(wtPath, 'file.txt'), 'v2-committed\n', 'utf8')
    await run('git', ['-C', wtPath, 'add', '-A'])
    await run('git', ['-C', wtPath, 'commit', '-q', '-m', 'advance'])

    // listAll must NOT overwrite baseCommit with the new HEAD
    const listed = await service.listAll()
    const item = listed.items.find(i => i.path === wtPath)
    assert.ok(item)
    assert.equal(item.baseCommit, baseCommit)

    // Backflow in branch mode must still carry the committed change back to source
    const backflow = await service.applyBackflow(wtPath, { mode: 'branch', dryRun: false })
    assert.equal(backflow.applied, true)
    assert.equal(backflow.fileCount, 1)
    assert.equal(await readFile(join(dir, 'file.txt'), 'utf8'), 'v2-committed\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('setPreference persists per-repository policy to disk', async () => {
  const rawDir = await mkdtemp(join(tmpdir(), 'dsh-wtenv-pref-'))
  const dir = await realpath(rawDir)
  try {
    await initRepo(dir)
    const service = new WorktreeEnhanceService(makeCtx(), normalizeConfig({ defaultCreationPreference: 'ask' }))
    assert.equal(await service.preferenceFor(dir), 'ask')
    await service.setPreference(dir, 'dirty')
    assert.equal(await service.preferenceFor(dir), 'dirty')

    // Reload store from disk to verify durability
    const commonDir = (await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
    const store = storeOf(commonDir)
    await store.load({ force: true })
    assert.equal(await store.getPreference(), 'dirty')

    // Clearing override returns to global default
    await service.setPreference(dir, null)
    assert.equal(await service.preferenceFor(dir), 'ask')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed setup script does not capture partial env delta; restore resets setupState', async () => {
  const rawDir = await mkdtemp(join(tmpdir(), 'dsh-wtenv-setup-'))
  const dir = await realpath(rawDir)
  try {
    await initRepo(dir)
    await writeEnvConfig(join(dir, '.agents', 'environments', 'environment.toml'), {
      name: 'FailTest',
      setupScripts: { top: 'export SHOULD_NOT_SAVE=oops\nexit 1' },
    })
    const baseCommit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    const wtPath = join(dir, '.agents', 'worktrees', 'feat-fail')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feat-fail', wtPath])

    const service = new WorktreeEnhanceService(makeCtx(), normalizeConfig({ autoRunSetup: false, autoRunCleanup: false }))
    await service.registerCreated({ path: wtPath, branch: 'feat-fail', baseCommit, repositoryRoot: dir }, { runSetup: false })

    const res = await service.runSetup(wtPath)
    assert.equal(res.status, 'failed')
    assert.equal(res.capturedEnvCount, 0)

    // Archive and restore: setupState must NOT be hardcoded to 'succeeded'
    await service.archive(wtPath)
    const restored = await service.restore(wtPath, undefined, undefined, { runSetup: false })
    assert.equal(restored.restored, true)
    assert.equal(restored.setupPending, true)
    const rec = await service.requireRecord(wtPath)
    assert.equal(rec.setupState, 'none')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('GitRunner.serialized executes concurrent tasks sequentially per repository key', async () => {
  const { GitRunner } = await import('../src/git.js')
  const git = new GitRunner(makeCtx())
  const trace = []
  await Promise.all([
    git.serialized('repo-a', async () => {
      trace.push('start-1')
      await new Promise(r => setTimeout(r, 30))
      trace.push('end-1')
    }),
    git.serialized('repo-a', async () => {
      trace.push('start-2')
      trace.push('end-2')
    }),
  ])
  assert.deepEqual(trace, ['start-1', 'end-1', 'start-2', 'end-2'])
})

test('updateConfig syncs relative worktreeDirectory to built-in configEditor, rejects invalid paths, and enforceQuota preserves pinned sessions', async () => {
  const rawDir = await mkdtemp(join(tmpdir(), 'dsh-wtenv-cfg-'))
  const dir = await realpath(rawDir)
  try {
    await initRepo(dir)
    const baseCommit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    const wtPinned = join(dir, '.agents', 'worktrees', 'wt-pinned')
    const wtRegular = join(dir, '.agents', 'worktrees', 'wt-regular')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'wt-pinned', wtPinned])
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'wt-regular', wtRegular])

    const nativeEntry = {
      options: { id: 'worktree', name: '@deepseek-ai/dsh-experimental-worktree', config: {} },
      fiber: { config: { directory: '.agents/worktrees' } },
    }
    const ctx = makeCtx({
      workspaceRegistry: {
        list: () => [{ path: dir }],
        pinnedSessionIds: ['sess-pinned'],
      },
      configEditor: {
        entries: () => [nativeEntry],
        edit: async (entry, change) => {
          const next = change(entry.options.config, {})
          entry.options.config = next
          entry.fiber.config.directory = next.directory ?? '.agents/worktrees'
        },
      },
    })
    const service = new WorktreeEnhanceService(ctx, normalizeConfig({ autoRunSetup: false, autoRunCleanup: false, keepCount: 1 }))
    const cfgPath = join(dir, 'persisted-config.json')

    // Rejects absolute paths and parent traversal just like built-in worktree module
    await assert.rejects(
      () => service.updateConfig({ worktreeDirectory: '/tmp/outside' }, { configFilePath: cfgPath }),
      (err) => err?.code === 'INVALID_WORKTREE_DIRECTORY' && err?.status === 400,
    )
    await assert.rejects(
      () => service.updateConfig({ worktreeDirectory: '../outside' }, { configFilePath: cfgPath }),
      (err) => err?.code === 'INVALID_WORKTREE_DIRECTORY' && err?.status === 400,
    )

    // Accepts relative directory and syncs directly to the built-in worktree entry
    await service.updateConfig({
      worktreeDirectory: '.worktrees',
      upstreamRefreshMode: 'best-effort',
      autoCleanupEnabled: true,
      keepCount: 1,
      confirmBeforeDelete: false,
    }, { configFilePath: cfgPath })
    assert.equal(nativeEntry.options.config.directory, '.worktrees')
    assert.equal(service.worktreeDirectoryState().worktreeDirectory, '.worktrees')
    assert.equal(service.worktreeDirectoryState().nativeSynced, true)

    const saved = JSON.parse(await readFile(cfgPath, 'utf8'))
    assert.deepEqual(saved, {
      worktreeDirectory: '.worktrees',
      upstreamRefreshMode: 'best-effort',
      autoCleanupEnabled: true,
      keepCount: 1,
      confirmBeforeDelete: false,
    })

    // Toggling autoCleanupEnabled off persists and pauses quota cleanup
    await service.updateConfig({ autoCleanupEnabled: false }, { configFilePath: cfgPath })
    assert.equal(JSON.parse(await readFile(cfgPath, 'utf8')).autoCleanupEnabled, false)
    assert.deepEqual(await service.enforceQuota(), { archived: 0 })
    await service.updateConfig({ autoCleanupEnabled: true }, { configFilePath: cfgPath })

    // Clearing resets built-in override back to default (.agents/worktrees)
    await service.updateConfig({ worktreeDirectory: '' }, { configFilePath: cfgPath })
    assert.equal(nativeEntry.options.config.directory, undefined)
    assert.equal(service.worktreeDirectoryState().worktreeDirectory, '')

    await service.registerCreated({ path: wtPinned, branch: 'wt-pinned', baseCommit, repositoryRoot: dir, sessionId: 'sess-pinned' }, { runSetup: false })
    await service.registerCreated({ path: wtRegular, branch: 'wt-regular', baseCommit, repositoryRoot: dir, sessionId: 'sess-regular' }, { runSetup: false })
    // Make wtPinned older so it would normally be evicted first if not pinned
    const commonDir = (await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
    const store = storeOf(commonDir)
    await store.patch(wtPinned, { lastAccessedAt: 100 })
    await store.patch(wtRegular, { lastAccessedAt: 200 })

    const result = await service.enforceQuota()
    assert.equal(result.archived, 0)
    assert.equal((await store.get(wtPinned)).status, 'active')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listEnvironmentProjects lists workspaces with remote owner and supports multi-file environment read/write', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wt-envproj-')))
  try {
    await initRepo(dir)
    await run('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme-org/demo-app.git'])
    const ctx = makeCtx({ workspaceRegistry: { list: () => [{ path: dir }] } })
    const service = new WorktreeEnhanceService(ctx, normalizeConfig({}))

    const before = await service.listEnvironmentProjects()
    assert.equal(before.projects.length, 1)
    assert.equal(before.projects[0].owner, 'acme-org')
    assert.equal(before.projects[0].environments.length, 0)

    const target1 = before.projects[0].nextConfigPath
    await service.writeEnvironment(dir, { name: 'demo-app', setupScripts: { top: 'npm install' } }, target1)

    const after1 = await service.listEnvironmentProjects()
    assert.equal(after1.projects[0].environments.length, 1)
    assert.equal(after1.projects[0].environments[0].name, 'demo-app')
    assert.equal(after1.projects[0].environments[0].fileName, 'environment.toml')

    // Reject path outside .agents/environments
    await assert.rejects(
      () => service.writeEnvironment(dir, { name: 'bad' }, join(dir, 'evil.toml')),
      /configPath must point/,
    )

    const target2 = after1.projects[0].nextConfigPath
    await service.writeEnvironment(dir, { name: 'demo-staging', setupScripts: { top: 'pnpm i' } }, target2)
    const read2 = await service.readEnvironment(dir, target2)
    assert.equal(read2.environment.name, 'demo-staging')
    assert.equal(read2.environment.setupScripts.top, 'pnpm i')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listAll scans only DSH-created worktrees and prunes foreign worktrees', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wt-onlydsh-')))
  const externalDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wt-codex-')))
  try {
    await initRepo(dir)
    const dshWt = join(dir, '.agents', 'worktrees', 'dsh-feat')
    const customWt = join(dir, '.worktrees', 'dsh-custom')
    const foreignWt = join(externalDir, 'a011')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'dsh-feat', dshWt])
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'dsh-custom', customWt])
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'codex-a011', foreignWt])

    // Seed a legacy auto-adopted foreign record (without origin / createdSessionId) to verify pruning
    const commonDir = (await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
    const store = storeOf(commonDir)
    await store.put({
      id: foreignWt, path: foreignWt, branch: 'codex-a011', baseCommit: 'unknown',
      repositoryRoot: dir, status: 'active', createdAt: 1, lastAccessedAt: 1,
      createdSessionId: null, setupState: 'not-configured', setupError: null, snapshotRef: null, archivedAt: null,
    })

    const ctx = makeCtx({ workspaceRegistry: { list: () => [{ path: dir }] } })
    const service = new WorktreeEnhanceService(ctx, normalizeConfig({ worktreeDirectory: '.worktrees' }))
    const listed = await service.listAll()
    const paths = listed.items.map(i => i.path).sort()
    assert.deepEqual(paths, [dshWt, customWt].sort())
    assert.equal(await store.get(foreignWt), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(externalDir, { recursive: true, force: true })
  }
})

test('sessionActions and startActionForDirectory work in both regular repos and managed worktrees', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wt-sessact-')))
  try {
    await initRepo(dir)
    await writeEnvConfig(join(dir, '.agents', 'environments', 'environment.toml'), {
      name: 'DemoEnv',
      actions: [
        { name: 'hello', icon: 'run', command: 'echo hi-from-action', platform: null },
      ],
    })
    const service = new WorktreeEnhanceService(makeCtx(), normalizeConfig({ autoRunSetup: false }))

    // 1. Regular project checkout (not a worktree)
    const localInfo = await service.sessionActions(undefined, dir)
    assert.equal(localInfo.inWorktree, false)
    assert.equal(localInfo.actions.length, 1)
    assert.equal(localInfo.actions[0].name, 'hello')

    const { operationId } = await service.startActionForDirectory(dir, 'hello')
    assert.ok(operationId)
    // Wait briefly for echo to finish
    for (let i = 0; i < 40; i += 1) {
      if (service.runner.get(operationId)?.status !== 'running') break
      await new Promise(r => setTimeout(r, 25))
    }
    const op = service.runner.get(operationId)
    assert.equal(op.status, 'succeeded')
    assert.match(op.logs.map(l => l.text).join(''), /hi-from-action/)

    // 2. Managed worktree resolved via live agent sessionId
    const baseCommit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    const wtPath = join(dir, '.agents', 'worktrees', 'feat-act')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feat-act', wtPath])
    const fakeSession = { header: { id: 'sess-live-1', cwd: dir } }
    const ctxWithAgent = makeCtx({
      agents: { list: () => [{ session: fakeSession }] },
    })
    ctxWithAgent.workingDirectory.get = (s) => (s === fakeSession ? wtPath : undefined)
    const wtService = new WorktreeEnhanceService(ctxWithAgent, normalizeConfig({ autoRunSetup: false }))
    await wtService.registerCreated({ path: wtPath, branch: 'feat-act', baseCommit, repositoryRoot: dir, sessionId: 'sess-live-1' }, { runSetup: false })

    const wtInfo = await wtService.sessionActions('sess-live-1', undefined)
    assert.equal(wtInfo.inWorktree, true)
    assert.equal(wtInfo.branch, 'feat-act')
    assert.equal(wtInfo.actions.length, 1)
    assert.equal(wtInfo.actions[0].name, 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('handleSessionArchived snapshots dirty worktree, reopened session auto-detects archived worktree, and restore recovers work losslessly', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wt-reopen-')))
  try {
    await initRepo(dir)
    await writeEnvConfig(join(dir, '.agents', 'environments', 'environment.toml'), {
      name: 'RestoreDemo',
      actions: [{ name: 'dev', icon: 'run', command: 'echo dev', platform: null }],
    })
    const baseCommit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    const wtPath = join(dir, '.agents', 'worktrees', 'feat-snap')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feat-snap', wtPath])

    // Uncommitted edit + untracked file inside the worktree
    await writeFile(join(wtPath, 'file.txt'), 'wip-edit\n', 'utf8')
    await writeFile(join(wtPath, 'draft.txt'), 'untracked-wip\n', 'utf8')

    const ctx = makeCtx({ workspaceRegistry: { list: () => [{ path: dir }], pinnedSessionIds: [] } })
    const service = new WorktreeEnhanceService(ctx, normalizeConfig({ autoRunSetup: false, autoRunCleanup: false, keepCount: 15 }))
    await service.registerCreated({ path: wtPath, branch: 'feat-snap', baseCommit, repositoryRoot: dir, sessionId: 'sess-old-1' }, { runSetup: false })

    // Archiving the session snapshots uncommitted changes and frees the worktree directory
    const res = await service.handleSessionArchived('sess-old-1')
    assert.equal(res.archived, 1)
    const archivedRec = await service.requireRecord(wtPath)
    assert.equal(archivedRec.status, 'archived')
    assert.ok(archivedRec.snapshotRef, 'expected hidden recovery snapshot ref')

    // Cold service (no in-memory commonDirs) reopening the old session auto-detects the archived worktree
    const coldService = new WorktreeEnhanceService(makeCtx(), normalizeConfig({ autoRunSetup: false, autoRunCleanup: false }))
    const reopened = await coldService.sessionActions('sess-old-1', wtPath)
    assert.equal(reopened.inWorktree, true)
    assert.ok(reopened.archivedWorktree, 'reopened session should detect archivedWorktree')
    assert.equal(reopened.archivedWorktree.id, wtPath)
    assert.equal(reopened.archivedWorktree.branch, 'feat-snap')
    assert.equal(reopened.archivedWorktree.hasSnapshot, true)

    // Restoring recovers both edited and untracked files, removes consumed snapshot ref, and restores actions
    const restored = await coldService.restore(wtPath, undefined, undefined, { runSetup: false })
    assert.equal(restored.restored, true)
    assert.equal(restored.snapshotRestored?.applied, true)
    assert.equal(await readFile(join(wtPath, 'file.txt'), 'utf8'), 'wip-edit\n')
    assert.equal(await readFile(join(wtPath, 'draft.txt'), 'utf8'), 'untracked-wip\n')

    const refsAfter = (await run('git', ['-C', dir, 'for-each-ref', 'refs/dsh-worktree-env/snapshots'])).stdout.trim()
    assert.equal(refsAfter, '', 'consumed snapshot ref should be cleaned up after lossless restore')

    const activeAgain = await coldService.sessionActions('sess-old-1', wtPath)
    assert.equal(activeAgain.archivedWorktree, null)
    assert.equal(activeAgain.actions.length, 1)
    assert.equal(activeAgain.actions[0].name, 'dev')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('backflowInfo and applyBackflow support target branch selection, dirty-source protection, ref precheck, and new branch creation', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wt-branchsel-')))
  try {
    await initRepo(dir)
    const baseCommit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    // Create a worktree 'feat-login' from main and modify a file there
    const wtPath = join(dir, '.agents', 'worktrees', 'feat-login')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feat-login', wtPath])
    await writeFile(join(wtPath, 'login.txt'), 'login-feature\n', 'utf8')

    // Switch main directory to 'feat-logout' (different branch!) and leave uncommitted edit
    await run('git', ['-C', dir, 'checkout', '-q', '-b', 'feat-logout'])
    await writeFile(join(dir, 'logout.txt'), 'wip-logout\n', 'utf8')

    const service = new WorktreeEnhanceService(makeCtx(), normalizeConfig({ autoRunSetup: false }))
    await service.registerCreated({ path: wtPath, branch: 'feat-login', baseCommit, repositoryRoot: dir }, { runSetup: false })

    // 1. backflowInfo reports currentBranch='feat-logout', sourceDirty=true, excludes 'feat-login' (locked by worktree)
    const info = await service.backflowInfo(wtPath)
    assert.equal(info.currentBranch, 'feat-logout')
    assert.equal(info.sourceDirty, true)
    assert.equal(info.sourceDirtyCount, 1)
    assert.deepEqual(info.branches, ['feat-logout', 'main'])

    // 2. Trying to switch to 'main' while 'feat-logout' is dirty is blocked safely
    const blocked = await service.applyBackflow(wtPath, { mode: 'branch', dryRun: true, targetBranch: 'main' })
    assert.equal(blocked.applied, false)
    assert.equal(blocked.blockedReason, 'SOURCE_DIRTY_CANNOT_SWITCH')

    // Commit 'logout.txt' on feat-logout so main checkout becomes clean (ignoring .agents/worktrees)
    await run('git', ['-C', dir, 'add', 'logout.txt'])
    await run('git', ['-C', dir, 'commit', '-q', '-m', 'logout wip'])

    // 3. Dry-run precheck against 'main' must NOT switch main directory off 'feat-logout'
    const dry = await service.applyBackflow(wtPath, { mode: 'branch', dryRun: true, targetBranch: 'main' })
    assert.equal(dry.applied, false)
    assert.equal(dry.fileCount, 1)
    assert.deepEqual(dry.conflicts, [])
    assert.equal(dry.willSwitchBranch, true)
    assert.equal((await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'feat-logout')

    // 4. Actual apply to 'main' switches main checkout to 'main' and applies login.txt cleanly
    const appliedMain = await service.applyBackflow(wtPath, { mode: 'branch', dryRun: false, targetBranch: 'main' })
    assert.equal(appliedMain.applied, true)
    assert.equal(appliedMain.targetBranch, 'main')
    assert.equal(appliedMain.switchedBranch, true)
    assert.equal((await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main')
    assert.equal(await readFile(join(dir, 'login.txt'), 'utf8'), 'login-feature\n')

    // 5. Reset applied login.txt (git apply --3way stages new files) and test creating a brand new target branch
    await run('git', ['-C', dir, 'reset', '--hard', '-q', 'HEAD'])
    const dup = await service.applyBackflow(wtPath, { mode: 'branch', dryRun: true, targetBranch: 'main', createBranch: true })
    assert.equal(dup.blockedReason, 'BRANCH_ALREADY_EXISTS')
    const appliedNew = await service.applyBackflow(wtPath, { mode: 'branch', dryRun: false, targetBranch: 'feat/login-local', createBranch: true })
    assert.equal(appliedNew.applied, true)
    assert.equal(appliedNew.createdBranch, true)
    assert.equal((await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'feat/login-local')
    assert.equal(await readFile(join(dir, 'login.txt'), 'utf8'), 'login-feature\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unarchiving cancels pending archive cleanup and clean worktrees removed by DSH built-in cleanup remain restorable', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wt-unarch-')))
  try {
    await initRepo(dir)
    const baseCommit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    const wtPath = join(dir, '.agents', 'worktrees', 'feat-clean')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feat-clean', wtPath])

    const ctx = makeCtx({ workspaceRegistry: { list: () => [{ path: dir }], pinnedSessionIds: [] } })
    const service = new WorktreeEnhanceService(ctx, normalizeConfig({ autoRunSetup: false, autoRunCleanup: false }))
    await service.registerCreated({ path: wtPath, branch: 'feat-clean', baseCommit, repositoryRoot: dir, sessionId: 'sess-u1' }, { runSetup: false })

    // 1. Unarchiving aborts handleSessionArchived before removing the worktree
    service.markSessionUnarchiving('sess-u1')
    const aborted = await service.handleSessionArchived('sess-u1')
    assert.equal(aborted.cancelled, true)
    assert.equal(aborted.archived, 0)
    assert.equal((await service.requireRecord(wtPath)).status, 'active')

    // 2. Simulate DSH built-in cleanup removing a clean checkout before our plugin runs
    await run('git', ['-C', dir, 'worktree', 'remove', wtPath])
    const reopened = await service.sessionActions('sess-u1', wtPath)
    assert.ok(reopened.archivedWorktree, 'clean checkout removed by built-in cleanup should still be auto-detected for restore')
    assert.equal(reopened.archivedWorktree.branch, 'feat-clean')
    assert.equal(reopened.archivedWorktree.hasSnapshot, false)

    // Restore brings the checkout back cleanly
    const restored = await service.restore(wtPath, undefined, undefined, { runSetup: false })
    assert.equal(restored.restored, true)
    assert.equal(await readFile(join(wtPath, 'file.txt'), 'utf8'), 'v1\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
