/**
 * Workspace transfer: package one checkout's uncommitted changes through a
 * temporary Git index (never touching the user's index or working tree),
 * apply them inside a fresh worktree, refresh upstreams, and compute/apply
 * three-way backflow patches onto the source checkout.
 *
 * @module
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Package staged, unstaged, and non-ignored untracked changes of one checkout
 * relative to a given baseline commit/tree (defaults to `HEAD`).
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} root - checkout root.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {string} [baseline] - commit or ref to diff against (default `'HEAD'`).
 * @returns {Promise<{ patch: string | null, fileCount: number }>} unified `--binary` patch (null when clean).
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
    if (tree === baseTree) return { patch: null, fileCount: 0 }
    const patch = await git.check(root, ['diff-tree', '-p', '--binary', '--no-commit-id', baseTree, tree], { env, signal })
    const count = await git.run(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', baseTree, tree], { env, signal })
    return { patch: patch.length > 0 ? patch : null, fileCount: count.stdout.split('\n').filter(Boolean).length }
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
 * @returns {Promise<{ patches: { name: string, text: string }[], fileCount: number }>}
 */
export async function backflowPatch(git, worktree, mode, signal) {
  const baseline = mode === 'branch' ? worktree.baseCommit : 'HEAD'
  const packaged = await packageWorkingTree(git, worktree.path, signal, baseline)
  if (packaged.patch === null) {
    return { patches: [], fileCount: 0 }
  }
  return {
    patches: [{ name: `${mode}.patch`, text: packaged.patch }],
    fileCount: packaged.fileCount,
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
