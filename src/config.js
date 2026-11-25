/**
 * Shared plugin configuration constants, validation, normalization, and
 * disk persistence used across host entry, service, store, and HTTP routes.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PREFERENCES = /** @type {const} */ (['ask', 'always', 'never', 'dirty'])
export const DEFAULT_WORKTREE_DIRECTORY = '.agents/worktrees'

export const CONFIG_DEFAULTS = {
  worktreeDirectory: '',
  autoRunSetup: true,
  autoRunCleanup: true,
  setupTimeoutMs: 300000,
  upstreamRefreshMode: /** @type {'never' | 'best-effort'} */ ('never'),
  defaultCreationPreference: /** @type {'ask' | 'always' | 'never' | 'dirty'} */ ('ask'),
  repositoryPreferences: /** @type {{ commonDir: string, root: string, preference: 'ask' | 'always' | 'never' | 'dirty' }[]} */ ([]),
  snapshotOnArchive: true,
  autoCleanupEnabled: true,
  keepCount: 15,
  confirmBeforeDelete: true,
}

/**
 * Matches `@deepseek-ai/dsh-experimental-worktree`'s strict relative-path rule:
 * non-empty relative path inside the repository root without `.`, `..`, `\`, `:`,
 * or leading/consecutive slashes.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidRelativeWorktreeDir(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.includes(':')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/** Path where UI-edited plugin settings are persisted across restarts. */
export function persistedConfigPath() {
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(dshHome, 'plugins', 'dsh-worktree-env', 'config.json')
}

/** Read persisted UI settings from disk (best-effort). */
export function readPersistedConfig(filePath = persistedConfigPath()) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist editable UI settings to disk. */
export async function writePersistedConfig(config, filePath = persistedConfigPath()) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify({
    worktreeDirectory: config.worktreeDirectory ?? '',
    upstreamRefreshMode: config.upstreamRefreshMode,
    autoCleanupEnabled: config.autoCleanupEnabled,
    keepCount: config.keepCount,
    confirmBeforeDelete: config.confirmBeforeDelete,
  }, null, 2), 'utf8')
}

/**
 * Normalize a raw row config against the documented defaults.
 * @param {Record<string, unknown> | undefined} raw
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const positiveInt = (value, fallback, min) => {
    const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : Number.NaN
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
  }
  const rawDir = typeof input.worktreeDirectory === 'string'
    ? input.worktreeDirectory.trim().replace(/\/+$/, '')
    : ''
  return {
    worktreeDirectory: rawDir.length > 0 && isValidRelativeWorktreeDir(rawDir) ? rawDir : CONFIG_DEFAULTS.worktreeDirectory,
    autoRunSetup: input.autoRunSetup !== false,
    autoRunCleanup: input.autoRunCleanup !== false,
    setupTimeoutMs: positiveInt(input.setupTimeoutMs, CONFIG_DEFAULTS.setupTimeoutMs, 1000),
    upstreamRefreshMode: input.upstreamRefreshMode === 'best-effort' ? 'best-effort' : 'never',
    defaultCreationPreference: PREFERENCES.includes(/** @type {any} */ (input.defaultCreationPreference))
      ? /** @type {'ask' | 'always' | 'never' | 'dirty'} */ (input.defaultCreationPreference)
      : 'ask',
    repositoryPreferences: Array.isArray(input.repositoryPreferences)
      ? input.repositoryPreferences.filter(entry => entry !== null && typeof entry === 'object'
        && typeof entry.commonDir === 'string' && typeof entry.root === 'string'
        && PREFERENCES.includes(entry.preference))
      : [],
    snapshotOnArchive: input.snapshotOnArchive !== false,
    autoCleanupEnabled: input.autoCleanupEnabled !== false,
    keepCount: positiveInt(input.keepCount, CONFIG_DEFAULTS.keepCount, 1),
    confirmBeforeDelete: input.confirmBeforeDelete !== false,
  }
}
