/**
 * WorktreeEnhanceService: the Host orchestration layer every consumer (agent
 * tools, HTTP API, prompt context) shares. It layers on the optional native
 * `ctx.worktrees` service and degrades to direct Git when that is absent.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { access, constants, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { GitRunner, parseWorktreeList, repoInfo } from './git.js'
import { classifyManagedEnvPath, discoverEnvConfig, listEnvConfigs, parseGitRemoteOwner, preferredConfigPath, readEnvConfigFile, writeEnvConfig } from './env-config.js'
import { EnvRunner } from './env-runner.js'
import { applyPatches, backflowPatch, fetchUpstream, packageWorkingTree, precheckPatches } from './transfer.js'
import { deleteSnapshot, directorySize, isClean, nestedRepositoryFindings, restoreSnapshot, writeSnapshot } from './snapshot.js'
import { storeOf } from './store.js'

const CREATED_RECORD = 'plugin:worktree/created'
const NATIVE_WORKTREE_PKG = '@deepseek-ai/dsh-experimental-worktree'
const DEFAULT_WORKTREE_DIRECTORY = '.agents/worktrees'

function isValidRelativeDir(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.includes(':')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

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
  static inject = ['subprocess', 'workingDirectory']

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
    const env = this.scriptEnv(record)
    const captured = await store.readEnv(record.branch)
    if (captured !== null) Object.assign(env, captured)
    void (async () => {
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
      } catch (error) {
        this.runner.log(operation, 'stderr', `${error instanceof Error ? error.message : String(error)}\n`)
        await store.patch(record.id, { setupState: 'failed', setupError: error instanceof Error ? error.message : String(error) }).catch(() => {})
        this.runner.finish(operation, 'failed')
      } finally {
        this.busyPaths.delete(record.path)
      }
    })()
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
    const env = this.scriptEnv(record)
    const captured = await store.readEnv(record.branch)
    if (captured !== null) Object.assign(env, captured)
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
      return { operationId: operation.id, status: result.status, capturedEnvCount: Object.keys(result.capturedEnv).length }
    } finally {
      this.busyPaths.delete(record.path)
    }
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
    const operation = this.runner.begin('action', `${record.branch} · ${action.name}`, record.path)
    const store = await this.storeOfRecord(record)
    const env = this.scriptEnv(record)
    const captured = await store.readEnv(record.branch)
    if (captured !== null) Object.assign(env, captured)
    this.busyPaths.add(record.path)
    void (async () => {
      try {
        this.runner.log(operation, 'meta', `Running "${action.name}" in ${record.path}\n`)
        const result = await this.runner.runScript({
          ctx: this.ctx, operation, cwd: record.path, script: action.command, env,
          timeoutMs: this.config.setupTimeoutMs, captureEnv: false,
        })
        this.runner.finish(operation, result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed')
      } finally {
        this.busyPaths.delete(record.path)
        await store.patch(record.id, { lastAccessedAt: Date.now() }).catch(() => {})
      }
    })()
    return { operationId: operation.id }
  }

  /**
   * Handoff: move the calling session into a new worktree, optionally carrying
   * the current checkout's uncommitted changes and refreshing the upstream.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent - calling agent.
   * @param {{ name?: string, from?: string, carryChanges?: boolean, fetch?: boolean }} [options]
   * @param {AbortSignal} [signal] - cancellation.
   */
  async handoff(agent, options = {}, signal) {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const info = await repoInfo(this.git, cwd)
    if (info === null) throw new Error(`not a git repository: ${cwd}`)
    const root = info.root
    const operation = this.runner.begin('handoff', options.name ?? 'handoff', root)
    return await this.git.serialized(info.commonDir, async () => {
      try {
        let patch = null
        let carriedFiles = 0
        if (options.fetch ?? this.config.upstreamRefreshMode === 'best-effort') {
          await fetchUpstream(this.git, root, (stream, text) => this.runner.log(operation, stream, text), signal)
        }
        if (options.carryChanges !== false) {
          this.runner.log(operation, 'meta', 'Packaging uncommitted changes from the source checkout…\n')
          const packaged = await packageWorkingTree(this.git, root, signal)
          patch = packaged.patch
          carriedFiles = packaged.fileCount
          this.runner.log(operation, 'meta', `Packaged ${carriedFiles} changed file(s).\n`)
        }
        const created = await this.createWorktree(agent, { name: options.name, from: options.from }, signal)
        this.runner.log(operation, 'meta', `Created worktree ${created.branch} at ${created.path}\n`)
        if (patch !== null) {
          const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
          const { tmpdir } = await import('node:os')
          const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-apply-'))
          const file = join(dir, 'handoff.patch')
          try {
            await writeFile(file, patch, 'utf8')
            const result = await this.git.run(created.path, ['apply', '--3way', '--', file], { allowedExitCodes: [0, 1], signal })
            if (result.exitCode !== 0) {
              this.runner.log(operation, 'stderr', `Carried changes applied with conflicts:\n${result.stderr}`)
            } else {
              this.runner.log(operation, 'meta', 'Carried changes applied inside the worktree.\n')
            }
          } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {})
          }
        }
        const record = await this.registerCreated({ ...created, sessionId: agent.session.header.id }, { runSetup: true })
        this.runner.finish(operation, 'succeeded')
        return { created, carriedFiles, record }
      } catch (error) {
        this.runner.finish(operation, 'failed')
        throw error
      }
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
      if (normalized.length > 0 && !isValidRelativeDir(normalized)) {
        throw new Error('工作树目录必须是项目内的相对路径，不能以 / 开头或包含 . / .. / \\ / :（例如 .agents/worktrees 或 .worktrees）')
      }
      nextDir = normalized === DEFAULT_WORKTREE_DIRECTORY ? '' : normalized
      this.config.worktreeDirectory = nextDir
      dirChanged = true
    }
    if (patch.upstreamRefreshMode === 'never' || patch.upstreamRefreshMode === 'best-effort') {
      this.config.upstreamRefreshMode = patch.upstreamRefreshMode
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

    const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
    const file = options.configFilePath ?? join(dshHome, 'plugins', 'dsh-worktree-env', 'config.json')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({
      worktreeDirectory: this.config.worktreeDirectory ?? '',
      upstreamRefreshMode: this.config.upstreamRefreshMode,
      keepCount: this.config.keepCount,
      confirmBeforeDelete: this.config.confirmBeforeDelete,
    }, null, 2), 'utf8')
    return this.config
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
    const branch = request.name ?? `dsh-${agent.session.header.id.slice(0, 8)}-${Date.now().toString(36)}`
    const revision = request.from ?? 'HEAD'
    const baseCommit = (await this.git.check(info.root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], { signal })).trim()
    const relDir = typeof this.config.worktreeDirectory === 'string' && isValidRelativeDir(this.config.worktreeDirectory)
      ? this.config.worktreeDirectory
      : DEFAULT_WORKTREE_DIRECTORY
    const path = join(info.root, ...relDir.split('/'), branch)
    await mkdir(dirname(path), { recursive: true })
    await this.git.check(info.root, ['worktree', 'add', '-b', branch, '--', path, baseCommit], { signal })
    const canonicalPath = await this.ctx.workingDirectory.set(agent, path, signal)
    return { path: canonicalPath, branch, baseCommit, repositoryRoot: info.root }
  }

  /**
   * Precheck or apply the backflow patch onto the source checkout.
   * @param {string} id - record id.
   * @param {{ mode?: 'branch' | 'uncommitted', dryRun?: boolean }} [options]
   * @param {AbortSignal} [signal] - cancellation.
   */
  async applyBackflow(id, options = {}, signal) {
    const record = await this.requireRecord(id)
    const store = await this.storeOfRecord(record)
    return await this.git.serialized(store.commonDir, async () => {
      const mode = options.mode ?? 'branch'
      const { patches, fileCount } = await backflowPatch(this.git, record, mode, signal)
      if (patches.length === 0) {
        return { applied: false, fileCount: 0, conflicts: [], message: 'No changes to apply.' }
      }
      const precheck = await precheckPatches(this.git, record.repositoryRoot, patches, signal)
      if (options.dryRun === true || !precheck.ok) {
        return { applied: false, fileCount, conflicts: precheck.conflicts, message: options.dryRun === true ? 'Dry run: patches would apply cleanly.' : undefined }
      }
      await applyPatches(this.git, record.repositoryRoot, patches, signal)
      return { applied: true, fileCount, conflicts: [], message: `Applied ${fileCount} changed file(s) onto ${record.repositoryRoot}.` }
    })
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
    if (record.status !== 'archived') return { restored: true, alreadyActive: true }
    const store = await this.storeOfRecord(record)
    return await this.git.serialized(store.commonDir, async () => {
      const operation = this.runner.begin('restore', `${record.branch} · restore`, record.path)
      const native = this.native
      try {
        if (native !== undefined && agent !== undefined) {
          await native.restore(agent, { path: record.path, branch: record.branch, baseCommit: record.baseCommit, repositoryRoot: record.repositoryRoot }, signal)
        } else {
          const existing = await this.git.run(record.repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`], { allowedExitCodes: [0, 1], signal })
          const args = existing.exitCode === 0
            ? ['worktree', 'add', '--', record.path, record.branch]
            : ['worktree', 'add', '-b', record.branch, '--', record.path, record.baseCommit]
          await this.git.check(record.repositoryRoot, args, { signal })
        }
        let snapshotRestored = null
        if (record.snapshotRef !== null) {
          const result = await restoreSnapshot(this.git, record.path, record.snapshotRef, signal)
          snapshotRestored = result
          this.runner.log(operation, 'meta', result.applied ? 'Snapshot restored into the worktree.\n' : `Snapshot restore failed: ${result.reason ?? 'unknown'}\n`)
        }
        const envConfig = await discoverEnvConfig(this.git, record.path, signal)
        const hasSetup = envConfig.setup !== null
        await store.patch(record.id, {
          status: 'active',
          snapshotRef: null,
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
    if (typeof dirState.worktreeDirectory === 'string' && isValidRelativeDir(dirState.worktreeDirectory)) {
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
        if (exists && record.status === 'active') {
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
   * Enforce the per-repository quota on unarchived worktrees.
   * Skips worktrees with running operations, live sessions, or pinned sessions.
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
      const excess = list.length - this.config.keepCount
      for (let i = 0; i < excess; i += 1) {
        const victim = list[i]
        if (this.busyPaths.has(victim.path)) continue
        const liveSessions = sessions.get(victim.path) ?? []
        if (liveSessions.length > 0) continue
        if (victim.createdSessionId !== null && pinnedSessions.has(victim.createdSessionId)) continue
        try {
          await this.archive(victim.id)
          archived += 1
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

  /**
   * Read the environment config editor payload for one root (or one specific `.toml` file).
   * @param {string} root - repository or project root.
   * @param {string} [configPath] - optional specific config file path inside the project.
   */
  async readEnvironment(root, configPath) {
    const info = await repoInfo(this.git, root)
    const projectRoot = info !== null ? info.root : resolve(root)
    if (typeof configPath === 'string' && configPath.length > 0) {
      const source = classifyManagedEnvPath(projectRoot, configPath)
      const discovered = info !== null ? await discoverEnvConfig(this.git, projectRoot) : null
      const allowedCustom = discovered?.sourcePath !== null && discovered?.sourcePath !== undefined && resolve(discovered.sourcePath) === resolve(configPath)
      if (source === null && !allowedCustom) {
        throw new Error(`configPath must point to a .toml file inside .agents/environments`)
      }
      const abs = resolve(configPath)
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
      const source = classifyManagedEnvPath(projectRoot, configPath)
      const discovered = info !== null ? await discoverEnvConfig(this.git, projectRoot) : null
      const allowedCustom = discovered?.sourcePath !== null && discovered?.sourcePath !== undefined && resolve(discovered.sourcePath) === resolve(configPath)
      if (source === null && !allowedCustom) {
        throw new Error(`configPath must point to a .toml file inside .agents/environments`)
      }
      target = resolve(configPath)
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
    return { repositoryRoot: info.root, commonDir: info.commonDir, override: preference, preference: effective }
  }

  /**
   * Whether a worktree path is known to the index.
   * @param {string} path
   * @returns {boolean}
   */
  isManagedPath(path) {
    for (const [known] of this.knownPaths) {
      if (path === known || path.startsWith(`${known}/`)) return true
    }
    return false
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
   * Refresh the cached preference for one root.
   * @param {string} root - repository root.
   */
  async refreshPreference(root) {
    this.preferenceCache.set(root, await this.preferenceFor(root))
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
        sessionId: session.header.id,
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
    const info = await repoInfo(this.git, id).catch(() => null)
    if (info !== null) {
      candidates.add(info.commonDir)
      // the record's repository may differ from the checkout's own repo when id is a root
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
      CODEX_SOURCE_TREE_PATH: record.repositoryRoot,
      DSH_WORKTREE_PATH: record.path,
      CODEX_WORKTREE_PATH: record.path,
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
