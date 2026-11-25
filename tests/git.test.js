/**
 * End-to-end tests of the Git-level primitives (transfer packaging, snapshot
 * archive/restore, store persistence, env capture) against real temporary
 * repositories. These exercise the same code the Host service calls.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile, access, constants } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

/** Minimal subprocess provider backed by child_process, as the Host provides. */
function fakeCtx() {
  return {
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
  }
}

async function initRepo(dir) {
  await run('git', ['init', '-q', '-b', 'main', dir])
  await run('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  await writeFile(join(dir, 'committed.txt'), 'base\n', 'utf8')
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'base'])
}

test('packageWorkingTree captures modified and untracked files without touching the index', async () => {
  const { GitRunner } = await import('../src/git.js')
  const { packageWorkingTree, applyPatches } = await import('../src/transfer.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-transfer-'))
  try {
    await initRepo(dir)
    await writeFile(join(dir, 'committed.txt'), 'modified\n', 'utf8')
    await writeFile(join(dir, 'untracked.txt'), 'brand new\n', 'utf8')
    const statusBefore = await run('git', ['-C', dir, 'status', '--porcelain'])
    const git = new GitRunner(fakeCtx())
    const packaged = await packageWorkingTree(git, dir)
    assert.ok(packaged.patch !== null)
    assert.equal(packaged.fileCount, 2)
    assert.match(packaged.patch, /modified/)
    assert.match(packaged.patch, /brand new/)
    const statusAfter = await run('git', ['-C', dir, 'status', '--porcelain'])
    assert.equal(statusAfter.stdout, statusBefore.stdout)
    // Applying the patch to a clean clone reproduces both files.
    const clone = join(dir, 'clone')
    await run('git', ['clone', '-q', dir, clone])
    await run('git', ['-C', clone, 'config', 'user.email', 'test@example.com'])
    await run('git', ['-C', clone, 'config', 'user.name', 'Test'])
    await applyPatches(git, clone, [{ name: 'handoff.patch', text: packaged.patch }])
    assert.equal(await readFile(join(clone, 'committed.txt'), 'utf8'), 'modified\n')
    assert.equal(await readFile(join(clone, 'untracked.txt'), 'utf8'), 'brand new\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot write and restore preserve uncommitted work', async () => {
  const { GitRunner } = await import('../src/git.js')
  const { writeSnapshot, restoreSnapshot, isClean, deleteSnapshot } = await import('../src/snapshot.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-snap-'))
  try {
    await initRepo(dir)
    const git = new GitRunner(fakeCtx())
    await writeFile(join(dir, 'committed.txt'), 'work in flight\n', 'utf8')
    await writeFile(join(dir, 'scratch.txt'), 'uncommitted\n', 'utf8')
    assert.equal(await isClean(git, dir), false)
    const snapshot = await writeSnapshot(git, dir, 'test-branch')
    assert.match(snapshot.ref, /^refs\/dsh-worktree-env\/snapshots\/test-branch$/)
    // Simulate losing the working state.
    await run('git', ['-C', dir, 'checkout', '-q', '--', '.'])
    await rm(join(dir, 'scratch.txt'), { force: true })
    assert.equal(await isClean(git, dir), true)
    const restored = await restoreSnapshot(git, dir, snapshot.ref)
    assert.deepEqual(restored, { applied: true })
    assert.equal(await readFile(join(dir, 'committed.txt'), 'utf8'), 'work in flight\n')
    assert.equal(await readFile(join(dir, 'scratch.txt'), 'utf8'), 'uncommitted\n')
    await deleteSnapshot(git, dir, snapshot.ref)
    const refs = await run('git', ['-C', dir, 'for-each-ref', 'refs/dsh-worktree-env/snapshots'])
    assert.equal(refs.stdout.trim(), '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('nestedRepositoryFindings blocks archives of nested repos', async () => {
  const { GitRunner } = await import('../src/git.js')
  const { nestedRepositoryFindings } = await import('../src/snapshot.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-nested-'))
  try {
    await initRepo(dir)
    const nested = join(dir, 'vendor', 'dep')
    await mkdir(nested, { recursive: true })
    await run('git', ['init', '-q', nested])
    const git = new GitRunner(fakeCtx())
    const findings = await nestedRepositoryFindings(git, dir)
    assert.ok(findings.length > 0)
    assert.ok(findings.some(f => f.includes('nested repository')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('RepoStore persists records and env captures', async () => {
  const { RepoStore } = await import('../src/store.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-store-'))
  try {
    const store = new RepoStore(dir)
    await store.put({
      id: '/tmp/x', path: '/tmp/x', branch: 'dsh-a', baseCommit: 'c0', repositoryRoot: '/tmp',
      status: 'active', createdAt: 1, lastAccessedAt: 2, createdSessionId: null,
      setupState: 'none', setupError: null, snapshotRef: null, archivedAt: null,
    })
    await store.writeEnv('dsh-a', { PATH_EXTRA: '/opt/bin', QUOTED: "it's" })
    const reopened = new RepoStore(dir)
    const records = await reopened.list()
    assert.equal(records.length, 1)
    assert.equal(records[0].branch, 'dsh-a')
    const env = await reopened.readEnv('dsh-a')
    assert.deepEqual(env, { PATH_EXTRA: '/opt/bin', QUOTED: "it's" })
    await reopened.patch(records[0].id, { status: 'archived', snapshotRef: 'refs/dsh-worktree/snapshots/dsh-a' })
    assert.equal((await reopened.get('/tmp/x')).status, 'archived')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('diffCapturedEnv keeps only new, non-sensitive, non-volatile keys', async () => {
  const { diffCapturedEnv } = await import('../src/env-runner.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-envdiff-'))
  try {
    await writeFile(join(dir, 'before.env'), 'PATH=/usr/bin\0OLDPWD=/a\0API_KEY=secret\0DSH_WORKTREE_PATH=/x\0KEEP=1\0', 'utf8')
    await writeFile(join(dir, 'after.env'), 'PATH=/usr/bin\0PWD=/b\0API_KEY=secret\0DSH_WORKTREE_PATH=/x\0KEEP=2\0NEW_TOKEN=nope\0ADDED=yes\0', 'utf8')
    const delta = await diffCapturedEnv(dir)
    assert.deepEqual(delta, { KEEP: '2', ADDED: 'yes' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('backflowPatch deduplicates tracked+uncommitted edits and applies cleanly in both modes', async () => {
  const { GitRunner } = await import('../src/git.js')
  const { backflowPatch, precheckPatches, applyPatches } = await import('../src/transfer.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-back-'))
  try {
    await initRepo(dir)
    const worktree = join(dir, 'wt')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feature', worktree])
    const git = new GitRunner(fakeCtx())
    const base = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    // committed change on the branch
    await writeFile(join(worktree, 'committed.txt'), 'committed change\n', 'utf8')
    await run('git', ['-C', worktree, 'add', '-A'])
    await run('git', ['-C', worktree, 'commit', '-q', '-m', 'work'])
    // further uncommitted edit to the SAME tracked file + an untracked file
    await writeFile(join(worktree, 'committed.txt'), 'committed + uncommitted\n', 'utf8')
    await writeFile(join(worktree, 'uncommitted.txt'), 'later\n', 'utf8')

    // branch mode: single deduplicated patch covering committed + uncommitted + untracked
    const branch = await backflowPatch(git, { path: worktree, baseCommit: base }, 'branch')
    assert.equal(branch.patches.length, 1)
    assert.equal(branch.fileCount, 2)
    const cleanTarget = join(dir, 'target-branch')
    await run('git', ['clone', '-q', dir, cleanTarget])
    const precheck = await precheckPatches(git, cleanTarget, branch.patches)
    assert.equal(precheck.ok, true)
    await applyPatches(git, cleanTarget, branch.patches)
    assert.equal(await readFile(join(cleanTarget, 'committed.txt'), 'utf8'), 'committed + uncommitted\n')
    assert.equal(await readFile(join(cleanTarget, 'uncommitted.txt'), 'utf8'), 'later\n')

    // uncommitted mode: single deduplicated patch covering tracked uncommitted edit + untracked file
    const uncommitted = await backflowPatch(git, { path: worktree, baseCommit: base }, 'uncommitted')
    assert.equal(uncommitted.patches.length, 1)
    assert.equal(uncommitted.fileCount, 2)
    const headTarget = join(dir, 'target-uncommitted')
    await run('git', ['clone', '-q', '-b', 'feature', dir, headTarget])
    const precheckUncommitted = await precheckPatches(git, headTarget, uncommitted.patches)
    assert.equal(precheckUncommitted.ok, true)
    await applyPatches(git, headTarget, uncommitted.patches)
    assert.equal(await readFile(join(headTarget, 'committed.txt'), 'utf8'), 'committed + uncommitted\n')
    assert.equal(await readFile(join(headTarget, 'uncommitted.txt'), 'utf8'), 'later\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
