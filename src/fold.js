'use strict'
/**
 * dsh-dashboard — 纯统计折叠层（无依赖，可离线单测）
 *
 * 会话日志事件流（session.v3/v4.jsonl.zstd 解压后的 JSONL）fold 成
 * 「会话 × 本地日」事实行；事实行集合再聚合成任意粒度（日/ISO 周/自然月）
 * × 任意维度（模型/工具/技能/命令/项目/会话）的指标行。
 *
 * 指标口径（见 dsh-dashboard-design.md）：
 * - inputTokens 按请求累计（与账单同口径，跨 turn 重复计）
 * - 速度 = decodeTok / decodeWindowMs，窗口取 stream 逐 chunk 时序的
 *   首尾跨度（`{time}` chunk 与 `{time0,dt[]}` 紧凑流两种形态都认）
 * - 质量信号 = turn/end reason 分布 + llm/retry 次数 + 工具 isError 率
 * - 工作时段 = 事件时间本地 小时×星期 热度（168 格）
 */

/** 命令首词白名单外的词原样入榜（榜单长度有上限，不会爆炸）。 */
function classifyCommand(raw) {
  if (typeof raw !== 'string') return ''
  const s = raw.trim()
  if (!s) return ''
  const first = s.split(/\s+/)[0] || ''
  // "FOO=bar cmd …" / "cd x && cmd" 只取末段执行词的粗略归一
  const word = (first.split('/').pop() || first).toLowerCase()
  return word.slice(0, 40)
}

/** 错误分类学：把宿主与各家报错归一成少量可聚合的类别。 */
function classifyError(kindHint, message) {
  const msg = String(message || '')
  const m = msg.toLowerCase()
  if (kindHint) {
    const k = String(kindHint).toUpperCase()
    if (k === 'RATE_LIMIT' || k === 'SERVER' || k === 'TIMEOUT' || k === 'EMPTY_RESPONSE' || k === 'TRANSPORT') return k
  }
  if (/429|quota|rate.?limit|too many requests/.test(m)) return 'RATE_LIMIT'
  if (/timeout|timed out|etimedout/.test(m)) return 'TIMEOUT'
  if (/\b5\d\d\b|bad gateway|server error|internal error|overloaded/.test(m)) return 'SERVER'
  if (/econn|enetunreach|eai_again|fetch failed|network|socket|certificate|ssl|failed to connect|connection refused/.test(m)) return 'NETWORK'
  if (/401|403|unauthorized|forbidden|invalid.?api.?key|authentication/i.test(msg)) return 'AUTH'
  if (/empty|no content|no body/.test(m)) return 'EMPTY_RESPONSE'
  if (/abort|cancel|interrupt/.test(m)) return 'ABORTED'
  if (/eacces|permission denied|denied|operation not permitted/.test(m)) return 'PERMISSION'
  if (/enoent|no such file|not found|does not exist/.test(m)) return 'NOT_FOUND'
  if (/exit code|exited with|non-zero/.test(m)) return 'COMMAND_FAILED'
  return 'OTHER'
}

/** 错误类别清单（固定顺序供聚合/展示）。 */
const ERROR_KINDS = Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'EMPTY_RESPONSE', 'TRANSPORT', 'NETWORK', 'AUTH', 'ABORTED', 'PERMISSION', 'NOT_FOUND', 'COMMAND_FAILED', 'OTHER'])

/** 归一错误聚簇键：去长数字/引号，压空白，截 72 字符。 */
function errorClusterKey(message) {
  return String(message || '').replace(/\d{4,}/g, '#').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 72) || '(empty)'
}

/** stream 数组 → 逐 chunk 时序窗口 ms（首 chunk → 末 chunk）。 */
function streamWindowMs(stream) {
  if (!Array.isArray(stream)) return 0
  let min = Infinity
  let max = -Infinity
  for (const s of stream) {
    if (!s || typeof s !== 'object') continue
    if (typeof s.time === 'number' && s.time > 0) {
      if (s.time < min) min = s.time
      if (s.time > max) max = s.time
    }
    if (typeof s.time0 === 'number' && s.time0 > 0 && Array.isArray(s.dt)) {
      if (s.time0 < min) min = s.time0
      if (s.time0 > max) max = s.time0
      let t = s.time0
      for (const d of s.dt) {
        if (typeof d === 'number' && d > 0) t += d
      }
      if (t > max) max = t
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? max - min : 0
}

/** usage 对象正整数/readable 字段。 */
function usageNum(usage, key) {
  const v = usage && typeof usage === 'object' ? usage[key] : 0
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** 本地日界 → 'YYYY-MM-DD'。 */
function localDate(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** ISO 8601 周 → 'YYYY-Wnn'（周一为一周始，含跨年归属）。 */
function isoWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow = (date.getUTCDay() + 6) % 7 // 周一=0
  date.setUTCDate(date.getUTCDate() - dow + 3) // 归到本周周四
  const isoYear = date.getUTCFullYear()
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const jan4dow = (jan4.getUTCDay() + 6) % 7
  const week1Mon = new Date(jan4)
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4dow)
  const week = Math.round((date - week1Mon) / (7 * 86400000)) + 1
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

function localMonth(dateStr) {
  return dateStr.slice(0, 7)
}

function bucketOf(dateStr, granularity) {
  if (granularity === 'week') return isoWeek(dateStr)
  if (granularity === 'month') return localMonth(dateStr)
  return dateStr
}

/** 空「日」累计器。 */
function emptyDay() {
  return {
    msgs: 0,
    msgsNoUsage: 0,
    inTok: 0,
    outTok: 0,
    cacheReadTok: 0,
    cacheWriteTok: 0,
    turns: 0,
    turnsCompleted: 0,
    turnsError: 0,
    turnsAborted: 0,
    turnsInterrupted: 0,
    turnsMaxTokens: 0,
    turnsUser: 0,
    userMsgs: 0,
    userInputChars: 0,
    inputLenRes: [],
    speedRes: [],
    activeMs: 0,
    subagents: 0,
    retries: 0,
    compactions: 0,
    slashCmds: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolMs: 0,
    llmMs: 0,
    decodeMs: 0,
    decodeTok: 0,
    speedSamples: 0,
    retryDelayMs: 0,
    retryExhausted: 0,
    byModel: {},
    byModelRetry: {},
    byTool: {},
    bySkill: {},
    byCmd: {},
    byCmdErr: {},
    bySlash: {},
    turnErrKinds: {},
    heat: new Array(168).fill(0),
    firstAt: 0,
    lastAt: 0,
  }
}

function emptySessionFact(sessionId, project, depth, createdAt) {
  return {
    sessionId,
    project: project || '',
    depth: depth || 0,
    createdAt: createdAt || 0,
    title: '',
    days: {},
    errors: [],
    modelErrors: [],
    firstAt: 0,
    lastAt: 0,
  }
}

const MAX_ERRORS_PER_SESSION = 60
const MAX_MODEL_ERRORS = 40
const MAX_MAP_KEYS = 60
const SPEED_MIN_WINDOW_MS = 200
const SPEED_MIN_TOKENS = 16

function bumpMap(map, key, cap) {
  if (!key) return
  if (map[key] === undefined) {
    if (Object.keys(map).length >= cap) return
    map[key] = 0
  }
  map[key] += 1
}

function modelEntry(byModel, model) {
  const key = model || 'unknown'
  let e = byModel[key]
  if (!e) {
    if (Object.keys(byModel).length >= MAX_MAP_KEYS) return byModel.unknown || (byModel.unknown = { msgs: 0, msgsNoUsage: 0, inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0, decodeMs: 0, decodeTok: 0, speedSamples: 0, speedRes: [], retries: 0 })
    e = byModel[key] = { msgs: 0, msgsNoUsage: 0, inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0, decodeMs: 0, decodeTok: 0, speedSamples: 0, speedRes: [], retries: 0 }
  }
  if (!Array.isArray(e.speedRes)) e.speedRes = []
  return e
}

/** 蓄水池抽样：cap 之前全收，之后等概率替换（counter 保证确定性）。 */
function resPush(arr, v, cap, counter) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return
  if (arr.length < cap) { arr.push(v); counter.n += 1; return }
  const idx = counter.n % cap
  counter.n += 1
  arr[idx] = v
}

function toolEntry(byTool, tool) {
  const key = tool || 'unknown'
  let e = byTool[key]
  if (!e) {
    if (Object.keys(byTool).length >= MAX_MAP_KEYS) return byTool.unknown || (byTool.unknown = { calls: 0, errs: 0, ms: 0, errKinds: {} })
    e = byTool[key] = { calls: 0, errs: 0, ms: 0, errKinds: {} }
  }
  if (!e.errKinds) e.errKinds = {}
  return e
}

function bumpMap1(map, key) {
  if (!key) return
  map[key] = (map[key] || 0) + 1
}

function touchTime(day, time) {
  if (!time) return
  if (!day.firstAt || time < day.firstAt) day.firstAt = time
  if (time > day.lastAt) day.lastAt = time
}

function pushError(fact, time, tool, text, kind) {
  if (fact.errors.length >= MAX_ERRORS_PER_SESSION) return
  fact.errors.push({
    time: time || 0,
    tool: tool || '',
    kind: kind || 'OTHER',
    text: typeof text === 'string' ? text.slice(0, 200) : '',
  })
}

/** 从 message.content（blocks）抽取首段 text（错误摘要用）。 */
function firstText(content) {
  if (!Array.isArray(content)) return ''
  for (const b of content) {
    if (b && typeof b === 'object') {
      if (typeof b.text === 'string' && b.text) return b.text
      if (Array.isArray(b.content)) {
        const inner = firstText(b.content)
        if (inner) return inner
      }
    }
  }
  return ''
}

/** 统计 message.content 全部 text 块的字符总数（用户输入长度用）。 */
function messageTextLength(content) {
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (typeof b.text === 'string') n += b.text.length
    if (Array.isArray(b.content)) n += messageTextLength(b.content)
  }
  return n
}

/**
 * 单会话事件流 fold。
 * @param {string} sessionId
 * @param {Iterable<object>} events 已 JSON.parse 的日志行
 * @returns {object|null} 会话事实（无 session 头且无有效事件时返回 null）
 */
function foldSession(sessionId, events) {
  const fact = emptySessionFact(sessionId, '', 0, 0)
  let headerSeen = false
  let haveData = false
  // 配对缓冲
  const openCalls = new Map() // callId → {time, name, cmd}
  const openTurns = new Map() // turn# → startTime
  const openSteps = new Map() // 'turn:step' → startTime
  const resCounter = { n: 0 } // 蓄水池替换计数器

  const dayOf = (time) => {
    const key = localDate(time || Date.now())
    let d = fact.days[key]
    if (!d) d = fact.days[key] = emptyDay()
    return d
  }

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const type = ev.type
    if (!type) continue
    const time = typeof ev.time === 'number' ? ev.time : 0
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {}

    if (type === 'session') {
      headerSeen = true
      if (!fact.project && typeof data.cwd === 'string') {
        fact.project = data.cwd.split('/').filter(Boolean).pop() || data.cwd
      }
      if (typeof data.delegationDepth === 'number') fact.depth = data.delegationDepth
      if (typeof data.createdAt === 'number') fact.createdAt = data.createdAt
      continue
    }
    if (type === 'session/title' && data && typeof data.title === 'string') {
      fact.title = data.title
      continue
    }

    haveData = true
    const day = dayOf(time)
    touchTime(day, time)
    if (!fact.firstAt || (time && time < fact.firstAt)) fact.firstAt = time
    if (time > fact.lastAt) fact.lastAt = time
    if (time) {
      const d = new Date(time)
      day.heat[d.getDay() * 24 + d.getHours()] += 1
    }

    switch (type) {
      case 'user/message': {
        day.userMsgs += 1
        // 真实输入在 data.content；兼容 data.message.content 形态
        const ucontent = (Array.isArray(data.content) && data.content) ||
          (data.message && Array.isArray(data.message.content) ? data.message.content : null)
        const chars = messageTextLength(ucontent)
        day.userInputChars += chars
        resPush(day.inputLenRes, chars, 64, resCounter)
        break
      }
      case 'turn/start': {
        day.turns += 1
        if (typeof data.turn === 'number') openTurns.set(data.turn, time)
        break
      }
      case 'turn/end': {
        const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
        const kind = reason.kind
        if (kind === 'completed') day.turnsCompleted += 1
        else if (kind === 'error') day.turnsError += 1
        else if (kind === 'aborted') day.turnsAborted += 1
        else if (kind === 'interrupted') day.turnsInterrupted += 1
        else if (kind === 'max-tokens') day.turnsMaxTokens += 1
        else if (kind === 'user') day.turnsUser += 1
        if (kind === 'error') {
          const errMsg = reason.error && typeof reason.error === 'object' ? String(reason.error.message || '') : ''
          const ek = classifyError('', errMsg)
          bumpMap1(day.turnErrKinds, ek)
          if (fact.modelErrors.length < MAX_MODEL_ERRORS) {
            fact.modelErrors.push({ time, kind: ek, provider: '', msg: errMsg.slice(0, 160) })
          }
        }
        if (typeof data.turn === 'number') openTurns.delete(data.turn)
        break
      }
      case 'step/start': {
        if (typeof data.turn === 'number' && typeof data.step === 'number') {
          openSteps.set(`${data.turn}:${data.step}`, time)
        }
        break
      }
      case 'assistant/message': {
        const msg = data.message && typeof data.message === 'object' ? data.message : {}
        const src = msg.source && typeof msg.source === 'object' ? msg.source : {}
        const model = typeof src.model === 'string' && src.model ? src.model : 'unknown'
        const usage = data.usage && typeof data.usage === 'object' ? data.usage : null
        const me = modelEntry(day.byModel, model)
        day.msgs += 1
        me.msgs += 1
        const stepKey = typeof data.turn === 'number' && typeof data.step === 'number' ? `${data.turn}:${data.step}` : null
        if (stepKey && openSteps.has(stepKey)) {
          const started = openSteps.get(stepKey)
          if (time > started) day.llmMs += time - started
          openSteps.delete(stepKey)
        }
        if (usage) {
          const input = usageNum(usage, 'inputTokens')
          const output = usageNum(usage, 'outputTokens')
          const cr = usageNum(usage, 'cacheReadTokens')
          const cw = usageNum(usage, 'cacheWriteTokens')
          day.inTok += input
          day.outTok += output
          day.cacheReadTok += cr
          day.cacheWriteTok += cw
          me.inTok += input
          me.outTok += output
          me.cacheReadTok += cr
          me.cacheWriteTok += cw
          const window = streamWindowMs(data.stream)
          if (window >= SPEED_MIN_WINDOW_MS && output >= SPEED_MIN_TOKENS) {
            day.decodeMs += window
            day.decodeTok += output
            day.speedSamples += 1
            me.decodeMs += window
            me.decodeTok += output
            me.speedSamples += 1
            const speed = output / (window / 1000)
            resPush(day.speedRes, speed, 64, resCounter)
            resPush(me.speedRes, speed, 32, resCounter)
          }
        } else {
          day.msgsNoUsage += 1
          me.msgsNoUsage += 1
        }
        break
      }
      case 'llm/retry':
      case 'llm/retry-started': {
        if (type === 'llm/retry') {
          day.retries += 1
          const failure = data.failure && typeof data.failure === 'object' ? data.failure : {}
          const code = classifyError(failure.code, failure.message)
          const provider = typeof data.provider === 'string' && data.provider ? data.provider : 'unknown'
          if (!day.byModelRetry[provider]) day.byModelRetry[provider] = {}
          bumpMap1(day.byModelRetry[provider], code)
          if (typeof data.delayMs === 'number' && data.delayMs > 0) day.retryDelayMs += data.delayMs
          if (typeof data.retry === 'number' && typeof data.maxRetries === 'number' && data.retry >= data.maxRetries) day.retryExhausted += 1
          const model = typeof data.model === 'string' && data.model ? data.model : ''
          if (model) modelEntry(day.byModel, model).retries += 1
          if (fact.modelErrors.length < MAX_MODEL_ERRORS) {
            fact.modelErrors.push({ time, kind: code, provider, msg: String(failure.message || '').slice(0, 160) })
          }
        }
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' && data.name ? data.name : 'unknown'
        day.toolCalls += 1
        if (name === 'subagent') day.subagents += 1
        const te = toolEntry(day.byTool, name)
        te.calls += 1
        if (typeof data.callId === 'string') openCalls.set(data.callId, { time, name, cmd: '' })
        let args = data.arguments
        if (typeof args === 'string') {
          try { args = JSON.parse(args) } catch { args = null }
        }
        if (args && typeof args === 'object') {
          if (name === 'skill' && typeof args.name === 'string') bumpMap(day.bySkill, args.name, MAX_MAP_KEYS)
          if (name === 'bash' && typeof args.command === 'string') {
            const cmd = classifyCommand(args.command)
            bumpMap(day.byCmd, cmd, MAX_MAP_KEYS)
            const open = typeof data.callId === 'string' ? openCalls.get(data.callId) : null
            if (open) open.cmd = cmd
          }
        }
        break
      }
      case 'tool/result': {
        const message = data.message && typeof data.message === 'object' ? data.message : {}
        const src = message.source && typeof message.source === 'object' ? message.source : {}
        const callId = typeof src.callId === 'string' ? src.callId : ''
        const open = callId ? openCalls.get(callId) : null
        if (open) {
          if (time > open.time) {
            const dur = time - open.time
            const te = toolEntry(day.byTool, open.name)
            te.ms += dur
            day.toolMs += dur
          }
          openCalls.delete(callId)
        }
        const isError = message.isError === true
        if (isError) {
          day.toolErrors += 1
          const name = open ? open.name : 'unknown'
          const text = firstText(message.content)
          const kind = classifyError('', text)
          const te = toolEntry(day.byTool, name)
          te.errs += 1
          bumpMap1(te.errKinds, kind)
          if (name === 'bash' && open && open.cmd) bumpMap1(day.byCmdErr, open.cmd)
          pushError(fact, time, name, text, kind)
        }
        break
      }
      case 'compaction/start': {
        day.compactions += 1
        break
      }
      case 'command/run': {
        day.slashCmds += 1
        const cmd = typeof data.command === 'string' ? data.command : typeof data.name === 'string' ? data.name : ''
        if (cmd) bumpMap(day.bySlash, cmd.replace(/^\//, '').slice(0, 40), MAX_MAP_KEYS)
        break
      }
      default:
        break
    }
  }

  if (!headerSeen && !haveData) return null
  // 每日运行时长：该会话当天首末事件跨度（收尾统一折算，事件流已排序）
  for (const day of Object.values(fact.days)) {
    if (day.firstAt && day.lastAt && day.lastAt > day.firstAt) day.activeMs = day.lastAt - day.firstAt
  }
  // 清理空日（只有 heat 全 0 且无计数的 Day 不该出现，保险起见不过滤，聚合时跳过全零）
  return fact
}

// ── 聚合 ────────────────────────────────────────────────────────────────────

/** 标量指标目录：可在 cube 行上直接聚合/公式引用。 */
const MEASURES = Object.freeze({
  msgs: '模型响应条数',
  inTok: '输入 tokens',
  outTok: '输出 tokens',
  cacheReadTok: '缓存读 tokens',
  cacheWriteTok: '缓存写 tokens',
  totalTok: '全部 tokens（含缓存）',
  turns: '回合数',
  turnsCompleted: '完成回合',
  turnsError: '出错回合',
  turnsAborted: '中止回合',
  userMsgs: '用户输入次数',
  userInputChars: '用户输入字符数',
  inputAvg: '平均输入长度（字符/条）',
  activeMs: '运行时长 ms（日内首末事件跨度）',
  activeMin: '运行时长分钟（activeMs/60000）',
  subagents: '子代理调用次数',
  retries: 'LLM 重试次数',
  retryExhausted: '重试耗尽次数',
  retryDelayMs: '重试等待总 ms',
  compactions: '上下文压缩次数',
  toolCalls: '工具调用次数',
  toolErrors: '工具报错次数',
  toolMs: '工具耗时 ms',
  llmMs: '模型耗时 ms',
  decodeMs: '解码耗时 ms',
  decodeTok: '解码 tokens',
  speed: '输出速度 tokens/s（decodeTok/decodeMs）',
  sessions: '活跃会话数',
  skills: '技能调用次数',
  cmds: 'shell 命令次数',
  slashCmds: '斜杠命令次数',
  cost: '估算费用（按价格表）',
  errorRate: '回合错误率 %（pct(turnsError,turns)）',
})

/** 组合指标：聚合时从基础计数派生。 */
function deriveMeasure(key, acc) {
  switch (key) {
    case 'totalTok': return acc.inTok + acc.outTok + acc.cacheReadTok + acc.cacheWriteTok
    case 'sessions': return acc._sessions
    case 'skills': return acc._skills
    case 'cmds': return acc._cmds
    case 'speed': return acc.decodeMs > 0 ? (acc.decodeTok / acc.decodeMs) * 1000 : 0
    case 'cost': return acc._cost
    case 'errorRate': return acc.turns > 0 ? (acc.turnsError / acc.turns) * 100 : 0
    case 'inputAvg': return acc.userMsgs > 0 ? Math.round((acc.userInputChars / acc.userMsgs) * 10) / 10 : 0
    case 'activeMin': return Math.round((acc.activeMs / 60000) * 10) / 10
    default: {
      const v = acc[key]
      return typeof v === 'number' ? v : 0
    }
  }
}

function emptyAcc() {
  return {
    msgs: 0, msgsNoUsage: 0, inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0,
    turns: 0, turnsCompleted: 0, turnsError: 0, turnsAborted: 0, turnsInterrupted: 0, turnsMaxTokens: 0, turnsUser: 0,
    userMsgs: 0, userInputChars: 0, activeMs: 0, subagents: 0, retries: 0, retryDelayMs: 0, retryExhausted: 0, compactions: 0, slashCmds: 0,
    toolCalls: 0, toolErrors: 0, toolMs: 0, llmMs: 0, decodeMs: 0, decodeTok: 0, speedSamples: 0,
    _sessions: 0, _skills: 0, _cmds: 0, _cost: 0,
    firstAt: 0, lastAt: 0,
  }
}

function addNums(acc, day, fields) {
  for (const f of fields) acc[f] += day[f] || 0
}

const SUM_FIELDS = ['msgs', 'msgsNoUsage', 'inTok', 'outTok', 'cacheReadTok', 'cacheWriteTok', 'turns', 'turnsCompleted', 'turnsError', 'turnsAborted', 'turnsInterrupted', 'turnsMaxTokens', 'turnsUser', 'userMsgs', 'userInputChars', 'activeMs', 'subagents', 'retries', 'retryDelayMs', 'retryExhausted', 'compactions', 'slashCmds', 'toolCalls', 'toolErrors', 'toolMs', 'llmMs', 'decodeMs', 'decodeTok']

/** 模型价格（每 M token）；未收录模型回退 0。 */
function modelCost(byModel, pricing) {
  let sum = 0
  for (const [model, e] of Object.entries(byModel || {})) {
    const p = lookupPrice(pricing, model)
    if (!p) continue
    sum += (e.inTok * (p.in || 0) + e.outTok * (p.out || 0) + e.cacheReadTok * (p.cr || 0) + e.cacheWriteTok * (p.cw || 0)) / 1e6
  }
  return sum
}

function lookupPrice(pricing, model) {
  if (!pricing || typeof pricing !== 'object') return null
  if (pricing[model]) return pricing[model]
  const short = String(model).split('/').pop()
  return pricing[short] || null
}

/**
 * 事实集合 → 聚合行。
 * @param {Array<object>} facts 会话事实数组
 * @param {object} q {granularity:'day'|'week'|'month', from, to, groupBy:'', scope:'all'|'top', project:'', pricing}
 * @returns {{rows:Array<{bucket:string,key:string,values:object}>, coverage:{msgs:number,msgsNoUsage:number}}}
 */
function aggregate(facts, q) {
  const granularity = ['day', 'week', 'month'].includes(q.granularity) ? q.granularity : 'day'
  const groupBy = typeof q.groupBy === 'string' ? q.groupBy : ''
  const scope = q.scope === 'top' ? 'top' : 'all'
  const project = typeof q.project === 'string' && q.project ? q.project : ''
  const pricing = q.pricing || {}
  const accs = new Map() // `${bucket}\u0000${key}` → acc

  const accOf = (bucket, key) => {
    const id = bucket + '\u0000' + key
    let a = accs.get(id)
    if (!a) {
      a = emptyAcc()
      a._key = key
      a._bucket = bucket
      accs.set(id, a)
    }
    return a
  }
  const sessionSet = new Map() // bucket → Set(sessionId)（group 为 '' 时才计 sessions）

  for (const fact of facts) {
    if (!fact || !fact.days) continue
    if (scope === 'top' && fact.depth > 0) continue
    if (project && fact.project !== project) continue
    for (const [dateStr, day] of Object.entries(fact.days)) {
      if (q.from && dateStr < q.from) continue
      if (q.to && dateStr > q.to) continue
      const bucket = bucketOf(dateStr, granularity)
      const total = day.inTok + day.outTok + day.cacheReadTok + day.cacheWriteTok
      const hasSignals = total > 0 || day.turns > 0 || day.userMsgs > 0 || day.toolCalls > 0
      if (!hasSignals) continue

      if (groupBy === '') {
        const acc = accOf(bucket, '')
        addNums(acc, day, SUM_FIELDS)
        acc._sessions += 1
        acc._skills += Object.values(day.bySkill).reduce((s, n) => s + n, 0)
        acc._cmds += Object.values(day.byCmd).reduce((s, n) => s + n, 0)
        acc._cost += modelCost(day.byModel, pricing)
        if (day.firstAt && (!acc.firstAt || day.firstAt < acc.firstAt)) acc.firstAt = day.firstAt
        if (day.lastAt && day.lastAt > acc.lastAt) acc.lastAt = day.lastAt
      } else {
        const keys = groupKeysOf(day, fact, groupBy)
        for (const key of keys) {
          const acc = accOf(bucket, key)
          addGroupNums(acc, day, groupBy, key)
          acc._cost += groupCost(day, groupBy, key, pricing)
        }
      }
    }
  }

  const rows = []
  let msgs = 0
  let msgsNoUsage = 0
  for (const acc of accs.values()) {
    const values = {}
    // 费用是小数（USD），保留 6 位；其余整数指标不受影响
    for (const m of Object.keys(MEASURES)) values[m] = Math.round(deriveMeasure(m, acc) * 1e6) / 1e6
    values.firstAt = acc.firstAt || 0
    values.lastAt = acc.lastAt || 0
    rows.push({ bucket: acc._bucket, key: acc._key, values })
    msgs += acc.msgs
    msgsNoUsage += acc.msgsNoUsage
  }
  rows.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : a.key < b.key ? -1 : 1))
  return { rows, coverage: { msgs, msgsNoUsage } }
}

function groupKeysOf(day, fact, groupBy) {
  switch (groupBy) {
    case 'model': return Object.keys(day.byModel)
    case 'project_model': return Object.keys(day.byModel).map((m) => (fact.project || '未知') + '/' + m)
    case 'tool': return Object.keys(day.byTool)
    case 'skill': return Object.keys(day.bySkill)
    case 'cmd': return Object.keys(day.byCmd)
    case 'slash': return Object.keys(day.bySlash)
    case 'project': return [fact.project || 'unknown']
    case 'session': return [fact.sessionId]
    default: return ['']
  }
}

/** project_model 复合键 → 模型名（project 不含 '/'，首个 '/' 后即完整模型名）。 */
function pmModel(key) {
  return key.slice(key.indexOf('/') + 1)
}

function addGroupNums(acc, day, groupBy, key) {
  if (groupBy === 'model') {
    const me = day.byModel[key]
    if (!me) return
    acc.msgs += me.msgs
    acc.msgsNoUsage += me.msgsNoUsage || 0
    acc.inTok += me.inTok
    acc.outTok += me.outTok
    acc.cacheReadTok += me.cacheReadTok
    acc.cacheWriteTok += me.cacheWriteTok
    acc.decodeMs += me.decodeMs
    acc.decodeTok += me.decodeTok
    acc.speedSamples += me.speedSamples || 0
    acc.retries += me.retries || 0
  } else if (groupBy === 'project_model') {
    const me = day.byModel[pmModel(key)]
    if (!me) return
    acc.msgs += me.msgs
    acc.msgsNoUsage += me.msgsNoUsage || 0
    acc.inTok += me.inTok
    acc.outTok += me.outTok
    acc.cacheReadTok += me.cacheReadTok
    acc.cacheWriteTok += me.cacheWriteTok
    acc.decodeMs += me.decodeMs
    acc.decodeTok += me.decodeTok
    acc.retries += me.retries || 0
  } else if (groupBy === 'tool') {
    const te = day.byTool[key]
    if (!te) return
    acc.toolCalls += te.calls
    acc.toolErrors += te.errs
    acc.toolMs += te.ms
  } else if (groupBy === 'skill') {
    acc._skills += day.bySkill[key] || 0
  } else if (groupBy === 'cmd') {
    acc._cmds += day.byCmd[key] || 0
  } else if (groupBy === 'slash') {
    acc.slashCmds += day.bySlash[key] || 0
  } else {
    addNums(acc, day, SUM_FIELDS)
  }
}

function groupCost(day, groupBy, key, pricing) {
  if (groupBy === 'model' || groupBy === 'project_model') {
    const model = groupBy === 'project_model' ? pmModel(key) : key
    const me = groupBy === 'project_model' ? day.byModel[model] : day.byModel[key]
    if (!me) return 0
    const p = lookupPrice(pricing, model)
    if (!p) return 0
    return (me.inTok * (p.in || 0) + me.outTok * (p.out || 0) + me.cacheReadTok * (p.cr || 0) + me.cacheWriteTok * (p.cw || 0)) / 1e6
  }
  if (groupBy === '') return modelCost(day.byModel, pricing)
  return 0
}

// ── 深度下钻与专项分析 ───────────────────────────────────────────────────────

/** 分位数（线性插值）。arr 非空数字数组 → [min, p25, p50, p75, max]。 */
function quantiles(arr) {
  const s = arr.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!s.length) return null
  const q = (p) => {
    const idx = p * (s.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)
  }
  return [s[0], q(0.25), q(0.5), q(0.75), s[s.length - 1]]
}

/**
 * 分布统计（/api/dist）：逐消息速度样本的按模型箱线 / 按日 K 线分位数 / 输入长度直方图。
 * 依赖 day.speedRes / day.byModel[m].speedRes / day.inputLenRes 蓄水池（每 fold 重置）。
 */
function speedDist(facts, q) {
  const scope = q.scope === 'top' ? 'top' : 'all'
  const project = q.project || ''
  const byModel = new Map() // model → speed values[]
  const daily = new Map() // date → speed values[]（全模型）
  const inputAll = [] // 输入长度全量
  for (const fact of facts) {
    if (!fact || !fact.days) continue
    if (scope === 'top' && fact.depth > 0) continue
    if (project && fact.project !== project) continue
    for (const [dateStr, day] of Object.entries(fact.days)) {
      if (q.from && dateStr < q.from) continue
      if (q.to && dateStr > q.to) continue
      if (Array.isArray(day.speedRes)) {
        let cur = daily.get(dateStr)
        if (!cur) { cur = []; daily.set(dateStr, cur) }
        for (const v of day.speedRes) cur.push(v)
      }
      for (const [m, me] of Object.entries(day.byModel || {})) {
        if (!Array.isArray(me.speedRes)) continue
        if (!byModel.has(m)) byModel.set(m, [])
        const arr = byModel.get(m)
        for (const v of me.speedRes) if (arr.length < 4000) arr.push(v)
      }
      if (Array.isArray(day.inputLenRes)) for (const v of day.inputLenRes) inputAll.push(v)
    }
  }
  const boxOf = (values) => {
    const b = quantiles(values)
    return b ? b.map((v) => Math.round(v * 10) / 10) : null
  }
  const byModelRows = [...byModel.entries()]
    .map(([name, values]) => ({ name, n: values.length, box: values.length >= 4 ? boxOf(values) : null }))
    .filter((r) => r.box)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
  const dailyRows = [...daily.entries()]
    .map(([date, values]) => ({ date, n: values.length, box: values.length >= 4 ? boxOf(values) : null }))
    .filter((r) => r.box)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  // 输入长度直方图（12 箱，min→max 均分）
  let input = { n: inputAll.length, bins: [], p50: null, p95: null }
  if (inputAll.length >= 4) {
    const b = quantiles(inputAll)
    const lo = b[0]
    const hi = b[4]
    const step = (hi - lo) / 12 || 1
    const bins = Array.from({ length: 12 }, (_, i) => ({ lo: Math.round(lo + i * step), hi: Math.round(lo + (i + 1) * step), count: 0 }))
    for (const v of inputAll) {
      const i = Math.min(11, Math.max(0, Math.floor((v - lo) / step)))
      bins[i].count += 1
    }
    input = { n: inputAll.length, bins, p50: Math.round(b[2]), p95: Math.round(b[4]) }
  }
  return { byModel: byModelRows, dailySpeed: dailyRows, input }
}

/**
 * 供应商 → 项目 资金/用量流向（sankey 数据）。
 * @returns { nodes:[{name}], links:[{source,target,value}] }
 */
function flowsOf(facts, q, pricing) {
  const scope = q.scope === 'top' ? 'top' : 'all'
  const project = q.project || ''
  const byCost = q.measure === 'cost'
  const pricingMap = q.pricing || {}
  const map = new Map() // 'provider → project' → value
  const projTotals = new Map()
  const provTotals = new Map()
  for (const fact of facts) {
    if (!fact || !fact.days) continue
    if (scope === 'top' && fact.depth > 0) continue
    if (project && fact.project !== project) continue
    for (const day of Object.values(fact.days)) {
      for (const [model, me] of Object.entries(day.byModel || {})) {
        if (!me.outTok && !me.inTok) continue
        const provider = String(model).split('/')[0] || '未知'
        const proj = fact.project || '未知'
        let value
        if (byCost) {
          const p = lookupPrice(pricingMap, model)
          value = p ? (me.inTok * (p.in || 0) + me.outTok * (p.out || 0) + me.cacheReadTok * (p.cr || 0) + me.cacheWriteTok * (p.cw || 0)) / 1e6 : 0
        } else {
          value = (me.outTok || 0) + (me.inTok || 0)
        }
        if (!(value > 0)) continue
        const k = provider + ' → ' + proj
        map.set(k, (map.get(k) || 0) + value)
        projTotals.set(proj, (projTotals.get(proj) || 0) + value)
        provTotals.set(provider, (provTotals.get(provider) || 0) + value)
      }
    }
  }
  const links = [...map.entries()]
    .map(([k, value]) => {
      const sep = k.indexOf(' → ')
      return { source: k.slice(0, sep), target: k.slice(sep + 3), value: Math.round(value) }
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 40)
  const nodes = [...new Set([...links.flatMap((l) => [l.source, l.target])])].map((name) => ({ name }))
  return { nodes, links, byProvider: [...provTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })), byProject: [...projTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })) }
}

/** 会话级汇总行（/api/sessions）。 */
function sessionRows(facts, q) {
  const pricing = q.pricing || {}
  const out = []
  for (const fact of facts) {
    if (!fact || !fact.days) continue
    if (q.scope === 'top' && fact.depth > 0) continue
    if (q.project && fact.project !== q.project) continue
    const acc = emptyAcc()
    let days = 0
    for (const [dateStr, day] of Object.entries(fact.days)) {
      if (q.from && dateStr < q.from) continue
      if (q.to && dateStr > q.to) continue
      const total = day.inTok + day.outTok + day.cacheReadTok + day.cacheWriteTok
      if (total === 0 && day.turns === 0 && day.userMsgs === 0) continue
      addNums(acc, day, SUM_FIELDS)
      acc._sessions += 1
      acc._skills += Object.values(day.bySkill).reduce((s, n) => s + n, 0)
      acc._cmds += Object.values(day.byCmd).reduce((s, n) => s + n, 0)
      acc._cost += modelCost(day.byModel, pricing)
      if (day.firstAt && (!acc.firstAt || day.firstAt < acc.firstAt)) acc.firstAt = day.firstAt
      if (day.lastAt && day.lastAt > acc.lastAt) acc.lastAt = day.lastAt
      days += 1
    }
    if (days === 0) continue
    out.push({
      sessionId: fact.sessionId,
      project: fact.project,
      title: fact.title,
      depth: fact.depth,
      createdAt: fact.createdAt,
      days,
      turns: acc.turns,
      turnsError: acc.turnsError,
      userMsgs: acc.userMsgs,
      inputChars: acc.userInputChars,
      inTok: acc.inTok,
      outTok: acc.outTok,
      totalTok: deriveMeasure('totalTok', acc),
      cost: Math.round(deriveMeasure('cost', acc) * 1000) / 1000,
      speed: Math.round(deriveMeasure('speed', acc) * 10) / 10,
      durationMin: (acc.lastAt && acc.firstAt && acc.lastAt > acc.firstAt) ? Math.round((acc.lastAt - acc.firstAt) / 60000) : 0,
      activeMin: Math.round(deriveMeasure('activeMin', acc) * 10) / 10,
      subagents: acc.subagents,
      retries: acc.retries,
      toolCalls: acc.toolCalls,
      toolErrors: acc.toolErrors,
      firstAt: acc.firstAt,
      lastAt: acc.lastAt,
    })
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  return out
}

/** 小时×星期热度聚合（/api/heat）。heat 索引 = weekday(0=周日)*24+hour。 */
function heat(facts, q) {
  const totals = new Array(168).fill(0)
  for (const fact of facts) {
    if (!fact || !fact.days) continue
    if (q.scope === 'top' && fact.depth > 0) continue
    if (q.project && fact.project !== q.project) continue
    for (const [dateStr, day] of Object.entries(fact.days)) {
      if (q.from && dateStr < q.from) continue
      if (q.to && dateStr > q.to) continue
      if (!Array.isArray(day.heat)) continue
      for (let i = 0; i < 168; i++) totals[i] += day.heat[i] || 0
    }
  }
  return { heat: totals }
}

/** 错误样本聚合（/api/errors）。 */
function errorRows(facts, q) {
  const out = []
  for (const fact of facts) {
    if (!fact || !Array.isArray(fact.errors)) continue
    if (q.scope === 'top' && fact.depth > 0) continue
    if (q.project && fact.project !== q.project) continue
    for (const e of fact.errors) {
      const date = e.time ? localDate(e.time) : ''
      if (q.from && date && date < q.from) continue
      if (q.to && date && date > q.to) continue
      out.push({ time: e.time, date, tool: e.tool, text: e.text, project: fact.project, sessionId: fact.sessionId })
    }
  }
  out.sort((a, b) => (b.time || 0) - (a.time || 0))
  return out
}

/** 今天/近7天/近30天/全部 汇总（/api/summary）。 */
function summary(facts, pricing, scope) {
  const today = localDate(Date.now())
  const ago = (n) => {
    const d = new Date(Date.now() - n * 86400000)
    const p = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const pick = (from, to) => {
    const { rows } = aggregate(facts, { granularity: 'day', from, to, groupBy: '', scope, pricing })
    const acc = emptyAcc()
    for (const r of rows) {
      for (const k of SUM_FIELDS) acc[k] += r.values[k] || 0
      acc._sessions += r.values.sessions || 0
      acc._cost += r.values.cost || 0
    }
    return {
      inTok: acc.inTok, outTok: acc.outTok, cacheReadTok: acc.cacheReadTok, cacheWriteTok: acc.cacheWriteTok,
      totalTok: deriveMeasure('totalTok', acc),
      turns: acc.turns, turnsError: acc.turnsError,
      userMsgs: acc.userMsgs, userInputChars: acc.userInputChars, inputAvg: deriveMeasure('inputAvg', acc),
      activeMin: deriveMeasure('activeMin', acc), subagents: acc.subagents,
      retries: acc.retries, retryExhausted: acc.retryExhausted, compactions: acc.compactions,
      toolCalls: acc.toolCalls, toolErrors: acc.toolErrors,
      sessions: acc._sessions,
      cost: Math.round(acc._cost * 1000) / 1000,
      speed: Math.round(deriveMeasure('speed', acc) * 10) / 10,
    }
  }
  return {
    today: pick(today, today),
    d7: pick(ago(6), today),
    d30: pick(ago(29), today),
    all: pick('', ''),
    todayDate: today,
  }
}

// ── 深度下钻与专项分析 ───────────────────────────────────────────────────────

function mergeCountMaps(target, src) {
  for (const [k, v] of Object.entries(src || {})) target[k] = (target[k] || 0) + (v || 0)
}

/**
 * 错误专项聚合（/api/errors）：
 * byTurnKind / byRetryProvider{provider:{code}} / byToolErr{tool:{kind}} /
 * byCmdErr / trend[{date,{kind}}] / samples[]（回合错误 + 工具错误，归一时间倒序）/
 * clusters[{key,n}]（错误聚簇 Top）。
 */
function errorBreakdown(facts, q) {
  const scope = q.scope === 'top' ? 'top' : 'all'
  const project = q.project || ''
  const byTurnKind = {}
  const byRetryProvider = {}
  const byToolErr = {}
  const byCmdErr = {}
  const trend = new Map() // date → {kind:n}
  const clusters = new Map()
  const samples = []
  for (const fact of facts) {
    if (!fact || !fact.days) continue
    if (scope === 'top' && fact.depth > 0) continue
    if (project && fact.project !== project) continue
    for (const [dateStr, day] of Object.entries(fact.days)) {
      if (q.from && dateStr < q.from) continue
      if (q.to && dateStr > q.to) continue
      mergeCountMaps(byTurnKind, day.turnErrKinds || {})
      for (const [provider, codes] of Object.entries(day.byModelRetry || {})) {
        if (!byRetryProvider[provider]) byRetryProvider[provider] = {}
        mergeCountMaps(byRetryProvider[provider], codes)
      }
      for (const [tool, te] of Object.entries(day.byTool || {})) {
        if (!byToolErr[tool]) byToolErr[tool] = {}
        mergeCountMaps(byToolErr[tool], te.errKinds || {})
      }
      for (const [cmd, n] of Object.entries(day.byCmdErr || {})) byCmdErr[cmd] = (byCmdErr[cmd] || 0) + n
      const t = trend.get(dateStr) || {}
      for (const [k, n] of Object.entries(day.turnErrKinds || {})) t[k] = (t[k] || 0) + n
      if ((day.toolErrors || 0) > 0) t.TOOL = (t.TOOL || 0) + day.toolErrors
      trend.set(dateStr, t)
    }
    for (const e of fact.modelErrors || []) {
      if (q.from && localDate(e.time || 0) < q.from) continue
      if (q.to && localDate(e.time || 0) > q.to) continue
      const key = errorClusterKey(e.msg)
      clusters.set(key, (clusters.get(key) || 0) + 1)
      samples.push({ time: e.time || 0, kind: e.kind, source: 'model', provider: e.provider || '', text: e.msg || '', project: fact.project, sessionId: fact.sessionId })
    }
    for (const e of fact.errors || []) {
      if (q.from && localDate(e.time || 0) < q.from) continue
      if (q.to && localDate(e.time || 0) > q.to) continue
      const key = errorClusterKey(e.text)
      clusters.set(key, (clusters.get(key) || 0) + 1)
      samples.push({ time: e.time || 0, kind: e.kind || 'OTHER', source: 'tool', provider: '', text: e.text || '', project: fact.project, sessionId: fact.sessionId })
    }
  }
  samples.sort((a, b) => (b.time || 0) - (a.time || 0))
  const trendRows = [...trend.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, kinds]) => ({ date, kinds }))
  const clusterRows = [...clusters.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n).slice(0, 10)
  return { byTurnKind, byRetryProvider, byToolErr, byCmdErr, trend: trendRows, clusters: clusterRows, samples: samples.slice(0, 100) }
}

/** 单日下钻（/api/day/:date）：当日会话明细 + 工具/技能/命令 + 错误 + 小时热度。 */
function dayDetail(facts, date, pricing, scope) {
  const sessions = []
  const tools = {}
  const skills = {}
  const cmds = {}
  const errors = []
  const heat = new Array(24).fill(0)
  // 该日期的星期（fold.heat 索引 = getDay()*24+hour，0=周日）
  const [yy, mm, dd] = date.split('-').map(Number)
  const weekday = new Date(yy, mm - 1, dd).getDay()
  for (const fact of facts) {
    if (!fact || !fact.days) continue
    if (scope === 'top' && fact.depth > 0) continue
    const day = fact.days[date]
    if (!day) continue
    sessions.push({
      sessionId: fact.sessionId,
      project: fact.project,
      title: fact.title,
      depth: fact.depth,
      turns: day.turns || 0,
      turnsError: day.turnsError || 0,
      inTok: day.inTok || 0,
      outTok: day.outTok || 0,
      totalTok: (day.inTok || 0) + (day.outTok || 0) + (day.cacheReadTok || 0) + (day.cacheWriteTok || 0),
      userMsgs: day.userMsgs || 0,
      toolCalls: day.toolCalls || 0,
      toolErrors: day.toolErrors || 0,
      cost: Math.round(modelCost(day.byModel, pricing) * 1000) / 1000,
      speed: (day.decodeMs || 0) > 0 ? Math.round((day.decodeTok / day.decodeMs) * 1000 * 10) / 10 : 0,
      firstAt: day.firstAt || 0,
      lastAt: day.lastAt || 0,
    })
    mergeCountMaps(tools, Object.fromEntries(Object.entries(day.byTool || {}).map(([k, v]) => [k, v.calls || 0])))
    mergeCountMaps(skills, day.bySkill || {})
    mergeCountMaps(cmds, day.byCmd || {})
    for (let hh = 0; hh < 24; hh++) {
      const v = day.heat ? day.heat[weekday * 24 + hh] : 0
      heat[hh] += v || 0
    }
    for (const e of fact.errors || []) {
      if (localDate(e.time || 0) !== date) continue
      errors.push({ time: e.time, tool: e.tool, kind: e.kind, text: e.text, sessionId: fact.sessionId })
    }
  }
  sessions.sort((a, b) => b.totalTok - a.totalTok)
  return {
    date,
    totals: {
      turns: sessions.reduce((s, x) => s + x.turns, 0),
      turnsError: sessions.reduce((s, x) => s + x.turnsError, 0),
      totalTok: sessions.reduce((s, x) => s + x.totalTok, 0),
      outTok: sessions.reduce((s, x) => s + x.outTok, 0),
      cost: Math.round(sessions.reduce((s, x) => s + x.cost, 0) * 1000) / 1000,
      sessions: sessions.length,
    },
    sessions: sessions.slice(0, 60),
    tools, skills, cmds, errors: errors.slice(0, 40), heat,
  }
}

/** 模型下钻（/api/model/:model）：逐日趋势 + 错误码 + Top 会话。 */
function modelDetail(facts, model, q, pricing) {
  const days = []
  const topSessions = []
  const tot = { msgs: 0, inTok: 0, outTok: 0, decodeMs: 0, decodeTok: 0, retries: 0 }
  for (const fact of facts) {
    if (!fact || !fact.days) continue
    for (const [dateStr, day] of Object.entries(fact.days)) {
      if (q.from && dateStr < q.from) continue
      if (q.to && dateStr > q.to) continue
      const me = (day.byModel || {})[model]
      if (!me) continue
      days.push({
        date: dateStr, msgs: me.msgs, inTok: me.inTok, outTok: me.outTok,
        retries: me.retries || 0,
        speed: (me.decodeMs || 0) > 0 ? Math.round((me.decodeTok / me.decodeMs) * 1000 * 10) / 10 : 0,
      })
      tot.msgs += me.msgs; tot.inTok += me.inTok; tot.outTok += me.outTok
      tot.decodeMs += me.decodeMs || 0; tot.decodeTok += me.decodeTok || 0; tot.retries += me.retries || 0
      if ((me.outTok || 0) > 0) {
        topSessions.push({ sessionId: fact.sessionId, project: fact.project, title: fact.title, outTok: me.outTok, msgs: me.msgs, retries: me.retries || 0 })
      }
    }
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1))
  topSessions.sort((a, b) => b.outTok - a.outTok)
  const p = lookupPrice(pricing, model)
  const cost = p ? (tot.inTok * (p.in || 0) + tot.outTok * (p.out || 0)) / 1e6 : 0
  return {
    model,
    totals: {
      msgs: tot.msgs, inTok: tot.inTok, outTok: tot.outTok, retries: tot.retries,
      speed: tot.decodeMs > 0 ? Math.round((tot.decodeTok / tot.decodeMs) * 1000 * 10) / 10 : 0,
      cost: Math.round(cost * 1000) / 1000,
      priced: !!p,
    },
    days,
    topSessions: topSessions.slice(0, 10),
  }
}

/** 会话下钻（/api/session/:id）：完整单会话画像。 */
function sessionDetail(fact, pricing) {
  if (!fact) return null
  const days = Object.entries(fact.days).map(([date, day]) => ({
    date,
    turns: day.turns || 0,
    turnsError: day.turnsError || 0,
    inTok: day.inTok || 0,
    outTok: day.outTok || 0,
    userMsgs: day.userMsgs || 0,
    toolCalls: day.toolCalls || 0,
    toolErrors: day.toolErrors || 0,
    retries: day.retries || 0,
    compactions: day.compactions || 0,
    cost: Math.round(modelCost(day.byModel, pricing) * 1000) / 1000,
    speed: (day.decodeMs || 0) > 0 ? Math.round((day.decodeTok / day.decodeMs) * 1000 * 10) / 10 : 0,
    models: Object.keys(day.byModel || {}),
  })).sort((a, b) => (a.date < b.date ? -1 : 1))
  let tools = {}
  let skills = {}
  let cmds = {}
  let models = {}
  for (const day of Object.values(fact.days)) {
    for (const [k, v] of Object.entries(day.byTool || {})) {
      if (!tools[k]) tools[k] = { calls: 0, errs: 0, ms: 0 }
      tools[k].calls += v.calls || 0; tools[k].errs += v.errs || 0; tools[k].ms += v.ms || 0
    }
    for (const [k, n] of Object.entries(day.bySkill || {})) skills[k] = (skills[k] || 0) + n
    for (const [k, n] of Object.entries(day.byCmd || {})) cmds[k] = (cmds[k] || 0) + n
    for (const [k, me] of Object.entries(day.byModel || {})) {
      if (!models[k]) models[k] = { msgs: 0, outTok: 0, retries: 0 }
      models[k].msgs += me.msgs || 0; models[k].outTok += me.outTok || 0; models[k].retries += me.retries || 0
    }
  }
  return {
    sessionId: fact.sessionId,
    project: fact.project,
    title: fact.title,
    depth: fact.depth,
    createdAt: fact.createdAt,
    days,
    tools, skills, cmds, models,
    turnErrKinds: (() => { const m = {}; for (const d of Object.values(fact.days)) mergeCountMaps(m, d.turnErrKinds || {}); return m })(),
    errors: (fact.errors || []).slice(-40),
    modelErrors: (fact.modelErrors || []).slice(-40),
  }
}

/**
 * 专项洞察（/api/insights）：异常日 / 最贵会话 / 重试风暴 / 慢工具 /
 * 命令失败率 / 压缩大户 / 错误聚簇。
 */
function insights(facts, q, pricing) {
  const scope = q.scope === 'top' ? 'top' : 'all'
  const project = q.project || ''
  const dayAgg = new Map() // date → acc
  const sessionAgg = new Map() // sessionId → {fact, acc}
  const toolAgg = new Map() // tool → {calls, errs, ms}
  const cmdAgg = new Map() // cmd → {calls, errs}
  const providerRetry = new Map()
  const clusters = new Map()
  for (const fact of facts) {
    if (!fact || !fact.days) continue
    if (scope === 'top' && fact.depth > 0) continue
    if (project && fact.project !== project) continue
    for (const [dateStr, day] of Object.entries(fact.days)) {
      if (q.from && dateStr < q.from) continue
      if (q.to && dateStr > q.to) continue
      const total = (day.inTok || 0) + (day.outTok || 0) + (day.cacheReadTok || 0) + (day.cacheWriteTok || 0)
      if (total === 0 && (day.turns || 0) === 0) continue
      const acc = dayAgg.get(dateStr) || emptyAcc()
      addNums(acc, day, SUM_FIELDS)
      acc._sessions += 1
      acc._cost += modelCost(day.byModel, pricing)
      dayAgg.set(dateStr, acc)
      for (const [provider, codes] of Object.entries(day.byModelRetry || {})) {
        const cur = providerRetry.get(provider) || { retries: 0, codes: {} }
        for (const [code, n] of Object.entries(codes)) { cur.codes[code] = (cur.codes[code] || 0) + n; cur.retries += n }
        providerRetry.set(provider, cur)
      }
      for (const [tool, te] of Object.entries(day.byTool || {})) {
        const t = toolAgg.get(tool) || { calls: 0, errs: 0, ms: 0 }
        t.calls += te.calls || 0; t.errs += te.errs || 0; t.ms += te.ms || 0
        toolAgg.set(tool, t)
      }
      for (const [cmd, n] of Object.entries(day.byCmd || {})) {
        const c = cmdAgg.get(cmd) || { calls: 0, errs: 0 }
        c.calls += n; cmdAgg.set(cmd, c)
      }
      for (const [cmd, n] of Object.entries(day.byCmdErr || {})) {
        const c = cmdAgg.get(cmd) || { calls: 0, errs: 0 }
        c.errs += n; cmdAgg.set(cmd, c)
      }
    }
    let sAcc = sessionAgg.get(fact.sessionId)
    if (!sAcc) { sAcc = emptyAcc(); sessionAgg.set(fact.sessionId, sAcc) }
    for (const [dateStr, day] of Object.entries(fact.days)) {
      if (q.from && dateStr < q.from) continue
      if (q.to && dateStr > q.to) continue
      addNums(sAcc, day, SUM_FIELDS)
      sAcc._cost += modelCost(day.byModel, pricing)
      sAcc._compactions = (sAcc._compactions || 0) + (day.compactions || 0)
      if (day.firstAt && (!sAcc.firstAt || day.firstAt < sAcc.firstAt)) sAcc.firstAt = day.firstAt
      if (day.lastAt && day.lastAt > sAcc.lastAt) sAcc.lastAt = day.lastAt
    }
    // 错误聚簇按会话收一次（原在逐日循环里，多日活动会把同一条错误重复计天数遍）
    for (const e of (fact.modelErrors || []).slice(-40)) {
      const edate = localDate(e.time || 0)
      if (q.from && edate < q.from) continue
      if (q.to && edate > q.to) continue
      const key = errorClusterKey(e.msg)
      const cur = clusters.get(key) || { n: 0, kind: e.kind || 'OTHER', lastAt: 0 }
      cur.n += 1
      if ((e.time || 0) > cur.lastAt) cur.lastAt = e.time || 0
      clusters.set(key, cur)
    }
  }

  const days = [...dayAgg.entries()].map(([date, a]) => ({
    date, turns: a.turns, turnsError: a.turnsError,
    errorRate: a.turns > 0 ? Math.round((a.turnsError / a.turns) * 1000) / 10 : 0,
    totalTok: deriveMeasure('totalTok', a),
    retries: a.retries, retryExhausted: a.retryExhausted,
    cost: Math.round(a._cost * 1000) / 1000, sessions: a._sessions,
  }))
  const activeDays = days.filter((d) => d.turns >= 3)
  const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
  const medTok = median(days.map((d) => d.totalTok).filter((v) => v > 0))
  const medErrorRate = median(activeDays.map((d) => d.errorRate))
  const sessions = [...sessionAgg.entries()].map(([id, a]) => {
    const f = facts.find((x) => x.sessionId === id) || {}
    return {
      sessionId: id, project: f.project || '', title: f.title || '',
      turns: a.turns, turnsError: a.turnsError, outTok: a.outTok,
      userMsgs: a.userMsgs, inputChars: a.userInputChars,
      cost: Math.round(a._cost * 1000) / 1000, compactions: a._compactions || 0, retries: a.retries,
      durationMin: (a.lastAt && a.firstAt && a.lastAt > a.firstAt) ? Math.round((a.lastAt - a.firstAt) / 60000) : 0,
    }
  })
  return {
    medErrorRate,
    worstErrorDays: activeDays.filter((d) => d.errorRate > 0).sort((a, b) => b.errorRate - a.errorRate).slice(0, 5),
    tokenSpikeDays: days.filter((d) => d.totalTok > 0 && medTok > 0).sort((a, b) => b.totalTok - a.totalTok).slice(0, 5).map((d) => ({ ...d, vsMedian: Math.round((d.totalTok / medTok) * 10) / 10 })),
    topCostSessions: sessions.filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 8),
    mostErrorSessions: sessions.filter((s) => s.turnsError > 0).sort((a, b) => b.turnsError - a.turnsError).slice(0, 8),
    topInputSessions: sessions.filter((s) => s.userMsgs > 0).sort((a, b) => b.userMsgs - a.userMsgs).slice(0, 8),
    longestSessions: sessions.filter((s) => s.durationMin > 0).sort((a, b) => b.durationMin - a.durationMin).slice(0, 8),
    retryTopProviders: [...providerRetry.entries()].map(([provider, v]) => ({ provider, retries: v.retries, codes: v.codes })).sort((a, b) => b.retries - a.retries).slice(0, 6),
    slowTools: [...toolAgg.entries()].filter(([, t]) => t.calls >= 10).map(([tool, t]) => ({ tool, calls: t.calls, avgMs: Math.round(t.ms / t.calls), errs: t.errs })).sort((a, b) => b.avgMs - a.avgMs).slice(0, 8),
    cmdFailRate: [...cmdAgg.entries()].filter(([, c]) => c.calls >= 5 && c.errs > 0).map(([cmd, c]) => ({ cmd, calls: c.calls, errs: c.errs, failRate: Math.round((c.errs / c.calls) * 1000) / 10 })).sort((a, b) => b.failRate - a.failRate).slice(0, 8),
    compactionHeavy: sessions.filter((s) => s.compactions > 0).sort((a, b) => b.compactions - a.compactions).slice(0, 5),
    errorClusters: [...clusters.entries()].map(([key, v]) => ({ key, n: v.n, kind: v.kind, lastAt: v.lastAt })).sort((a, b) => b.n - a.n).slice(0, 8),
  }
}

module.exports = {
  classifyCommand,
  classifyError,
  errorClusterKey,
  ERROR_KINDS,
  streamWindowMs,
  usageNum,
  localDate,
  isoWeek,
  bucketOf,
  emptyDay,
  emptySessionFact,
  foldSession,
  MEASURES,
  aggregate,
  sessionRows,
  heat,
  errorRows,
  summary,
  errorBreakdown,
  dayDetail,
  flowsOf,
  speedDist,
  quantiles,
  modelDetail,
  sessionDetail,
  insights,
  lookupPrice,
}
