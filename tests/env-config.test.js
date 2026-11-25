/** Tests for environment config parsing and platform resolution. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyManagedEnvPath, discoverEnvConfig, listEnvConfigs, parseEnvConfig, parseGitRemoteOwner, writeEnvConfig } from '../src/env-config.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SAMPLE = `version = 1
name = "Demo"

[setup]
script = "generic setup"

[setup.${process.platform}]
script = "platform setup"

[cleanup]
script = "generic cleanup"

[[actions]]
name = "Dev"
icon = "run"
command = "pnpm dev"

[[actions]]
name = "Other platform"
command = "echo nope"
platform = "not-a-real-platform"
`

test('platform-specific script wins; foreign actions filtered', () => {
  const config = parseEnvConfig(SAMPLE, '/tmp/environment.toml', 'dsh')
  assert.equal(config.setup.script, 'platform setup')
  assert.equal(config.setup.platform, process.platform)
  assert.equal(config.cleanup.script, 'generic cleanup')
  assert.equal(config.actions.length, 1)
  assert.equal(config.actions[0].name, 'Dev')
  assert.equal(config.actions[0].icon, 'run')
  assert.equal(config.allActions.length, 2)
  assert.equal(config.allActions[1].platform, 'not-a-real-platform')
})

test('falls back to the top-level script without a platform override', () => {
  const config = parseEnvConfig('[setup]\nscript = "only"\n', null, null)
  assert.equal(config.setup.script, 'only')
  assert.equal(config.setup.platform, null)
  assert.equal(config.actions.length, 0)
})

test('writeEnvConfig produces parseable TOML', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-envcfg-'))
  try {
    const path = join(dir, '.agents', 'environments', 'environment.toml')
    await writeEnvConfig(path, {
      version: 1,
      name: 'Round trip',
      setupScripts: { top: 'echo top', darwin: 'echo mac' },
      cleanupScripts: { top: 'echo clean' },
      actions: [{ name: 'A', command: 'echo a', icon: 'run', platform: null }],
    })
    const written = await readFile(path, 'utf8')
    assert.match(written, /\[setup\.darwin\]/)
    const config = parseEnvConfig(written, path, 'dsh')
    assert.equal(config.name, 'Round trip')
    assert.equal(config.setupScripts.darwin, 'echo mac')
    assert.equal(config.actions[0].command, 'echo a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('discoverEnvConfig reads .agents/environments only, ignores .codex, and honors dsh git config overrides', async () => {
  const { GitRunner } = await import('../src/git.js')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-disc-'))
  const fakeCtx = {
    subprocess: {
      resolveExecutable: async (command) => command,
      spawn: (spec) => {
        const child = execFile(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env, ...Object.fromEntries(Object.entries(spec.env ?? {}).filter(([, v]) => v !== undefined)) }, signal: spec.signal, maxBuffer: 16 * 1024 * 1024 }, () => {})
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', chunk => { stdout += chunk })
        child.stderr?.on('data', chunk => { stderr += chunk })
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          collected: {},
          done: new Promise((resolve, reject) => {
            child.on('error', reject)
            child.on('close', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }))
          }),
          terminate: () => { child.kill('SIGTERM') },
          waitForExit: async () => true,
        }
      },
    },
  }
  try {
    await run('git', ['init', '-q', dir])
    const git = new GitRunner(fakeCtx)
    const none = await discoverEnvConfig(git, dir)
    assert.equal(none.sourcePath, null)
    // .codex/environments/environment.toml must be ignored (not shared with ChatGPT/Codex)
    await writeEnvConfig(join(dir, '.codex', 'environments', 'environment.toml'), { setupScripts: { top: 'codex setup' } })
    const stillNone = await discoverEnvConfig(git, dir)
    assert.equal(stillNone.sourcePath, null)
    await writeEnvConfig(join(dir, '.agents', 'environments', 'environment.toml'), { setupScripts: { top: 'dsh setup' } })
    const dsh = await discoverEnvConfig(git, dir)
    assert.equal(dsh.source, 'dsh')
    assert.equal(dsh.setup.script, 'dsh setup')
    await run('git', ['-C', dir, 'config', '--local', 'dsh.localEnvironmentConfigPath', '__none__'])
    const disabled = await discoverEnvConfig(git, dir)
    assert.equal(disabled.disabled, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseGitRemoteOwner extracts org/owner from SSH and HTTPS URLs', () => {
  assert.equal(parseGitRemoteOwner('git@github.com:fq-business-systems/fq-mall.git'), 'fq-business-systems')
  assert.equal(parseGitRemoteOwner('https://gitlab.example.com/fq-front/content-team-skills.git'), 'fq-front')
  assert.equal(parseGitRemoteOwner('ssh://git@git.company.com:2222/team/sub/repo.git'), 'sub')
  assert.equal(parseGitRemoteOwner(''), null)
  assert.equal(parseGitRemoteOwner(null), null)
})

test('listEnvConfigs lists only .agents/environments .toml files, ignores .codex, and picks nextConfigPath', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-listenv-'))
  try {
    const empty = await listEnvConfigs(null, dir)
    assert.equal(empty.environments.length, 0)
    assert.equal(empty.nextConfigPath, join(dir, '.agents', 'environments', 'environment.toml'))

    const codexPath = join(dir, '.codex', 'environments', 'environment.toml')
    await writeEnvConfig(codexPath, { name: 'codex-only', setupScripts: { top: 'npm install' } })
    assert.equal((await listEnvConfigs(null, dir)).environments.length, 0)
    assert.equal(classifyManagedEnvPath(dir, codexPath), null)

    const dshPath = join(dir, '.agents', 'environments', 'environment.toml')
    await writeEnvConfig(dshPath, { name: 'fq-mall', setupScripts: { top: 'npm install' } })
    const one = await listEnvConfigs(null, dir)
    assert.equal(one.environments.length, 1)
    assert.equal(one.environments[0].name, 'fq-mall')
    assert.equal(one.environments[0].fileName, 'environment.toml')
    assert.equal(one.environments[0].source, 'dsh')
    assert.equal(one.nextConfigPath, join(dir, '.agents', 'environments', 'environment-2.toml'))

    await writeEnvConfig(one.nextConfigPath, { name: 'fq-mall staging', setupScripts: { top: 'pnpm i' } })
    const two = await listEnvConfigs(null, dir)
    assert.equal(two.environments.length, 2)
    assert.equal(two.nextConfigPath, join(dir, '.agents', 'environments', 'environment-3.toml'))

    assert.equal(classifyManagedEnvPath(dir, dshPath), 'dsh')
    assert.equal(classifyManagedEnvPath(dir, one.nextConfigPath), 'dsh')
    assert.equal(classifyManagedEnvPath(dir, join(dir, 'outside.toml')), null)
    assert.equal(classifyManagedEnvPath(dir, '/etc/passwd'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
