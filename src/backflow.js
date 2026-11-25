/**
 * Target-branch inspection and three-way patch backflow orchestration
 * (extracted from WorktreeEnhanceService to keep branch-switching,
 * dirty-source protection, ref precheck, and rollback isolated).
 *
 * @module
 */

import { DEFAULT_WORKTREE_DIRECTORY, isValidRelativeWorktreeDir } from './config.js'
import { parseWorktreeList } from './git.js'
import { applyPatches, backflowPatch, precheckPatches, precheckPatchesOnRef } from './transfer.js'

/**
 * Inspect the source checkout's active branch and dirty file count, excluding
 * DSH's own worktree pool directory so untracked `.agents/worktrees/` never
 * falsely marks a clean repository as dirty.
 * @param {import('./git.js').GitRunner} git
 * @param {string} root
 * @param {string} configuredWorktreeDir
 * @param {AbortSignal} [signal]
 */
export async function sourceCheckoutStatus(git, root, configuredWorktreeDir, signal) {
  const headRes = await git.run(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowedExitCodes: [0, 128], signal })
  const rawHead = headRes.exitCode === 0 ? headRes.stdout.trim() : ''
  const currentBranch = rawHead.length > 0 && rawHead !== 'HEAD' ? rawHead : null
  const excludes = [`:(exclude)${DEFAULT_WORKTREE_DIRECTORY}`]
  if (typeof configuredWorktreeDir === 'string' && isValidRelativeWorktreeDir(configuredWorktreeDir) && configuredWorktreeDir !== DEFAULT_WORKTREE_DIRECTORY) {
    excludes.push(`:(exclude)${configuredWorktreeDir}`)
  }
  const statusRes = await git.run(root, ['status', '--porcelain', '--', '.', ...excludes], { allowedExitCodes: [0, 128], signal })
  const dirtyLines = statusRes.exitCode === 0 ? statusRes.stdout.split('\n').filter(Boolean) : []
  return {
    currentBranch,
    sourceDirty: dirtyLines.length > 0,
    sourceDirtyCount: dirtyLines.length,
  }
}

/**
 * Validate that a proposed new local Git branch name is well-formed and does
 * not already exist under `refs/heads/`.
 * @param {import('./git.js').GitRunner} git
 * @param {string} root - repository root.
 * @param {string} branch - trimmed branch name.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true } | { ok: false, code: 'INVALID_BRANCH_NAME' | 'BRANCH_ALREADY_EXISTS', message: string }>}
 */
export async function validateNewBranchName(git, root, branch, signal) {
  const fmt = await git.run(root, ['check-ref-format', '--branch', branch], { allowedExitCodes: [0, 1, 128], signal })
  if (fmt.exitCode !== 0) {
    return { ok: false, code: 'INVALID_BRANCH_NAME', message: `Invalid branch name: ${branch}` }
  }
  const exists = await git.run(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowedExitCodes: [0, 1], signal })
  if (exists.exitCode === 0) {
    return { ok: false, code: 'BRANCH_ALREADY_EXISTS', message: `Branch already exists: ${branch}` }
  }
  return { ok: true }
}

/**
 * Describe the source checkout's current branch, cleanliness, and available
 * target branches for applying changes back from a worktree.
 * @param {import('./git.js').GitRunner} git
 * @param {import('./store.js').WorktreeRecord} record
 * @param {string} configuredWorktreeDir
 * @param {AbortSignal} [signal]
 */
export async function inspectBackflowInfo(git, record, configuredWorktreeDir, signal) {
  const root = record.repositoryRoot
  const { currentBranch, sourceDirty, sourceDirtyCount } = await sourceCheckoutStatus(git, root, configuredWorktreeDir, signal)
  const porcelain = await git.run(root, ['worktree', 'list', '--porcelain'], { allowedExitCodes: [0, 128], signal })
  const lockedBranches = new Set()
  if (porcelain.exitCode === 0) {
    for (const entry of parseWorktreeList(porcelain.stdout)) {
      if (entry.path !== root && typeof entry.branch === 'string' && entry.branch.length > 0) {
        lockedBranches.add(entry.branch)
      }
    }
  }
  const refsRes = await git.run(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { allowedExitCodes: [0, 128], signal })
  const allLocal = refsRes.exitCode === 0 ? refsRes.stdout.split('\n').filter(Boolean) : []
  const available = allLocal.filter(name => name === currentBranch || !lockedBranches.has(name))
  const priority = (name) => {
    if (name === currentBranch) return 0
    if (name === 'main') return 1
    if (name === 'master') return 2
    return 3
  }
  available.sort((a, b) => (priority(a) - priority(b)) || a.localeCompare(b))
  return {
    worktreeId: record.id,
    worktreeBranch: record.branch,
    repositoryRoot: root,
    currentBranch,
    sourceDirty,
    sourceDirtyCount,
    branches: available,
  }
}

/**
 * Precheck or apply a worktree's backflow patch onto the source checkout,
 * optionally switching to (or creating) a chosen target branch first.
 * @param {{
 *   git: import('./git.js').GitRunner,
 *   commonDir: string,
 *   record: import('./store.js').WorktreeRecord,
 *   configuredWorktreeDir: string,
 *   options?: { mode?: 'branch' | 'uncommitted', dryRun?: boolean, targetBranch?: string | null, createBranch?: boolean },
 *   signal?: AbortSignal,
 * }} input
 */
export async function executeBackflow({ git, commonDir, record, configuredWorktreeDir, options = {}, signal }) {
  const mode = options.mode ?? 'branch'
  const { patches, fileCount, files } = await backflowPatch(git, record, mode, signal)
  const root = record.repositoryRoot
  const { currentBranch, sourceDirty, sourceDirtyCount } = await sourceCheckoutStatus(git, root, configuredWorktreeDir, signal)

  const wantsCreate = options.createBranch === true
  const rawTarget = typeof options.targetBranch === 'string' && options.targetBranch.trim().length > 0
    ? options.targetBranch.trim()
    : null
  const targetBranch = rawTarget ?? currentBranch
  const needsSwitch = wantsCreate || (targetBranch !== null && targetBranch !== currentBranch)

  const fail = (extra) => ({
    applied: false,
    fileCount,
    conflicts: [],
    currentBranch,
    targetBranch,
    sourceDirty,
    sourceDirtyCount,
    ...extra,
  })

  if (patches.length === 0) {
    return fail({ fileCount: 0, message: 'No changes to apply.' })
  }

  if (wantsCreate) {
    if (rawTarget === null) {
      return fail({ blockedReason: 'INVALID_BRANCH_NAME', targetBranch: null, message: 'New branch name is required.' })
    }
    const validation = await validateNewBranchName(git, root, rawTarget, signal)
    if (!validation.ok) {
      return fail({ blockedReason: validation.code, targetBranch: rawTarget, message: validation.message })
    }
  } else if (needsSwitch && targetBranch !== null) {
    const exists = await git.run(root, ['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`], { allowedExitCodes: [0, 1], signal })
    if (exists.exitCode !== 0) {
      return fail({ blockedReason: 'BRANCH_NOT_FOUND', message: `Target branch not found: ${targetBranch}` })
    }
    const porcelain = await git.run(root, ['worktree', 'list', '--porcelain'], { allowedExitCodes: [0, 128], signal })
    if (porcelain.exitCode === 0) {
      const inUse = parseWorktreeList(porcelain.stdout).some(entry => entry.path !== root && entry.branch === targetBranch)
      if (inUse) {
        return fail({
          blockedReason: 'BRANCH_IN_USE',
          message: `Branch "${targetBranch}" is currently checked out in another worktree.`,
        })
      }
    }
  }

  if (needsSwitch && sourceDirty) {
    return fail({
      blockedReason: 'SOURCE_DIRTY_CANNOT_SWITCH',
      message: `Source checkout has ${sourceDirtyCount} uncommitted change(s) on "${currentBranch ?? 'HEAD'}"; commit or stash them before switching branches.`,
    })
  }

  const precheck = needsSwitch && !wantsCreate && targetBranch !== null
    ? await precheckPatchesOnRef(git, commonDir, `refs/heads/${targetBranch}`, patches, files, signal)
    : await precheckPatches(git, root, patches, signal)

  if (options.dryRun === true || !precheck.ok) {
    return fail({
      conflicts: precheck.conflicts,
      willSwitchBranch: needsSwitch,
      createBranch: wantsCreate,
      message: options.dryRun === true && precheck.ok ? 'Dry run: patches would apply cleanly.' : undefined,
    })
  }

  if (needsSwitch && targetBranch !== null) {
    const prevRef = currentBranch ?? (await git.check(root, ['rev-parse', 'HEAD'], { signal })).trim()
    await git.check(root, wantsCreate ? ['checkout', '-b', targetBranch] : ['checkout', targetBranch], { signal })
    try {
      await applyPatches(git, root, patches, signal)
    } catch (error) {
      await git.run(root, ['checkout', prevRef], { allowedExitCodes: [0, 1, 128] }).catch(() => {})
      if (wantsCreate) {
        await git.run(root, ['branch', '-D', targetBranch], { allowedExitCodes: [0, 1, 128] }).catch(() => {})
      }
      throw error
    }
  } else {
    await applyPatches(git, root, patches, signal)
  }

  return {
    applied: true,
    fileCount,
    conflicts: [],
    currentBranch,
    targetBranch,
    switchedBranch: needsSwitch,
    createdBranch: wantsCreate,
    message: `Applied ${fileCount} changed file(s) onto ${root}${targetBranch ? ` (${targetBranch})` : ''}.`,
  }
}
