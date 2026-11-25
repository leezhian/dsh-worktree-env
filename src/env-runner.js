/**
 * Execution engine for environment scripts (`setup`, `cleanup`, `actions`)
 * with live log streaming, cancellation, timeouts, and POSIX environment-delta
 * capture. Operations are tracked in a registry the SSE endpoint replays.
 *
 * @module
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainStream } from './git.js'

/** Environment keys that never enter a captured delta. */
const VOLATILE_KEYS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'SSH_AUTH_SOCK', 'TMPDIR', 'TMP', 'TEMP'])
const SENSITIVE_KEY = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i
const MAX_LOG_CHARS = 400_000

/**
 * One tracked execution.
 * @typedef {Object} Operation
 * @property {string} id
 * @property {'setup' | 'cleanup' | 'action' | 'fetch' | 'archive' | 'restore' | 'handoff' | 'apply-patch'} kind
 * @property {string} label - human-readable target label.
 * @property {string | null} worktreePath - owning worktree path, when scoped to one checkout.
 * @property {number} startedAt
 * @property {number | null} endedAt
 * @property {'running' | 'succeeded' | 'failed' | 'cancelled'} status
 * @property {{ stream: 'stdout' | 'stderr' | 'meta', text: string, time: number }[]} logs
 * @property {AbortController} controller
 * @property {Set<(entry: Operation['logs'][number]) => void>} listeners
 */

let operationCounter = 0

/**
 * Registry and executor for environment operations.
 */
export class EnvRunner {
  constructor() {
    /** @type {Map<string, Operation>} */
    this.operations = new Map()
    this.order = []
  }

  /**
   * Begin one operation (tracking only; no process).
   * @param {Operation['kind']} kind
   * @param {string} label
   * @param {string | null} [worktreePath]
   * @returns {Operation}
   */
  begin(kind, label, worktreePath = null) {
    operationCounter += 1
    const id = `op-${Date.now().toString(36)}-${operationCounter.toString(36)}`
    /** @type {Operation} */
    const operation = {
      id, kind, label, worktreePath, startedAt: Date.now(), endedAt: null, status: 'running',
      logs: [], controller: new AbortController(), listeners: new Set(),
    }
    this.operations.set(id, operation)
    this.order.push(id)
    while (this.order.length > 200) {
      const oldest = this.order[0]
      if (this.operations.get(oldest)?.status === 'running') break
      this.order.shift()
      this.operations.delete(oldest)
    }
    return operation
  }

  /**
   * Append one log entry and notify subscribers.
   * @param {Operation} operation
   * @param {Operation['logs'][number]['stream']} stream
   * @param {string} text
   */
  log(operation, stream, text) {
    const entry = { stream, text, time: Date.now() }
    const total = operation.logs.reduce((sum, item) => sum + item.text.length, 0)
    if (total + text.length <= MAX_LOG_CHARS) operation.logs.push(entry)
    for (const listener of operation.listeners) {
      try {
        listener(entry)
      } catch {
        // listener errors must not break the run
      }
    }
  }

  /**
   * Finish one operation.
   * @param {Operation} operation
   * @param {Exclude<Operation['status'], 'running'>} status
   */
  finish(operation, status) {
    operation.status = status
    operation.endedAt = Date.now()
  }

  /**
   * Subscribe to live log entries of one operation.
   * @param {string} id
   * @param {(entry: Operation['logs'][number]) => void} listener
   * @returns {() => void} disposer.
   */
  subscribe(id, listener) {
    const operation = this.operations.get(id)
    if (operation === undefined) return () => {}
    operation.listeners.add(listener)
    return () => operation.listeners.delete(listener)
  }

  /**
   * Read one operation.
   * @param {string} id
   */
  get(id) {
    return this.operations.get(id)
  }

  /**
   * Cancel one running operation.
   * @param {string} id
   */
  cancel(id) {
    const operation = this.operations.get(id)
    if (operation !== undefined && operation.status === 'running') {
      operation.controller.abort(new Error('cancelled by user'))
      this.log(operation, 'meta', 'Cancellation requested.')
    }
  }

  /**
   * Run a shell script for one worktree environment.
   * @param {Object} input
   * @param {import('@deepseek-ai/cordis').Context} input.ctx - Host context providing `subprocess`.
   * @param {Operation} input.operation - tracking operation.
   * @param {string} input.cwd - working directory.
   * @param {string} input.script - shell script text.
   * @param {Record<string, string>} [input.env] - extra environment.
   * @param {number} [input.timeoutMs] - deadline; 0 disables.
   * @param {boolean} [input.captureEnv] - capture the POSIX env delta.
   * @returns {Promise<{ status: 'succeeded' | 'failed' | 'cancelled', exitCode: number, capturedEnv: Record<string, string> }>}
   */
  async runScript({ ctx, operation, cwd, script, env = {}, timeoutMs = 0, captureEnv = false }) {
    let captureDir = null
    let effectiveScript = script
    if (captureEnv && process.platform !== 'win32') {
      captureDir = await mkdtemp(join(tmpdir(), 'dsh-worktree-env-'))
      effectiveScript = [
        `__DSH_CAPTURE_DIR='${captureDir.replace(/'/g, `'\\''`)}'`,
        'env -0 > "$__DSH_CAPTURE_DIR/before.env" 2>/dev/null || true',
        script,
        '__DSH_STATUS=$?',
        'if [ "$__DSH_STATUS" -eq 0 ]; then env -0 > "$__DSH_CAPTURE_DIR/after.env" 2>/dev/null || true; fi',
        'exit $__DSH_STATUS',
        '',
      ].join('\n')
    }
    const signal = operation.controller.signal
    /** @type {import('@deepseek-ai/dsh-subprocess').SubprocessHandle | null} */
    let child = null
    try {
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', effectiveScript] : ['-c', effectiveScript]
      const program = await ctx.subprocess.resolveExecutable(shell, undefined, signal)
      const timeout = timeoutMs > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal
      child = ctx.subprocess.spawn({
        argv: [program, ...shellArgs],
        cwd,
        env: { ...env, ...(captureDir !== null ? { __DSH_CAPTURE_DIR: captureDir } : {}) },
        graceMs: 3_000,
        signal: timeout,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      })
      const drain = (stream, label) => drainStream(stream, (chunk) => {
        for (const line of chunk.split('\n')) {
          if (line.length > 0 || chunk.includes('\n')) this.log(operation, label, line.endsWith('\r') ? `${line}\n` : `${line}\n`)
        }
      })
      const stdout = drain(child.stdout, 'stdout')
      const stderr = drain(child.stderr, 'stderr')
      const outcome = await child.done
      await Promise.all([stdout, stderr])
      const aborted = signal.aborted || timeout.aborted && !outcome.exitCode
      const exitCode = outcome.exitCode ?? -1
      let capturedEnv = {}
      if (captureDir !== null && outcome.exitCode === 0 && !signal.aborted) {
        capturedEnv = await diffCapturedEnv(captureDir)
      }
      const status = signal.aborted ? 'cancelled' : outcome.exitCode === 0 ? 'succeeded' : aborted ? 'cancelled' : 'failed'
      if (status === 'failed') this.log(operation, 'meta', `Script exited with code ${exitCode}.`)
      return { status, exitCode, capturedEnv }
    } catch (error) {
      if (signal.aborted) {
        this.log(operation, 'meta', 'Script cancelled.')
        return { status: 'cancelled', exitCode: -1, capturedEnv: {} }
      }
      this.log(operation, 'stderr', `${error instanceof Error ? error.message : String(error)}\n`)
      return { status: 'failed', exitCode: -1, capturedEnv: {} }
    } finally {
      if (child !== null) {
        child.terminate()
        await child.waitForExit().catch(() => false)
      }
      if (captureDir !== null) await rm(captureDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Compute the environment delta from before/after `env -0` dumps.
 * @param {string} dir - capture directory.
 * @returns {Promise<Record<string, string>>} new or changed, non-sensitive keys.
 */
export async function diffCapturedEnv(dir) {
  const read = async (name) => {
    try {
      const text = await readFile(join(dir, name), 'utf8')
      /** @type {Record<string, string>} */
      const map = {}
      for (const entry of text.split('\0')) {
        const separator = entry.indexOf('=')
        if (separator <= 0) continue
        map[entry.slice(0, separator)] = entry.slice(separator + 1)
      }
      return map
    } catch {
      return {}
    }
  }
  const before = await read('before.env')
  const after = await read('after.env')
  /** @type {Record<string, string>} */
  const delta = {}
  for (const [key, value] of Object.entries(after)) {
    if (before[key] === value) continue
    if (VOLATILE_KEYS.has(key) || key.startsWith('DSH_') || key.startsWith('CODEX_') || key.startsWith('__DSH')) continue
    if (SENSITIVE_KEY.test(key)) continue
    delta[key] = value
  }
  return delta
}
