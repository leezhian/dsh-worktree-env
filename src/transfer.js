/**
 * Workspace transfer: package one checkout's uncommitted changes through a
 * temporary Git index (never touching the user's index or working tree),
 * apply them inside a fresh worktree, refresh upstreams, and compute/apply
 * three-way backflow patches onto the source checkout.
 *
 * @module
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Package staged, unstaged, and non-ignored untracked changes of one checkout
 * relative to a given baseline commit/tree (defaults to `HEAD`).
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} root - checkout root.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {string} [baseline] - commit or ref to diff against (default `'HEAD'`).
 * @returns {Promise<{ patch: string | null, fileCount: number, files: string[] }>} unified `--binary` patch (null when clean).
 */
export async function packageWorkingTree(git, root, signal, baseline = 'HEAD') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-worktree-pkg-'))
  try {
    const indexFile = join(dir, 'index')
    const env = { GIT_INDEX_FILE: indexFile }
    await git.check(root, ['read-tree', 'HEAD'], { env, signal })
    await git.check(root, ['add', '-A', '--', '.'], { env, signal })
    const tree = (await git.check(root, ['write-tree'], { env, signal })).trim()
    const baseTree = (await git.check(root, ['rev-parse', `${baseline}^{tree}`], { signal })).trim()
    if (tree === baseTree) return { patch: null, fileCount: 0, files: [] }
    const patch = await git.check(root, ['diff-tree', '-p', '--binary', '--no-commit-id', baseTree, tree], { env, signal })
    const count = await git.run(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', baseTree, tree], { env, signal })
    const files = count.stdout.split('\n').filter(Boolean)
    return { patch: patch.length > 0 ? patch : null, fileCount: files.length, files }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Compute the deduplicated backflow patch of one worktree toward its source checkout.
 * - `'branch'`: committed + staged + unstaged + non-ignored untracked changes relative to `baseCommit`.
 * - `'uncommitted'`: staged + unstaged + non-ignored untracked changes relative to `HEAD`.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {{ path: string, baseCommit: string }} worktree - checkout directory and baseline.
 * @param {'branch' | 'uncommitted'} mode - committed-plus-uncommitted, or uncommitted only.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ patches: { name: string, text: string }[], fileCount: number, files: string[] }>}
 */
export async function backflowPatch(git, worktree, mode, signal) {
  const baseline = mode === 'branch' ? worktree.baseCommit : 'HEAD'
  const packaged = await packageWorkingTree(git, worktree.path, signal, baseline)
  if (packaged.patch === null) {
    return { patches: [], fileCount: 0, files: [] }
  }
  return {
    patches: [{ name: `${mode}.patch`, text: packaged.patch }],
    fileCount: packaged.fileCount,
    files: packaged.files,
  }
}

/**
 * Precheck patches against an arbitrary Git ref (e.g. a different local branch)
 * without touching the user's real checkout directory. Only the touched files
 * are materialized into a temporary working tree so even huge repos stay fast.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} commonDir - repository `.git` common directory.
 * @param {string} targetRef - target ref such as `refs/heads/main`.
 * @param {{ name: string, text: string }[]} patches - patch payloads.
 * @param {string[]} touchedFiles - repo-relative file paths touched by the patches.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ ok: boolean, conflicts: string[] }>}
 */
export async function precheckPatchesOnRef(git, commonDir, targetRef, patches, touchedFiles, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-refchk-'))
  const workDir = join(dir, 'work')
  const indexFile = join(dir, 'index')
  try {
    await mkdir(workDir, { recursive: true })
    const env = { GIT_DIR: commonDir, GIT_WORK_TREE: workDir, GIT_INDEX_FILE: indexFile }
    await git.check(workDir, ['read-tree', targetRef], { env, signal })
    if (Array.isArray(touchedFiles) && touchedFiles.length > 0) {
      const listed = await git.run(workDir, ['ls-tree', '-r', '--name-only', targetRef, '--', ...touchedFiles], { env, allowedExitCodes: [0, 128], signal })
      const present = listed.stdout.split('\n').filter(Boolean)
      if (present.length > 0) {
        await git.check(workDir, ['checkout-index', '-f', '--', ...present], { env, signal })
      }
    }
    /** @type {string[]} */
    const conflicts = []
    for (const patch of patches) {
      const file = join(dir, `pre-${patch.name}`)
      await writeFile(file, patch.text, 'utf8')
      const result = await git.run(workDir, ['apply', '--check', '--3way', '--', file], { env, allowedExitCodes: [0, 1, 128], signal })
      if (result.exitCode !== 0) conflicts.push(...conflictFiles(result.stderr, patch.name))
    }
    return { ok: conflicts.length === 0, conflicts }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Precheck patches against a target checkout with `git apply --check --3way`.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} target - checkout that would receive the patches.
 * @param {{ name: string, text: string }[]} patches - patch payloads.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ ok: boolean, conflicts: string[] }>} conflict file list when not ok.
 */
export async function precheckPatches(git, target, patches, signal) {
  /** @type {string[]} */
  const conflicts = []
  for (const patch of patches) {
    const file = join(tmpdir(), `dsh-wt-pre-${patch.name}`)
    await writeFile(file, patch.text, 'utf8')
    try {
      const result = await git.run(target, ['apply', '--check', '--3way', '--', file], { allowedExitCodes: [0, 1, 128], signal })
      if (result.exitCode !== 0) conflicts.push(...conflictFiles(result.stderr, patch.name))
    } finally {
      await rm(file, { force: true }).catch(() => {})
    }
  }
  return { ok: conflicts.length === 0, conflicts }
}

/**
 * Apply patches to a target checkout with three-way merge.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} target - checkout receiving the patches.
 * @param {{ name: string, text: string }[]} patches - patch payloads.
 * @param {AbortSignal} [signal] - cancellation.
 */
export async function applyPatches(git, target, patches, signal) {
  for (const patch of patches) {
    const file = join(tmpdir(), `dsh-wt-apply-${patch.name}`)
    await writeFile(file, patch.text, 'utf8')
    try {
      await git.check(target, ['apply', '--3way', '--', file], { signal })
    } finally {
      await rm(file, { force: true }).catch(() => {})
    }
  }
}

/**
 * Best-effort upstream refresh before creating a worktree.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} root - repository root.
 * @param {(stream: 'stdout' | 'stderr' | 'meta', text: string) => void} [log]
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<boolean>} whether the fetch succeeded.
 */
export async function fetchUpstream(git, root, log, signal) {
  const result = await git.run(root, ['fetch', '--all', '--prune', '--quiet'], { allowedExitCodes: [0, 1, 128], signal, timeoutMs: 120_000 })
  if (result.exitCode !== 0) {
    log?.('meta', `git fetch failed (ignored): ${result.stderr.trim().slice(0, 300)}`)
    return false
  }
  log?.('meta', 'git fetch completed.')
  return true
}

/**
 * Extract conflict file paths from a `git apply --check` stderr.
 * @param {string} stderr - git error output.
 * @param {string} label - patch label for context.
 * @returns {string[]} deduplicated conflict descriptions.
 */
export function conflictFiles(stderr, label) {
  const out = []
  const seen = new Set()
  for (const line of stderr.split('\n')) {
    const match = /^(?:error: )?(?:patch failed|conflict|[A-Za-z ]+hunk)?:?\s*([^:]+):\d+/.exec(line)
      ?? /^error: ([^:]+): (?:does not match|already exists|No such file)/.exec(line)
    if (match !== null) {
      const file = `${label}: ${match[1].trim()}`
      if (!seen.has(file)) {
        seen.add(file)
        out.push(file)
      }
    }
  }
  if (out.length === 0 && stderr.trim().length > 0) out.push(`${label}: ${stderr.trim().split('\n')[0].slice(0, 160)}`)
  return out
}
