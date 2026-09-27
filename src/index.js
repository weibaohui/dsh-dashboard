'use strict'
/**
 * dsh-dashboard — Host 半体
 *
 * 纯离线统计分析：扫描 ~/.dsh/sessions/**\/session.v*.jsonl.zstd（zstd 解压逐行
 * fold 成「会话×日」事实表），对外提供 cube/summary/sessions/heat/errors 等只读
 * 查询 API 与 pages/pricing 配置 API；client 半体用 gridstack+ECharts 渲染可拖拽
 * 卡片页（预设五页 + 手排 + AI 提示词往返导入）。
 *
 * 增量策略：按文件 mtime 跳过未变化文件；会话事实按 sessionId 落 storageDomain
 * （域 dsh_dashboard），内存持一份供 API 聚合。整插件零 npm 运行时依赖
 * （zstd 用 node:zlib，缺 zlib 支持时回退外部 zstd 命令）。
 */

const { homedir } = require('node:os')
const { join, basename, dirname } = require('node:path')
const { readdir, readFile, stat } = require('node:fs').promises
const zlib = require('node:zlib')
const { Readable } = require('node:stream')
const { spawn } = require('node:child_process')

const fold = require('./fold')
const presets = require('./presets')

const PLUGIN_ID = 'dsh-dashboard'
const API_PREFIX = '/dsh-dashboard/api'
const MAX_BODY_BYTES = 1024 * 1024
const PAGE_COUNT_MAX = 20

// ── 会话文件发现与解压 ────────────────────────────────────────────────────────

function sessionsRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

async function listSessionFiles(root) {
  const out = []
  let projects = []
  try { projects = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const projPath = join(root, proj.name)
    let sessions = []
    try { sessions = await readdir(projPath, { withFileTypes: true }) } catch { continue }
    for (const s of sessions) {
      if (!s.isDirectory() || !s.name.startsWith('session-')) continue
      const dir = join(projPath, s.name)
      let entries = []
      try { entries = await readdir(dir) } catch { continue }
      // 同目录可能并存 v3/v4（迁移残留）：取版本号最高的一个
      let best = null
      for (const name of entries) {
        const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name)
        if (!m) continue
        const ver = Number(m[1])
        if (!best || ver > best.ver) best = { ver, name }
      }
      if (!best) continue
      const path = join(dir, best.name)
      try {
        const st = await stat(path)
        out.push({ path, mtime: Math.round(st.mtimeMs), sessionId: s.name, project: proj.name })
      } catch { /* 竞态：文件刚被删 */ }
    }
  }
  return out
}

async function zstdCli(path) {
  return new Promise((resolve, reject) => {
    const child = spawn('zstd', ['-dc', path], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', (c) => chunks.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
      else reject(new Error(`zstd exited ${code}`))
    })
  })
}

/**
 * zstd 解压。zstd 帧头通常不带内容长度，node:zlib 的一次性 zstdDecompress
 * 会按初始缓冲截断输出（实测 10MB 输入静默截成 190 字节）——必须走流式
 * createZstdDecompress（宿主 dsh-session-persistence-jsonl 同款）。
 */
async function zstdStreamDecompress(buf) {
  const chunks = []
  const source = Readable.from([buf])
  const dz = zlib.createZstdDecompress()
  for await (const chunk of source.pipe(dz)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 结构化扫描 zstd 帧边界（不解压块，只按帧格式跳步）。
 * 会话日志是「多帧拼接容器」（宿主每批次 append 一帧，利于增量与断帧恢复），
 * node:zlib 的解压流解完第一帧即视为结束——必须逐帧解。
 * 返回 {frames:[{start,end}], tornStart?}（tornStart 为尾部不完整帧起点）。
 */
function scanZstdFrames(buf, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length >= maxFrames) return { frames }
  }
  return { frames }
}

/**
 * 读会话日志全文。主路径：多帧容器逐帧一次性解压（zstdDecompressSync 对单帧
 * 自洽）；帧结构异常或运行时无 zstd 支持时，回退解压流 / 外部 zstd 命令。
 */
async function readSessionText(path) {
  const buf = await readFile(path)
  if (typeof zlib.zstdDecompressSync === 'function') {
    try {
      const { frames } = scanZstdFrames(buf)
      if (frames.length > 0) {
        const parts = []
        for (const f of frames) parts.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)))
        return Buffer.concat(parts).toString('utf8')
      }
    } catch (e) {
      // 容器结构不符（或非多帧格式）：掉到通用解压路径
    }
  }
  if (typeof zlib.createZstdDecompress === 'function') {
    try {
      return (await zstdStreamDecompress(buf)).toString('utf8')
    } catch (e) { /* 掉到外部命令 */ }
  }
  if (typeof zlib.zstdDecompressSync === 'function') {
    try {
      return zlib.zstdDecompressSync(buf, { chunkSize: 64 * 1024 * 1024 }).toString('utf8')
    } catch (e) { /* 掉到外部命令 */ }
  }
  return zstdCli(path)
}

async function readSessionEvents(path) {
  const text = await readSessionText(path)
  const events = []
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue
    try { events.push(JSON.parse(line)) } catch { /* 单行坏了不影响整体 */ }
  }
  return events
}

// ── 配置校验 ────────────────────────────────────────────────────────────────

function normalizeQuery(raw) {
  const q = {}
  if (!raw || typeof raw !== 'object') return q
  if (Array.isArray(raw.measures)) {
    q.measures = raw.measures.filter((m) => typeof m === 'string' && fold.MEASURES[m]).slice(0, 6)
  }
  if (typeof raw.formula === 'string') q.formula = raw.formula.slice(0, 300)
  if (presets.GRANULARITIES.includes(raw.granularity)) q.granularity = raw.granularity
  if (raw.groupBy === '' || presets.GROUP_BYS.includes(raw.groupBy)) q.groupBy = raw.groupBy
  if (raw.scope === 'top' || raw.scope === 'all') q.scope = raw.scope
  if (typeof raw.project === 'string') q.project = raw.project.slice(0, 120)
  if (presets.RANGES.includes(String(raw.range))) q.range = String(raw.range)
  return q
}

/** 页面对象校验；返回 {ok, errors, page}。 */
function validatePage(raw) {
  const errors = []
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['page 必须是对象'] }
  const page = {}
  page.id = typeof raw.id === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.id) ? raw.id : ''
  if (!page.id) errors.push('id 必须是 1-40 位小写字母/数字/连字符')
  page.title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 40) : ''
  if (!page.title) errors.push('title 不能为空')
  page.cols = typeof raw.cols === 'number' && raw.cols >= 4 && raw.cols <= 24 ? Math.round(raw.cols) : 12
  if (!Array.isArray(raw.layout)) {
    errors.push('layout 必须是数组')
    return { ok: false, errors, page: null }
  }
  const layout = []
  const seen = new Set()
  for (const it of raw.layout.slice(0, 80)) {
    if (!it || typeof it !== 'object' || typeof it.i !== 'string') { errors.push('layout 项缺少 i'); continue }
    if (seen.has(it.i)) { errors.push(`layout 项重复：${it.i}`); continue }
    seen.add(it.i)
    const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : d)
    layout.push({ i: it.i.slice(0, 60), x: n(it.x, 0), y: n(it.y, 0), w: n(it.w, 3), h: n(it.h, 3) })
  }
  page.layout = layout
  const cards = {}
  if (!raw.cards || typeof raw.cards !== 'object') {
    errors.push('cards 必须是对象')
  } else {
    for (const [id, card] of Object.entries(raw.cards).slice(0, 80)) {
      if (!card || typeof card !== 'object') { errors.push(`卡片 ${id} 不是对象`); continue }
      if (!presets.CARD_TYPES[card.type]) { errors.push(`卡片 ${id} 类型未知：${card.type}`); continue }
      if (layout.length && !seen.has(id)) { errors.push(`卡片 ${id} 不在 layout 中`); continue }
      cards[id.slice(0, 60)] = {
        type: card.type,
        title: typeof card.title === 'string' && card.title.trim() ? card.title.trim().slice(0, 80) : presets.CARD_TYPES[card.type],
        query: normalizeQuery(card.query),
        options: card.options && typeof card.options === 'object' ? card.options : {},
      }
    }
  }
  page.cards = cards
  for (const it of layout) {
    if (!cards[it.i]) errors.push(`layout 项 ${it.i} 没有对应卡片`)
  }
  return { ok: errors.length === 0, errors, page }
}

function normalizePricing(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [model, p] of Object.entries(raw).slice(0, 200)) {
    if (!p || typeof p !== 'object') continue
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
    const key = String(model).slice(0, 80)
    out[key] = { in: num(p.in), out: num(p.out), cr: num(p.cr), cw: num(p.cw) }
  }
  return out
}

// ── 插件 ────────────────────────────────────────────────────────────────────

module.exports = {
  name: PLUGIN_ID,
  inject: ['webServer', 'connection', 'storageDomain'],

  __internals: { validatePage, normalizePricing, normalizeQuery, listSessionFiles, readSessionEvents },

  apply(ctx) {
    // ── 存储 ──────────────────────────────────────────────────────────────
    // open 失败（如重启窗口期域名仍被上一个实例占用）不能静默：退化为内存
    // 存储（重启即失），并在 /status 里如实标注 storage 模式。
    const memTables = { facts: new Map(), meta: new Map(), pages: new Map(), pricing: new Map(), config: new Map() }
    const storageMode = { mode: 'memory', error: '' }
    // 宿主在 open 时会对每条已存记录跑 valueSchema.parse(raw)：表规格必须带
    // parse（这里用透传的 duck-typed schema，KV 值自身已是插件产出的 JSON）；
    // 缺 valueSchema 会让重启加载第一条记录时直接抛 invalid-record。
    // invalidRecords 容错：坏记录挪到备份并视为缺失，不让整个域打不开。
    const passthrough = { parse: (v) => v }
    const domainPromise = ctx.storageDomain.open({
      name: 'dsh_dashboard',
      version: 1,
      invalidRecords: 'backup-and-skip',
      tables: {
        facts: { valueSchema: passthrough },
        meta: { valueSchema: passthrough },
        pages: { valueSchema: passthrough },
        pricing: { valueSchema: passthrough },
        config: { valueSchema: passthrough },
      },
    }).then((domain) => {
      if (domain) storageMode.mode = 'domain'
      return domain
    }).catch((e) => {
      storageMode.mode = 'memory'
      storageMode.error = String((e && e.message) || e).slice(0, 200)
      return null
    })

    async function storeTable(name) {
      const domain = await domainPromise
      if (domain) return domain.table(name)
      return {
        get: (key) => memTables[name].get(key),
        put: async (key, value) => { memTables[name].set(key, value) },
      }
    }
    ctx.effect(() => () => {
      domainPromise.then((d) => d && d.close()).catch(() => {})
    }, 'dsh-dashboard: storage close')

    // ── 内存事实缓存 ───────────────────────────────────────────────────────
    const factsById = new Map()
    const scanState = {
      scanning: false,
      progress: { total: 0, done: 0 },
      lastScanAt: 0,
      fileCount: 0,
      scanErrors: [],
      startedAt: 0,
    }
    let factsLoaded = false

    async function ensureFactsLoaded() {
      if (factsLoaded) return
      factsLoaded = true
      try {
        const meta = await storeTable('meta')
        const facts = await storeTable('facts')
        const ids = (await meta.get('factIds')) || []
        for (const id of ids) {
          try {
            const fact = await facts.get(id)
            if (fact && fact.days) factsById.set(id, fact)
          } catch { /* 单条坏了跳过 */ }
        }
      } catch { /* 存储不可用：仅扫描结果可用 */ }
    }

    async function persistFact(id, fact) {
      try {
        const facts = await storeTable('facts')
        if (fact === null && facts.delete) {
          await facts.delete(id)
          return
        }
        await facts.put(id, fact)
      } catch { /* 值过大或存储不可用：保留内存副本 */ }
    }

    async function persistFactIds() {
      try {
        const meta = await storeTable('meta')
        await meta.put('factIds', [...factsById.keys()])
      } catch { /* ignore */ }
    }

    async function runScan(full) {
      if (scanState.scanning) return { ok: false, error: 'scan already running' }
      scanState.scanning = true
      scanState.startedAt = Date.now()
      scanState.scanErrors = []
      scanState.progress = { total: 0, done: 0 }
      // 异步执行，进度经 /status 轮询
      const promise = (async () => {
        await ensureFactsLoaded()
        const root = sessionsRoot()
        const files = await listSessionFiles(root)
        scanState.fileCount = files.length
        let meta = { files: {} }
        try {
          const table = await storeTable('meta')
          const stored = await table.get('scanMeta')
          if (stored && typeof stored.files === 'object') meta = stored
        } catch { /* ignore */ }
        const todo = files.filter((f) => full || meta.files[f.path] !== f.mtime)
        scanState.progress.total = todo.length
        for (const f of todo) {
          try {
            const events = await readSessionEvents(f.path)
            const fact = fold.foldSession(f.sessionId, events)
            if (fact && (fact.days && Object.keys(fact.days).length > 0)) {
              fact.project = fact.project || (f.project || '').replace(/^--|--$/g, '').split('/').pop() || ''
              factsById.set(f.sessionId, fact)
              await persistFact(f.sessionId, fact)
            } else if (!fact) {
              factsById.delete(f.sessionId)
              await persistFact(f.sessionId, null)
            }
          } catch (e) {
            scanState.scanErrors.push(`${basename(f.path)}: ${String((e && e.message) || e).slice(0, 120)}`)
            if (scanState.scanErrors.length > 30) scanState.scanErrors.shift()
          }
          meta.files[f.path] = f.mtime
          if (Object.keys(meta.files).length > 5000) {
            // 防无限膨胀：丢最旧的一半
            const keys = Object.keys(meta.files)
            for (const k of keys.slice(0, 2500)) delete meta.files[k]
          }
          scanState.progress.done += 1
        }
        try {
          const table = await storeTable('meta')
          await table.put('scanMeta', meta)
        } catch { /* ignore */ }
        await persistFactIds()
        scanState.lastScanAt = Date.now()
      })()
      try {
        await promise
      } finally {
        scanState.scanning = false
      }
      return { ok: true }
    }

    // 启动即增量扫描（后台）
    setTimeout(() => { runScan(false).catch(() => {}) }, 3000)

    // ── 查询辅助 ───────────────────────────────────────────────────────────
    const todayStr = () => fold.localDate(Date.now())
    const daysAgo = (n) => fold.localDate(Date.now() - (n - 1) * 86400000)

    function resolveRange(range) {
      if (range === 'today') { const t = todayStr(); return { from: t, to: t } }
      const n = Number(range)
      if (Number.isFinite(n) && n > 0) return { from: daysAgo(Math.min(2000, Math.round(n))), to: todayStr() }
      return { from: '', to: '' }
    }

    async function currentPricing() {
      try {
        const table = await storeTable('pricing')
        const stored = await table.get('prices')
        if (stored && typeof stored === 'object' && Object.keys(stored).length > 0) return stored
      } catch { /* ignore */ }
      return presets.DEFAULT_PRICING
    }

    async function currentPages() {
      try {
        const table = await storeTable('pages')
        const stored = await table.get('pages')
        if (Array.isArray(stored) && stored.length > 0) return stored
      } catch { /* ignore */ }
      return presets.defaultPages()
    }

    const DEFAULT_CONFIG = { entry: 'sidebar' } // sidebar | settings | both

    async function currentConfig() {
      try {
        const table = await storeTable('config')
        const stored = await table.get('ui')
        if (stored && typeof stored === 'object') return { ...DEFAULT_CONFIG, ...stored }
      } catch { /* ignore */ }
      return { ...DEFAULT_CONFIG }
    }

    const listFacts = (q) => [...factsById.values()]

    function readBody(req, limit) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
          chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    // ── AI 编排提示词（往返流程：复制 → 会话里让 AI 生成 → 粘回导入）────────
    function aiPrompt(request) {
      const catalog = presets.catalog()
      const lines = []
      lines.push('你是 dsh-dashboard 页面编排助手。请生成一个仪表盘页面配置 JSON（只输出 JSON，不要任何解释或代码围栏）。')
      lines.push(`用户需求：${request || '综合概览页'}`)
      lines.push('')
      lines.push('页面 JSON Schema：')
      lines.push(JSON.stringify({
        id: '小写字母数字连字符，唯一',
        title: '页面标题',
        cols: 12,
        layout: [{ i: '卡片id', x: 0, y: 0, w: 4, h: 3 }],
        cards: {
          卡片id: {
            type: 'stat | line | bar | pie | table | calendarHeatmap | punchcard',
            title: '卡片标题',
            query: { measures: ['指标名'], formula: '可选公式', granularity: 'day|week|month', range: 'today|7|30|90|365|all', groupBy: 'model|tool|skill|cmd|slash|project|session|""', scope: 'all|top', project: '可选' },
            options: {},
          },
        },
      }, null, 2))
      lines.push('')
      lines.push('可用指标（measures）：' + Object.entries(fold.MEASURES).map(([k, v]) => `${k}(${v})`).join('、'))
      lines.push('公式函数：pct(a,b)=a/b*100；perSec(tokens,ms)=每秒速率；delta(x)=环比差；ma(x,n)=n期移动平均')
      lines.push('卡片类型说明：' + Object.entries(catalog.cardTypes).map(([k, v]) => `${k}=${v}`).join('；'))
      lines.push('规则：calendarHeatmap 用 range "365"、measures 单指标；punchcard 不需要 measures；stat 用 range "today" 或 "7"；bar/pie/table 建议带 groupBy；每页 4-9 张卡片；布局 12 列网格，stat 卡 w=3 h=2，图表卡 w=4-8 h=4-7，注意 x+w<=12、y 不重叠。')
      return lines.join('\n')
    }

    // ── 路由 ──────────────────────────────────────────────────────────────
    ctx.effect(() => {
      const disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.writeHead(rejection)
            res.end()
            return
          }
          const url = new URL(req.url || '/', 'http://dsh.local')
          const path = url.pathname.replace(/\/+$/, '')
          const sendJson = (status, payload) => {
            res.writeHead(status, {
              'Content-Type': 'application/json; charset=utf-8',
              // 统计与配置都是小响应且要求写后读一致，明确禁止浏览器缓存
              'Cache-Control': 'no-store',
            })
            res.end(JSON.stringify(payload))
          }

          try {
            await ensureFactsLoaded()
            const qp = url.searchParams

            if (req.method === 'GET' && path.endsWith('/status')) {
              sendJson(200, {
                scanning: scanState.scanning,
                progress: scanState.progress,
                lastScanAt: scanState.lastScanAt,
                fileCount: scanState.fileCount,
                sessionCount: factsById.size,
                scanErrors: scanState.scanErrors.slice(-5),
                root: sessionsRoot(),
                startedAt: scanState.startedAt,
                storage: storageMode.mode,
                storageError: storageMode.error,
              })
              return
            }
            if (req.method === 'POST' && path.endsWith('/scan')) {
              let body = {}
              try { body = JSON.parse((await readBody(req, 4096)) || '{}') } catch { /* 空体 */ }
              const r = await runScan(body.full === true)
              sendJson(r.ok ? 200 : 409, r.ok ? { ok: true, progress: scanState.progress } : r)
              return
            }
            if (req.method === 'GET' && path.endsWith('/catalog')) {
              sendJson(200, { ...presets.catalog(), measures: fold.MEASURES })
              return
            }
            if (req.method === 'GET' && path.endsWith('/projects')) {
              const map = new Map()
              for (const f of factsById.values()) {
                if (!f.project) continue
                const e = map.get(f.project) || { project: f.project, sessions: 0 }
                e.sessions += 1
                map.set(f.project, e)
              }
              sendJson(200, { projects: [...map.values()].sort((a, b) => b.sessions - a.sessions) })
              return
            }
            if (req.method === 'GET' && path.endsWith('/summary')) {
              const scope = qp.get('scope') === 'top' ? 'top' : 'all'
              const pricing = await currentPricing()
              sendJson(200, fold.summary(listFacts(), pricing, scope))
              return
            }
            if (req.method === 'GET' && path.endsWith('/cube')) {
              const range = resolveRange(qp.get('range'))
              const pricing = await currentPricing()
              const result = fold.aggregate(listFacts(), {
                granularity: qp.get('granularity') || 'day',
                groupBy: qp.get('groupBy') || '',
                scope: qp.get('scope') || 'all',
                project: qp.get('project') || '',
                from: qp.get('from') || range.from,
                to: qp.get('to') || range.to,
                pricing,
              })
              sendJson(200, result)
              return
            }
            if (req.method === 'GET' && path.endsWith('/sessions')) {
              const range = resolveRange(qp.get('range') || '30')
              const pricing = await currentPricing()
              const rows = fold.sessionRows(listFacts(), {
                scope: qp.get('scope') === 'top' ? 'top' : 'all',
                project: qp.get('project') || '',
                from: qp.get('from') || range.from,
                to: qp.get('to') || range.to,
                pricing,
              })
              const limit = Math.min(200, Number(qp.get('limit')) || 50)
              sendJson(200, { rows: rows.slice(0, limit), total: rows.length })
              return
            }
            if (req.method === 'GET' && path.endsWith('/heat')) {
              const range = resolveRange(qp.get('range') || '90')
              sendJson(200, fold.heat(listFacts(), {
                scope: qp.get('scope') === 'top' ? 'top' : 'all',
                project: qp.get('project') || '',
                from: qp.get('from') || range.from,
                to: qp.get('to') || range.to,
              }))
              return
            }
            if (req.method === 'GET' && path.endsWith('/errors')) {
              const range = resolveRange(qp.get('range') || '30')
              sendJson(200, fold.errorBreakdown(listFacts(), {
                scope: qp.get('scope') === 'top' ? 'top' : 'all',
                project: qp.get('project') || '',
                from: qp.get('from') || range.from,
                to: qp.get('to') || range.to,
              }))
              return
            }
            if (req.method === 'GET' && path.endsWith('/insights')) {
              const range = resolveRange(qp.get('range') || '30')
              const pricing = await currentPricing()
              sendJson(200, fold.insights(listFacts(), {
                scope: qp.get('scope') === 'top' ? 'top' : 'all',
                project: qp.get('project') || '',
                from: qp.get('from') || range.from,
                to: qp.get('to') || range.to,
              }, pricing))
              return
            }

            // ── 参数化下钻：/day/:date /model/:model /session/:id ──────────
            const rest = path.startsWith(API_PREFIX + '/') ? path.slice(API_PREFIX.length + 1) : ''
            const drill = /^(day|model|session)\/(.+)$/.exec(rest)
            if (req.method === 'GET' && drill) {
              const pricing = await currentPricing()
              const scope = qp.get('scope') === 'top' ? 'top' : 'all'
              const key = decodeURIComponent(drill[2])
              if (drill[1] === 'day') {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) { sendJson(400, { error: 'bad date' }); return }
                sendJson(200, fold.dayDetail(listFacts(), key, pricing, scope))
                return
              }
              if (drill[1] === 'model') {
                const range = resolveRange(qp.get('range') || '30')
                sendJson(200, fold.modelDetail(listFacts(), key, { from: range.from, to: range.to }, pricing))
                return
              }
              if (drill[1] === 'session') {
                await ensureFactsLoaded()
                const detail = fold.sessionDetail(factsById.get(key), pricing)
                if (!detail) { sendJson(404, { error: 'session not found' }); return }
                sendJson(200, detail)
                return
              }
            }

            // ── 入口/界面配置 ─────────────────────────────────────────────
            if (req.method === 'GET' && path.endsWith('/config')) {
              sendJson(200, await currentConfig())
              return
            }
            if (req.method === 'PUT' && path.endsWith('/config')) {
              const body = JSON.parse((await readBody(req, 4096)) || '{}')
              const cfg = { ...(await currentConfig()) }
              if (body.entry === 'sidebar' || body.entry === 'settings' || body.entry === 'both') cfg.entry = body.entry
              try {
                const table = await storeTable('config')
                await table.put('ui', cfg)
              } catch (e) {
                sendJson(500, { ok: false, error: String((e && e.message) || e) })
                return
              }
              sendJson(200, { ok: true, config: cfg })
              return
            }

            // ── 页面配置 ────────────────────────────────────────────────────
            if (req.method === 'GET' && path.endsWith('/pages')) {
              sendJson(200, { pages: await currentPages() })
              return
            }
            if (req.method === 'PUT' && path.endsWith('/pages')) {
              const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
              const pages = Array.isArray(body.pages) ? body.pages : []
              if (pages.length === 0 || pages.length > PAGE_COUNT_MAX) {
                sendJson(400, { ok: false, errors: ['pages 必须是 1-20 个的数组'] })
                return
              }
              const cleaned = []
              const allErrors = []
              for (const p of pages) {
                const v = validatePage(p)
                if (!v.ok) allErrors.push(...v.errors.map((e) => `${p.id || '?'}: ${e}`))
                else cleaned.push(v.page)
              }
              const ids = new Set(cleaned.map((p) => p.id))
              if (ids.size !== cleaned.length) allErrors.push('页面 id 重复')
              if (allErrors.length > 0) { sendJson(400, { ok: false, errors: allErrors.slice(0, 20) }); return }
              try {
                const table = await storeTable('pages')
                await table.put('pages', cleaned)
              } catch (e) {
                sendJson(500, { ok: false, errors: [`保存失败：${String((e && e.message) || e)}`] })
                return
              }
              sendJson(200, { ok: true, pages: cleaned })
              return
            }
            if (req.method === 'POST' && path.endsWith('/pages/validate')) {
              const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
              const v = validatePage(body.page)
              sendJson(200, { ok: v.ok, errors: v.errors, page: v.page })
              return
            }
            if (req.method === 'POST' && path.endsWith('/pages/reset')) {
              try {
                const table = await storeTable('pages')
                await table.put('pages', presets.defaultPages())
              } catch { /* ignore */ }
              sendJson(200, { ok: true, pages: presets.defaultPages() })
              return
            }
            if (req.method === 'POST' && path.endsWith('/pages/import')) {
              const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
              const v = validatePage(body.page)
              if (!v.ok) { sendJson(400, { ok: false, errors: v.errors }); return }
              const pages = (await currentPages()).filter((p) => p.id !== v.page.id)
              pages.push(v.page)
              try {
                const table = await storeTable('pages')
                await table.put('pages', pages)
              } catch (e) {
                sendJson(500, { ok: false, errors: [`保存失败：${String((e && e.message) || e)}`] })
                return
              }
              sendJson(200, { ok: true, page: v.page, pages })
              return
            }

            // ── 价格表 ─────────────────────────────────────────────────────
            if (req.method === 'GET' && path.endsWith('/pricing')) {
              sendJson(200, { prices: await currentPricing(), isDefault: false })
              return
            }
            if (req.method === 'PUT' && path.endsWith('/pricing')) {
              const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
              const prices = normalizePricing(body.prices)
              try {
                const table = await storeTable('pricing')
                await table.put('prices', prices)
              } catch (e) {
                sendJson(500, { ok: false, error: String((e && e.message) || e) })
                return
              }
              sendJson(200, { ok: true, prices })
              return
            }

            // ── AI 编排提示词 ───────────────────────────────────────────────
            if (req.method === 'GET' && path.endsWith('/ai/prompt')) {
              sendJson(200, { prompt: aiPrompt(qp.get('request') || '') })
              return
            }

            sendJson(404, { error: `no route for ${req.method} ${path}` })
          } catch (e) {
            try {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: (e && e.message) || 'internal error' }))
            } catch { /* res 可能已写出 */ }
          }
        },
      })
      return () => {
        try { if (typeof disposeRoute === 'function') disposeRoute() } catch {}
      }
    }, 'dsh-dashboard: api')
  },
}
