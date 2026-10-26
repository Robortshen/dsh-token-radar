/**
 * Token Meter — Host half.
 *
 * Reads DeepSeek Harness session logs (~/.dsh/sessions), extracts the real
 * `usage` block of every model call, de-duplicates migrated log copies and
 * sub-agent history copies, and serves one JSON document to the Client half
 * over a same-origin HTTP route.
 *
 * @module token-meter
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const SESSION_ROOT = join(homedir(), '.dsh', 'sessions')
const ROUTE = '/dsh-token-meter/stats'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** USD per 1M tokens; matched by model-name substring. */
const PRICE_TABLE = [
  { match: 'pro', hit: 0.022, miss: 0.66, out: 1.98 },
  { match: 'flash', hit: 0.007, miss: 0.22, out: 0.66 },
]
const DEFAULT_PRICE = PRICE_TABLE[1]
const FX_CNY = 7.2
const SCAN_TTL_MS = 2500

/** @type {Map<string, {size: number, mtimeMs: number, session: object}>} */
const fileCache = new Map()
/** @type {{at: number, data: object}|null} */
let documentCache = null
let scanning = null

// --------------------------------------------------------------------- zstd

/**
 * A session log appends one zstd frame per flush, so the whole file is a
 * concatenation of frames; `zstdDecompressSync` only returns the first one.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function decodeFrames(buf) {
  const offsets = []
  let cursor = 0
  for (;;) {
    const at = buf.indexOf(ZSTD_MAGIC, cursor)
    if (at < 0) break
    offsets.push(at)
    cursor = at + 4
  }
  if (offsets.length === 0) return Buffer.alloc(0)
  offsets.push(buf.length)
  const parts = []
  let k = 0
  while (k < offsets.length - 1) {
    let advanced = false
    for (let m = k + 1; m < offsets.length; m += 1) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], offsets[m])))
        k = m
        advanced = true
        break
      } catch {
        // a longer slice may be a complete frame; keep extending
      }
    }
    if (!advanced) k += 1
  }
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------- parsing

/** @param {unknown} content */
function textLength(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (block && typeof block === 'object') {
      n += String(block.text ?? block.content ?? '').length
    }
  }
  return n
}

/**
 * @param {string} path
 * @param {Buffer} buf
 * @param {number} mtimeMs
 */
function parseSession(path, buf, mtimeMs) {
  const text = decodeFrames(buf).toString('utf8')
  /** @type {any} */
  const session = {
    path,
    mtimeMs,
    id: '',
    version: 0,
    parent: null,
    origin: 'main',
    depth: 0,
    preset: '',
    cwd: '',
    title: '',
    label: '',
    start: 0,
    end: 0,
    steps: [],
    toolCalls: [],
  }
  let header = null
  let provider = null
  let model = null
  const calls = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = event.type
    const data = event.data ?? {}
    const time = typeof event.time === 'number' ? event.time : 0
    if (type === 'session' && header === null) {
      header = event
      continue
    }
    if (time) {
      if (!session.start || time < session.start) session.start = time
      if (time > session.end) session.end = time
    }
    switch (type) {
      case 'request/context':
        provider = data.provider ?? null
        model = data.model ?? null
        break
      case 'session/title':
        session.title = data.title || session.title
        break
      case 'subagent/descriptor':
        session.label = data.label || ''
        break
      case 'tool/call': {
        const call = {
          turn: data.turn,
          step: data.step,
          name: data.name ?? '?',
          callId: data.callId,
          args: textLength(data.arguments),
          resultChars: 0,
        }
        calls.set(call.callId, call)
        session.toolCalls.push(call)
        break
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.message?.source?.callId ?? data.meta?.callId
        const call = calls.get(callId)
        if (call) call.resultChars += textLength(data.message?.content)
        break
      }
      case 'assistant/message': {
        const usage = data.usage
        if (!usage || typeof usage !== 'object') break
        const inp = usage.inputTokens ?? 0
        const cacheRead = usage.cacheReadTokens ?? 0
        const cacheWrite = usage.cacheWriteTokens ?? 0
        const out = usage.outputTokens ?? 0
        session.steps.push({
          turn: data.turn ?? 0,
          step: data.step ?? 0,
          time,
          inp,
          cacheRead,
          cacheWrite,
          out,
          reasoning: usage.reasoningTokens ?? 0,
          total: usage.totalTokens ?? inp + cacheRead + cacheWrite + out,
          provider,
          model,
          tools: [],
        })
        break
      }
      default:
        break
    }
  }
  if (header) {
    session.id = header.id ?? ''
    session.version = header.version ?? 0
    session.parent = header.parentSession ?? null
    session.origin = header.origin ?? 'main'
    session.depth = header.delegationDepth ?? 0
    session.preset = header.agentPreset ?? ''
    session.cwd = header.cwd ?? ''
  }
  if (!session.id) return null
  // attach tool names to the step that issued them
  const byStep = new Map()
  for (const step of session.steps) byStep.set(`${step.turn}:${step.step}`, step)
  for (const call of session.toolCalls) {
    const step = byStep.get(`${call.turn}:${call.step}`)
    if (step && call.name) step.tools.push(call.name)
  }
  return session
}

// ---------------------------------------------------------------- storing

async function listLogs(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await listLogs(path, out)
    else if (entry.name.endsWith('.zstd')) out.push(path)
  }
  return out
}

function zero() {
  return { steps: 0, inp: 0, cacheRead: 0, cacheWrite: 0, out: 0, reasoning: 0, total: 0 }
}

function accumulate(target, step) {
  target.steps += 1
  target.inp += step.inp
  target.cacheRead += step.cacheRead
  target.cacheWrite += step.cacheWrite
  target.out += step.out
  target.reasoning += step.reasoning
  target.total += step.total
  return target
}

function totalOf(steps) {
  const out = zero()
  for (const step of steps) accumulate(out, step)
  return out
}

function priceOf(model) {
  const name = String(model ?? '').toLowerCase()
  for (const row of PRICE_TABLE) if (name.includes(row.match)) return row
  return DEFAULT_PRICE
}

function costOf(steps) {
  let usd = 0
  for (const step of steps) {
    const price = priceOf(step.model)
    usd += (step.inp * price.miss + step.cacheRead * price.hit + step.out * price.out) / 1e6
  }
  return usd
}

function dayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** @returns {Promise<object[]>} */
async function loadSessions(log) {
  const files = await listLogs(SESSION_ROOT)
  const stats = await Promise.all(
    files.map(async (path) => {
      try {
        return { path, st: await stat(path) }
      } catch {
        return null
      }
    }),
  )
  const sessions = []
  for (const item of stats) {
    if (!item) continue
    const { path, st } = item
    const cached = fileCache.get(path)
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      sessions.push(cached.session)
      continue
    }
    let buf
    try {
      buf = await readFile(path)
    } catch {
      continue
    }
    const session = parseSession(path, buf, st.mtimeMs)
    if (!session) continue
    log.decoded += 1
    fileCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, session })
    sessions.push(session)
  }
  log.files = files.length
  // drop cache entries for removed files
  const alive = new Set(files)
  for (const path of fileCache.keys()) if (!alive.has(path)) fileCache.delete(path)
  return sessions.filter((session) => session.steps.length > 0)
}

/**
 * One session id can have several migrated log copies; one session log can also
 * carry a full copy of its parent's history. Both would double count.
 */
function dedupe(sessions) {
  const best = new Map()
  for (const session of sessions) {
    const current = best.get(session.id)
    if (!current) {
      best.set(session.id, session)
      continue
    }
    const rank = (s) => [s.steps.length, s.version, s.mtimeMs]
    const a = rank(session)
    const b = rank(current)
    const better = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    if (better > 0) best.set(session.id, session)
  }
  const ordered = [...best.values()].sort(
    (left, right) => left.depth - right.depth || left.start - right.start,
  )
  const seen = new Set()
  const out = []
  for (const session of ordered) {
    const kept = []
    for (const step of session.steps) {
      const key = [step.time, step.turn, step.step, step.inp, step.cacheRead, step.cacheWrite, step.out].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(step)
    }
    if (kept.length === 0) continue
    session.steps = kept
    out.push(session)
  }
  return out
}

// ---------------------------------------------------------------- document

function childrenIndex(sessions) {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const kids = new Map()
  for (const session of sessions) {
    if (!session.parent || !byId.has(session.parent)) continue
    const list = kids.get(session.parent) ?? []
    list.push(session)
    kids.set(session.parent, list)
  }
  return { byId, kids }
}

function sumTree(session, kids, seen = new Set()) {
  if (seen.has(session.id)) return zero()
  seen.add(session.id)
  const total = totalOf(session.steps)
  for (const child of kids.get(session.id) ?? []) {
    const childTotal = sumTree(child, kids, seen)
    for (const key of Object.keys(total)) total[key] += childTotal[key]
  }
  return total
}

function pickCurrent(sessions, sessionId) {
  if (sessionId) {
    const found = sessions.find((session) => session.id === sessionId)
    if (found) return found
    return null
  }
  let latest = null
  for (const session of sessions) {
    if (!latest || (session.end ?? 0) > (latest.end ?? 0)) latest = session
  }
  return latest
}

function stepView(step, previousPrompt) {
  const prompt = step.inp + step.cacheRead + step.cacheWrite
  return {
    turn: step.turn,
    step: step.step,
    time: step.time,
    inp: step.inp,
    cacheRead: step.cacheRead,
    cacheWrite: step.cacheWrite,
    out: step.out,
    reasoning: step.reasoning,
    total: step.total,
    prompt,
    delta: previousPrompt === null ? null : prompt - previousPrompt,
    model: step.model,
    provider: step.provider,
    tools: step.tools.slice(0, 6),
  }
}

/** Tool-cost attribution: measured prompt growth minus the previous output. */
function toolAttribution(session) {
  const byName = new Map()
  const callsByStep = new Map()
  for (const call of session.toolCalls) {
    const key = `${call.turn}:${call.step}`
    const list = callsByStep.get(key) ?? []
    list.push(call)
    callsByStep.set(key, list)
    const row = byName.get(call.name) ?? { name: call.name, calls: 0, chars: 0, alloc: 0 }
    row.calls += 1
    row.chars += call.resultChars
    byName.set(call.name, row)
  }
  let previous = null
  for (const step of session.steps) {
    if (previous) {
      const growth = step.inp + step.cacheRead + step.cacheWrite - previous.prompt - previous.out
      const calls = callsByStep.get(`${previous.turn}:${previous.step}`) ?? []
      if (calls.length > 0 && growth > 0) {
        const weight = calls.reduce((sum, call) => sum + Math.max(1, call.resultChars), 0)
        for (const call of calls) {
          const row = byName.get(call.name)
          if (row) row.alloc += (growth * Math.max(1, call.resultChars)) / weight
        }
      }
    }
    previous = { turn: step.turn, step: step.step, prompt: step.inp + step.cacheRead + step.cacheWrite, out: step.out }
  }
  return [...byName.values()]
    .map((row) => ({ ...row, alloc: Math.round(row.alloc) }))
    .sort((left, right) => right.alloc - left.alloc)
}

function currentView(session, sessions, kids) {
  if (!session) return null
  const totals = totalOf(session.steps)
  const turns = new Map()
  for (const step of session.steps) {
    const key = step.turn
    const row = turns.get(key) ?? { turn: key, steps: 0, inp: 0, cacheRead: 0, out: 0, total: 0, cost: 0 }
    row.steps += 1
    row.inp += step.inp
    row.cacheRead += step.cacheRead
    row.out += step.out
    row.total += step.total
    row.cost += costOf([step])
    turns.set(key, row)
  }
  const steps = []
  let previousPrompt = null
  for (const step of session.steps) {
    const view = stepView(step, previousPrompt)
    previousPrompt = view.prompt
    steps.push(view)
  }
  const subagents = []
  const walk = (parentId, depth) => {
    for (const child of kids.get(parentId) ?? []) {
      const total = sumTree(child, kids)
      subagents.push({
        id: child.id,
        label: child.label || child.title || child.id.slice(0, 16),
        depth,
        steps: child.steps.length,
        total: total.total,
        inp: total.inp,
        cacheRead: total.cacheRead,
        out: total.out,
        cost: costOf(child.steps),
      })
      walk(child.id, depth + 1)
    }
  }
  walk(session.id, 1)
  return {
    sessionId: session.id,
    title: session.title || session.label || '',
    cwd: session.cwd,
    start: session.start,
    end: session.end,
    model: session.steps.at(-1)?.model ?? null,
    provider: session.steps.at(-1)?.provider ?? null,
    totals: { ...totals, cost: costOf(session.steps) },
    tree: sumTree(session, kids),
    turns: [...turns.values()],
    steps: steps.length > 240 ? steps.slice(-240) : steps,
    truncated: steps.length > 240,
    subagents,
    tools: toolAttribution(session),
  }
}

async function buildDocument() {
  const startedAt = Date.now()
  const log = { files: 0, decoded: 0 }
  const raw = await loadSessions(log)
  const sessions = dedupe(raw)
  const { kids } = childrenIndex(sessions)

  const allSteps = []
  const mainSteps = []
  const subSteps = []
  const days = new Map()
  const models = new Map()
  const workspaces = new Map()
  for (const session of sessions) {
    for (const step of session.steps) {
      allSteps.push(step)
      if (session.depth > 0) subSteps.push(step)
      else mainSteps.push(step)
      const day = dayKey(step.time || session.start)
      const dayRow = days.get(day) ?? { date: day, ...zero() }
      accumulate(dayRow, step)
      days.set(day, dayRow)
      const modelKey = `${step.provider ?? '?'}:${step.model ?? '?'}`
      const modelRow = models.get(modelKey) ?? { key: modelKey, ...zero(), cost: 0 }
      accumulate(modelRow, step)
      modelRow.cost += costOf([step])
      models.set(modelKey, modelRow)
    }
    const cwd = session.cwd || '(未知)'
    const workspaceRow = workspaces.get(cwd) ?? { cwd, sessions: 0, steps: 0, inp: 0, cacheRead: 0, out: 0, total: 0 }
    workspaceRow.sessions += 1
    const total = totalOf(session.steps)
    workspaceRow.steps += total.steps
    workspaceRow.inp += total.inp
    workspaceRow.cacheRead += total.cacheRead
    workspaceRow.out += total.out
    workspaceRow.total += total.total
    workspaces.set(cwd, workspaceRow)
  }

  const totals = totalOf(allSteps)
  const today = dayKey(Date.now())
  const todayRow = days.get(today) ?? { date: today, ...zero() }

  const sessionRows = sessions
    .slice()
    .sort((left, right) => (right.end ?? 0) - (left.end ?? 0))
    .slice(0, 200)
    .map((session) => {
      const total = totalOf(session.steps)
      return {
        id: session.id,
        parent: session.parent,
        depth: session.depth,
        title: session.title || session.label || '',
        cwd: session.cwd,
        start: session.start,
        end: session.end,
        steps: total.steps,
        inp: total.inp,
        cacheRead: total.cacheRead,
        out: total.out,
        total: total.total,
        cost: costOf(session.steps),
        treeTotal: session.depth === 0 ? sumTree(session, kids).total : total.total,
      }
    })

  const data = {
    generatedAt: Date.now(),
    scan: {
      files: log.files,
      decoded: log.decoded,
      sessions: sessions.length,
      ms: Date.now() - startedAt,
      zstd: typeof zlib.zstdDecompressSync === 'function',
    },
    totals: { ...totals, cost: costOf(allSteps) },
    main: totalOf(mainSteps),
    sub: totalOf(subSteps),
    today: { ...todayRow, cost: costOf(allSteps.filter((step) => dayKey(step.time || 0) === today)) },
    days: [...days.values()].sort((left, right) => (left.date < right.date ? -1 : 1)).slice(-30),
    models: [...models.values()].sort((left, right) => right.total - left.total),
    workspaces: [...workspaces.values()].sort((left, right) => right.total - left.total).slice(0, 12),
    sessions: sessionRows,
    current: null,
    fx: FX_CNY,
  }
  return { data, sessions, kids }
}

/** @type {Map<string, object>} current views of the generation in `documentCache` */
let currentCache = new Map()
/** @type {{sessions: object[], kids: Map<string, object[]>}|null} */
let lastScan = null

function rememberScan(sessions, kids) {
  lastScan = { sessions, kids }
  currentCache = new Map()
}

function currentForKey(sessionId) {
  if (!lastScan) return null
  const key = sessionId || ''
  if (currentCache.has(key)) return currentCache.get(key)
  const session = pickCurrent(lastScan.sessions, sessionId)
  const view = currentView(session, lastScan.sessions, lastScan.kids)
  currentCache.set(key, view)
  return view
}

async function document(sessionId) {
  const fresh = documentCache && Date.now() - documentCache.at < SCAN_TTL_MS
  if (!fresh) {
    if (!scanning) {
      scanning = buildDocument()
        .then(({ data, sessions, kids }) => {
          documentCache = { at: Date.now(), data }
          rememberScan(sessions, kids)
          return data
        })
        .finally(() => {
          scanning = null
        })
    }
    await scanning
  }
  return { ...documentCache.data, current: currentForKey(sessionId) }
}

// ---------------------------------------------------------------- plugin

export const inject = ['webServer']

/**
 * @param {import('@cordisjs/core').Context} ctx
 */
export function apply(ctx) {
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url ?? ROUTE, 'http://localhost')
      const sessionId = url.searchParams.get('session') ?? ''
      const data = await document(sessionId)
      const body = JSON.stringify(data)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: String(error?.message ?? error) }))
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: serve }),
    'token-meter: stats route',
  )
}

export { buildDocument as buildStats }
