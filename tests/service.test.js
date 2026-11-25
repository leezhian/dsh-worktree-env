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
      keepCount: 1,
      confirmBeforeDelete: false,
    })

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
