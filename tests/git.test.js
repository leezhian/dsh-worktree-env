/**
 * End-to-end tests of the Git-level primitives (transfer packaging, snapshot
 * archive/restore, store persistence, env capture) against real temporary
 * repositories. These exercise the same code the Host service calls.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo as initBaseRepo, makeCtx, run } from './_helpers.js'

const fakeCtx = makeCtx
const initRepo = (dir) => initBaseRepo(dir, 'committed.txt', 'base\n')

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

test('precheckPatches and precheckPatchesOnRef accurately detect 3-way conflicts and clean cross-branch tracked edits', async () => {
  const { GitRunner } = await import('../src/git.js')
  const { backflowPatch, precheckPatches, precheckPatchesOnRef } = await import('../src/transfer.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-3way-'))
  try {
    await initRepo(dir)
    await writeFile(join(dir, 'committed.txt'), 'line1\nline2\nline3\nline4\nline5\n', 'utf8')
    await run('git', ['-C', dir, 'commit', '-aq', '-m', 'multiline'])
    const base = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()

    // Branch `clean-other` edits line 5 (non-overlapping with worktree's line 2 edit)
    await run('git', ['-C', dir, 'checkout', '-q', '-b', 'clean-other'])
    await writeFile(join(dir, 'committed.txt'), 'line1\nline2\nline3\nline4\nother5\n', 'utf8')
    await run('git', ['-C', dir, 'commit', '-aq', '-m', 'clean-other'])

    // Branch `main` edits line 2 (overlapping conflict with worktree's line 2 edit)
    await run('git', ['-C', dir, 'checkout', '-q', 'main'])
    await writeFile(join(dir, 'committed.txt'), 'line1\nmain2\nline3\nline4\nline5\n', 'utf8')
    await run('git', ['-C', dir, 'commit', '-aq', '-m', 'main-conflict'])

    const worktree = join(dir, '.agents', 'worktrees', 'feat-edit')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feat-edit', worktree, base])
    await writeFile(join(worktree, 'committed.txt'), 'line1\nfeat2\nline3\nline4\nline5\n', 'utf8')
    await run('git', ['-C', worktree, 'commit', '-aq', '-m', 'feat-edit'])

    const git = new GitRunner(fakeCtx())
    const commonDir = (await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
    const { patches, files } = await backflowPatch(git, { path: worktree, baseCommit: base }, 'branch')

    // 1. Conflicting 3-way merge on current checkout MUST fail precheck (even though git apply --check --3way exits 0)
    const conflictCheck = await precheckPatches(git, dir, patches)
    assert.equal(conflictCheck.ok, false)
    assert.ok(conflictCheck.conflicts.some(c => c.includes('committed.txt')))
    assert.equal(await readFile(join(dir, 'committed.txt'), 'utf8'), 'line1\nmain2\nline3\nline4\nline5\n', 'precheck must not write conflict markers')

    // 2. Clean 3-way merge on another branch (`clean-other`) MUST succeed (stat cache refreshed after checkout-index)
    const refClean = await precheckPatchesOnRef(git, commonDir, 'refs/heads/clean-other', patches, files)
    assert.equal(refClean.ok, true, `expected clean ref precheck, got conflicts: ${refClean.conflicts.join('; ')}`)

    // 3. Conflicting 3-way merge on `main` via precheckPatchesOnRef MUST report conflict
    const refConflict = await precheckPatchesOnRef(git, commonDir, 'refs/heads/main', patches, files)
    assert.equal(refConflict.ok, false)
    assert.ok(refConflict.conflicts.some(c => c.includes('committed.txt')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('packageWorkingTree excludes .agents/worktrees even without .gitignore', async () => {
  const { GitRunner } = await import('../src/git.js')
  const { packageWorkingTree } = await import('../src/transfer.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-excl-'))
  try {
    await initRepo(dir)
    const wtPath = join(dir, '.agents', 'worktrees', 'existing-wt')
    await run('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'existing-wt', wtPath])
    await writeFile(join(dir, 'real-edit.txt'), 'hello\n', 'utf8')

    const git = new GitRunner(fakeCtx())
    const packaged = await packageWorkingTree(git, dir)
    assert.equal(packaged.fileCount, 1)
    assert.deepEqual(packaged.files, ['real-edit.txt'])
    assert.doesNotMatch(packaged.patch ?? '', /\.agents\/worktrees/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('nestedRepositoryFindings ignores uninitialized submodules while blocking initialized ones', async () => {
  const { GitRunner } = await import('../src/git.js')
  const { nestedRepositoryFindings } = await import('../src/snapshot.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-submod-'))
  try {
    const subRepo = join(dir, 'sub-origin')
    await initRepo(subRepo)
    const mainRepo = join(dir, 'main-repo')
    await initRepo(mainRepo)
    await run('git', ['-C', mainRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRepo, 'libs/sub'])
    await run('git', ['-C', mainRepo, 'commit', '-aq', '-m', 'add sub'])

    // A fresh linked worktree has the submodule UNINITIALIZED (`-` prefix in `git submodule status`)
    const wtPath = join(dir, 'wt-uninit')
    await run('git', ['-C', mainRepo, 'worktree', 'add', '-q', '-b', 'wt-uninit', wtPath])

    const git = new GitRunner(fakeCtx())
    const uninitFindings = await nestedRepositoryFindings(git, wtPath)
    assert.deepEqual(uninitFindings, [], 'uninitialized submodule should not block archive')

    // Once initialized inside the worktree, it MUST block archive
    await run('git', ['-C', wtPath, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])
    const initFindings = await nestedRepositoryFindings(git, wtPath)
    assert.ok(initFindings.length > 0, 'initialized submodule must block archive')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('RepoStore.writeEnv exports variables for POSIX child processes and EnvRunner scrubs host API keys', async () => {
  const { RepoStore } = await import('../src/store.js')
  const { EnvRunner } = await import('../src/env-runner.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-envexp-'))
  const prevKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'sk-host-secret-must-not-leak'
  try {
    const store = new RepoStore(dir)
    await store.writeEnv('feat', { CUSTOM_VAR: 'propagated-value' })
    const raw = await readFile(store.envFile('feat'), 'utf8')
    assert.match(raw, /^export CUSTOM_VAR='propagated-value'$/m)

    // Sourcing the file in /bin/sh propagates CUSTOM_VAR into a child process
    const res = await run('/bin/sh', ['-c', `. '${store.envFile('feat')}' && /bin/sh -c 'printf "%s" "$CUSTOM_VAR"'`])
    assert.equal(res.stdout, 'propagated-value')

    // EnvRunner scrubs DEEPSEEK_API_KEY from child scripts
    const runner = new EnvRunner()
    const op = runner.begin('action', 'scrub-check', dir)
    const outcome = await runner.runScript({
      ctx: fakeCtx(),
      operation: op,
      cwd: dir,
      script: 'printf "LEAK=%s\\n" "$DEEPSEEK_API_KEY"',
    })
    assert.equal(outcome.status, 'succeeded')
    const outText = op.logs.map(l => l.text).join('')
    assert.match(outText, /LEAK=\n/)
    assert.doesNotMatch(outText, /sk-host-secret/)
  } finally {
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prevKey
    await rm(dir, { recursive: true, force: true })
  }
})
