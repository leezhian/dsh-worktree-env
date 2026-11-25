/**
 * Per-repository persistence: `<git-common-dir>/dsh-worktree/state.json` holds
 * the managed-worktree registry (including archived entries with snapshot
 * refs), and `<git-common-dir>/dsh-worktree/<branch>.env` holds captured
 * environment deltas. Writes are atomic and serialized per repository.
 *
 * @module
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * One managed worktree record. Plain JSON, tolerant of unknown fields.
 * @typedef {Object} WorktreeRecord
 * @property {string} id - stable id: the checkout directory path.
 * @property {string} path - canonical checkout directory.
 * @property {string} branch - branch name.
 * @property {string} baseCommit - commit the branch started from.
 * @property {string} repositoryRoot - canonical source repository root.
 * @property {'active' | 'archived'} status - lifecycle state.
 * @property {number} createdAt - epoch milliseconds.
 * @property {number} lastAccessedAt - epoch milliseconds of last observed use.
 * @property {string | null} createdSessionId - session that created it, when known.
 * @property {'none' | 'running' | 'succeeded' | 'failed' | 'not-configured'} setupState
 * @property {string | null} setupError - last setup failure summary.
 * @property {string | null} snapshotRef - snapshot ref written at archive time.
 * @property {number | null} archivedAt - epoch milliseconds.
 */

/**
 * Repository-scoped store with an in-process write mutex.
 */
export class RepoStore {
  /**
   * @param {string} commonDir - absolute git common directory.
   */
  constructor(commonDir) {
    this.commonDir = commonDir
    this.dir = join(commonDir, 'dsh-worktree-env')
    this.legacyDir = join(commonDir, 'dsh-worktree')
    this.stateFile = join(this.dir, 'state.json')
    /** @type {Map<string, WorktreeRecord>} */
    this.records = new Map()
    /** @type {'ask' | 'always' | 'never' | 'dirty' | null} */
    this.preference = null
    this.loaded = false
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve()
  }

  /**
   * Load state from disk once; later calls are no-ops unless `force`.
   * Falls back to reading the legacy `<commonDir>/dsh-worktree/state.json` if present.
   * @param {{ force?: boolean }} [options]
   */
  async load(options = {}) {
    if (this.loaded && !options.force) return
    let text = null
    for (const candidate of [this.stateFile, join(this.legacyDir, 'state.json')]) {
      try {
        text = await readFile(candidate, 'utf8')
        break
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
          throw error
        }
      }
    }
    this.records = new Map()
    this.preference = null
    if (text !== null) {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') {
        if (Array.isArray(parsed.records)) {
          for (const record of parsed.records) {
            if (record !== null && typeof record === 'object' && typeof record.id === 'string') {
              this.records.set(record.id, record)
            }
          }
        }
        if (typeof parsed.preference === 'string' && ['ask', 'always', 'never', 'dirty'].includes(parsed.preference)) {
          this.preference = parsed.preference
        }
      }
    }
    this.loaded = true
  }

  /**
   * Serialize one exclusive mutation of the registry.
   * @param {() => Promise<void> | void} body - mutation; the queued write persists afterwards.
   */
  async update(body) {
    const run = this.queue.then(async () => {
      await this.load()
      await body()
      await this.persist()
    })
    this.queue = run.catch(() => {})
    await run
  }

  /**
   * Read-only snapshot of the registry (loaded first).
   * @returns {Promise<WorktreeRecord[]>} records in insertion order.
   */
  async list() {
    await this.load()
    return [...this.records.values()]
  }

  /**
   * Fetch one record by id.
   * @param {string} id - record id (checkout path).
   * @returns {Promise<WorktreeRecord | undefined>}
   */
  async get(id) {
    await this.load()
    return this.records.get(id)
  }

  /**
   * Upsert one record and persist.
   * @param {WorktreeRecord} record - complete record.
   */
  async put(record) {
    await this.update(() => {
      this.records.set(record.id, record)
    })
  }

  /**
   * Patch one record and persist.
   * @param {string} id - record id.
   * @param {Partial<WorktreeRecord>} patch - fields to replace.
   * @returns {Promise<WorktreeRecord | undefined>} the updated record.
   */
  async patch(id, patch) {
    let updated
    await this.update(() => {
      const current = this.records.get(id)
      if (current === undefined) return
      updated = { ...current, ...patch }
      this.records.set(id, updated)
    })
    return updated
  }

  /**
   * Remove one record and persist.
   * @param {string} id - record id.
   */
  async remove(id) {
    await this.update(() => {
      this.records.delete(id)
    })
  }

  /**
   * Read the persisted per-repository creation preference override, if any.
   * @returns {Promise<'ask' | 'always' | 'never' | 'dirty' | null>}
   */
  async getPreference() {
    await this.load()
    return this.preference
  }

  /**
   * Persist (or clear, with null) the per-repository creation preference.
   * @param {'ask' | 'always' | 'never' | 'dirty' | null} preference
   */
  async setPreference(preference) {
    await this.update(() => {
      this.preference = preference
    })
  }

  async persist() {
    await mkdir(this.dir, { recursive: true })
    const payload = JSON.stringify({
      version: 1,
      ...(this.preference !== null ? { preference: this.preference } : {}),
      records: [...this.records.values()],
    }, null, 2)
    const temp = `${this.stateFile}.tmp`
    await writeFile(temp, payload, 'utf8')
    await rename(temp, this.stateFile)
  }

  /**
   * Path of the captured environment file for one branch.
   * @param {string} branch - branch name (sanitized).
   * @returns {string} absolute file path.
   */
  envFile(branch) {
    return join(this.dir, `${branch.replace(/[^A-Za-z0-9._-]+/g, '_')}.env`)
  }

  /**
   * Write the captured environment as a `KEY=value` shell file.
   * @param {string} branch - branch name.
   * @param {Record<string, string>} env - captured variables.
   */
  async writeEnv(branch, env) {
    await mkdir(this.dir, { recursive: true })
    const lines = ['# Captured by dsh-worktree setup; safe to source in POSIX shells.']
    for (const [key, value] of Object.entries(env)) {
      lines.push(`${key}=${singleQuote(value)}`)
    }
    await writeFile(this.envFile(branch), `${lines.join('\n')}\n`, 'utf8')
  }

  /**
   * Read the captured environment file, when present.
   * @param {string} branch - branch name.
   * @returns {Promise<Record<string, string> | null>}
   */
  async readEnv(branch) {
    try {
      const text = await readFile(this.envFile(branch), 'utf8')
      const env = {}
      for (const line of text.split('\n')) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/.exec(line)
        if (match !== null) env[match[1]] = match[2].replace(/'\\''/g, "'")
      }
      return env
    } catch {
      return null
    }
  }
}

function singleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Cache of open stores keyed by common directory.
 * @type {Map<string, RepoStore>}
 */
const stores = new Map()

/**
 * Get (or open) the store of one repository.
 * @param {string} commonDir - absolute git common directory.
 * @returns {RepoStore}
 */
export function storeOf(commonDir) {
  let store = stores.get(commonDir)
  if (store === undefined) {
    store = new RepoStore(commonDir)
    stores.set(commonDir, store)
  }
  return store
}
