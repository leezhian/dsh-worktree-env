/** Tests for the TOML subset parser/serializer. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseToml, stringifyToml, TomlError } from '../src/toml.js'

const SAMPLE = `# environment.toml
version = 1
name = "My Project"

[setup]
script = """
pnpm install --frozen-lockfile
"""

[setup.darwin]
script = "brew install thing"

[cleanup]
script = "docker compose down || true"

[[actions]]
name = "Dev Server"
icon = "run"
command = "pnpm dev"

[[actions]]
name = "Test"
icon = "test"
command = "pnpm test"
platform = "linux"
`

test('parses the full environment schema', () => {
  const doc = parseToml(SAMPLE)
  assert.equal(doc.version, 1)
  assert.equal(doc.name, 'My Project')
  assert.equal(doc.setup.script, 'pnpm install --frozen-lockfile\n')
  assert.equal(doc.setup.darwin.script, 'brew install thing')
  assert.equal(doc.cleanup.script, 'docker compose down || true')
  assert.equal(doc.actions.length, 2)
  assert.equal(doc.actions[0].name, 'Dev Server')
  assert.equal(doc.actions[0].icon, 'run')
  assert.equal(doc.actions[1].platform, 'linux')
})

test('round-trips scalars, tables, and array tables', () => {
  const doc = parseToml(SAMPLE)
  const out = parseToml(stringifyToml(doc))
  assert.deepEqual(out, doc)
})

test('parses escapes, booleans, numbers, and arrays', () => {
  const doc = parseToml(`
flag = true
off = false
count = 42
ratio = 3.5
label = "a \\"quoted\\" \\\\ value\\n"
tags = ["one", "two", "three"]
`)
  assert.equal(doc.flag, true)
  assert.equal(doc.off, false)
  assert.equal(doc.count, 42)
  assert.equal(doc.ratio, 3.5)
  assert.equal(doc.label, 'a "quoted" \\ value\n')
  assert.deepEqual(doc.tags, ['one', 'two', 'three'])
})

test('rejects duplicate keys and malformed lines with line numbers', () => {
  assert.throws(() => parseToml('a = 1\na = 2\n'), TomlError)
  assert.throws(() => parseToml('this is not toml\n'), TomlError)
  try {
    parseToml('ok = 1\nbad line here\n')
    assert.fail('should throw')
  } catch (error) {
    assert.ok(error instanceof TomlError)
    assert.equal(error.line, 2)
  }
})

test('serializes multiline scripts readably', () => {
  const text = stringifyToml({ version: 1, setup: { script: 'line one\nline two\n' } })
  assert.match(text, /\[setup\]/)
  assert.match(text, /"""\nline one\nline two\n"""/)
})
