/**
 * Git command execution over `ctx.subprocess` with bounded output collection,
 * deadlines, cancellation, and the same Git selector clearing the native
 * worktree service applies. Long-running commands can stream live output.
 *
 * @module
 */

/** Environment tombstones that clear inherited repository selectors. */
const GIT_ENV = {
  ...Object.fromEntries([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
  ].map(key => [key, undefined])),
  LC_MESSAGES: 'C',
  LANGUAGE: 'C',
}

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_GRACE_MS = 3_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * One failed Git command.
 */
export class GitError extends Error {
  /**
   * @param {string} argv0 - the failing command label.
   * @param {{ exitCode: number | null, signal: string | null, stderr: string }} outcome - process facts.
   */
  constructor(argv0, outcome) {
    super(`git command failed (${outcome.signal ?? outcome.exitCode}): ${outcome.stderr.trim().slice(0, 2000)}`)
    this.name = 'GitError'
    this.exitCode = outcome.exitCode
    this.signal = outcome.signal
    this.stderr = outcome.stderr
  }
}

/**
 * Collect a piped stream into a string, forwarding chunks to an optional
 * live consumer and truncating at `maxBytes`.
 * @param {import('node:stream').Readable | undefined} stream - piped output.
 * @param {(chunk: string) => void} [onChunk] - live consumer.
 * @param {number} [maxBytes] - truncation bound.
 * @returns {Promise<string>} the collected text.
 */
export function drainStream(stream, onChunk, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  if (stream === undefined) return Promise.resolve('')
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      total += chunk.length
      if (total <= maxBytes) chunks.push(Buffer.from(chunk, 'utf8'))
      if (onChunk !== undefined) onChunk(chunk)
    })
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', finish)
  })
}

/**
 * Confined, cancellable Git runner for one Host context.
 */
export class GitRunner {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - Host context providing `subprocess`.
   * @param {{ gitCommand?: string, timeoutMs?: number, graceMs?: number, maxOutputBytes?: number }} [options]
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.gitCommand = options.gitCommand ?? 'git'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    /** @type {Map<string, Promise<unknown>>} per-repository write queue */
    this._locks = new Map()
  }

  /**
   * Serialize mutating Git operations targeting the same repository common dir
   * to prevent concurrent `.git/index.lock` and worktree metadata races.
   * @template T
   * @param {string} key - repository commonDir or root.
   * @param {() => Promise<T>} fn - exclusive body.
   * @returns {Promise<T>}
   */
  async serialized(key, fn) {
    const prev = this._locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const settled = next.then(() => undefined, () => undefined)
    this._locks.set(key, settled)
    try {
      return await next
    } finally {
      if (this._locks.get(key) === settled) this._locks.delete(key)
    }
  }

  /**
   * Resolve the Git executable once for this runner.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} executable path or name.
   */
  async executable(signal) {
    if (this._program === undefined) {
      this._program = await this.ctx.subprocess.resolveExecutable(this.gitCommand, undefined, signal ?? new AbortController().signal)
    }
    return this._program
  }

  /**
   * Run one Git argv and collect both streams.
   * @param {string} cwd - working directory.
   * @param {readonly string[]} args - Git arguments after the executable.
   * @param {{ allowedExitCodes?: readonly number[], env?: Record<string, string | undefined>, signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>} complete output.
   */
  async run(cwd, args, options = {}) {
    const signal = options.signal
    const timeout = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
    ])
    const program = await this.executable(timeout)
    const child = this.ctx.subprocess.spawn({
      argv: [program, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      cwd,
      env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', ...(options.env ?? {}) },
      graceMs: this.graceMs,
      signal: timeout,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    const stdout = drainStream(child.stdout, undefined, this.maxOutputBytes)
    const stderr = drainStream(child.stderr, undefined, this.maxOutputBytes)
    try {
      const outcome = await child.done
      return { stdout: await stdout, stderr: await stderr, exitCode: outcome.exitCode ?? -1 }
    } finally {
      child.terminate()
      await child.waitForExit().catch(() => false)
    }
  }

  /**
   * Run Git and require an allowed exit code, returning stdout.
   * @param {string} cwd - working directory.
   * @param {readonly string[]} args - Git arguments.
   * @param {{ allowedExitCodes?: readonly number[], env?: Record<string, string | undefined>, signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<string>} stdout text.
   * @throws {GitError} when every allowed exit code misses.
   */
  async check(cwd, args, options = {}) {
    const allowed = options.allowedExitCodes ?? [0]
    const result = await this.run(cwd, args, options)
    if (!allowed.includes(result.exitCode)) {
      throw new GitError(`git ${args[0] ?? ''}`.trim(), { exitCode: result.exitCode, signal: null, stderr: result.stderr })
    }
    return result.stdout
  }
}

/**
 * Repository facts for one directory.
 * @property {string} root - absolute repository root.
 * @property {string} commonDir - absolute git common directory.
 * @property {string} gitDir - absolute per-checkout git directory.
 */
/**
 * Resolve repository facts for a directory.
 * @param {GitRunner} git - runner.
 * @param {string} cwd - any directory inside the repository.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ root: string, commonDir: string, gitDir: string } | null>} null outside a repository.
 */
export async function repoInfo(git, cwd, signal) {
  try {
    const root = (await git.check(cwd, ['rev-parse', '--show-toplevel'], { signal })).trim()
    const gitDir = (await git.check(cwd, ['rev-parse', '--absolute-git-dir'], { signal })).trim()
    const commonDir = (await git.check(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { signal })).trim()
    if (root.length === 0 || gitDir.length === 0 || commonDir.length === 0) return null
    return { root, commonDir, gitDir }
  } catch {
    return null
  }
}

/**
 * Parse `git worktree list --porcelain` output.
 * @param {string} text - porcelain output.
 * @returns {{ path: string, head: string | null, branch: string | null, bare: boolean, detached: boolean }[]}
 */
export function parseWorktreeList(text) {
  /** @type {{ path: string, head: string | null, branch: string | null, bare: boolean, detached: boolean }[]} */
  const out = []
  for (const block of text.split('\n\n')) {
    let path = null
    let head = null
    let branch = null
    let bare = false
    let detached = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'bare') bare = true
      else if (line === 'detached') detached = true
    }
    if (path !== null) out.push({ path, head, branch, bare, detached })
  }
  return out
}
