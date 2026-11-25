/**
 * dsh-worktree Host entry: configuration normalization, the shared
 * WorktreeEnhanceService, native-creation hooks, session-activity protection,
 * quota enforcement, the /worktree command, agent tools, prompt context,
 * shell-env contribution, and the HTTP surface. Dependency-free: everything
 * runs against the services the Loader injects.
 *
 * @module
 */

import {
  DEFAULT_WORKTREE_DIRECTORY,
  PREFERENCES,
  isValidRelativeWorktreeDir,
  normalizeConfig,
  persistedConfigPath,
  readPersistedConfig,
} from './config.js'
import { WorktreeEnhanceService } from './service.js'
import { registerPromptContext, registerShellEnv } from './prompt.js'
import { registerServer } from './server.js'
import { registerWorktreeTools } from './tools.js'

export const name = 'dsh-worktree-env'
export { DEFAULT_WORKTREE_DIRECTORY, isValidRelativeWorktreeDir, normalizeConfig, persistedConfigPath }

/**
 * Optional Schemastery Config schema so DSH Settings auto-generates the plugin
 * configuration form when `@deepseek-ai/schemastery` is available in the profile,
 * while keeping the package runnable standalone under `node --test` with zero deps.
 */
async function buildConfigSchema() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const Schema = mod.default ?? mod
    if (typeof Schema?.object !== 'function') return undefined
    const prefSchema = Schema.union(PREFERENCES)
    const repoPrefSchema = Schema.object({
      commonDir: Schema.string().required(),
      root: Schema.string().required(),
      preference: prefSchema.default('ask'),
    })
    return Schema.object({
      worktreeDirectory: Schema.string().default('').description('Relative worktree directory inside each repository (empty uses .agents/worktrees; synced with built-in worktree module).'),
      autoRunSetup: Schema.boolean().default(true).description('Automatically run environment.toml [setup] when a worktree is created.'),
      autoRunCleanup: Schema.boolean().default(true).description('Automatically run environment.toml [cleanup] before archiving a worktree.'),
      setupTimeoutMs: Schema.natural().min(1000).default(300000).description('Timeout (ms) for setup, cleanup, and action scripts.'),
      upstreamRefreshMode: Schema.union(['never', 'best-effort']).default('never').description('Whether to run git fetch before handoff/creation.'),
      defaultCreationPreference: prefSchema.default('ask').description('Default policy for creating worktrees for edits.'),
      repositoryPreferences: Schema.array(repoPrefSchema).default([]).description('Per-repository policy overrides keyed by git commonDir.'),
      snapshotOnArchive: Schema.boolean().default(true).description('Save uncommitted changes as a hidden Git snapshot ref before archiving.'),
      autoCleanupEnabled: Schema.boolean().default(true).description('Automatically archive/clean up old worktrees beyond keepCount.'),
      keepCount: Schema.natural().min(1).default(15).description('Maximum number of recent active worktrees to retain per repository.'),
      confirmBeforeDelete: Schema.boolean().default(true).description('Ask for confirmation before archiving or deleting a worktree in the UI.'),
    })
  } catch {
    return undefined
  }
}

export const Config = await buildConfigSchema()

export const inject = ['subprocess', 'workingDirectory', 'tools', 'systemPrompt', 'webServer', 'commands', 'timer']

/**
 * Mount the enhancement layer.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} rawConfig - raw row configuration.
 * @returns {() => void} cleanup.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig({ ...(rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}), ...readPersistedConfig() })
  const service = new WorktreeEnhanceService(ctx, config)

  // Adopt worktrees the native service (or our tools) created, from any session.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    void service.observeSessionEvent(session, event)
  }), 'dsh-worktree-env: creation adoption')

  // Keep worktree `lastAccessedAt` and prompt dirty/policy cache fresh on directory changes.
  ctx.effect(() => ctx.on('working-directory/change', (payload) => {
    const cwd = typeof payload === 'string' ? payload : (payload?.path ?? payload?.cwd ?? payload?.next)
    const sessionId = typeof payload === 'object' && payload !== null
      ? (payload.sessionId ?? payload.session?.header?.id ?? payload.agent?.session?.header?.id ?? null)
      : null
    if (typeof cwd === 'string' && cwd.length > 0) {
      void service.touchWorktreeAccess(cwd, sessionId)
      void service.refreshPreference(cwd).catch(() => {})
    }
  }), 'dsh-worktree-env: working directory tracking')

  // Protect setup/action runs from session archival, and stop only operations
  // belonging to worktrees owned by the stopped session.
  ctx.effect(() => ctx.on('workspace/session-activity', async (request, next) => {
    const inherited = await next()
    const own = service.sessionActivity(request.sessionId)
    return own.length > 0 ? [...inherited, ...own] : inherited
  }), 'dsh-worktree-env: session activity')
  ctx.effect(() => ctx.on('workspace/session-stop', async (request) => {
    service.cancelOperationsForSession(request.sessionId)
  }), 'dsh-worktree-env: session stop')

  // Startup + periodic quota enforcement (matching Codex App startup & background cleanup).
  ctx.effect(() => ctx.timer.timeout(() => {
    void service.enforceQuota().catch(() => {})
  }, 5000), 'dsh-worktree-env: startup quota sweep')
  ctx.effect(() => ctx.timer.interval(() => {
    void service.enforceQuota().catch(() => {})
  }, 30 * 60 * 1000), 'dsh-worktree-env: quota sweep')

  // Coordinate session archive & unarchive events so unarchiving cancels any
  // pending archive cleanup, and reconcile clean worktrees removed by DSH's
  // built-in worktree module so reopened sessions still offer Restore.
  /** @type {Map<string, () => void>} */
  const pendingArchiveTimers = new Map()
  const extractSessionId = (payload) => (typeof payload === 'string'
    ? payload
    : (payload?.sessionId ?? payload?.id ?? payload?.session?.header?.id ?? null))
  ctx.effect(() => () => {
    for (const cancel of pendingArchiveTimers.values()) {
      try { cancel() } catch { /* ignore */ }
    }
    pendingArchiveTimers.clear()
  }, 'dsh-worktree-env: drain archive timers')
  ctx.effect(() => ctx.on('workspace/session-archived', (payload) => {
    const sessionId = extractSessionId(payload)
    if (sessionId !== null) {
      service.clearSessionUnarchiving(sessionId)
      const prev = pendingArchiveTimers.get(sessionId)
      if (typeof prev === 'function') prev()
    }
    const cancel = ctx.timer.timeout(() => {
      if (sessionId !== null) pendingArchiveTimers.delete(sessionId)
      void service.handleSessionArchived(sessionId).catch(() => {})
    }, 1500)
    if (sessionId !== null && typeof cancel === 'function') {
      pendingArchiveTimers.set(sessionId, cancel)
    }
  }), 'dsh-worktree-env: post-archive sweep')
  ctx.effect(() => ctx.on('workspace/session-unarchiving', (payload) => {
    const sessionId = extractSessionId(payload)
    if (sessionId === null) return
    service.markSessionUnarchiving(sessionId)
    const cancel = pendingArchiveTimers.get(sessionId)
    if (typeof cancel === 'function') {
      cancel()
      pendingArchiveTimers.delete(sessionId)
    }
  }), 'dsh-worktree-env: cancel archive on unarchive')
  ctx.effect(() => ctx.on('worktree/cleanup', (payload) => {
    if (payload?.cleanup?.status === 'removed' && typeof payload?.path === 'string') {
      void service.markExternallyRemoved(payload.path, extractSessionId(payload)).catch(() => {})
    }
  }), 'dsh-worktree-env: reconcile built-in cleanup')

  // Initial index build so shellEnv/prompt context answer right after startup.
  void service.listAll().catch(() => {})

  // The /worktree human command: session menu rows and the panel send these.
  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-worktree-env.command',
    name: 'worktree',
    description: 'Worktree enhancements: handoff with uncommitted changes, backflow, archiving, and snapshot restore.',
    input: { hint: 'status | handoff [name] | apply-patch [branch|uncommitted] | restore [branch] | archive' },
    async handler(invocation) {
      const [verb, ...rest] = invocation.rawInput.trim().split(/\s+/)
      try {
        if (verb === 'handoff') {
          const result = await service.handoff(invocation.agent, { name: rest[0] }, invocation.signal)
          return { kind: 'success', text: `Worktree ${result.created.branch} at ${result.created.path}; carried ${result.carriedFiles} file(s).` }
        }
        if (verb === 'apply-patch') {
          const cwd = await ctx.workingDirectory.ensure(invocation.agent, invocation.signal)
          const covering = service.coveringWorktree(cwd)
          if (covering === null) return { kind: 'error', text: 'Not inside a managed worktree.' }
          const mode = rest[0] === 'uncommitted' ? 'uncommitted' : 'branch'
          const precheck = await service.applyBackflow(covering.path, { mode, dryRun: true }, invocation.signal)
          if (precheck.conflicts.length > 0) return { kind: 'error', text: `Conflicts: ${precheck.conflicts.join('; ')}` }
          const applied = await service.applyBackflow(covering.path, { mode, dryRun: false }, invocation.signal)
          return { kind: 'success', text: applied.message ?? 'Applied.' }
        }
        if (verb === 'restore') {
          const sessionId = invocation.agent?.session?.header?.id ?? null
          const cwd = service.sessionDirectory(sessionId, invocation.agent?.session?.header?.cwd)
          let target = null
          if (typeof rest[0] === 'string' && rest[0].length > 0) {
            const { items } = await service.listAll()
            target = items.find(i => i.status === 'archived' && (i.branch === rest[0] || i.id === rest[0])) ?? null
          } else {
            target = await service.findArchivedWorktree(sessionId, cwd)
          }
          if (target === null) return { kind: 'error', text: 'No archived worktree found to restore.' }
          const result = await service.restore(target.id, invocation.agent, invocation.signal)
          return {
            kind: 'success',
            text: `Restored ${target.branch} at ${target.path}${result.snapshotRestored?.applied ? ' with recovery snapshot.' : '.'}`,
          }
        }
        if (verb === 'archive') {
          const cwd = await ctx.workingDirectory.ensure(invocation.agent, invocation.signal)
          const covering = service.coveringWorktree(cwd)
          if (covering === null) return { kind: 'error', text: 'Not inside a managed worktree.' }
          const result = await service.archive(covering.path, {}, invocation.signal)
          return { kind: 'success', text: `Archived${result.snapshotRef ? ` with snapshot ${result.snapshotRef}` : ''}.` }
        }
        const cwd = await ctx.workingDirectory.ensure(invocation.agent, invocation.signal)
        const description = await service.describeEnv(cwd)
        const covering = service.coveringWorktree(cwd)
        return {
          kind: 'success',
          text: [
            covering === null ? 'Not inside a managed worktree.' : `Worktree: ${covering.branch} at ${covering.path}`,
            `Repository: ${description.repository?.root ?? cwd}`,
            `Environment: ${description.environment.sourcePath ?? 'none found'}`,
            `Setup: ${covering !== null ? (await service.requireRecord(covering.path)).setupState : 'n/a'}`,
            `Actions: ${description.environment.actions.map(a => a.name).join(', ') || 'none'}`,
          ].join('\n'),
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'dsh-worktree: /worktree command')

  const disposeTools = registerWorktreeTools(ctx, service)
  const disposePrompt = registerPromptContext(ctx, service)
  const disposeShellEnv = registerShellEnv(ctx, service)
  const disposeServer = registerServer(ctx, service)

  return () => {
    disposeServer()
    disposeShellEnv()
    disposePrompt()
    disposeTools()
  }
}
