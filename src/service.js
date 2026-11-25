/**
 * WorktreeEnhanceService: the Host orchestration layer every consumer (agent
 * tools, HTTP API, prompt context) shares. It layers on the optional native
 * `ctx.worktrees` service and degrades to direct Git when that is absent.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { access, constants, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DEFAULT_WORKTREE_DIRECTORY, isValidRelativeWorktreeDir, persistedConfigPath, writePersistedConfig } from './config.js'
import { GitRunner, parseWorktreeList, repoInfo } from './git.js'
import { classifyManagedEnvPath, discoverEnvConfig, listEnvConfigs, parseGitRemoteOwner, preferredConfigPath, readEnvConfigFile, writeEnvConfig } from './env-config.js'
import { EnvRunner } from './env-runner.js'
import { detectApplyConflicts, fetchUpstream, packageWorkingTree } from './transfer.js'
import { executeBackflow, inspectBackflowInfo, sourceCheckoutStatus, validateNewBranchName } from './backflow.js'
import { deleteSnapshot, directorySize, isClean, nestedRepositoryFindings, restoreSnapshot, writeSnapshot } from './snapshot.js'
import { storeOf } from './store.js'

const CREATED_RECORD = 'plugin:worktree/created'
const NATIVE_WORKTREE_PKG = '@deepseek-ai/dsh-experimental-worktree'

/**
 * User-facing plugin configuration (the row's `config`).
 * @typedef {Object} EnhanceConfig
 * @property {boolean} autoRunSetup
 * @property {boolean} autoRunCleanup
 * @property {number} setupTimeoutMs
 * @property {'never' | 'best-effort'} upstreamRefreshMode
 * @property {'ask' | 'always' | 'never' | 'dirty'} defaultCreationPreference
 * @property {{ commonDir: string, root: string, preference: 'ask' | 'always' | 'never' | 'dirty' }[]} repositoryPreferences
 * @property {boolean} snapshotOnArchive
 * @property {boolean} autoCleanupEnabled
 * @property {number} keepCount
 * @property {boolean} confirmBeforeDelete
 */

/**
 * Orchestrates environments, handoff, backflow, snapshots, and quota cleanup.
 * A plain class (not a Cordis service) so the bundle stays dependency-free;
 * every consumer closes over the one instance created in `apply`.
 */
export class WorktreeEnhanceService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context.
   * @param {EnhanceConfig} config - resolved plugin configuration.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.git = new GitRunner(ctx)
    this.runner = new EnvRunner()
    /** Paths with a running setup/action process. */
    this.busyPaths = new Set()
    /** In-memory index: worktree path → branch/repositoryRoot, refreshed by scans. */
    this.knownPaths = new Map()
    /** Every git common dir this service has opened; survives record lookup after restarts. */
    this.commonDirs = new Set()
    /** worktree path → prompt-facing description slice, refreshed by scans and setup runs. */
    this.describeCache = new Map()
    /** repository root → cached creation preference. */
    this.preferenceCache = new Map()
    /** directory → cached `{ isGitRepo, preference, dirty }` for system prompt policy. */
    this.repoPolicyCache = new Map()
    /** Sessions currently being unarchived (cancels pending/in-flight archive cleanup). */
    this.unarchivingSessions = new Set()
    /** Sessions currently inside `handoff()` (prevents duplicate premature adoption). */
    this.pendingHandoffSessions = new Set()
  }

  /**
   * Mark a session as unarchiving so any pending or in-flight archive cleanup
   * for its worktree is aborted cleanly.
   * @param {string | null | undefined} sessionId
   */
  markSessionUnarchiving(sessionId) {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.unarchivingSessions.add(sessionId)
    }
  }

  /**
   * Clear the unarchiving flag when a session is archived again.
   * @param {string | null | undefined} sessionId
   */
  clearSessionUnarchiving(sessionId) {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.unarchivingSessions.delete(sessionId)
    }
  }

  /**
   * Reconcile a worktree removed externally (e.g. clean checkout removed by
   * DSH's built-in `dsh-experimental-worktree` archive handler) so reopening
   * its session still surfaces the one-click Restore button.
   * @param {string} worktreePath
   * @param {string | null | undefined} [sessionId]
   */
  async markExternallyRemoved(worktreePath, sessionId) {
    if (typeof worktreePath !== 'string' || worktreePath.length === 0) return false
    const absPath = resolve(worktreePath)
    const exists = await access(absPath, constants.F_OK).then(() => true, () => false)
    if (exists) return false
    let record
    try {
      record = await this.requireRecord(absPath)
    } catch {
      return false
    }
    const store = await this.storeOfRecord(record)
    const patch = {}
    if (record.status !== 'archived') {
      patch.status = 'archived'
      patch.archivedAt = record.archivedAt ?? Date.now()
    }
    if (typeof sessionId === 'string' && sessionId.length > 0 && record.createdSessionId === null) {
      patch.createdSessionId = sessionId
    }
    if (Object.keys(patch).length > 0) {
      await store.patch(record.id, patch)
    }
    this.knownPaths.delete(record.path)
    return true
  }

  /** @returns {import('@deepseek-ai/dsh-experimental-worktree').WorktreeService | undefined} */
  get native() {
    return this.ctx.get('worktrees')
  }

  /**
   * Adopt a worktree created by any session (native record or our own tools).
   * @param {{ path: string, branch: string, baseCommit: string, repositoryRoot: string, sessionId?: string }} created
   * @param {{ runSetup?: boolean } } [options]
   * @returns {Promise<import('./store.js').WorktreeRecord>} the registry record.
   */
  async registerCreated(created, options = {}) {
    const info = await repoInfo(this.git, created.repositoryRoot)
    const commonDir = info?.commonDir
    if (commonDir === undefined) throw new Error(`not a git repository: ${created.repositoryRoot}`)
    const store = storeOf(commonDir)
    this.commonDirs.add(commonDir)
    const now = Date.now()
    /** @type {import('./store.js').WorktreeRecord} */
    const record = {
      id: created.path,
      path: created.path,
      branch: created.branch,
      baseCommit: created.baseCommit,
      repositoryRoot: created.repositoryRoot,
      origin: 'dsh',
      status: 'active',
      createdAt: now,
      lastAccessedAt: now,
      createdSessionId: created.sessionId ?? null,
      setupState: 'not-configured',
      setupError: null,
      snapshotRef: null,
      archivedAt: null,
    }
    const existing = await store.get(record.id)
    await (existing === undefined ? store.put(record) : store.patch(record.id, {
      origin: 'dsh', status: 'active', snapshotRef: null, archivedAt: null, lastAccessedAt: now, branch: created.branch, baseCommit: created.baseCommit,
    }))
    this.knownPaths.set(created.path, { branch: created.branch, repositoryRoot: created.repositoryRoot, commonDir })
    const config = await this.describeEnv(created.path)
    if (config.environment.setup === null && config.environment.actions.length === 0 && config.environment.cleanup === null) {
      await store.patch(record.id, { setupState: 'not-configured' })
    } else if ((options.runSetup ?? this.config.autoRunSetup) && config.environment.setup !== null) {
      void this.runSetup(record.id).catch(() => {})
    }
    return (await store.get(record.id)) ?? record
  }

  /**
   * Describe the environment configuration visible from one directory.
   * @param {string} dir - any checkout directory.
   */
  async describeEnv(dir) {
    const info = await repoInfo(this.git, dir)
    const config = await discoverEnvConfig(this.git, dir)
    return { repository: info, environment: config }
  }

  /**
   * Shared setup execution body. Intentionally does NOT pre-inject previously
   * captured env vars before snapshotting `before.env`, so re-running `setup`
   * captures the full fresh delta instead of losing unchanged variables.
   */
  async _executeSetup(record, config, store, operation) {
    const env = this.scriptEnv(record)
    try {
      await store.patch(record.id, { setupState: 'running', setupError: null })
      this.runner.log(operation, 'meta', `Running setup in ${record.path}\n`)
      const result = await this.runner.runScript({
        ctx: this.ctx, operation, cwd: record.path, script: config.setup.script, env,
        timeoutMs: this.config.setupTimeoutMs, captureEnv: true,
      })
      if (result.status === 'succeeded' && Object.keys(result.capturedEnv).length > 0) {
        await store.writeEnv(record.branch, result.capturedEnv)
      }
      await store.patch(record.id, {
        setupState: result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'none' : 'failed',
        setupError: result.status === 'failed'
          ? `setup exited with code ${result.exitCode}`
          : result.status === 'cancelled' ? 'setup cancelled' : null,
      })
      this.describeCache.delete(record.path)
      this.runner.finish(operation, result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed')
      return result
    } catch (error) {
      this.runner.log(operation, 'stderr', `${error instanceof Error ? error.message : String(error)}\n`)
      await store.patch(record.id, { setupState: 'failed', setupError: error instanceof Error ? error.message : String(error) }).catch(() => {})
      this.runner.finish(operation, 'failed')
      throw error
    } finally {
      this.busyPaths.delete(record.path)
    }
  }

  /**
   * Start `setup` asynchronously and return the tracked operation id immediately
   * so the Web UI can stream live logs over SSE.
   * @param {string} id - record id.
   * @returns {Promise<{ operationId: string | null, status: string }>}
   */
  async startSetup(id) {
    const record = await this.requireRecord(id)
    const config = await discoverEnvConfig(this.git, record.path)
    if (config.setup === null) return { operationId: null, status: 'not-configured' }
    const store = await this.storeOfRecord(record)
    const operation = this.runner.begin('setup', `${record.branch} · setup`, record.path)
    this.busyPaths.add(record.path)
    void this._executeSetup(record, config, store, operation).catch(() => {})
    return { operationId: operation.id, status: 'running' }
  }

  /**
   * Run (or re-run) `setup` for one worktree record.
   * @param {string} id - record id.
   * @returns {Promise<{ operationId: string | null, status: string, capturedEnvCount: number }>}
   */
  async runSetup(id) {
    const record = await this.requireRecord(id)
    const config = await discoverEnvConfig(this.git, record.path)
    if (config.setup === null) return { operationId: null, status: 'not-configured', capturedEnvCount: 0 }
    const store = await this.storeOfRecord(record)
    const operation = this.runner.begin('setup', `${record.branch} · setup`, record.path)
    this.busyPaths.add(record.path)
    const result = await this._executeSetup(record, config, store, operation)
    return { operationId: operation.id, status: result.status, capturedEnvCount: Object.keys(result.capturedEnv).length }
  }

  /**
   * Run `cleanup` for one worktree record.
   * @param {import('./store.js').WorktreeRecord} record
   * @param {import('./env-runner.js').Operation} [operation] - parent operation to log into.
   */
  async runCleanup(record, operation) {
    const config = await discoverEnvConfig(this.git, record.path)
    if (config.cleanup === null) return { status: 'not-configured' }
    const target = operation ?? this.runner.begin('cleanup', `${record.branch} · cleanup`, record.path)
    const store = await this.storeOfRecord(record)
    const env = this.scriptEnv(record)
    const captured = await store.readEnv(record.branch)
    if (captured !== null) Object.assign(env, captured)
    const result = await this.runner.runScript({
      ctx: this.ctx, operation: target, cwd: record.path, script: config.cleanup.script, env,
      timeoutMs: this.config.setupTimeoutMs, captureEnv: false,
    })
    return { status: result.status }
  }

  /** Shared async launcher for worktree and plain-directory actions. */
  _launchActionOperation({ label, actionName, cwd, command, env, onFinally }) {
    const operation = this.runner.begin('action', label, cwd)
    operation.actionName = actionName
    this.busyPaths.add(cwd)
    void (async () => {
      try {
        this.runner.log(operation, 'meta', `Running "${actionName}" in ${cwd}\n`)
        const result = await this.runner.runScript({
          ctx: this.ctx, operation, cwd, script: command, env,
          timeoutMs: this.config.setupTimeoutMs, captureEnv: false,
        })
        this.runner.finish(operation, result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed')
      } finally {
        this.busyPaths.delete(cwd)
        if (typeof onFinally === 'function') await onFinally()
      }
    })()
    return { operationId: operation.id }
  }

  /**
   * Run one named action from the worktree's environment config.
   * @param {string} id - record id.
   * @param {string} actionName - action name.
   * @returns {Promise<{ operationId: string }>} the tracked operation.
   */
  async startAction(id, actionName) {
    const record = await this.requireRecord(id)
    const config = await discoverEnvConfig(this.git, record.path)
    const action = config.actions.find(entry => entry.name === actionName)
    if (action === undefined) throw new Error(`unknown action "${actionName}" for ${record.branch}`)
    const store = await this.storeOfRecord(record)
    const env = this.scriptEnv(record)
    const captured = await store.readEnv(record.branch)
    if (captured !== null) Object.assign(env, captured)
    return this._launchActionOperation({
      label: `${record.branch} · ${action.name}`,
      actionName: action.name,
      cwd: record.path,
      command: action.command,
      env,
      onFinally: () => store.patch(record.id, { lastAccessedAt: Date.now() }).catch(() => {}),
    })
  }

  /**
   * Resolve the live working directory of a session (preferring the live agent's
   * working directory over a client-provided fallback).
   * @param {string | null | undefined} sessionId
   * @param {string | null | undefined} fallbackCwd
   * @returns {string | null}
   */
  sessionDirectory(sessionId, fallbackCwd) {
    const agent = this.findLiveAgent(sessionId)
    if (agent !== null) {
      try {
        const cwd = this.ctx.workingDirectory.get(agent.session)
        if (typeof cwd === 'string' && cwd.length > 0) return resolve(cwd)
      } catch {
        // fall through to session header
      }
      if (typeof agent.session?.header?.cwd === 'string' && agent.session.header.cwd.length > 0) {
        return resolve(agent.session.header.cwd)
      }
    }
    if (typeof fallbackCwd === 'string' && fallbackCwd.trim().length > 0) {
      return resolve(fallbackCwd.trim())
    }
    return null
  }

  /**
   * Locate the enclosing Git repository for a path even if the leaf directory
   * has already been removed (e.g. an archived worktree path).
   * @param {string} targetPath
   */
  async findRepoInfoAscending(targetPath) {
    let cur = resolve(targetPath)
    for (let depth = 0; depth < 8; depth += 1) {
      const exists = await access(cur, constants.F_OK).then(() => true, () => false)
      if (exists) {
        const info = await repoInfo(this.git, cur).catch(() => null)
        if (info !== null) return info
      }
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return null
  }

  /**
   * Look up an archived worktree record associated with a session (by its
   * last working directory or recorded `createdSessionId` / `sessionIds`).
   * @param {string | null | undefined} sessionId
   * @param {string | null} dir - path to match (when `matchPath` is true) and/or discover the enclosing repo.
   * @param {{ matchPath?: boolean }} [options]
   * @returns {Promise<import('./store.js').WorktreeRecord | null>}
   */
  async findArchivedWorktree(sessionId, dir, options = {}) {
    const matchPath = options.matchPath !== false
    const candidates = new Set(this.commonDirs)
    if (typeof dir === 'string' && dir.length > 0) {
      const info = await this.findRepoInfoAscending(dir)
      if (info !== null) {
        this.commonDirs.add(info.commonDir)
        candidates.add(info.commonDir)
      }
    }
    for (const workspaceHint of this.workspaceRoots()) {
      const repo = await repoInfo(this.git, workspaceHint).catch(() => null)
      if (repo !== null) {
        this.commonDirs.add(repo.commonDir)
        candidates.add(repo.commonDir)
      }
    }
    let sessionMatch = null
    for (const commonDir of candidates) {
      const store = storeOf(commonDir)
      const records = await store.list()
      for (const record of records) {
        let isArchived = record.status === 'archived'
        if (!isArchived && record.status === 'active') {
          const onDisk = await access(record.path, constants.F_OK).then(() => true, () => false)
          if (!onDisk) {
            // Reconcile clean worktrees removed by DSH's built-in cleanup so they remain restorable.
            const archivedAt = record.archivedAt ?? Date.now()
            await store.patch(record.id, { status: 'archived', archivedAt }).catch(() => {})
            record.status = 'archived'
            record.archivedAt = archivedAt
            this.knownPaths.delete(record.path)
            isArchived = true
          }
        }
        if (!isArchived) continue
        if (matchPath && typeof dir === 'string' && dir.length > 0 && (record.path === dir || dir.startsWith(`${record.path}/`))) {
          return record
        }
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          const matchesSession = record.createdSessionId === sessionId
            || (Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId))
          if (matchesSession && (sessionMatch === null || (record.archivedAt ?? 0) > (sessionMatch.archivedAt ?? 0))) {
            sessionMatch = record
          }
        }
      }
    }
    return sessionMatch
  }

  /** Shape a `sessionActions` response for an archived worktree record. */
  _archivedSessionActionResult(cwd, archived) {
    return {
      cwd,
      repositoryRoot: archived.repositoryRoot,
      branch: archived.branch,
      inWorktree: true,
      worktreeId: archived.id,
      archivedWorktree: {
        id: archived.id,
        path: archived.path,
        branch: archived.branch,
        repositoryRoot: archived.repositoryRoot,
        hasSnapshot: typeof archived.snapshotRef === 'string' && archived.snapshotRef.length > 0,
        archivedAt: archived.archivedAt ?? null,
      },
      envName: null,
      envSourcePath: null,
      envFile: null,
      actions: [],
      activeOperations: [],
    }
  }

  /**
   * Describe quick actions available for one session (works in both managed
   * worktrees and regular local project checkouts, and surfaces archived
   * worktrees so reopened sessions can offer one-click restoration — including
   * when DSH's working-directory service falls back to the main repository root
   * after the worktree directory was removed).
   * @param {string | null | undefined} sessionId
   * @param {string | null | undefined} fallbackCwd
   */
  async sessionActions(sessionId, fallbackCwd) {
    const dir = this.sessionDirectory(sessionId, fallbackCwd)
    const exists = dir !== null && await access(dir, constants.F_OK).then(() => true, () => false)
    if (dir === null || !exists) {
      const archived = await this.findArchivedWorktree(sessionId, dir, { matchPath: true })
      if (archived !== null) return this._archivedSessionActionResult(dir ?? archived.path, archived)
      return {
        cwd: dir, repositoryRoot: null, branch: null, inWorktree: false, worktreeId: null, archivedWorktree: null,
        envName: null, envSourcePath: null, envFile: null, actions: [], activeOperations: [],
      }
    }
    const info = await repoInfo(this.git, dir)
    const covering = this.coveringWorktree(dir)
    // When DSH unarchives a worktree session whose checkout directory was removed,
    // DSH's working-directory service falls back `cwd` to the existing repository
    // root (`exists === true`, `covering === null`). Detect the archived worktree
    // by `sessionId` so the session still surfaces its one-click Restore banner.
    if (covering === null && typeof sessionId === 'string' && sessionId.length > 0) {
      const archived = await this.findArchivedWorktree(sessionId, dir, { matchPath: false })
      if (archived !== null) return this._archivedSessionActionResult(archived.path, archived)
    }
    if (covering !== null) {
      void this.touchWorktreeAccess(dir, sessionId)
    }
    const config = info !== null
      ? await discoverEnvConfig(this.git, dir)
      : ((await listEnvConfigs(null, dir)).environments.find(e => e.valid)?.environment ?? {
        sourcePath: null, name: basename(dir), actions: [],
      })
    let branch = covering?.branch ?? null
    if (branch === null && info !== null) {
      const head = await this.git.run(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowedExitCodes: [0, 128] })
      if (head.exitCode === 0 && head.stdout.trim().length > 0) branch = head.stdout.trim()
    }
    const matchPath = covering?.path ?? dir
    const activeOperations = []
    for (const op of this.runner.operations.values()) {
      if (op.status !== 'running') continue
      if (op.worktreePath === matchPath || op.worktreePath === dir) {
        activeOperations.push({
          id: op.id,
          kind: op.kind,
          label: op.label,
          actionName: op.actionName ?? null,
          status: op.status,
        })
      }
    }
    const envFilePath = covering !== null ? storeOf(covering.commonDir).envFile(covering.branch) : null
    return {
      cwd: dir,
      repositoryRoot: covering?.repositoryRoot ?? info?.root ?? dir,
      branch,
      inWorktree: covering !== null,
      worktreeId: covering?.path ?? null,
      archivedWorktree: null,
      envName: config.name ?? null,
      envSourcePath: config.sourcePath ?? null,
      envFile: envFilePath !== null && existsSync(envFilePath) ? envFilePath : null,
      actions: config.actions ?? [],
      activeOperations,
    }
  }

  /**
   * Run one named environment action in any session directory (managed worktree
   * or regular local project checkout).
   * @param {string} dir - working directory.
   * @param {string} actionName - action name.
   * @returns {Promise<{ operationId: string }>}
   */
  async startActionForDirectory(dir, actionName) {
    const absDir = resolve(dir)
    const covering = this.coveringWorktree(absDir)
    if (covering !== null) {
      return await this.startAction(covering.path, actionName)
    }
    const info = await repoInfo(this.git, absDir)
    const config = info !== null
      ? await discoverEnvConfig(this.git, absDir)
      : ((await listEnvConfigs(null, absDir)).environments.find(e => e.valid)?.environment ?? null)
    const action = config?.actions?.find(entry => entry.name === actionName)
    if (action === undefined) {
      const err = new Error(`unknown action "${actionName}" for ${absDir}`)
      err.status = 404
      throw err
    }
    let branch = ''
    if (info !== null) {
      const head = await this.git.run(absDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowedExitCodes: [0, 128] })
      if (head.exitCode === 0) branch = head.stdout.trim()
    }
    const labelScope = branch.length > 0 ? branch : basename(absDir)
    const sourceRoot = info?.root ?? absDir
    const env = {
      DSH_SOURCE_TREE_PATH: sourceRoot,
      DSH_WORKTREE_PATH: absDir,
      DSH_WORKTREE_BRANCH: branch,
    }
    return this._launchActionOperation({
      label: `${labelScope} · ${action.name}`,
      actionName: action.name,
      cwd: absDir,
      command: action.command,
      env,
    })
  }

  /**
   * Find the live mounted agent for a given session id, if currently loaded.
   * @param {string | null | undefined} sessionId
   */
  findLiveAgent(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    const agents = this.ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return null
    for (const agent of agents.list()) {
      if (agent.session?.header?.id === sessionId) return agent
    }
    return null
  }

  /**
   * Resolve a session's directory and enclosing Git repository, throwing a 400
   * HTTP-annotated error if unavailable or outside Git.
   * @param {string | null | undefined} sessionId
   * @param {string | null | undefined} fallbackCwd
   */
  async _resolveSessionRepo(sessionId, fallbackCwd) {
    const dir = this.sessionDirectory(sessionId, fallbackCwd)
    if (dir === null) {
      const err = new Error('session directory unavailable')
      err.status = 400
      throw err
    }
    const info = await repoInfo(this.git, dir)
    if (info === null) {
      const err = new Error(`not a git repository: ${dir}`)
      err.status = 400
      throw err
    }
    return { dir, info }
  }

  /**
   * Create a worktree directly with Git under `<root>/<worktreeDirectory>/<branch>`.
   * @param {string} root
   * @param {{ name?: string, from?: string, suffix?: string }} request
   * @param {AbortSignal} [signal]
   */
  async _createDirectWorktree(root, request, signal) {
    const suffix = request.suffix || 'wt'
    const branch = request.name ?? `dsh-${suffix}-${Date.now().toString(36)}`
    const revision = request.from ?? 'HEAD'
    const baseCommit = (await this.git.check(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], { signal })).trim()
    const relDir = this.worktreeDirectoryState().worktreeDirectory || DEFAULT_WORKTREE_DIRECTORY
    const wtPath = join(root, ...relDir.split('/'), branch)
    await mkdir(dirname(wtPath), { recursive: true })
    await this.git.check(root, ['worktree', 'add', '-b', branch, '--', wtPath, baseCommit], { signal })
    return { path: wtPath, branch, baseCommit, repositoryRoot: root }
  }

  /**
   * Shared serialized handoff pipeline used by both live-agent `handoff()` and
   * idle-session `handoffForSession()`.
   * @param {{
   *   root: string,
   *   commonDir: string,
   *   options: { name?: string, from?: string, carryChanges?: boolean, fetch?: boolean, runSetup?: boolean },
   *   createCheckout: () => Promise<{ path: string, branch: string, baseCommit: string, repositoryRoot: string }>,
   *   recordSessionId: string | null,
   *   pendingSessionId?: string | null,
   *   signal?: AbortSignal,
   * }} params
   */
  async _runHandoffPipeline({ root, commonDir, options, createCheckout, recordSessionId, pendingSessionId = null, signal }) {
    const operation = this.runner.begin('handoff', options.name ?? 'handoff', root)
    return await this.git.serialized(commonDir, async () => {
      if (typeof pendingSessionId === 'string' && pendingSessionId.length > 0) {
        this.pendingHandoffSessions.add(pendingSessionId)
      }
      try {
        let patch = null
        let carriedFiles = 0
        /** @type {string[]} */
        let conflicts = []
        if (options.fetch ?? this.config.upstreamRefreshMode === 'best-effort') {
          await fetchUpstream(this.git, root, (stream, text) => this.runner.log(operation, stream, text), signal)
        }
        if (options.carryChanges !== false) {
          this.runner.log(operation, 'meta', 'Packaging uncommitted changes from the source checkout…\n')
          const packaged = await packageWorkingTree(this.git, root, signal, 'HEAD', this.worktreeExcludePaths())
          patch = packaged.patch
          carriedFiles = packaged.fileCount
          this.runner.log(operation, 'meta', `Packaged ${carriedFiles} changed file(s).\n`)
        }
        const created = await createCheckout()
        this.runner.log(operation, 'meta', `Created worktree ${created.branch} at ${created.path}\n`)
        if (patch !== null) {
          const tmp = await mkdtemp(join(tmpdir(), 'dsh-wt-apply-'))
          const file = join(tmp, 'handoff.patch')
          try {
            await writeFile(file, patch, 'utf8')
            const result = await this.git.run(created.path, ['apply', '--3way', '--', file], { allowedExitCodes: [0, 1], signal })
            conflicts = detectApplyConflicts(result, 'handoff.patch')
            if (conflicts.length > 0 || result.exitCode !== 0) {
              this.runner.log(operation, 'stderr', `Carried changes applied with conflicts:\n${result.stderr}`)
            } else {
              this.runner.log(operation, 'meta', 'Carried changes applied inside the worktree.\n')
            }
          } finally {
            await rm(tmp, { recursive: true, force: true }).catch(() => {})
          }
        }
        const record = await this.registerCreated(
          { ...created, sessionId: recordSessionId },
          options.runSetup !== undefined ? { runSetup: options.runSetup } : {},
        )
        this.runner.finish(operation, conflicts.length > 0 ? 'failed' : 'succeeded')
        return { created, carriedFiles, conflicts, record }
      } catch (error) {
        this.runner.finish(operation, 'failed')
        throw error
      } finally {
        if (typeof pendingSessionId === 'string' && pendingSessionId.length > 0) {
          this.pendingHandoffSessions.delete(pendingSessionId)
        }
      }
    })
  }

  /**
   * Inspect a session's local checkout before running a UI-triggered handoff
   * into a new worktree.
   * @param {string | null | undefined} sessionId
   * @param {string | null | undefined} fallbackCwd
   * @param {AbortSignal} [signal]
   */
  async handoffInfo(sessionId, fallbackCwd, signal) {
    const { dir, info } = await this._resolveSessionRepo(sessionId, fallbackCwd)
    const status = await this.sourceCheckoutStatus(info.root, signal)
    return {
      cwd: dir,
      repositoryRoot: info.root,
      currentBranch: status.currentBranch,
      dirtyCount: status.sourceDirtyCount,
      inWorktree: this.coveringWorktree(dir) !== null,
      hasLiveAgent: this.findLiveAgent(sessionId) !== null,
    }
  }

  /**
   * Handoff triggered from the Web UI (HTTP endpoint): uses the live agent to
   * switch the session in-place when loaded, or creates the worktree directly
   * with carried uncommitted changes so the client can open a new session in it.
   * Idle-session handoffs leave `createdSessionId: null` so the untouched local
   * session is never falsely bound to the newly created worktree.
   * @param {string | null | undefined} sessionId
   * @param {string | null | undefined} fallbackCwd
   * @param {{ name?: string, from?: string, carryChanges?: boolean, fetch?: boolean, runSetup?: boolean }} [options]
   * @param {AbortSignal} [signal]
   */
  async handoffForSession(sessionId, fallbackCwd, options = {}, signal) {
    const cleanName = typeof options.name === 'string' && options.name.trim().length > 0 ? options.name.trim() : undefined
    const { info } = await this._resolveSessionRepo(sessionId, fallbackCwd)
    if (cleanName !== undefined) {
      const validation = await validateNewBranchName(this.git, info.root, cleanName, signal)
      if (!validation.ok) {
        const err = new Error(validation.message)
        err.status = validation.code === 'BRANCH_ALREADY_EXISTS' ? 409 : 400
        err.code = validation.code
        throw err
      }
    }
    const liveAgent = this.findLiveAgent(sessionId)
    if (liveAgent !== null) {
      const result = await this.handoff(liveAgent, { ...options, name: cleanName }, signal)
      return { ...result, switchedInPlace: true }
    }
    const suffix = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId.slice(0, 8) : 'wt'
    const result = await this._runHandoffPipeline({
      root: info.root,
      commonDir: info.commonDir,
      options: { ...options, name: cleanName },
      createCheckout: () => this._createDirectWorktree(info.root, { name: cleanName, from: options.from, suffix }, signal),
      recordSessionId: null,
      signal,
    })
    return { ...result, switchedInPlace: false }
  }

  /**
   * Handoff: move the calling session into a new worktree, optionally carrying
   * the current checkout's uncommitted changes and refreshing the upstream.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent - calling agent.
   * @param {{ name?: string, from?: string, carryChanges?: boolean, fetch?: boolean, runSetup?: boolean }} [options]
   * @param {AbortSignal} [signal] - cancellation.
   */
  async handoff(agent, options = {}, signal) {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const info = await repoInfo(this.git, cwd)
    if (info === null) throw new Error(`not a git repository: ${cwd}`)
    const sessionId = agent?.session?.header?.id ?? null
    return await this._runHandoffPipeline({
      root: info.root,
      commonDir: info.commonDir,
      options,
      createCheckout: () => this.createWorktree(agent, { name: options.name, from: options.from }, signal),
      recordSessionId: sessionId,
      pendingSessionId: sessionId,
      signal,
    })
  }

  /**
   * Locate the built-in `@deepseek-ai/dsh-experimental-worktree` Loader entry via `ctx.configEditor`.
   */
  nativeWorktreeConfigEntry() {
    const editor = this.ctx.get('configEditor')
    if (editor === undefined || typeof editor.entries !== 'function') return null
    const entries = editor.entries()
    return entries.find(row => row.options?.name === NATIVE_WORKTREE_PKG)
      ?? entries.find(row => row.options?.id === 'worktree')
      ?? null
  }

  /**
   * Current relative worktree directory (reading the live built-in module first
   * so UI and built-in settings stay in sync). Empty string means default `.agents/worktrees`.
   * @returns {{ worktreeDirectory: string, defaultWorktreeDirectory: string, nativeSynced: boolean }}
   */
  worktreeDirectoryState() {
    const entry = this.nativeWorktreeConfigEntry()
    if (entry !== null) {
      const live = entry.fiber?.config?.directory ?? entry.options?.config?.directory
      const dir = typeof live === 'string' && live.trim().length > 0 ? live.trim() : ''
      return {
        worktreeDirectory: dir === DEFAULT_WORKTREE_DIRECTORY ? '' : dir,
        defaultWorktreeDirectory: DEFAULT_WORKTREE_DIRECTORY,
        nativeSynced: true,
      }
    }
    const configured = typeof this.config.worktreeDirectory === 'string' ? this.config.worktreeDirectory.trim() : ''
    return {
      worktreeDirectory: configured === DEFAULT_WORKTREE_DIRECTORY ? '' : configured,
      defaultWorktreeDirectory: DEFAULT_WORKTREE_DIRECTORY,
      nativeSynced: false,
    }
  }

  /**
   * Update user-editable settings live and persist them. When `worktreeDirectory`
   * changes, validates it against the built-in worktree relative-path rule and
   * writes directly to `@deepseek-ai/dsh-experimental-worktree` via `ctx.configEditor.edit`.
   * @param {Partial<EnhanceConfig> & { worktreeDirectory?: string }} patch
   * @param {{ configFilePath?: string }} [options]
   */
  async updateConfig(patch, options = {}) {
    let dirChanged = false
    let nextDir = this.config.worktreeDirectory ?? ''
    if (typeof patch.worktreeDirectory === 'string') {
      const normalized = patch.worktreeDirectory.trim().replace(/\/+$/, '')
      if (normalized.length > 0 && !isValidRelativeWorktreeDir(normalized)) {
        const error = new Error('Worktree directory must be a project-relative path (no leading "/", ".", "..", "\\", or ":", e.g. .agents/worktrees)')
        error.status = 400
        error.code = 'INVALID_WORKTREE_DIRECTORY'
        throw error
      }
      nextDir = normalized === DEFAULT_WORKTREE_DIRECTORY ? '' : normalized
      this.config.worktreeDirectory = nextDir
      dirChanged = true
    }
    if (patch.upstreamRefreshMode === 'never' || patch.upstreamRefreshMode === 'best-effort') {
      this.config.upstreamRefreshMode = patch.upstreamRefreshMode
    }
    if (typeof patch.autoCleanupEnabled === 'boolean') {
      this.config.autoCleanupEnabled = patch.autoCleanupEnabled
    }
    if (typeof patch.keepCount === 'number' && Number.isFinite(patch.keepCount) && Math.floor(patch.keepCount) >= 1) {
      this.config.keepCount = Math.floor(patch.keepCount)
    }
    if (typeof patch.confirmBeforeDelete === 'boolean') {
      this.config.confirmBeforeDelete = patch.confirmBeforeDelete
    }

    // Sync relative directory directly to the official built-in worktree module
    // via `ctx.configEditor.edit` (which persists to cordis.patch.yml and reloads the fiber).
    if (dirChanged) {
      const editor = this.ctx.get('configEditor')
      const entry = this.nativeWorktreeConfigEntry()
      if (editor !== undefined && typeof editor.edit === 'function' && entry !== null) {
        await editor.edit(entry, (current) => {
          const next = current !== null && typeof current === 'object' ? { ...current } : {}
          if (nextDir.length > 0) next.directory = nextDir
          else delete next.directory
          return next
        })
      }
    }

    await writePersistedConfig(this.config, options.configFilePath ?? persistedConfigPath())
    return this.config
  }

  /** Relative worktree directories excluded when scanning or packaging the source tree. */
  worktreeExcludePaths() {
    const dirState = this.worktreeDirectoryState()
    const out = [DEFAULT_WORKTREE_DIRECTORY]
    if (isValidRelativeWorktreeDir(dirState.worktreeDirectory) && dirState.worktreeDirectory !== DEFAULT_WORKTREE_DIRECTORY) {
      out.push(dirState.worktreeDirectory)
    }
    return out
  }

  /**
   * Create a worktree through the native service (which uses the synced relative
   * `directory`), or directly with Git under `<repoRoot>/<worktreeDirectory>/<branch>`.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent - calling agent.
   * @param {{ name?: string, from?: string }} request
   * @param {AbortSignal} [signal] - cancellation.
   */
  async createWorktree(agent, request, signal) {
    const native = this.native
    if (native !== undefined) {
      return await native.create(agent, request, signal)
    }
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const info = await repoInfo(this.git, cwd)
    if (info === null) throw new Error(`not a git repository: ${cwd}`)
    const created = await this._createDirectWorktree(info.root, {
      name: request.name,
      from: request.from,
      suffix: agent.session.header.id.slice(0, 8),
    }, signal)
    const canonicalPath = await this.ctx.workingDirectory.set(agent, created.path, signal)
    return { ...created, path: canonicalPath }
  }

  /**
   * Inspect the source checkout's active branch and dirty file count, excluding
   * DSH's own worktree pool directory.
   * @param {string} root
   * @param {AbortSignal} [signal]
   */
  async sourceCheckoutStatus(root, signal) {
    return await sourceCheckoutStatus(this.git, root, this.worktreeDirectoryState().worktreeDirectory, signal)
  }

  /**
   * Describe the source checkout's current branch, cleanliness, and available
   * target branches for applying changes back from a worktree.
   * @param {string} id - worktree record id (or path).
   * @param {AbortSignal} [signal] - cancellation.
   */
  async backflowInfo(id, signal) {
    const record = await this.requireRecord(id)
    return await inspectBackflowInfo(this.git, record, this.worktreeDirectoryState().worktreeDirectory, signal)
  }

  /**
   * Precheck or apply the backflow patch onto the source checkout, optionally
   * switching to (or creating) a chosen target branch first.
   * @param {string} id - record id.
   * @param {{ mode?: 'branch' | 'uncommitted', dryRun?: boolean, targetBranch?: string | null, createBranch?: boolean }} [options]
   * @param {AbortSignal} [signal] - cancellation.
   */
  async applyBackflow(id, options = {}, signal) {
    const record = await this.requireRecord(id)
    const store = await this.storeOfRecord(record)
    return await this.git.serialized(store.commonDir, () => executeBackflow({
      git: this.git,
      commonDir: store.commonDir,
      record,
      configuredWorktreeDir: this.worktreeDirectoryState().worktreeDirectory,
      options,
      signal,
    }))
  }

  /**
   * Archive one worktree: cleanup, snapshot, release.
   * @param {string} id - record id.
   * @param {{ force?: boolean, snapshot?: boolean }} [options]
   * @param {AbortSignal} [signal] - cancellation.
   */
  async archive(id, options = {}, signal) {
    const record = await this.requireRecord(id)
    if (record.status === 'archived') return { archived: true, alreadyArchived: true }
    const store = await this.storeOfRecord(record)
    return await this.git.serialized(store.commonDir, async () => {
      const findings = await nestedRepositoryFindings(this.git, record.path, signal)
      if (findings.length > 0 && options.force !== true) {
        throw new Error(`refusing to archive: ${findings.join('; ')}. Keep the checkout or pass force after reviewing.`)
      }
      const operation = this.runner.begin('archive', `${record.branch} · archive`, record.path)
      try {
        const clean = await isClean(this.git, record.path, signal)
        let snapshotRef = null
        if (!clean && (options.snapshot ?? this.config.snapshotOnArchive)) {
          this.runner.log(operation, 'meta', 'Writing snapshot of uncommitted changes…\n')
          const snapshot = await writeSnapshot(this.git, record.path, snapshotIdOf(record), signal)
          snapshotRef = snapshot.ref
          this.runner.log(operation, 'meta', `Snapshot written: ${snapshot.ref}\n`)
        }
        if (this.config.autoRunCleanup) {
          const cleanup = await this.runCleanup(record, operation)
          this.runner.log(operation, 'meta', `Cleanup: ${cleanup.status}\n`)
        }
        await this.git.check(record.repositoryRoot, ['worktree', 'remove', '--force', '--', record.path], { signal })
        await this.git.check(record.repositoryRoot, ['worktree', 'prune'], { signal })
        await store.patch(record.id, { status: 'archived', snapshotRef, archivedAt: Date.now() })
        this.knownPaths.delete(record.path)
        this.runner.finish(operation, 'succeeded')
        return { archived: true, snapshotRef }
      } catch (error) {
        this.runner.finish(operation, 'failed')
        throw error
      }
    })
  }

  /**
   * Restore an archived worktree, including its snapshot uncommitted state.
   * @param {string} id - record id.
   * @param {import('@deepseek-ai/dsh-agent').Agent} [agent] - session to enter, when restoring in-place.
   * @param {AbortSignal} [signal] - cancellation.
   * @param {{ runSetup?: boolean }} [options]
   */
  async restore(id, agent, signal, options = {}) {
    const record = await this.requireRecord(id)
    const existsOnDisk = await access(record.path, constants.F_OK).then(() => true, () => false)
    if (record.status !== 'archived' && existsOnDisk) return { restored: true, alreadyActive: true }
    const store = await this.storeOfRecord(record)
    return await this.git.serialized(store.commonDir, async () => {
      const operation = this.runner.begin('restore', `${record.branch} · restore`, record.path)
      const native = this.native
      const effectiveAgent = agent
        ?? this.findLiveAgent(record.createdSessionId)
        ?? (Array.isArray(record.sessionIds) ? record.sessionIds.map(sid => this.findLiveAgent(sid)).find(Boolean) : null)
        ?? undefined
      try {
        if (native !== undefined && typeof native.restore === 'function' && effectiveAgent !== undefined) {
          try {
            await native.restore(effectiveAgent, { path: record.path, branch: record.branch, baseCommit: record.baseCommit, repositoryRoot: record.repositoryRoot }, signal)
          } catch {
            // fall back to direct git worktree add below if native.restore rejects
          }
        }
        const recreated = await access(record.path, constants.F_OK).then(() => true, () => false)
        if (!recreated) {
          const existing = await this.git.run(record.repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`], { allowedExitCodes: [0, 1], signal })
          const args = existing.exitCode === 0
            ? ['worktree', 'add', '--', record.path, record.branch]
            : ['worktree', 'add', '-b', record.branch, '--', record.path, record.baseCommit]
          await this.git.check(record.repositoryRoot, args, { signal })
        }
        if (effectiveAgent !== undefined && typeof this.ctx.workingDirectory?.set === 'function') {
          await this.ctx.workingDirectory.set(effectiveAgent, record.path, signal).catch(() => {})
        }
        let snapshotRestored = null
        let remainingSnapshotRef = null
        if (record.snapshotRef !== null) {
          const result = await restoreSnapshot(this.git, record.path, record.snapshotRef, signal)
          snapshotRestored = result
          this.runner.log(operation, 'meta', result.applied ? 'Snapshot restored into the worktree.\n' : `Snapshot restore failed: ${result.reason ?? 'unknown'}\n`)
          if (result.applied) {
            await deleteSnapshot(this.git, record.repositoryRoot, record.snapshotRef, signal).catch(() => {})
          } else {
            remainingSnapshotRef = record.snapshotRef
          }
        }
        const envConfig = await discoverEnvConfig(this.git, record.path, signal)
        const hasSetup = envConfig.setup !== null
        await store.patch(record.id, {
          status: 'active',
          snapshotRef: remainingSnapshotRef,
          archivedAt: null,
          lastAccessedAt: Date.now(),
          setupState: hasSetup ? 'none' : 'not-configured',
          setupError: null,
        })
        this.describeCache.delete(record.path)
        this.knownPaths.set(record.path, { branch: record.branch, repositoryRoot: record.repositoryRoot, commonDir: store.commonDir })
        this.runner.finish(operation, 'succeeded')
        if (hasSetup && (options.runSetup ?? this.config.autoRunSetup)) {
          void this.runSetup(record.id).catch(() => {})
        }
        return { restored: true, snapshotRestored, setupPending: hasSetup }
      } catch (error) {
        this.runner.finish(operation, 'failed')
        throw error
      }
    })
  }

  /**
   * Delete one record (and its snapshot ref) without touching a live checkout.
   * @param {string} id - record id.
   * @param {{ deleteSnapshot?: boolean }} [options]
   * @param {AbortSignal} [signal] - cancellation.
   */
  async removeRecord(id, options = {}, signal) {
    const record = await this.requireRecord(id)
    const store = await this.storeOfRecord(record)
    return await this.git.serialized(store.commonDir, async () => {
      if (record.status === 'active') {
        const exists = await access(record.path, constants.F_OK).then(() => true, () => false)
        if (exists) throw new Error('worktree still exists; archive it first')
      }
      if (options.deleteSnapshot !== false && record.snapshotRef !== null) {
        await deleteSnapshot(this.git, record.repositoryRoot, record.snapshotRef, signal)
      }
      await store.remove(id)
      this.knownPaths.delete(record.path)
      return { removed: true }
    })
  }

  /**
   * Whether `worktreePath` lives inside DSH's configured worktree directory
   * (or the default `.agents/worktrees` pool) under `repoRoot`.
   * Excludes foreign worktrees created by ChatGPT/Codex (`~/.codex/worktrees`)
   * or manual `git worktree add` outside DSH.
   * @param {string} repoRoot
   * @param {string} worktreePath
   * @returns {boolean}
   */
  isDshManagedWorktreePath(repoRoot, worktreePath) {
    const absPath = resolve(worktreePath)
    const dirState = this.worktreeDirectoryState()
    const pools = new Set([DEFAULT_WORKTREE_DIRECTORY])
    if (isValidRelativeWorktreeDir(dirState.worktreeDirectory)) {
      pools.add(dirState.worktreeDirectory)
    }
    for (const relDir of pools) {
      const poolRoot = resolve(repoRoot, ...relDir.split('/'))
      const rel = relative(poolRoot, absPath)
      if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) return true
    }
    return false
  }

  /**
   * Whether a persisted record was created by DSH (explicitly registered or
   * inside DSH's managed worktree directory).
   * @param {string} repoRoot
   * @param {import('./store.js').WorktreeRecord & { origin?: string }} record
   * @returns {boolean}
   */
  isDshOwnedRecord(repoRoot, record) {
    if (record.origin === 'dsh') return true
    if (typeof record.createdSessionId === 'string' && record.createdSessionId.length > 0) return true
    return this.isDshManagedWorktreePath(repoRoot, record.path)
  }

  /**
   * Aggregate scan of every known repository's DSH-created worktrees.
   * @param {{ withSize?: boolean }} [options]
   */
  async listAll(options = {}) {
    const roots = new Set()
    const registry = this.ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      for (const workspace of registry.list()) {
        if (typeof workspace.path === 'string' && workspace.path.length > 0) roots.add(workspace.path)
      }
    }
    for (const [, entry] of this.knownPaths) roots.add(entry.repositoryRoot)
    for (const commonDir of this.commonDirs) {
      const store = storeOf(commonDir)
      for (const record of await store.list()) roots.add(record.repositoryRoot)
    }
    /** @type {Record<string, string>} commonDir → repositoryRoot */
    const repositories = {}
    /** @type {unknown[]} */
    const items = []
    const seenCommonDirs = new Set()
    for (const root of roots) {
      const info = await repoInfo(this.git, root)
      if (info === null || seenCommonDirs.has(info.commonDir)) continue
      seenCommonDirs.add(info.commonDir)
      this.commonDirs.add(info.commonDir)
      repositories[info.commonDir] = info.root
      const store = storeOf(info.commonDir)
      const records = new Map((await store.list()).map(record => [record.id, record]))
      // Prune stale records previously auto-adopted from non-DSH worktrees (e.g. ~/.codex/worktrees).
      for (const [id, record] of [...records.entries()]) {
        if (!this.isDshOwnedRecord(info.root, record)) {
          records.delete(id)
          this.knownPaths.delete(record.path)
          void store.remove(id).catch(() => {})
        }
      }
      const porcelain = await this.git.run(info.root, ['worktree', 'list', '--porcelain'], { signal: undefined, allowedExitCodes: [0, 128] })
      if (porcelain.exitCode === 0) {
        for (const entry of parseWorktreeList(porcelain.stdout)) {
          if (entry.bare || entry.path === info.root || entry.branch === null) continue
          const existing = records.get(entry.path)
          const validHead = entry.head !== null && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(entry.head) ? entry.head : null
          if (existing !== undefined) {
            // Backfill only an unknown/invalid baseline (e.g. adopted while the
            // repository had an unborn HEAD); never overwrite a valid baseCommit
            // when the worktree branch advances with new commits.
            const hasValidBase = typeof existing.baseCommit === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(existing.baseCommit)
            if (!hasValidBase && validHead !== null) {
              await store.patch(entry.path, { baseCommit: validHead })
              existing.baseCommit = validHead
            }
            continue
          }
          // Only adopt worktrees inside DSH's own worktree pool; ignore Codex / manual worktrees.
          if (!this.isDshManagedWorktreePath(info.root, entry.path)) continue
          const head = validHead ?? 'unknown'
          /** @type {import('./store.js').WorktreeRecord} */
          const adopted = {
            id: entry.path, path: entry.path, branch: entry.branch, baseCommit: head,
            repositoryRoot: info.root, origin: 'dsh', status: 'active', createdAt: Date.now(), lastAccessedAt: Date.now(),
            createdSessionId: null, setupState: 'not-configured', setupError: null, snapshotRef: null, archivedAt: null,
          }
          records.set(entry.path, adopted)
          void store.put(adopted).catch(() => {})
        }
      }
      for (const record of records.values()) {
        const exists = await access(record.path, constants.F_OK).then(() => true, () => false)
        let changedFiles = null
        let clean = null
        if (!exists && record.status === 'active') {
          const archivedAt = record.archivedAt ?? Date.now()
          record.status = 'archived'
          record.archivedAt = archivedAt
          this.knownPaths.delete(record.path)
          void store.patch(record.id, { status: 'archived', archivedAt }).catch(() => {})
        } else if (exists && record.status === 'active') {
          const status = await this.git.run(record.path, ['status', '--porcelain'], { allowedExitCodes: [0, 128] })
          clean = status.exitCode === 0 ? status.stdout.trim().length === 0 : null
          changedFiles = status.exitCode === 0 ? status.stdout.split('\n').filter(Boolean).length : null
          this.knownPaths.set(record.path, { branch: record.branch, repositoryRoot: record.repositoryRoot, commonDir: info.commonDir })
          void this.refreshDescribe(record).catch(() => {})
        }
        items.push({
          ...record,
          exists,
          clean,
          changedFiles,
          sizeBytes: options.withSize === true && exists ? await directorySize(record.path) : null,
          busy: this.busyPaths.has(record.path),
          actions: this.describeCache.get(record.path)?.actions ?? [],
          envSourcePath: this.describeCache.get(record.path)?.sourcePath ?? null,
        })
      }
    }
    return { repositories, items }
  }

  /**
   * Live sessions per worktree path (prefix match).
   * @returns {Map<string, { sessionId: string, cwd: string }[]>}
   */
  sessionIndex() {
    /** @type {Map<string, { sessionId: string, cwd: string }[]>} */
    const index = new Map()
    const agents = this.ctx.get('agents')
    if (agents === undefined) return index
    for (const agent of agents.list()) {
      let cwd
      try {
        cwd = this.ctx.workingDirectory.get(agent.session)
      } catch {
        continue
      }
      if (cwd === undefined) continue
      for (const [path] of this.knownPaths) {
        if (cwd === path || cwd.startsWith(`${path}/`)) {
          const list = index.get(path) ?? []
          list.push({ sessionId: agent.session.header.id, cwd })
          index.set(path, list)
        }
      }
    }
    return index
  }

  /**
   * Report running setup/action activities owned by `sessionId` so host session
   * archival protects them.
   * @param {string} sessionId
   */
  sessionActivity(sessionId) {
    const index = this.sessionIndex()
    const own = []
    for (const [path, entries] of index) {
      if (entries.some(entry => entry.sessionId === sessionId) && this.busyPaths.has(path)) {
        own.push({ kind: `dsh-worktree-env setup/action (${path})`, startedAt: Date.now() })
      }
    }
    return own
  }

  /**
   * Cancel running operations belonging to worktrees owned by `sessionId`.
   * @param {string} sessionId
   */
  cancelOperationsForSession(sessionId) {
    const index = this.sessionIndex()
    const ownedPaths = new Set()
    for (const [path, entries] of index) {
      if (entries.some(entry => entry.sessionId === sessionId)) {
        ownedPaths.add(path)
      }
    }
    if (ownedPaths.size === 0) return
    for (const [id, operation] of this.runner.operations) {
      if (operation.status !== 'running') continue
      if (operation.worktreePath !== null && ownedPaths.has(operation.worktreePath)) {
        this.runner.cancel(id)
      }
    }
  }

  /** Read one tracked operation by id. */
  getOperation(id) {
    return this.runner.get(id)
  }

  /** Cancel one tracked operation by id. */
  cancelOperation(id) {
    this.runner.cancel(id)
  }

  /** Subscribe to live log entries of one tracked operation. */
  subscribeOperation(id, listener) {
    return this.runner.subscribe(id, listener)
  }

  /** Resolve the Git repository top-level directory for `root`, or null. */
  async repositoryRootOf(root) {
    const info = await repoInfo(this.git, root)
    return info?.root ?? null
  }

  /**
   * Record access to a managed worktree (updating `lastAccessedAt` and tracking
   * associated session IDs so pinned chats created inside the worktree protect it).
   * @param {string} cwd
   * @param {string | null | undefined} [sessionId]
   */
  async touchWorktreeAccess(cwd, sessionId) {
    if (typeof cwd !== 'string' || cwd.length === 0) return
    const covering = this.coveringWorktree(cwd)
    if (covering === null) return
    const store = storeOf(covering.commonDir)
    const rec = await store.get(covering.path)
    if (rec === undefined) return
    /** @type {Record<string, unknown>} */
    const patch = { lastAccessedAt: Date.now() }
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      if (rec.createdSessionId === null) patch.createdSessionId = sessionId
      const existing = Array.isArray(rec.sessionIds) ? rec.sessionIds : []
      if (!existing.includes(sessionId)) {
        patch.sessionIds = [...existing, sessionId]
      }
    }
    await store.patch(rec.id, patch).catch(() => {})
  }

  /** Whether any session associated with a worktree record is pinned. */
  _isPinnedWorktree(record, pinnedSessions) {
    if (record.createdSessionId !== null && pinnedSessions.has(record.createdSessionId)) return true
    if (Array.isArray(record.sessionIds) && record.sessionIds.some(sid => pinnedSessions.has(sid))) return true
    return false
  }

  /**
   * Handle DSH session archival: when `autoCleanupEnabled` is on, save a
   * recovery snapshot (per `snapshotOnArchive`) and clean up the archived
   * session's dedicated worktree (when not pinned, busy, or shared with another
   * active session), then run quota enforcement.
   * @param {string | null | undefined} sessionId
   */
  async handleSessionArchived(sessionId) {
    if (!this.config.autoCleanupEnabled) return { archived: 0 }
    let archived = 0
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      if (this.unarchivingSessions.has(sessionId)) {
        return { archived: 0, cancelled: true }
      }
      const { items } = await this.listAll()
      const sessions = this.sessionIndex()
      const pinnedSessions = new Set(this.ctx.get('workspaceRegistry')?.pinnedSessionIds ?? [])
      if (!pinnedSessions.has(sessionId)) {
        for (const item of items) {
          if (this.unarchivingSessions.has(sessionId)) {
            return { archived, cancelled: true }
          }
          if (item.status !== 'active' || !item.exists) continue
          if (item.createdSessionId !== sessionId) continue
          if (this.busyPaths.has(item.path)) continue
          if (this._isPinnedWorktree(item, pinnedSessions)) continue
          const liveOthers = (sessions.get(item.path) ?? []).filter(entry => entry.sessionId !== sessionId)
          if (liveOthers.length > 0) continue
          try {
            await this.archive(item.id, { snapshot: this.config.snapshotOnArchive })
            archived += 1
          } catch {
            // keep worktree intact if nested repos or git locks prevent removal
          }
        }
      }
    }
    const quota = await this.enforceQuota()
    return { archived: archived + quota.archived }
  }

  /**
   * Enforce the per-repository quota on unarchived worktrees.
   * Skips worktrees with running operations, live sessions, or pinned sessions,
   * advancing to the next oldest eligible candidate until within `keepCount`.
   */
  async enforceQuota() {
    if (!this.config.autoCleanupEnabled) return { archived: 0 }
    const { items } = await this.listAll()
    const sessions = this.sessionIndex()
    const pinnedSessions = new Set(this.ctx.get('workspaceRegistry')?.pinnedSessionIds ?? [])
    const byRepo = new Map()
    for (const item of items) {
      if (item.status !== 'active' || !item.exists) continue
      const list = byRepo.get(item.repositoryRoot) ?? []
      list.push(item)
      byRepo.set(item.repositoryRoot, list)
    }
    let archived = 0
    for (const list of byRepo.values()) {
      list.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)
      let remaining = list.length - this.config.keepCount
      for (let i = 0; i < list.length && remaining > 0; i += 1) {
        const victim = list[i]
        if (this.busyPaths.has(victim.path)) continue
        const liveSessions = sessions.get(victim.path) ?? []
        if (liveSessions.length > 0) continue
        if (this._isPinnedWorktree(victim, pinnedSessions)) continue
        try {
          await this.archive(victim.id)
          archived += 1
          remaining -= 1
        } catch {
          // nested repos or git failures keep the checkout; try the next candidate
        }
      }
    }
    return { archived }
  }

  /**
   * List all known projects (registered DSH workspaces + known git repos)
   * together with their local environment `.toml` files and remote owner.
   */
  async listEnvironmentProjects() {
    /** @type {Map<string, { root: string, title: string | null }>} */
    const rawRoots = new Map()
    const registry = this.ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      for (const workspace of registry.list()) {
        if (typeof workspace.path === 'string' && workspace.path.length > 0) {
          rawRoots.set(resolve(workspace.path), {
            root: resolve(workspace.path),
            title: typeof workspace.title === 'string' && workspace.title.trim().length > 0 ? workspace.title.trim() : null,
          })
        }
      }
    }
    for (const [, entry] of this.knownPaths) {
      const abs = resolve(entry.repositoryRoot)
      if (!rawRoots.has(abs)) rawRoots.set(abs, { root: abs, title: null })
    }
    for (const commonDir of this.commonDirs) {
      const store = storeOf(commonDir)
      for (const record of await store.list()) {
        const abs = resolve(record.repositoryRoot)
        if (!rawRoots.has(abs)) rawRoots.set(abs, { root: abs, title: null })
      }
    }

    const projects = []
    const seen = new Set()
    for (const entry of rawRoots.values()) {
      const exists = await access(entry.root, constants.F_OK).then(() => true, () => false)
      if (!exists) continue
      const info = await repoInfo(this.git, entry.root)
      const projectRoot = info !== null ? resolve(info.root) : entry.root
      if (seen.has(projectRoot)) continue
      seen.add(projectRoot)
      let owner = null
      if (info !== null) {
        const remote = await this.git.run(projectRoot, ['remote', 'get-url', 'origin'], { allowedExitCodes: [0, 2, 128] })
        if (remote.exitCode === 0) owner = parseGitRemoteOwner(remote.stdout)
      }
      if (owner === null) {
        const parent = basename(dirname(projectRoot))
        owner = parent.length > 0 ? parent : null
      }
      const { environments, nextConfigPath } = await listEnvConfigs(info !== null ? this.git : null, projectRoot)
      projects.push({
        root: projectRoot,
        name: entry.title ?? basename(projectRoot),
        owner,
        isGitRepo: info !== null,
        environments,
        nextConfigPath,
      })
    }
    return { projects }
  }

  /** Validate that `configPath` points to a managed `.agents/environments/*.toml` or the active custom path. */
  async _resolveManagedConfigPath(projectRoot, info, configPath) {
    const source = classifyManagedEnvPath(projectRoot, configPath)
    const discovered = info !== null ? await discoverEnvConfig(this.git, projectRoot) : null
    const allowedCustom = discovered?.sourcePath !== null && discovered?.sourcePath !== undefined && resolve(discovered.sourcePath) === resolve(configPath)
    if (source === null && !allowedCustom) {
      throw new Error(`configPath must point to a .toml file inside .agents/environments`)
    }
    return { abs: resolve(configPath), source }
  }

  /**
   * Read the environment config editor payload for one root (or one specific `.toml` file).
   * @param {string} root - repository or project root.
   * @param {string} [configPath] - optional specific config file path inside the project.
   */
  async readEnvironment(root, configPath) {
    const info = await repoInfo(this.git, root)
    const projectRoot = info !== null ? info.root : resolve(root)
    if (typeof configPath === 'string' && configPath.length > 0) {
      const { abs, source } = await this._resolveManagedConfigPath(projectRoot, info, configPath)
      const exists = await access(abs, constants.F_OK).then(() => true, () => false)
      const environment = exists
        ? await readEnvConfigFile(abs, source ?? 'custom')
        : {
          sourcePath: null,
          source: source ?? 'dsh',
          disabled: false,
          version: 1,
          name: basename(projectRoot),
          setup: null,
          setupScripts: {},
          cleanup: null,
          cleanupScripts: {},
          actions: [],
        }
      return { repository: info ?? { root: projectRoot }, environment, writablePath: abs }
    }
    const config = info !== null
      ? await discoverEnvConfig(this.git, projectRoot)
      : (await listEnvConfigs(null, projectRoot)).environments[0]?.environment ?? {
        sourcePath: null,
        source: null,
        disabled: false,
        version: 1,
        name: basename(projectRoot),
        setup: null,
        setupScripts: {},
        cleanup: null,
        cleanupScripts: {},
        actions: [],
      }
    return { repository: info ?? { root: projectRoot }, environment: config, writablePath: config.sourcePath ?? preferredConfigPath(projectRoot) }
  }

  /**
   * Write an environment definition for one root (optionally to a specific managed `.toml` file).
   * @param {string} root - repository or project root.
   * @param {Parameters<typeof writeEnvConfig>[1]} definition
   * @param {string} [configPath]
   */
  async writeEnvironment(root, definition, configPath) {
    const info = await repoInfo(this.git, root)
    const projectRoot = info !== null ? info.root : resolve(root)
    let target
    if (typeof configPath === 'string' && configPath.length > 0) {
      const { abs } = await this._resolveManagedConfigPath(projectRoot, info, configPath)
      target = abs
    } else {
      const config = info !== null ? await discoverEnvConfig(this.git, projectRoot) : null
      target = config?.sourcePath ?? preferredConfigPath(projectRoot)
    }
    await writeEnvConfig(target, definition)
    const saved = await readEnvConfigFile(target, classifyManagedEnvPath(projectRoot, target) ?? 'custom')
    return { writtenTo: target, environment: saved }
  }

  /**
   * Effective creation preference for one repository root.
   * Resolution order: persisted per-repo store override → plugin config `repositoryPreferences` → `defaultCreationPreference`.
   * @param {string} root - repository root.
   * @returns {Promise<'ask' | 'always' | 'never' | 'dirty'>}
   */
  async preferenceFor(root) {
    const info = await repoInfo(this.git, root)
    if (info !== null) {
      const stored = await storeOf(info.commonDir).getPreference()
      if (stored !== null) return stored
      for (const entry of this.config.repositoryPreferences) {
        if (entry.commonDir === info.commonDir || entry.root === info.root) return entry.preference
      }
    }
    return this.config.defaultCreationPreference
  }

  /**
   * Persist (or clear with null) the per-repository creation preference override.
   * @param {string} root - repository root (or any directory inside).
   * @param {'ask' | 'always' | 'never' | 'dirty' | null} preference
   */
  async setPreference(root, preference) {
    const info = await repoInfo(this.git, root)
    if (info === null) throw new Error(`not a git repository: ${root}`)
    const store = storeOf(info.commonDir)
    this.commonDirs.add(info.commonDir)
    await store.setPreference(preference)
    const effective = await this.preferenceFor(info.root)
    this.preferenceCache.set(info.root, effective)
    this.preferenceCache.set(root, effective)
    const { sourceDirty } = await this.sourceCheckoutStatus(info.root)
    const policy = { isGitRepo: true, preference: effective, dirty: sourceDirty }
    this.repoPolicyCache.set(info.root, policy)
    this.repoPolicyCache.set(root, policy)
    return { repositoryRoot: info.root, commonDir: info.commonDir, override: preference, preference: effective }
  }

  /**
   * Managed worktree covering one path, when any.
   * @param {string} path
   * @returns {{ branch: string, repositoryRoot: string, commonDir: string, path: string } | null}
   */
  coveringWorktree(path) {
    for (const [known, entry] of this.knownPaths) {
      if (path === known || path.startsWith(`${known}/`)) return { ...entry, path: known }
    }
    return null
  }

  /**
   * Environment variables injected into model shell commands inside worktrees.
   * Synchronous: the prompt and shell-env providers call it per command.
   * @param {string} path - session working directory.
   * @returns {Record<string, string> | null}
   */
  shellVariablesFor(path) {
    const covering = this.coveringWorktree(path)
    if (covering === null) return null
    const store = storeOf(covering.commonDir)
    const envFile = store.envFile(covering.branch)
    return {
      DSH_WORKTREE_SOURCE_ROOT: covering.repositoryRoot,
      DSH_WORKTREE_PATH: covering.path,
      DSH_WORKTREE_BRANCH: covering.branch,
      ...(existsSync(envFile) ? { DSH_WORKTREE_ENV_FILE: envFile } : {}),
    }
  }

  /**
   * Refresh the prompt-facing description cache for one worktree record.
   * @param {import('./store.js').WorktreeRecord} record
   * @param {{ ttlMs?: number }} [options]
   */
  async refreshDescribe(record, options = {}) {
    const cached = this.describeCache.get(record.path)
    const ttl = options.ttlMs ?? 60_000
    if (cached !== undefined && Date.now() - cached.refreshedAt < ttl) return
    try {
      const config = await discoverEnvConfig(this.git, record.path)
      this.describeCache.set(record.path, {
        refreshedAt: Date.now(),
        setupState: record.setupState,
        setupError: record.setupError,
        sourcePath: config.sourcePath,
        actions: config.actions.map(action => ({ name: action.name, icon: action.icon, command: action.command })),
      })
      if (config.setup !== null && record.setupState === 'not-configured') {
        // A config exists the record has never run; surface it as pending.
        await (await this.storeOfRecord(record)).patch(record.id, { setupState: 'none' }).catch(() => {})
      }
    } catch {
      // keep any previous entry
    }
  }

  /**
   * Synchronous snapshot for the system-prompt context provider. Caches are
   * refreshed by scans and setup runs; the provider itself must stay sync.
   * @param {string} path - session working directory.
   */
  promptSnapshot(path) {
    const covering = this.coveringWorktree(path)
    if (covering === null) return null
    const described = this.describeCache.get(covering.path) ?? null
    return {
      path: covering.path,
      branch: covering.branch,
      repositoryRoot: covering.repositoryRoot,
      setupState: described?.setupState ?? 'unknown',
      setupError: described?.setupError ?? null,
      actions: described?.actions ?? [],
      envSourcePath: described?.sourcePath ?? null,
    }
  }

  /**
   * Cached creation preference for one root; falls back to the global default
   * until {@link refreshPreference} has settled.
   * @param {string} root - repository root.
   */
  cachedPreference(root) {
    return this.preferenceCache.get(root) ?? this.config.defaultCreationPreference
  }

  /**
   * Cached Git repository & cleanliness facts used synchronously by the system
   * prompt context provider. Returns null until {@link refreshPreference} has
   * observed `cwd` as a Git repository.
   * @param {string} cwd
   * @returns {{ isGitRepo: boolean, preference: 'ask' | 'always' | 'never' | 'dirty', dirty: boolean } | null}
   */
  cachedRepoPolicy(cwd) {
    return this.repoPolicyCache.get(cwd) ?? null
  }

  /**
   * Refresh the cached preference and dirty state for one directory.
   * @param {string} root - repository root or directory.
   */
  async refreshPreference(root) {
    const info = await repoInfo(this.git, root)
    if (info === null) {
      const policy = { isGitRepo: false, preference: this.config.defaultCreationPreference, dirty: false }
      this.repoPolicyCache.set(root, policy)
      return
    }
    const preference = await this.preferenceFor(info.root)
    const { sourceDirty } = await this.sourceCheckoutStatus(info.root)
    const policy = { isGitRepo: true, preference, dirty: sourceDirty }
    this.preferenceCache.set(root, preference)
    this.preferenceCache.set(info.root, preference)
    this.repoPolicyCache.set(root, policy)
    this.repoPolicyCache.set(info.root, policy)
  }

  /**
   * Best-effort preference refresh for one agent's current directory.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   */
  async refreshPreferenceSafe(agent) {
    try {
      const cwd = this.ctx.workingDirectory.get(agent.session)
      if (typeof cwd !== 'string') return
      await this.refreshPreference(cwd)
    } catch {
      // no directory yet; nothing to cache
    }
  }

  /**
   * Refresh the index from one session event when it records a worktree creation.
   * @param {import('@deepseek-ai/dsh-session').Session} session
   * @param {import('@deepseek-ai/dsh-session').SessionEvent} event
   */
  async observeSessionEvent(session, event) {
    if (event.type !== CREATED_RECORD) return
    const sessionId = session?.header?.id
    if (typeof sessionId === 'string' && this.pendingHandoffSessions.has(sessionId)) {
      // handoff() applies carried changes before calling registerCreated(); avoid racing setup.
      return
    }
    const data = event.data
    if (data === null || typeof data !== 'object') return
    const created = data
    if (typeof created.path !== 'string' || typeof created.branch !== 'string') return
    try {
      await this.registerCreated({
        path: created.path,
        branch: created.branch,
        baseCommit: typeof created.baseCommit === 'string' ? created.baseCommit : 'unknown',
        repositoryRoot: typeof created.repositoryRoot === 'string' ? created.repositoryRoot : session.header.cwd,
        sessionId,
      })
    } catch (error) {
      // Registration failures must never break the session feed.
      void error
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<import('./store.js').WorktreeRecord>}
   */
  async requireRecord(id) {
    const candidates = new Set(this.commonDirs)
    const covering = this.coveringWorktree(id)
    if (covering !== null) candidates.add(covering.commonDir)
    const info = await this.findRepoInfoAscending(id)
    if (info !== null) {
      this.commonDirs.add(info.commonDir)
      candidates.add(info.commonDir)
    }
    for (const workspaceHint of this.workspaceRoots()) {
      const repo = await repoInfo(this.git, workspaceHint).catch(() => null)
      if (repo !== null) candidates.add(repo.commonDir)
    }
    for (const commonDir of candidates) {
      const record = await storeOf(commonDir).get(id)
      if (record !== undefined) return record
    }
    throw new Error(`unknown worktree: ${id}`)
  }

  /**
   * Workspace paths from the registry, when mounted.
   * @returns {string[]}
   */
  workspaceRoots() {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return []
    const out = []
    for (const workspace of registry.list()) {
      if (typeof workspace.path === 'string' && workspace.path.length > 0) out.push(workspace.path)
    }
    return out
  }

  /**
   * Open the store of one record's repository, registering the common dir.
   * @param {import('./store.js').WorktreeRecord} record
   */
  async storeOfRecord(record) {
    const info = await repoInfo(this.git, record.repositoryRoot)
    if (info === null) throw new Error(`repository root is gone: ${record.repositoryRoot}`)
    this.commonDirs.add(info.commonDir)
    this.knownPaths.set(record.path, { branch: record.branch, repositoryRoot: record.repositoryRoot, commonDir: info.commonDir })
    return storeOf(info.commonDir)
  }

  /**
   * Base environment for scripts executed in one worktree.
   * @param {import('./store.js').WorktreeRecord} record
   */
  scriptEnv(record) {
    return {
      DSH_SOURCE_TREE_PATH: record.repositoryRoot,
      DSH_WORKTREE_PATH: record.path,
      DSH_WORKTREE_BRANCH: record.branch,
    }
  }
}

/**
 * Derive a filesystem-safe snapshot id for one record.
 * @param {import('./store.js').WorktreeRecord} record
 */
function snapshotIdOf(record) {
  return record.branch.replace(/[^A-Za-z0-9._-]+/g, '-')
}
