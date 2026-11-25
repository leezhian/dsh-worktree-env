/**
 * Shared test utilities for host/git tests and client.js VM harnesses.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const run = promisify(execFile)

/** Minimal subprocess + workingDirectory provider backed by child_process. */
export function makeCtx(extra = {}) {
  return {
    get: (key) => extra[key],
    subprocess: {
      resolveExecutable: async (command) => command,
      spawn: (spec) => {
        const env = { ...process.env }
        for (const [key, value] of Object.entries(spec.env ?? {})) {
          if (value === undefined) delete env[key]
          else env[key] = value
        }
        const child = execFile(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, signal: spec.signal, maxBuffer: 64 * 1024 * 1024 }, () => {})
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          collected: {},
          done: new Promise((resolveDone, reject) => {
            child.on('error', reject)
            child.on('close', (code, signal) => resolveDone({ exitCode: code, signal: signal ?? null }))
          }),
          terminate: () => { if (child.exitCode === null) child.kill('SIGTERM') },
          waitForExit: async () => true,
        }
      },
    },
    workingDirectory: {
      get: () => undefined,
      ensure: async () => undefined,
      set: async (_agent, path) => path,
    },
  }
}

/** Initialize a clean Git repository on `main` with one initial file & commit. */
export async function initRepo(dir, initialFile = 'file.txt', content = 'v1\n') {
  await run('git', ['init', '-q', '-b', 'main', dir])
  await run('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  await writeFile(join(dir, initialFile), content, 'utf8')
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', 'init'])
}

/** Load `client.js` inside an isolated VM context with stateful React hook mocks. */
export async function loadClientModule({ fetchImpl, lang = 'zh-CN', defaultRectRef = false } = {}) {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const stateSlots = []
  const effectSlots = []
  const refSlots = []
  const cursors = { state: 0, effect: 0, ref: 0 }
  let loadedModule = null

  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => {
      const idx = cursors.state++
      if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init
      const setter = (next) => {
        stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next
      }
      return [stateSlots[idx], setter]
    },
    useEffect: (fn, deps) => {
      const idx = cursors.effect++
      const prev = effectSlots[idx]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => d !== prev.deps[i])
      if (changed) {
        if (typeof prev?.cleanup === 'function') prev.cleanup()
        effectSlots[idx] = { deps, cleanup: fn() }
      }
    },
    useMemo: (fn) => fn(),
    useRef: (init) => {
      const idx = cursors.ref++
      if (!(idx in refSlots)) {
        refSlots[idx] = {
          current: init ?? (defaultRectRef
            ? {
              getBoundingClientRect: () => ({ top: 10, bottom: 38, right: 600, left: 500 }),
              contains: () => false,
            }
            : init),
        }
      }
      return refSlots[idx]
    },
    useCallback: (fn) => fn,
  }

  const sandbox = {
    window: {
      innerWidth: 1200,
      __ModuleLoader__: {
        load(spec) {
          loadedModule = spec.factory((id) => {
            if (id === 'react') return mockReact
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
      addEventListener() {},
      removeEventListener() {},
    },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    navigator: { language: lang, languages: [lang] },
    document: {
      documentElement: { lang },
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })

  return {
    loadedModule,
    renderAt: (baseOffset, fn) => {
      cursors.state = baseOffset
      cursors.effect = baseOffset
      cursors.ref = baseOffset
      return fn()
    },
  }
}
