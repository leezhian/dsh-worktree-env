/**
 * A dependency-free TOML subset parser and serializer covering the whole
 * `environment.toml` schema: top-level scalars, `[table]` and `[a.b]` tables,
 * `[[array-of-tables]]`, basic/literal/multiline strings, integers, floats,
 * booleans, and (possibly multiline) arrays of scalars.
 *
 * Not supported: datetimes, inline tables, dotted key definitions on the right
 * side, and key values redefined after use. Unknown constructs throw with a
 * line number.
 *
 * @module
 */

/** Parse error carrying the 1-based line where parsing failed. */
export class TomlError extends Error {
  /**
   * @param {string} message - what failed.
   * @param {number} line - 1-based source line.
   */
  constructor(message, line) {
    super(`${message} (line ${line})`)
    this.name = 'TomlError'
    this.line = line
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/

/**
 * Parse TOML text into a plain object.
 * @param {string} text - TOML source.
 * @returns {Record<string, unknown>} parsed document.
 * @throws {TomlError} on syntax errors.
 */
export function parseToml(text) {
  const ctx = { src: String(text), pos: 0, line: 1 }
  /** @type {Record<string, unknown>} */
  const root = {}
  let current = root
  let currentPrefix = /** @type {string[]} */ ([])
  const definedTables = new Set()
  const definedArrays = new Set()
  /** Explicitly assigned key paths, to reject redefinition. */
  const assigned = new Set()
  const arrayTables = new Set()

  skipFiller(ctx)
  while (ctx.pos < ctx.src.length) {
    if (peek(ctx) === '[') {
      const isArray = ctx.src[ctx.pos + 1] === '['
      advance(ctx)
      if (isArray) advance(ctx)
      skipSpaces(ctx)
      const path = readKeyPath(ctx)
      skipSpaces(ctx)
      if (peek(ctx) !== ']') throw new TomlError('expected ] closing table header', ctx.line)
      advance(ctx)
      if (isArray) {
        if (peek(ctx) !== ']') throw new TomlError('expected ]] closing array-of-tables header', ctx.line)
        advance(ctx)
      }
      if (peek(ctx) === '\r') advance(ctx)
      if (peek(ctx) !== '\n' && ctx.pos < ctx.src.length) throw new TomlError('unexpected text after table header', ctx.line)
      const key = path.join('.')
      if (isArray) {
        if (definedTables.has(key) || assigned.has(key)) throw new TomlError(`cannot redefine "${key}" as array of tables`, ctx.line)
        arrayTables.add(key)
        definedArrays.add(key)
        const parent = descend(root, path.slice(0, -1), ctx)
        const leaf = path[path.length - 1]
        const list = Array.isArray(parent[leaf]) ? parent[leaf] : (parent[leaf] = [])
        current = {}
        list.push(current)
      } else {
        if (definedArrays.has(key) || arrayTables.has(key)) throw new TomlError(`cannot redefine array "${key}" as table`, ctx.line)
        if (definedTables.has(key)) throw new TomlError(`table "${key}" defined twice`, ctx.line)
        definedTables.add(key)
        current = descend(root, path, ctx)
      }
      currentPrefix = path
      skipFiller(ctx)
      continue
    }
    const path = readKeyPath(ctx)
    skipSpaces(ctx)
    if (peek(ctx) !== '=') throw new TomlError('expected = after key', ctx.line)
    advance(ctx)
    skipSpaces(ctx)
    const value = readValue(ctx)
    const fullPath = [...currentPrefix, ...path]
    const fullKey = fullPath.join('.')
    const underArrayTable = [...arrayTables].some(prefix => fullKey.startsWith(`${prefix}.`))
    if (!underArrayTable) {
      if (assigned.has(fullKey)) throw new TomlError(`key "${fullKey}" defined twice`, ctx.line)
      if (definedTables.has(fullKey) || definedArrays.has(fullKey)) throw new TomlError(`cannot redefine "${fullKey}" as a value`, ctx.line)
      assigned.add(fullKey)
    }
    const parent = path.length > 1 ? descend(current, path.slice(0, -1), ctx) : current
    parent[path[path.length - 1]] = value
    skipInline(ctx)
    if (ctx.pos < ctx.src.length && peek(ctx) !== '\n') throw new TomlError('unexpected text after value', ctx.line)
    skipFiller(ctx)
  }
  return root
}

/**
 * Serialize a plain object back to TOML in the canonical environment.toml
 * shape: scalars first, then plain tables (nested paths flattened), then
 * arrays of tables.
 * @param {Record<string, unknown>} value - plain object.
 * @returns {string} TOML text.
 */
export function stringifyToml(value) {
  /** @type {string[]} */
  const lines = []
  const tables = []
  const arrayTables = []
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) tables.push([key, entry])
    else if (Array.isArray(entry) && entry.length > 0 && entry.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      arrayTables.push([key, entry])
    } else {
      lines.push(`${formatKey(key)} = ${formatValue(entry)}`)
    }
  }
  const walk = (prefix, object) => {
    const nested = []
    for (const [key, entry] of Object.entries(object)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) nested.push([path, entry])
      else lines.push(`${formatKey(key)} = ${formatValue(entry)}`)
    }
    for (const [path, entry] of nested) {
      lines.push('', `[${path}]`)
      walk(path, entry)
    }
  }
  for (const [key, entry] of tables) {
    lines.push('', `[${formatKey(key)}]`)
    walk(key, entry)
  }
  for (const [key, entries] of arrayTables) {
    for (const entry of entries) {
      lines.push('', `[[${formatKey(key)}]]`)
      walk(key, entry)
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

/** Escape and quote a key only when it is not a bare key. */
function formatKey(key) {
  return BARE_KEY.test(key) ? key : `"${escapeBasic(key)}"`
}

function escapeBasic(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
}

function formatValue(value) {
  if (typeof value === 'string') {
    if (value.includes('\n')) return `"""\n${value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""`
    return `"${escapeBasic(value)}"`
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === null || value === undefined) return "''"
  if (Array.isArray(value)) return `[${value.map(item => formatValue(item)).join(', ')}]`
  throw new Error(`toml: cannot serialize value of type ${typeof value}`)
}

function peek(ctx) {
  return ctx.src[ctx.pos]
}

function advance(ctx) {
  if (ctx.src[ctx.pos] === '\n') ctx.line += 1
  ctx.pos += 1
}

function skipSpaces(ctx) {
  while (ctx.pos < ctx.src.length && (peek(ctx) === ' ' || peek(ctx) === '\t')) advance(ctx)
}

function skipInline(ctx) {
  skipSpaces(ctx)
  if (peek(ctx) === '#') {
    while (ctx.pos < ctx.src.length && peek(ctx) !== '\n') advance(ctx)
  }
}

function skipFiller(ctx) {
  while (ctx.pos < ctx.src.length) {
    const c = peek(ctx)
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') advance(ctx)
    else if (c === '#') {
      while (ctx.pos < ctx.src.length && peek(ctx) !== '\n') advance(ctx)
    } else break
  }
}

function readKeyPath(ctx) {
  const parts = []
  for (;;) {
    skipSpaces(ctx)
    const c = peek(ctx)
    let part
    if (c === '"' || c === "'") {
      part = readStringValue(ctx, c === '"' ? 'basic' : 'literal')
    } else {
      let end = ctx.pos
      while (end < ctx.src.length && /[A-Za-z0-9_-]/.test(ctx.src[end])) end += 1
      part = ctx.src.slice(ctx.pos, end)
      if (part.length === 0) throw new TomlError('expected a key', ctx.line)
      for (let i = 0; i < part.length; i += 1) advance(ctx)
    }
    parts.push(part)
    skipSpaces(ctx)
    if (peek(ctx) === '.') {
      advance(ctx)
      continue
    }
    return parts
  }
}

function readStringValue(ctx, flavor) {
  const startLine = ctx.line
  const quote = flavor === 'basic' ? '"' : "'"
  if (ctx.src.startsWith(flavor === 'basic' ? '"""' : "'''", ctx.pos)) {
    const triple = flavor === 'basic' ? '"""' : "'''"
    ctx.pos += 3
    for (let i = 0; i < 3; i += 1) if (ctx.src[ctx.pos - 3 + i] === '\n') ctx.line += 0
    // A newline immediately after the opening delimiter is trimmed.
    if (peek(ctx) === '\r') advance(ctx)
    if (peek(ctx) === '\n') advance(ctx)
    let out = ''
    while (ctx.pos < ctx.src.length && !ctx.src.startsWith(triple, ctx.pos)) {
      if (flavor === 'basic' && peek(ctx) === '\\') {
        out += readEscape(ctx, startLine)
        continue
      }
      out += peek(ctx)
      advance(ctx)
    }
    if (ctx.pos >= ctx.src.length) throw new TomlError('unterminated multiline string', ctx.line)
    ctx.pos += 3
    ctx.line += (out.match(/\n/g) ?? []).length
    return out
  }
  advance(ctx)
  let out = ''
  while (ctx.pos < ctx.src.length && peek(ctx) !== quote && peek(ctx) !== '\n') {
    if (flavor === 'basic' && peek(ctx) === '\\') {
      out += readEscape(ctx, startLine)
      continue
    }
    out += peek(ctx)
    advance(ctx)
  }
  if (peek(ctx) !== quote) throw new TomlError('unterminated string', ctx.line)
  advance(ctx)
  return out
}

function readEscape(ctx, line) {
  advance(ctx) // backslash
  const c = peek(ctx)
  if (c === undefined) throw new TomlError('unterminated escape', line)
  advance(ctx)
  if (c === 'n') return '\n'
  if (c === 't') return '\t'
  if (c === 'r') return '\r'
  if (c === '"') return '"'
  if (c === '\\') return '\\'
  if (c === 'b') return '\b'
  if (c === 'f') return '\f'
  if (c === 'u' || c === 'U') {
    const width = c === 'u' ? 4 : 8
    const hex = ctx.src.slice(ctx.pos, ctx.pos + width)
    if (hex.length < width) throw new TomlError('truncated unicode escape', line)
    for (let i = 0; i < width; i += 1) advance(ctx)
    const code = Number.parseInt(hex, 16)
    if (!Number.isFinite(code)) throw new TomlError(`invalid unicode escape \\${c}${hex}`, line)
    return String.fromCodePoint(code)
  }
  throw new TomlError(`invalid escape "\\${c}"`, line)
}

function readValue(ctx) {
  const c = peek(ctx)
  if (c === '"' || c === "'") return readStringValue(ctx, c === '"' ? 'basic' : 'literal')
  if (c === '[') return readArray(ctx)
  if (c === 't' && ctx.src.startsWith('true', ctx.pos)) {
    for (let i = 0; i < 4; i += 1) advance(ctx)
    return true
  }
  if (c === 'f' && ctx.src.startsWith('false', ctx.pos)) {
    for (let i = 0; i < 5; i += 1) advance(ctx)
    return false
  }
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(ctx.src.slice(ctx.pos))
  if (match !== null && match[0].length > 0) {
    for (let i = 0; i < match[0].length; i += 1) advance(ctx)
    const text = match[0]
    return text.includes('.') || /[eE]/.test(text) ? Number.parseFloat(text) : Number.parseInt(text, 10)
  }
  throw new TomlError('expected a value', ctx.line)
}

function readArray(ctx) {
  advance(ctx) // [
  const items = []
  for (;;) {
    skipFiller(ctx)
    if (ctx.pos >= ctx.src.length) throw new TomlError('unterminated array', ctx.line)
    if (peek(ctx) === ']') {
      advance(ctx)
      return items
    }
    items.push(readValue(ctx))
    skipFiller(ctx)
    if (peek(ctx) === ',') {
      advance(ctx)
      continue
    }
    if (peek(ctx) === ']') {
      advance(ctx)
      return items
    }
    throw new TomlError('expected , or ] in array', ctx.line)
  }
}

function descend(root, path, ctx) {
  let node = root
  for (const part of path) {
    const next = node[part]
    if (next === undefined) {
      const created = {}
      node[part] = created
      node = created
    } else if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      node = next
    } else {
      throw new TomlError(`cannot descend into "${part}": not a table`, ctx.line)
    }
  }
  return node
}
