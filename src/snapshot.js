/**
 * Lossless snapshot archiving: before a worktree with uncommitted changes is
 * released, its complete working-tree state is committed to a hidden ref under
 * `refs/dsh-worktree/snapshots/`, so the checkout can be recreated later with
 * the uncommitted work restored on top. Directories containing initialized
 * submodules or nested repositories are guarded.
 *
 * @module
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SNAPSHOT_NAMESPACE = 'refs/dsh-worktree-env/snapshots'
const LEGACY_SNAPSHOT_NAMESPACE = 'refs/dsh-worktree/snapshots'
const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: 'dsh-worktree-env',
  GIT_AUTHOR_EMAIL: 'dsh-worktree-env@localhost',
  GIT_COMMITTER_NAME: 'dsh-worktree-env',
  GIT_COMMITTER_EMAIL: 'dsh-worktree-env@localhost',
}

/**
 * Detect nested repositories and initialized submodules inside a worktree.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} path - worktree directory.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string[]>} findings that block auto-destruction (empty when safe).
 */
export async function nestedRepositoryFindings(git, path, signal) {
  /** @type {string[]} */
  const findings = []
  const submodules = await git.run(path, ['submodule', 'status'], { allowedExitCodes: [0, 1, 128], signal })
  if (submodules.exitCode === 0) {
    // `git submodule status` prefixes uninitialized submodules with `-`;
    // only initialized submodules (` `, `+`, `U`) contain live working trees.
    const initialized = submodules.stdout
      .split(/\r?\n/)
      .filter(line => line.length > 0 && !line.startsWith('-'))
    if (initialized.length > 0) {
      findings.push(`initialized submodules: ${initialized.length}`)
    }
  }
  const walk = async (dir, depth) => {
    if (depth > 6 || findings.length >= 5) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git') {
        // The worktree's own .git link at the root is normal; only a .git
        // inside a subdirectory marks a nested repository or submodule.
        if (depth > 0) {
          findings.push(`nested repository at ${join(dir, entry.name)}`)
          if (findings.length >= 5) return
        }
        continue
      }
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await walk(join(dir, entry.name), depth + 1)
      }
    }
  }
  await walk(path, 0)
  return findings
}

/**
 * Is the worktree clean relative to HEAD (no tracked change, no untracked file)?
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} path - worktree directory.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<boolean>} true when nothing would be lost by removal.
 */
export async function isClean(git, path, signal) {
  const status = await git.check(path, ['status', '--porcelain'], { signal })
  return status.trim().length === 0
}

/**
 * Write a hidden snapshot ref holding the complete working-tree state.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} path - worktree directory.
 * @param {string} id - snapshot id (branch or record id-derived).
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ ref: string, commit: string, parent: string }>} written ref facts.
 */
export async function writeSnapshot(git, path, id, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-worktree-snap-'))
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') }
    await git.check(path, ['read-tree', 'HEAD'], { env, signal })
    await git.check(path, ['add', '-A', '--', '.'], { env, signal })
    const tree = (await git.check(path, ['write-tree'], { env, signal })).trim()
    const head = (await git.check(path, ['rev-parse', 'HEAD'], { signal })).trim()
    const commit = (await git.check(path, ['commit-tree', tree, '-p', head, '-m', `dsh-worktree snapshot ${id}`], { env: { ...env, ...SNAPSHOT_ENV }, signal })).trim()
    const ref = `${SNAPSHOT_NAMESPACE}/${id}`
    await git.check(path, ['update-ref', ref, commit], { signal })
    return { ref, commit, parent: head }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Restore a snapshot's uncommitted delta into a live checkout. The snapshot's
 * parent diff is exactly the uncommitted changes at snapshot time; it is
 * applied with a three-way merge so branch movement is tolerated.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} path - live worktree directory.
 * @param {string} ref - snapshot ref.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ applied: boolean, reason?: string }>}
 */
export async function restoreSnapshot(git, path, ref, signal) {
  const commit = (await git.check(path, ['rev-parse', '--verify', '--end-of-options', ref], { signal })).trim()
  const parent = (await git.check(path, ['rev-parse', '--verify', '--end-of-options', `${commit}^`], { allowedExitCodes: [0, 1], signal })).trim()
  if (parent.length === 0) return { applied: false, reason: 'snapshot has no parent commit' }
  const patch = await git.check(path, ['diff', '--binary', parent, commit], { signal })
  if (patch.trim().length === 0) return { applied: true }
  const file = join(tmpdir(), `dsh-wt-restore-${Date.now()}.patch`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, patch, 'utf8')
  try {
    const result = await git.run(path, ['apply', '--3way', '--', file], { allowedExitCodes: [0, 1], signal })
    return result.exitCode === 0
      ? { applied: true }
      : { applied: false, reason: result.stderr.trim().slice(0, 500) }
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}

/**
 * Delete one snapshot ref.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} anyDir - any directory of the repository.
 * @param {string} ref - snapshot ref.
 * @param {AbortSignal} [signal] - cancellation.
 */
export async function deleteSnapshot(git, anyDir, ref, signal) {
  if (!ref.startsWith(`${SNAPSHOT_NAMESPACE}/`) && !ref.startsWith(`${LEGACY_SNAPSHOT_NAMESPACE}/`)) {
    throw new Error(`refusing to delete outside the snapshot namespace: ${ref}`)
  }
  await git.check(anyDir, ['update-ref', '-d', ref], { signal })
}

/**
 * Disk usage of one directory in bytes (best-effort, depth-bounded).
 * @param {string} dir - target directory.
 * @returns {Promise<number>} total bytes.
 */
export async function directorySize(dir) {
  let total = 0
  const walk = async (current, depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory() && entry.name !== '.git') await walk(full, depth + 1)
      else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          // vanished between listing and stat
        }
      }
    }
  }
  await walk(dir, 0)
  return total
}
