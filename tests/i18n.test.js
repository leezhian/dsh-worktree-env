/**
 * Multilingual coverage and live DSH locale reactivity tests:
 * - all 8 DSH locales exist in locale/*.json with valid meta.title/description/detail
 * - README.md & README.zh.md exist and cross-link
 * - client.js registers complete, key-aligned dictionaries for all 8 locales with ctx.locale
 * - switching ctx.locale updates slot labels, right-tab title, and live UI translations immediately
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

test('locale/*.json covers all 8 DSH languages and points to existing detail docs', async () => {
  for (const id of EXPECTED_LOCALES) {
    const file = join(ROOT, 'locale', `${id}.json`)
    const data = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(typeof data.meta?.title, 'string', `${id}.json missing meta.title`)
    assert.ok(data.meta.title.trim().length > 0, `${id}.json empty meta.title`)
    assert.equal(typeof data.meta?.description, 'string', `${id}.json missing meta.description`)
    assert.ok(data.meta.description.trim().length > 0, `${id}.json empty meta.description`)
    assert.equal(typeof data.meta?.detail, 'string', `${id}.json missing meta.detail`)
    await access(join(ROOT, data.meta.detail))
  }
  const zhMeta = JSON.parse(await readFile(join(ROOT, 'locale', 'zh.json'), 'utf8')).meta
  const enMeta = JSON.parse(await readFile(join(ROOT, 'locale', 'en.json'), 'utf8')).meta
  assert.equal(zhMeta.detail, 'docs/DETAIL.zh.md')
  assert.equal(enMeta.detail, 'docs/DETAIL.md')

  const readmeEn = await readFile(join(ROOT, 'README.md'), 'utf8')
  const readmeZh = await readFile(join(ROOT, 'README.zh.md'), 'utf8')
  assert.match(readmeEn, /\(README\.zh\.md\)/)
  assert.match(readmeZh, /\(README\.md\)/)
})

test('client.js registers all 8 locales with identical keys and reacts live to ctx.locale changes', async () => {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')

  let loadedModule = null
  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
  }

  const sandbox = {
    window: {
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
    navigator: { language: 'en-US', languages: ['en-US'] },
    document: { documentElement: { lang: 'en' } },
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(loadedModule && typeof loadedModule.apply === 'function')

  // Minimal mirror of @deepseek-ai/dsh-client-locale's LocaleRuntime
  const registered = new Map()
  const subscribers = new Set()
  const ctxListeners = new Map()
  let snapshot = { active: 'zh', revision: 0 }

  const localeService = {
    register(ns, dictsOrId, singleDict) {
      let map = registered.get(ns)
      if (!map) {
        map = new Map()
        registered.set(ns, map)
      }
      if (typeof dictsOrId === 'string') {
        map.set(dictsOrId, singleDict)
      } else {
        for (const [id, dict] of Object.entries(dictsOrId)) map.set(id, dict)
      }
      snapshot = { active: snapshot.active, revision: snapshot.revision + 1 }
      return () => { registered.delete(ns) }
    },
    bind(ns) {
      return (key, params) => {
        const map = registered.get(ns)
        const dict = map?.get(snapshot.active) ?? map?.get('en')
        const raw = dict?.[key] ?? map?.get('en')?.[key] ?? key
        if (!params) return raw
        return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
      }
    },
    getSnapshot: () => snapshot,
    getLocale: () => snapshot,
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    setLocale(nextActive) {
      snapshot = { active: nextActive, revision: snapshot.revision + 1 }
      for (const fn of [...subscribers]) fn()
      for (const fn of ctxListeners.get('locale/change') ?? []) fn(snapshot)
    },
  }

  const slots = []
  let rightTab = null
  const ctx = {
    locale: localeService,
    get(key) {
      if (key === 'locale') return localeService
      if (key === 'sidebarRightTabs') {
        return {
          register(def) {
            rightTab = def
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, fn) {
      const set = ctxListeners.get(event) ?? new Set()
      set.add(fn)
      ctxListeners.set(event, set)
      return () => set.delete(fn)
    },
    slots: {
      inject(_name, fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(meta, component) {
        slots.push({ meta, component })
        return () => {}
      },
    },
  }

  const dispose = loadedModule.apply(ctx)

  // Verify all 8 locales were registered with identical keys and placeholders
  const dicts = registered.get('dshWorktreeEnv')
  assert.ok(dicts, 'expected dshWorktreeEnv namespace to be registered')
  assert.deepEqual([...dicts.keys()].sort(), [...EXPECTED_LOCALES].sort())

  const enKeys = Object.keys(dicts.get('en')).sort()
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

  for (const id of EXPECTED_LOCALES) {
    const dict = dicts.get(id)
    assert.deepEqual(Object.keys(dict).sort(), enKeys, `key mismatch for locale "${id}"`)
    for (const key of enKeys) {
      assert.equal(typeof dict[key], 'string', `${id}.${key} must be string`)
      assert.ok(dict[key].trim().length > 0, `${id}.${key} must not be empty`)
      assert.deepEqual(
        placeholders(dict[key]),
        placeholders(dicts.get('en')[key]),
        `placeholder mismatch in ${id}.${key}`,
      )
    }
  }

  // Verify slot metadata passes locale namespace and dynamic title/label thunks react to locale switches
  const mainSlot = slots.find(s => s.meta.name === 'main')
  const menuSlot = slots.find(s => s.meta.name === 'sidebar.workspaces.session.menu.item')
  assert.equal(mainSlot.meta.locale, 'dshWorktreeEnv')
  assert.equal(menuSlot.meta.locale, 'dshWorktreeEnv')
  assert.ok(rightTab)

  assert.equal(rightTab.title(), 'Worktree 环境')
  localeService.setLocale('en')
  assert.equal(rightTab.title(), 'Worktree env')
  localeService.setLocale('ja')
  assert.equal(rightTab.title(), 'Worktree 環境')
  localeService.setLocale('de')
  assert.equal(rightTab.title(), 'Worktree-Umgebung')

  // Render WorktreePanel under en vs zh vs ja to confirm UI text follows ctx.locale (not navigator.language)
  const extractText = (node) => {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(extractText).join(' ')
    if (node && typeof node === 'object') return extractText(node.children)
    return ''
  }

  localeService.setLocale('zh')
  const zhRendered = extractText(mainSlot.component())
  assert.match(zhRendered, /设置/)
  assert.match(zhRendered, /环境/)

  localeService.setLocale('en')
  const enRendered = extractText(mainSlot.component())
  assert.match(enRendered, /Settings/)
  assert.match(enRendered, /Environments/)

  localeService.setLocale('ja')
  const jaRendered = extractText(mainSlot.component())
  assert.match(jaRendered, /設定/)
  assert.match(jaRendered, /環境/)

  dispose()
})
