/**
 * Model-facing context: a per-agent system-prompt context describing the
 * managed worktree the session sits in (or the isolation reminder for plain
 * repositories under an `always`/`dirty` policy), and the `ctx.shellEnv`
 * contribution that injects `DSH_WORKTREE_*` variables into every model
 * shell command executed inside a managed worktree.
 *
 * @module
 */

/**
 * Register the per-agent prompt context on every agent's own context, keeping
 * every disposer also in the plugin's effect so either teardown removes it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('./service.js').WorktreeEnhanceService} service
 * @returns {() => void} plugin-level disposer.
 */
export function registerPromptContext(ctx, service) {
  /** @type {Map<string, () => void>} */
  const perAgent = new Map()
  const offCreated = ctx.on('agent/created', ({ agent }) => {
    // agent.ctx owns the registration; keeping its disposer lets the plugin
    // unload remove it from still-live agents.
    const dispose = agent.ctx.inject(['systemPrompt'], (child) => {
      child.effect(() => child.systemPrompt.context({
        name: 'dsh-worktree-env',
        order: 105,
        text: () => promptTextFor(service, agent),
      }), 'dsh-worktree-env: prompt context')
    })
    perAgent.set(agent.session.header.id, dispose)
    void service.refreshPreferenceSafe(agent)
  })
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const dispose = perAgent.get(agent.session.header.id)
    if (dispose !== undefined) {
      dispose()
      perAgent.delete(agent.session.header.id)
    }
  })
  return () => {
    offCreated()
    offDisposed()
    for (const dispose of perAgent.values()) dispose()
    perAgent.clear()
  }
}

/**
 * Compute the context text for one agent; never throws.
 * @param {import('./service.js').WorktreeEnhanceService} service
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {string}
 */
function promptTextFor(service, agent) {
  let cwd
  try {
    cwd = service.ctx.workingDirectory.get(agent.session)
  } catch {
    return ''
  }
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const snapshot = service.promptSnapshot(cwd)
  if (snapshot !== null) {
    const lines = [
      `# Git worktree (dsh-worktree-env)`,
      `The session works inside the managed worktree "${snapshot.branch}" at ${snapshot.path}.`,
      `Source repository checkout: ${snapshot.repositoryRoot}. Environment variables DSH_WORKTREE_SOURCE_ROOT, DSH_WORKTREE_PATH, and DSH_WORKTREE_BRANCH are set for shell commands.`,
    ]
    if (snapshot.envSourcePath !== null) lines.push(`Local environment config: ${snapshot.envSourcePath} (setup state: ${snapshot.setupState}).`)
    else lines.push(`No local environment config was found for this worktree.`)
    if (snapshot.setupError !== null) lines.push(`Last setup failure: ${snapshot.setupError}. Consider worktree_setup (mode "run") to retry.`)
    if (snapshot.actions.length > 0) {
      lines.push(`Quick actions available via worktree_actions (mode "run"): ${snapshot.actions.map(action => `"${action.name}"`).join(', ')}.`)
    }
    lines.push(`To move changes back onto the source checkout use worktree_apply_patch (dryRun first); to free the directory while keeping uncommitted work recoverable use worktree_archive.`)
    return `${lines.join('\n')}\n`
  }
  const preference = service.cachedPreference(cwd)
  if (preference === 'always' || preference === 'dirty') {
    return [
      '# Git worktree (dsh-worktree-env)',
      preference === 'always'
        ? `This repository prefers edits in an isolated worktree. Before modifying files, ask the user for confirmation, then enter one with worktree_handoff (or create_worktree).`
        : `This repository suggests an isolated worktree while the main checkout has uncommitted changes. Before modifying files, ask the user whether to worktree_handoff (carrying the uncommitted changes) or edit in place.`,
      '',
    ].join('\n')
  }
  return ''
}

/**
 * Register the shell-env contribution (no-op when `shellEnv` is absent).
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('./service.js').WorktreeEnhanceService} service
 * @returns {() => void} disposer, or a no-op when the registry is missing.
 */
export function registerShellEnv(ctx, service) {
  const registry = ctx.get('shellEnv')
  if (registry === undefined) return () => {}
  return registry.register({
    name: 'dsh-worktree-env',
    variables: {
      DSH_WORKTREE_SOURCE_ROOT: { description: 'Source repository checkout this worktree was created from.' },
      DSH_WORKTREE_PATH: { description: 'Managed worktree checkout directory of this session.' },
      DSH_WORKTREE_BRANCH: { description: 'Branch checked out in the managed worktree of this session.' },
      DSH_WORKTREE_ENV_FILE: { description: 'Shell file of environment variables captured by the worktree setup, when present.' },
    },
    resolve(execution) {
      if (execution.agent === undefined) return {}
      let cwd
      try {
        cwd = service.ctx.workingDirectory.get(execution.agent.session)
      } catch {
        return {}
      }
      if (typeof cwd !== 'string') return {}
      return service.shellVariablesFor(cwd) ?? {}
    },
  })
}
