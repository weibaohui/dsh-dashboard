import { test } from 'node:test'
import assert from 'node:assert/strict'
import fold from '../src/fold.js'
import presets from '../src/presets.js'

const DAY_MS = 86400000

function ev(type, time, data) {
  return { type, seq: 0, time, data }
}

function sampleEvents(baseTime) {
  const d = (n) => baseTime + n * 3600_000
  return [
    ev('session', baseTime, { id: 'session-x', createdAt: baseTime, cwd: '/Users/mac/projects/ts/dsh-plugins/dsh-dashboard', delegationDepth: 0 }),
    ev('session/title', baseTime + 1, { title: '测试会话' }),
    ev('user/message', d(1), { message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }),
    ev('turn/start', d(1), { turn: 1 }),
    ev('step/start', d(1), { turn: 1, step: 1 }),
    ev('tool/call', d(2), { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"git status --short"}' }),
    ev('tool/result', d(2) + 500, { turn: 1, step: 1, message: { isError: false, source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'ok' }] } }),
    ev('tool/call', d(3), { turn: 1, step: 1, callId: 'call-2', name: 'bash', arguments: '{"command":"curl -s https://example.com"}' }),
    ev('tool/result', d(3) + 1200, { turn: 1, step: 1, message: { isError: true, source: { kind: 'tool', callId: 'call-2' }, content: [{ type: 'text', text: 'curl: (7) Failed to connect' }] } }),
    ev('tool/call', d(4), { turn: 1, step: 1, callId: 'call-3', name: 'skill', arguments: '{"name":"pdf-scan-to-markdown"}' }),
    ev('tool/result', d(4) + 300, { turn: 1, step: 1, message: { isError: false, source: { kind: 'tool', callId: 'call-3' }, content: [] } }),
    ev('tool/call', d(4), { turn: 1, step: 1, callId: 'call-4', name: 'subagent', arguments: '{"agent":" researcher"}' }),
    ev('tool/result', d(4) + 300, { turn: 1, step: 1, message: { isError: false, source: { kind: 'tool', callId: 'call-3' }, content: [] } }),
    {
      ...ev('assistant/message', d(5), {
        turn: 1, step: 1,
        message: { role: 'assistant', source: { kind: 'model', provider: 'zl', model: 'zhanlu/glm-5.2' }, content: [{ type: 'text', text: 'done' }] },
        usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 300, cacheWriteTokens: 50 },
        stream: [
          { type: 'chunk', time: d(4) + 1000 },
          { type: 'reasoning-chunks', time0: d(4) + 1000, dt: [500, 500, 500, 500] },
        ],
      }),
    },
    ev('step/end', d(5), { turn: 1, step: 1 }),
    ev('llm/retry', d(6), { turn: 1, attempt: 2, model: 'zhanlu/glm-5.2' }),
    ev('compaction/start', d(6), { turn: 1 }),
    ev('command/run', d(7), { command: '/compact' }),
    ev('turn/end', d(8), { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', d(9), { turn: 2 }),
    ev('turn/end', d(9) + 60_000, { turn: 2, reason: { kind: 'error' } }),
  ]
}

test('classifyCommand 取首词并归一化', () => {
  assert.equal(fold.classifyCommand('git status --short'), 'git')
  assert.equal(fold.classifyCommand('  curl -s http://x'), 'curl')
  assert.equal(fold.classifyCommand('/usr/local/bin/node -v'), 'node')
  assert.equal(fold.classifyCommand(''), '')
})

test('streamWindowMs 兼容 time 与 time0+dt 两种形态', () => {
  assert.equal(fold.streamWindowMs([{ type: 'chunk', time: 100 }, { type: 'chunk', time: 1300 }]), 1200)
  assert.equal(fold.streamWindowMs([{ type: 'reasoning-chunks', time0: 100, dt: [100, 100, 100] }]), 300)
  assert.equal(fold.streamWindowMs([]), 0)
  assert.equal(fold.streamWindowMs(undefined), 0)
})

test('isoWeek 边界（跨年周）', () => {
  assert.equal(fold.isoWeek('2026-01-01'), '2026-W01')
  assert.equal(fold.isoWeek('2025-12-29'), '2026-W01')
  assert.equal(fold.isoWeek('2026-09-27'), '2026-W39')
})

test('foldSession：token/模型/工具/命令/技能/质量全链路', () => {
  const base = new Date('2026-09-20T09:00:00').getTime() // 本地时间，取当天
  const fact = fold.foldSession('session-x', sampleEvents(base))
  assert.ok(fact, 'fact 生成')
  assert.equal(fact.project, 'dsh-dashboard')
  assert.equal(fact.title, '测试会话')
  assert.equal(fact.depth, 0)

  const date = fold.localDate(base)
  const day = fact.days[date]
  assert.ok(day, '当天日桶存在')
  assert.equal(day.userMsgs, 1)
  assert.equal(day.userInputChars, 2) // '你好'
  assert.equal(day.turns, 2)
  assert.equal(day.turnsCompleted, 1)
  assert.equal(day.turnsError, 1)
  assert.equal(day.subagents, 1)
  assert.ok(day.activeMs > 0)
  assert.equal(day.inTok, 1000)
  assert.equal(day.outTok, 200)
  assert.equal(day.cacheReadTok, 300)
  assert.equal(day.cacheWriteTok, 50)
  assert.equal(day.msgs, 1)
  assert.equal(day.retries, 1)
  assert.equal(day.compactions, 1)
  assert.equal(day.slashCmds, 1)
  assert.equal(day.bySlash.compact, 1)
  // 流式窗口 2000ms ≥ 200ms、200 tokens ≥ 16 → 计入速度
  assert.equal(day.decodeTok, 200)
  assert.equal(day.decodeMs, 2000)
  assert.equal(day.speedSamples, 1)
  // 工具配对：bash ok 500ms、bash err 1200ms、skill 300ms、subagent 无结果
  assert.equal(day.toolCalls, 4)
  assert.equal(day.toolErrors, 1)
  assert.equal(day.byTool.bash.calls, 2)
  assert.equal(day.byTool.bash.errs, 1)
  assert.equal(day.byTool.bash.ms, 1700)
  assert.equal(day.byTool.skill.calls, 1)
  assert.equal(day.byCmd.git, 1)
  assert.equal(day.byCmd.curl, 1)
  assert.equal(day.bySkill['pdf-scan-to-markdown'], 1)
  assert.equal(day.byModel['zhanlu/glm-5.2'].msgs, 1)
  assert.equal(day.byModel['zhanlu/glm-5.2'].retries, 1)
  // 错误样本
  assert.equal(fact.errors.length, 1)
  assert.equal(fact.errors[0].tool, 'bash')
  assert.ok(fact.errors[0].text.includes('curl'))
  // 热度 168 格
  assert.equal(day.heat.length, 168)
})

test('aggregate：日/月粒度 + 按模型分组 + 费用/速度派生', () => {
  const base = new Date('2026-09-20T09:00:00').getTime()
  const fact = fold.foldSession('session-x', sampleEvents(base))
  const pricing = { 'glm-5.2': { in: 1, out: 2, cr: 0, cw: 0 } }

  const day = fold.aggregate([fact], { granularity: 'day', groupBy: '', pricing })
  assert.equal(day.rows.length, 1)
  const r = day.rows[0]
  assert.equal(r.key, '')
  assert.equal(r.values.sessions, 1)
  assert.equal(r.values.inTok, 1000)
  // 费用 = (1000*1 + 200*2)/1e6 = 0.0014
  assert.ok(Math.abs(r.values.cost - 0.0014) < 1e-9)
  // 速度 = 200/2000ms = 100 tok/s
  assert.equal(r.values.speed, 100)
  assert.equal(r.values.errorRate, 50)

  const byModel = fold.aggregate([fact], { granularity: 'month', groupBy: 'model', pricing })
  assert.equal(byModel.rows.length, 1)
  assert.equal(byModel.rows[0].bucket, '2026-09')
  assert.equal(byModel.rows[0].key, 'zhanlu/glm-5.2')
  assert.equal(byModel.rows[0].values.outTok, 200)
  assert.ok(byModel.rows[0].values.cost > 0)

  // 价格表匹配取斜杠后段
  const byModelShort = fold.aggregate([fact], { granularity: 'day', groupBy: 'model', pricing })
  assert.ok(byModelShort.rows[0].values.cost > 0)
})

test('aggregate：scope=top 过滤子代理会话', () => {
  const base = new Date('2026-09-20T09:00:00').getTime()
  const fact = fold.foldSession('session-x', sampleEvents(base))
  const sub = fold.foldSession('session-sub', sampleEvents(base))
  sub.depth = 1
  const all = fold.aggregate([fact, sub], { granularity: 'day', groupBy: '' })
  const top = fold.aggregate([fact, sub], { granularity: 'day', groupBy: '', scope: 'top' })
  assert.equal(all.rows[0].values.sessions, 2)
  assert.equal(top.rows[0].values.sessions, 1)
})

test('sessionRows / heat / errorRows / summary 形状', () => {
  const base = new Date('2026-09-20T09:00:00').getTime()
  const fact = fold.foldSession('session-x', sampleEvents(base))
  const sessions = fold.sessionRows([fact], {})
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sessionId, 'session-x')
  assert.equal(sessions[0].turns, 2)
  assert.ok(sessions[0].totalTok > 0)

  const heat = fold.heat([fact], {})
  assert.equal(heat.heat.length, 168)
  assert.ok(heat.heat.some((v) => v > 0))

  const errors = fold.errorRows([fact], {})
  assert.equal(errors.length, 1)
  assert.equal(errors[0].tool, 'bash')

  const summary = fold.summary([fact], presets.DEFAULT_PRICING, 'all')
  assert.ok(summary.today)
  assert.ok(summary.d7)
  assert.ok(summary.d30)
  assert.ok(summary.all)
  assert.equal(typeof summary.all.totalTok, 'number')
})

test('跨日事件分桶（本地日界）', () => {
  const t0 = new Date('2026-09-20T23:50:00').getTime()
  const events = [
    ev('session', t0, { cwd: '/tmp/p', delegationDepth: 0 }),
    ev('user/message', t0, {}),
    ev('turn/start', t0 + 5 * 60_000, { turn: 1 }),
    ev('turn/end', t0 + 15 * 60_000, { turn: 1, reason: { kind: 'completed' } }), // 已跨到 9-21
  ]
  const fact = fold.foldSession('session-d', events)
  assert.equal(Object.keys(fact.days).length, 2)
  assert.ok(fact.days['2026-09-20'])
  assert.ok(fact.days['2026-09-21'])
  assert.equal(fact.days['2026-09-20'].userMsgs, 1)
  // 回合数在开始日计，结束原因在落地日计（跨午夜的回合两头各记一笔）
  assert.equal(fact.days['2026-09-20'].turns, 1)
  assert.equal(fact.days['2026-09-21'].turnsCompleted, 1)
})

test('空事件流返回 null', () => {
  assert.equal(fold.foldSession('s', []), null)
  assert.equal(fold.foldSession('s', [{}]), null)
})

test('classifyError 错误分类学', () => {
  assert.equal(fold.classifyError('SERVER', '任意'), 'SERVER')
  assert.equal(fold.classifyError('', '429 quota exceeded'), 'RATE_LIMIT')
  assert.equal(fold.classifyError('', 'Request timeout after 30s'), 'TIMEOUT')
  assert.equal(fold.classifyError('', '502 Bad Gateway'), 'SERVER')
  assert.equal(fold.classifyError('', 'ECONNREFUSED 127.0.0.1'), 'NETWORK')
  assert.equal(fold.classifyError('', 'invalid api key'), 'AUTH')
  assert.equal(fold.classifyError('', 'EACCES: permission denied'), 'PERMISSION')
  assert.equal(fold.classifyError('', 'ENOENT: no such file'), 'NOT_FOUND')
  assert.equal(fold.classifyError('', 'exited with code 1'), 'COMMAND_FAILED')
  assert.equal(fold.classifyError('', 'weird failure'), 'OTHER')
})

test('errorBreakdown：错误分类与聚簇聚合', () => {
  const base = new Date('2026-09-20T09:00:00').getTime()
  const fact = fold.foldSession('session-x', sampleEvents(base))
  const eb = fold.errorBreakdown([fact], {})
  // 工具错误：bash curl 连接失败 → NETWORK
  assert.equal(eb.byToolErr.bash.NETWORK, 1)
  assert.equal(eb.samples.length >= 1, true)
  assert.ok(eb.trend.length >= 1)
  // trend 里当日应含 TOOL 计数
  assert.equal(eb.trend[0].kinds.TOOL, 1)
})

test('insights：异常日 / 慢工具 / 会话排行 / 输入与时长', () => {
  const base = new Date('2026-09-20T09:00:00').getTime()
  const fact = fold.foldSession('session-x', sampleEvents(base))
  const ins = fold.insights([fact], {}, { 'glm-5.2': { in: 1, out: 2, cr: 0, cw: 0 } })
  assert.ok(Array.isArray(ins.worstErrorDays))
  assert.ok(Array.isArray(ins.topCostSessions))
  assert.ok(Array.isArray(ins.slowTools))
  assert.ok(Array.isArray(ins.errorClusters))
  assert.ok(Array.isArray(ins.topInputSessions))
  assert.ok(Array.isArray(ins.longestSessions))
  const s = fold.summary([fact], {}, 'all')
  assert.equal(typeof s.all.userInputChars, 'number')
  assert.equal(typeof s.all.activeMin, 'number')
  assert.equal(typeof s.all.subagents, 'number')
})

test('dayDetail / modelDetail / sessionDetail', () => {
  const base = new Date('2026-09-20T09:00:00').getTime()
  const fact = fold.foldSession('session-x', sampleEvents(base))
  const date = fold.localDate(base)
  const dd = fold.dayDetail([fact], date, {}, 'all')
  assert.equal(dd.date, date)
  assert.equal(dd.sessions.length, 1)
  assert.equal(dd.heat.length, 24)
  const md = fold.modelDetail([fact], 'zhanlu/glm-5.2', {}, { 'glm-5.2': { in: 1, out: 2, cr: 0, cw: 0 } })
  assert.equal(md.days.length, 1)
  assert.equal(md.totals.outTok, 200)
  assert.equal(md.totals.priced, true)
  const sd = fold.sessionDetail(fact, {})
  assert.equal(sd.sessionId, 'session-x')
  assert.ok(sd.days.length >= 1)
  assert.ok(sd.models['zhanlu/glm-5.2'])
})
