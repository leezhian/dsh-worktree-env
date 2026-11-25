/**
 * Discovery, validation, and writing of per-repository `.agents/environments/*.toml`
 * local-environment definitions (alongside DSH's `.agents/worktrees`).
 *
 * @module
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseToml, stringifyToml } from './toml.js'

export const PLATFORMS = ['darwin', 'linux', 'win32']
export const DISABLE_MARKER = '__none__'
export const ACTION_ICONS = ['tool', 'run', 'debug', 'test']
export const DEFAULT_RELATIVE_PATHS = ['.agents/environments/environment.toml']
export const ENV_DIRS = [
  { rel: '.agents/environments', source: /** @type {const} */ ('dsh') },
]

/**
 * Normalized local-environment definition.
 * @typedef {Object} EnvironmentConfig
 * @property {string | null} sourcePath - discovered file path, or null.
 * @property {'dsh' | 'custom' | null} source - where it was found.
 * @property {boolean} disabled - repository disabled the feature with `__none__`.
 * @property {number} version
 * @property {string} name - display name.
 * @property {{ script: string, platform: string | null } | null} setup - resolved for the current platform.
 * @property {Record<string, string>} setupScripts - per-platform raw scripts.
 * @property {{ script: string, platform: string | null } | null} cleanup
 * @property {Record<string, string>} cleanupScripts - per-platform raw cleanup scripts.
 * @property {{ name: string, icon: string | null, command: string, platform: string | null }[]} actions - filtered to the current platform.
 */

/**
 * Read one git-config value inside a repository.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} root - repository root.
 * @param {string} key - config key.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string | null>} trimmed value or null.
 */
async function gitConfig(git, root, key, signal) {
  const result = await git.run(root, ['config', '--local', '--get', key], { allowedExitCodes: [0, 1], signal })
  if (result.exitCode !== 0) return null
  const value = result.stdout.trim()
  return value.length === 0 ? null : value
}

/**
 * Discover and parse the environment config for one checkout.
 * @param {import('./git.js').GitRunner} git - runner.
 * @param {string} root - checkout root (worktree or source).
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<EnvironmentConfig>} normalized definition.
 */
export async function discoverEnvConfig(git, root, signal) {
  const custom = await gitConfig(git, root, 'dsh.localEnvironmentConfigPath', signal)
  if (custom === DISABLE_MARKER) {
    return emptyConfig(null, null, true)
  }
  /** @type {{ path: string, source: 'dsh' | 'custom' } | null} */
  let found = null
  if (custom !== null) {
    found = { path: isAbsolute(custom) ? custom : join(root, custom), source: 'custom' }
  } else {
    for (const relPath of DEFAULT_RELATIVE_PATHS) {
      const path = join(root, relPath)
      try {
        await readFile(path, 'utf8')
        found = { path, source: 'dsh' }
        break
      } catch {
        // try the next candidate
      }
    }
  }
  if (found === null) {
    // A linked worktree is a fresh checkout: untracked local files such as
    // environment.toml exist only in the source checkout, so fall back to the
    // repository's main root (the parent of the git common dir).
    const commonDir = await git.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowedExitCodes: [0, 128], signal })
    const mainRoot = commonDir.exitCode === 0 && commonDir.stdout.trim().endsWith('/.git')
      ? commonDir.stdout.trim().slice(0, -'/.git'.length)
      : null
    if (mainRoot !== null && mainRoot !== root) {
      for (const relPath of DEFAULT_RELATIVE_PATHS) {
        const path = join(mainRoot, relPath)
        try {
          await readFile(path, 'utf8')
          found = { path, source: 'dsh' }
          break
        } catch {
          // try the next candidate
        }
      }
    }
  }
  if (found === null) return emptyConfig(null, null, false)
  let text
  try {
    text = await readFile(found.path, 'utf8')
  } catch {
    return emptyConfig(found.path, found.source, false)
  }
  return parseEnvConfig(text, found.path, found.source)
}

/**
 * Parse environment.toml text into the normalized definition.
 * @param {string} text - TOML source.
 * @param {string | null} sourcePath - file it came from.
 * @param {'dsh' | 'codex' | 'custom' | null} source - provenance.
 * @returns {EnvironmentConfig}
 */
export function parseEnvConfig(text, sourcePath, source) {
  const doc = parseToml(text)
  const platform = process.platform
  /** @type {Record<string, string>} */
  const setupScripts = {}
  const setupTable = objectOf(doc.setup)
  if (typeof setupTable.script === 'string') setupScripts.top = setupTable.script
  for (const name of PLATFORMS) {
    const entry = objectOf(setupTable[name])
    if (typeof entry.script === 'string' && entry.script.trim().length > 0) setupScripts[name] = entry.script
  }
  const setup = resolveScript(setupScripts, platform)
  const cleanupTable = objectOf(doc.cleanup)
  /** @type {Record<string, string>} */
  const cleanupScripts = {}
  if (typeof cleanupTable.script === 'string') cleanupScripts.top = cleanupTable.script
  for (const name of PLATFORMS) {
    const entry = objectOf(cleanupTable[name])
    if (typeof entry.script === 'string' && entry.script.trim().length > 0) cleanupScripts[name] = entry.script
  }
  const cleanup = resolveScript(cleanupScripts, platform)
  /** @type {EnvironmentConfig['actions']} */
  const actions = []
  /** @type {EnvironmentConfig['actions']} */
  const allActions = []
  if (Array.isArray(doc.actions)) {
    for (const entry of doc.actions) {
      const item = objectOf(entry)
      if (typeof item.name !== 'string' || typeof item.command !== 'string') continue
      const icon = ACTION_ICONS.includes(item.icon) ? item.icon : null
      const actionPlatform = typeof item.platform === 'string' && PLATFORMS.includes(item.platform) ? item.platform : (typeof item.platform === 'string' ? item.platform : null)
      const normalized = { name: item.name, icon, command: item.command, platform: actionPlatform }
      allActions.push(normalized)
      if (actionPlatform !== null && actionPlatform !== platform) continue
      actions.push(normalized)
    }
  }
  return {
    sourcePath,
    source,
    disabled: false,
    version: Number.isInteger(doc.version) ? doc.version : 1,
    name: typeof doc.name === 'string' && doc.name.length > 0 ? doc.name : basenameOf(sourcePath),
    setup,
    setupScripts,
    cleanup,
    cleanupScripts,
    actions,
    allActions,
  }
}

/**
 * Where a new definition should be written for one repository.
 * @param {string} root - repository root.
 * @returns {string} preferred path (`.agents/environments/environment.toml`).
 */
export function preferredConfigPath(root) {
  return join(root, DEFAULT_RELATIVE_PATHS[0])
}

/**
 * Extract the repository owner / organization from a Git remote URL.
 * Supports SSH (`git@host:owner/repo.git`), `ssh://`, and `https://` URLs.
 * @param {string | null | undefined} remoteUrl
 * @returns {string | null}
 */
export function parseGitRemoteOwner(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null
  const trimmed = remoteUrl.trim()
  if (trimmed.length === 0) return null
  // SCP-style: git@github.com:org/repo.git or git@gitlab.com:group/sub/repo.git
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(trimmed)
  if (scp !== null) {
    const parts = scp[1].replace(/\.git$/i, '').split('/').filter(Boolean)
    return parts.length >= 2 ? parts[parts.length - 2] : null
  }
  try {
    const url = new URL(trimmed)
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean)
    return parts.length >= 2 ? parts[parts.length - 2] : null
  } catch {
    return null
  }
}

/**
 * Check whether `candidatePath` is inside `<root>/.agents/environments`
 * and ends with `.toml`.
 * @param {string} root
 * @param {string} candidatePath
 * @returns {'dsh' | null}
 */
export function classifyManagedEnvPath(root, candidatePath) {
  const abs = resolve(candidatePath)
  if (!abs.toLowerCase().endsWith('.toml')) return null
  for (const dir of ENV_DIRS) {
    const base = resolve(root, dir.rel)
    const rel = relative(base, abs)
    if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/') && !rel.includes('\\')) {
      return dir.source
    }
  }
  return null
}

/**
 * Read and parse one specific environment config file.
 * @param {string} configPath
 * @param {'dsh' | 'custom'} source
 * @returns {Promise<EnvironmentConfig>}
 */
export async function readEnvConfigFile(configPath, source) {
  const text = await readFile(configPath, 'utf8')
  return parseEnvConfig(text, configPath, source)
}

/**
 * List every local environment `.toml` file belonging to one project directory,
 * scanning `.agents/environments/*.toml` and any custom `dsh.localEnvironmentConfigPath`.
 * Also returns the next available path for creating a new environment file.
 * @param {import('./git.js').GitRunner} git
 * @param {string} root
 * @param {AbortSignal} [signal]
 */
export async function listEnvConfigs(git, root, signal) {
  /** @type {{ configPath: string, source: 'dsh' | 'custom' }[]} */
  const candidates = []
  const seen = new Set()
  const pushCandidate = (configPath, source) => {
    const abs = resolve(configPath)
    if (seen.has(abs)) return
    seen.add(abs)
    candidates.push({ configPath: abs, source })
  }

  for (const dir of ENV_DIRS) {
    const folder = join(root, dir.rel)
    let entries = []
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      continue
    }
    const files = entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.toml'))
      .map(e => e.name)
      .sort((a, b) => {
        if (a === 'environment.toml') return -1
        if (b === 'environment.toml') return 1
        return a.localeCompare(b)
      })
    for (const file of files) pushCandidate(join(folder, file), dir.source)
  }

  if (git !== null && git !== undefined) {
    const custom = await gitConfig(git, root, 'dsh.localEnvironmentConfigPath', signal).catch(() => null)
    if (custom !== null && custom !== DISABLE_MARKER) {
      const customPath = isAbsolute(custom) ? custom : join(root, custom)
      try {
        await readFile(customPath, 'utf8')
        pushCandidate(customPath, 'custom')
      } catch {
        // ignore missing custom path
      }
    }
  }

  const items = []
  for (const candidate of candidates) {
    const fileName = basename(candidate.configPath)
    const relPath = relative(root, candidate.configPath)
    try {
      const environment = await readEnvConfigFile(candidate.configPath, candidate.source)
      items.push({
        configPath: candidate.configPath,
        fileName,
        relativePath: relPath.startsWith('..') ? candidate.configPath : relPath,
        source: candidate.source,
        name: environment.name,
        valid: true,
        error: null,
        environment,
      })
    } catch (error) {
      items.push({
        configPath: candidate.configPath,
        fileName,
        relativePath: relPath.startsWith('..') ? candidate.configPath : relPath,
        source: candidate.source,
        name: fileName,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
        environment: null,
      })
    }
  }

  // Pick next available `.agents/environments/environment[-N].toml` path for "+" creation.
  const existingNames = new Set(items.map(item => item.fileName.toLowerCase()))
  let nextName = 'environment.toml'
  if (existingNames.has(nextName)) {
    let n = 2
    while (existingNames.has(`environment-${n}.toml`)) n += 1
    nextName = `environment-${n}.toml`
  }
  const nextConfigPath = join(root, ENV_DIRS[0].rel, nextName)

  return { environments: items, nextConfigPath }
}

/**
 * Serialize and write an environment definition.
 * @param {string} path - absolute target path.
 * @param {{ version?: number, name?: string, setupScripts?: Record<string, string>, cleanupScripts?: Record<string, string>, actions?: EnvironmentConfig['actions'] }} definition
 */
export async function writeEnvConfig(path, definition) {
  const doc = {
    version: definition.version ?? 1,
    ...(definition.name !== undefined ? { name: definition.name } : {}),
  }
  const setupScripts = definition.setupScripts ?? {}
  if (Object.keys(setupScripts).length > 0) {
    doc.setup = { ...(setupScripts.top !== undefined ? { script: setupScripts.top } : {}) }
    for (const platform of PLATFORMS) {
      if (setupScripts[platform] !== undefined) doc.setup[platform] = { script: setupScripts[platform] }
    }
  }
  const cleanupScripts = definition.cleanupScripts ?? {}
  if (Object.keys(cleanupScripts).length > 0) {
    doc.cleanup = { ...(cleanupScripts.top !== undefined ? { script: cleanupScripts.top } : {}) }
    for (const platform of PLATFORMS) {
      if (cleanupScripts[platform] !== undefined) doc.cleanup[platform] = { script: cleanupScripts[platform] }
    }
  }
  if (definition.actions !== undefined && definition.actions.length > 0) {
    doc.actions = definition.actions.map(action => ({
      name: action.name,
      ...(action.icon !== null && action.icon !== undefined ? { icon: action.icon } : {}),
      command: action.command,
      ...(action.platform !== null && action.platform !== undefined ? { platform: action.platform } : {}),
    }))
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, stringifyToml(doc), 'utf8')
}

/**
 * Pick the script for one platform: platform-specific wins over top-level.
 * @param {Record<string, string>} scripts - keys: `top`, `darwin`, `linux`, `win32`.
 * @param {string} platform - current platform.
 * @returns {{ script: string, platform: string | null } | null}
 */
function resolveScript(scripts, platform) {
  const specific = scripts[platform]
  if (specific !== undefined) return { script: specific, platform }
  if (scripts.top !== undefined) return { script: scripts.top, platform: null }
  return null
}

function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function basenameOf(sourcePath) {
  if (sourcePath === null) return 'Local environment'
  const segments = sourcePath.split('/')
  return segments.length > 3 ? segments[segments.length - 3] : sourcePath
}

function emptyConfig(sourcePath, source, disabled) {
  return {
    sourcePath,
    source,
    disabled,
    version: 1,
    name: 'Local environment',
    setup: null,
    setupScripts: {},
    cleanup: null,
    cleanupScripts: {},
    actions: [],
    allActions: [],
  }
}
