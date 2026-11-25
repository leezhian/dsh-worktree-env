/**
 * HTTP surface on the Host web server: `/api/dsh-worktree/*` REST routes plus
 * one SSE stream replaying operation logs live. Handlers own the raw Node
 * request/response pair.
 *
 * @module
 */

import { inspect } from 'node:util'

/**
 * Register every route on the web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('./service.js').WorktreeEnhanceService} service
 * @returns {() => void} disposer.
 */
export function registerServer(ctx, service) {
  const prefix = '/api/dsh-worktree-env'
  const disposers = [
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${prefix}/worktrees`, handler: (req, res) => guard(res, async () => listWorktrees(req, res, service)) }), 'dsh-worktree-env: list route'),
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: `${prefix}/worktrees`, handler: (req, res) => guard(res, () => worktreeAction(req, res, service)) }), 'dsh-worktree-env: item routes'),
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: `${prefix}/operations`, handler: (req, res) => guard(res, () => operationRoute(req, res, service)) }), 'dsh-worktree-env: operation routes'),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${prefix}/environments`, handler: (req, res) => guard(res, () => environmentRoute(req, res, service)) }), 'dsh-worktree-env: environment route'),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${prefix}/repo-preferences`, handler: (req, res) => guard(res, () => preferencesRoute(req, res, service)) }), 'dsh-worktree-env: preference route'),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${prefix}/quota`, handler: (req, res) => guard(res, async () => json(res, await service.enforceQuota())) }), 'dsh-worktree-env: quota route'),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${prefix}/config`, handler: (req, res) => guard(res, () => configRoute(req, res, service)) }), 'dsh-worktree-env: config route'),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

async function configRoute(req, res, service) {
  if (req.method === 'GET') {
    json(res, publicConfig(service))
    return
  }
  if (req.method === 'PUT') {
    const body = await readBody(req)
    if (body === null || typeof body !== 'object') throw httpError(400, 'JSON object body required')
    await service.updateConfig(body)
    json(res, publicConfig(service))
    return
  }
  throw httpError(405, 'GET or PUT only')
}

function publicConfig(service) {
  const dirState = service.worktreeDirectoryState()
  return {
    worktreeDirectory: dirState.worktreeDirectory,
    defaultWorktreeDirectory: dirState.defaultWorktreeDirectory,
    nativeSynced: dirState.nativeSynced,
    autoRunSetup: service.config.autoRunSetup,
    autoRunCleanup: service.config.autoRunCleanup,
    setupTimeoutMs: service.config.setupTimeoutMs,
    upstreamRefreshMode: service.config.upstreamRefreshMode,
    defaultCreationPreference: service.config.defaultCreationPreference,
    snapshotOnArchive: service.config.snapshotOnArchive,
    autoCleanupEnabled: service.config.autoCleanupEnabled,
    keepCount: service.config.keepCount,
    confirmBeforeDelete: service.config.confirmBeforeDelete,
  }
}

async function listWorktrees(req, res, service) {
  requireMethod(req, 'GET')
  const url = new URL(req.url ?? '/', 'http://local')
  const withSize = url.searchParams.get('withSize') === '1'
  const { repositories, items } = await service.listAll({ withSize })
  const sessions = service.sessionIndex()
  json(res, {
    repositories,
    items: items.map(item => ({
      ...item,
      sessions: sessions.get(item.path) ?? [],
    })),
  })
}

async function worktreeAction(req, res, service) {
  const url = new URL(req.url ?? '/', 'http://local')
  // /worktrees/<id>[/<action>[...]] — the id is a filesystem path with its
  // slashes percent-encoded, so split the raw (still-encoded) pathname first.
  const raw = url.pathname.replace(/^\/api\/dsh-worktree-env\/worktrees\/?/, '')
  const parts = raw.split('/').filter(part => part.length > 0)
  if (parts.length === 0) throw httpError(404, 'worktree id required')
  const id = decodeURIComponent(parts[0])
  const body = await readBody(req)
  if (parts.length === 1) {
    requireMethod(req, 'DELETE')
    json(res, await service.removeRecord(id, { deleteSnapshot: body?.deleteSnapshot !== false }))
    return
  }
  const action = parts[1]
  if (action === 'setup') {
    requireMethod(req, 'POST')
    if (url.searchParams.get('async') === '1' || body?.async === true) {
      json(res, await service.startSetup(id))
      return
    }
    json(res, await service.runSetup(id))
    return
  }
  if (action === 'actions') {
    requireMethod(req, 'POST')
    const tail = parts.slice(2)
    if (tail.length === 0) throw httpError(400, 'action name required')
    const name = decodeURIComponent(tail[tail.length - 1] === 'run' ? tail.slice(0, -1).join('/') : tail.join('/'))
    json(res, await service.startAction(id, name))
    return
  }
  if (action === 'apply-patch') {
    requireMethod(req, 'POST')
    json(res, await service.applyBackflow(id, { mode: body?.mode ?? 'branch', dryRun: body?.dryRun === true || body?.dryRun === undefined }))
    return
  }
  if (action === 'archive') {
    requireMethod(req, 'POST')
    json(res, await service.archive(id, { force: body?.force === true }))
    return
  }
  if (action === 'restore') {
    requireMethod(req, 'POST')
    json(res, await service.restore(id, undefined))
    return
  }
  if (action === 'handoff') {
    requireMethod(req, 'POST')
    throw httpError(400, 'handoff runs inside a session; use the worktree_handoff tool or the session menu')
  }
  throw httpError(404, `unknown worktree action "${action}"`)
}

async function operationRoute(req, res, service) {
  const url = new URL(req.url ?? '/', 'http://local')
  const rest = url.pathname.replace(/^\/api\/dsh-worktree-env\/operations\/?/, '')
  const [id, tail] = rest.split('/')
  if (id === undefined || id.length === 0) throw httpError(404, 'operation id required')
  if (tail === 'cancel') {
    requireMethod(req, 'POST')
    service.runner.cancel(id)
    json(res, { cancelled: true })
    return
  }
  if (tail === 'stream') {
    return await streamOperation(req, res, service, id)
  }
  requireMethod(req, 'GET')
  const operation = service.runner.get(id)
  if (operation === undefined) throw httpError(404, 'unknown operation')
  json(res, serializeOperation(operation))
}

async function streamOperation(req, res, service, id) {
  const operation = service.runner.get(id)
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': hello\n\n')
  if (operation === undefined) {
    res.write(`event: end\ndata: {"reason":"unknown operation"}\n\n`)
    res.end()
    return
  }
  res.write(`event: snapshot\ndata: ${JSON.stringify(serializeOperation(operation))}\n\n`)
  for (const entry of operation.logs) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`)
  }
  if (operation.status !== 'running') {
    res.write(`event: end\ndata: ${JSON.stringify({ status: operation.status })}\n\n`)
    res.end()
    return
  }
  const unsubscribe = service.runner.subscribe(id, (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`)
  })
  const interval = setInterval(() => res.write(': ping\n\n'), 15_000)
  const finish = () => {
    clearInterval(interval)
    unsubscribe()
    const latest = service.runner.get(id)
    res.write(`event: end\ndata: ${JSON.stringify({ status: latest?.status ?? 'unknown' })}\n\n`)
    res.end()
  }
  const poll = setInterval(() => {
    const latest = service.runner.get(id)
    if (latest === undefined || latest.status !== 'running') {
      clearInterval(poll)
      finish()
    }
  }, 500)
  req.on('close', () => {
    clearInterval(interval)
    clearInterval(poll)
    unsubscribe()
  })
}

async function environmentRoute(req, res, service) {
  const url = new URL(req.url ?? '/', 'http://local')
  const root = url.searchParams.get('root')
  const configPath = url.searchParams.get('configPath') ?? undefined
  if (req.method === 'GET') {
    if (root === null || root.length === 0) {
      json(res, await service.listEnvironmentProjects())
      return
    }
    json(res, await service.readEnvironment(root, configPath))
    return
  }
  if (req.method === 'PUT') {
    const body = await readBody(req)
    if (body === null || typeof body.root !== 'string' || typeof body.definition !== 'object') {
      throw httpError(400, 'root and definition required')
    }
    json(res, await service.writeEnvironment(body.root, body.definition, typeof body.configPath === 'string' ? body.configPath : undefined))
    return
  }
  throw httpError(405, 'GET or PUT only')
}

async function preferencesRoute(req, res, service) {
  const url = new URL(req.url ?? '/', 'http://local')
  const root = url.searchParams.get('root')
  if (req.method === 'GET') {
    if (root === null) throw httpError(400, 'root query parameter required')
    const info = await service.git.check(root, ['rev-parse', '--show-toplevel']).catch(() => null)
    json(res, {
      root,
      repositoryRoot: info?.trim() ?? null,
      preference: await service.preferenceFor(root),
      default: service.config.defaultCreationPreference,
    })
    return
  }
  if (req.method === 'PUT') {
    const body = await readBody(req)
    const allowed = ['ask', 'always', 'never', 'dirty']
    if (body === null || typeof body.root !== 'string' || (body.preference !== null && !allowed.includes(body.preference))) {
      throw httpError(400, 'root and preference (ask | always | never | dirty | null) required')
    }
    const previous = await service.preferenceFor(body.root)
    const saved = await service.setPreference(body.root, body.preference)
    json(res, { ...saved, previous, persisted: 'repository' })
    return
  }
  throw httpError(405, 'GET or PUT only')
}

function serializeOperation(operation) {
  return {
    id: operation.id,
    kind: operation.kind,
    label: operation.label,
    status: operation.status,
    startedAt: operation.startedAt,
    endedAt: operation.endedAt,
    logs: operation.logs.slice(-500),
  }
}

function requireMethod(req, method) {
  if (req.method !== method) throw httpError(405, `${method} required`)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > 4 * 1024 * 1024) {
        reject(httpError(413, 'body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(httpError(400, 'invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function json(res, value) {
  const text = JSON.stringify(value)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function guard(res, body) {
  try {
    await body()
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    const message = error instanceof Error ? error.message : inspect(error)
    const code = typeof error?.code === 'string' ? error.code : undefined
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    }
    res.end(JSON.stringify(code !== undefined ? { error: message, code } : { error: message }))
  }
}
