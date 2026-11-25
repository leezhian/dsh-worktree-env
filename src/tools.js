/**
 * The six enhancement tools layered on the native `create_worktree` tool.
 * All of them delegate to the shared WorktreeEnhanceService so the Web UI and
 * the agent operate on exactly the same logic.
 *
 * @module
 */

import { defineTool } from './tool-lib.js'

/**
 * @typedef {import('./service.js').WorktreeEnhanceService} Service
 */

/**
 * Register every enhancement tool on one context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Service} service - shared orchestration service.
 * @returns {() => void} disposer removing all tools.
 */
export function registerWorktreeTools(ctx, service) {
  const disposers = [
    ctx.tools.register(handoffTool(service)),
    ctx.tools.register(setupTool(service)),
    ctx.tools.register(actionsTool(service)),
    ctx.tools.register(applyPatchTool(service)),
    ctx.tools.register(archiveTool(service)),
    ctx.tools.register(restoreTool(service)),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

/** Resolve the calling agent's directory. */
async function cwdOf(service, exec) {
  if (exec.agent === undefined) throw new Error('worktree tools need a calling agent session')
  return await service.ctx.workingDirectory.ensure(exec.agent, exec.signal)
}

/** The managed worktree covering the caller's directory, or the error to surface. */
async function currentWorktree(service, exec) {
  const cwd = await cwdOf(service, exec)
  const covering = service.coveringWorktree(cwd)
  if (covering === null) {
    throw new Error(`the session directory is not inside a managed worktree: ${cwd}. Create one first (create_worktree or worktree_handoff).`)
  }
  const record = await service.requireRecord(covering.path)
  return { cwd, record }
}

function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * `worktree_handoff`: move this session into a fresh worktree, optionally
 * carrying uncommitted changes and refreshing the upstream first.
 */
function handoffTool(service) {
  return defineTool({
    name: 'worktree_handoff',
    description: 'Move the current session into a new Git worktree in-place. Packages the source checkout\'s uncommitted (staged, unstaged, and non-ignored untracked) changes through a temporary index without modifying them, creates the worktree (reusing the built-in worktree service when available), applies the changes inside it, and runs the project environment setup (.agents/environments/environment.toml) when configured. The source checkout is never cleaned automatically.',
    parameters: {
      name: { type: 'string', description: 'New branch and checkout name; generated when omitted.' },
      from: { type: 'string', description: 'Local revision to branch from; HEAD when omitted.' },
      carryChanges: { type: 'boolean', description: 'Carry uncommitted changes into the worktree (default true).' },
      fetch: { type: 'boolean', description: 'Run git fetch before creating (defaults to the plugin\'s upstreamRefreshMode).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('worktree_handoff needs a calling agent session')
      const result = await service.handoff(exec.agent, {
        name: args.name,
        from: args.from,
        carryChanges: args.carryChanges,
        fetch: args.fetch,
      }, exec.signal)
      return {
        tool: 'worktree_handoff',
        path: result.created.path,
        branch: result.created.branch,
        baseCommit: result.created.baseCommit,
        repositoryRoot: result.created.repositoryRoot,
        carriedFiles: result.carriedFiles,
        setup: (result.record.setupState),
        message: `Session now works in worktree ${result.created.branch} at ${result.created.path}${result.carriedFiles > 0 ? `; carried ${result.carriedFiles} changed file(s)` : ''}. Setup state: ${result.record.setupState}.`,
      }
    },
  })
}

/**
 * `worktree_setup`: inspect or (re-)run the environment setup.
 */
function setupTool(service) {
  return defineTool({
    name: 'worktree_setup',
    description: 'Inspect or run the local environment setup of the current repository/worktree (.agents/environments/environment.toml). mode "status" reports the discovered configuration, the setup state of the current worktree, and the available actions; mode "run" (re-)runs the setup script with live logging and environment capture.',
    parameters: {
      mode: { type: 'string', enum: ['status', 'run'], description: '"status" (default) or "run".' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const mode = args.mode ?? 'status'
      if (mode === 'run') {
        const { record } = await currentWorktree(service, exec)
        const result = await service.runSetup(record.id)
        return { tool: 'worktree_setup', mode, worktree: record.path, ...result }
      }
      const cwd = await cwdOf(service, exec)
      const covering = service.coveringWorktree(cwd)
      const description = await service.describeEnv(cwd)
      const setupState = covering !== null ? (await service.requireRecord(covering.path)).setupState : null
      return {
        tool: 'worktree_setup',
        mode,
        repositoryRoot: description.repository?.root ?? null,
        inWorktree: covering !== null,
        worktree: covering?.path ?? null,
        setupState,
        environment: {
          sourcePath: description.environment.sourcePath,
          disabled: description.environment.disabled,
          name: description.environment.name,
          hasSetup: description.environment.setup !== null,
          setupPlatform: description.environment.setup?.platform ?? null,
          hasCleanup: description.environment.cleanup !== null,
          actions: description.environment.actions.map(action => ({ name: action.name, icon: action.icon, command: action.command })),
        },
      }
    },
  })
}

/**
 * `worktree_actions`: list or run configured quick actions.
 */
function actionsTool(service) {
  return defineTool({
    name: 'worktree_actions',
    description: 'List or run the quick actions defined in the current repository\'s environment.toml ([[actions]] entries such as Dev Server, Test, Build). mode "list" (default) returns them; mode "run" starts one by name in the current worktree and returns the operation id whose logs stream through the worktree panel.',
    parameters: {
      mode: { type: 'string', enum: ['list', 'run'], description: '"list" (default) or "run".' },
      action: { type: 'string', description: 'Action name to run (required for mode "run").' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const mode = args.mode ?? 'list'
      if (mode === 'run') {
        if (typeof args.action !== 'string' || args.action.length === 0) {
          throw new Error('worktree_actions: mode "run" requires "action"')
        }
        const { record } = await currentWorktree(service, exec)
        const result = await service.startAction(record.id, args.action)
        return { tool: 'worktree_actions', mode, action: args.action, worktree: record.path, operationId: result.operationId, message: `Action "${args.action}" started; logs stream under operation ${result.operationId}.` }
      }
      const cwd = await cwdOf(service, exec)
      const description = await service.describeEnv(cwd)
      return {
        tool: 'worktree_actions',
        mode,
        actions: description.environment.actions.map(action => ({ name: action.name, icon: action.icon, command: action.command })),
      }
    },
  })
}

/**
 * `worktree_apply_patch`: three-way backflow onto the source checkout.
 */
function applyPatchTool(service) {
  return defineTool({
    name: 'worktree_apply_patch',
    description: 'Apply the current worktree\'s changes back onto the source repository checkout with a three-way merge. mode "branch" (default) covers committed plus uncommitted changes relative to the worktree\'s base commit; "uncommitted" covers only uncommitted work. dryRun true (default) prechecks and reports the change count and potential conflicts without modifying anything; confirm the operation with dryRun false after reviewing.',
    parameters: {
      mode: { type: 'string', enum: ['branch', 'uncommitted'], description: '"branch" (default) or "uncommitted".' },
      dryRun: { type: 'boolean', description: 'Precheck only (default true).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const { record } = await currentWorktree(service, exec)
      const result = await service.applyBackflow(record.id, { mode: args.mode ?? 'branch', dryRun: args.dryRun !== false }, exec.signal)
      return {
        tool: 'worktree_apply_patch',
        worktree: record.path,
        target: record.repositoryRoot,
        mode: args.mode ?? 'branch',
        dryRun: args.dryRun !== false,
        applied: result.applied,
        fileCount: result.fileCount,
        conflicts: result.conflicts,
        message: result.message ?? (result.conflicts.length > 0 ? `Conflicts prevent a clean apply: ${result.conflicts.join('; ')}` : undefined),
      }
    },
  })
}

/**
 * `worktree_archive`: cleanup, snapshot, and release the current worktree.
 */
function archiveTool(service) {
  return defineTool({
    name: 'worktree_archive',
    description: 'Archive the current worktree: run the environment cleanup script (when configured), write a hidden snapshot ref (refs/dsh-worktree-env/snapshots/…) when uncommitted changes exist, then remove the checkout directory to free disk space. The branch is kept and the uncommitted work stays recoverable via worktree_restore. Refuses when the directory contains initialized submodules or nested repositories unless force is true.',
    parameters: {
      force: { type: 'boolean', description: 'Bypass the nested-repository guard after manual review.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
    timeoutMs: 900_000,
    async execute(args, exec) {
      const { record } = await currentWorktree(service, exec)
      const result = await service.archive(record.id, { force: args.force === true }, exec.signal)
      return {
        tool: 'worktree_archive',
        worktree: record.path,
        branch: record.branch,
        ...result,
        message: `Worktree ${record.branch} archived${result.snapshotRef ? ` with snapshot ${result.snapshotRef}` : ''}. Restore it with worktree_restore.`,
      }
    },
  })
}

/**
 * `worktree_restore`: bring an archived worktree back, snapshot included.
 */
function restoreTool(service) {
  return defineTool({
    name: 'worktree_restore',
    description: 'Restore an archived worktree at its recorded directory and branch, re-applying its snapshot so uncommitted changes come back. Use worktree_setup or the panel to list archived worktrees when the path is unknown; the "path" argument is the archived checkout directory.',
    parameters: {
      path: { type: 'string', required: true, description: 'Archived worktree directory (its record id).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
    timeoutMs: 900_000,
    async execute(args, exec) {
      const result = await service.restore(args.path, exec.agent, exec.signal)
      const record = await service.requireRecord(args.path)
      return {
        tool: 'worktree_restore',
        path: args.path,
        branch: record.branch,
        ...result,
        snapshot: record.snapshotRef,
        message: result.alreadyActive === true
          ? `Worktree ${record.branch} is already active.`
          : `Worktree ${record.branch} restored at ${args.path}${result.snapshotRestored?.applied === false ? ' (snapshot restore failed: see reason)' : ' with its snapshot applied'}.`,
      }
    },
  })
}
