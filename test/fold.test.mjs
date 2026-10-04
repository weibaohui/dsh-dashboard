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
  // medErrorRate：异常日条形参照线；errorClusters kind/lastAt：按类别着色 + 最近时间
  assert.equal(typeof ins.medErrorRate, 'number')
  ins.errorClusters.forEach((c) => {
    assert.ok(c.kind)
    assert.equal(typeof c.lastAt, 'number')
  })
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

// ── v0.2 新统计：缓存命中率 / 峰谷成本 / 注入 / 人的时间 / 文件活动 / 上下文重放 ──

function ctxEvents(baseTime) {
  const t = (n) => baseTime + n * 1000
  return [
    { type: 'session', seq: 0, time: baseTime, data: { cwd: '/tmp/proj-a', createdAt: baseTime } },
    { type: 'request/header', seq: 1, time: t(1), data: { header: { config: { model: 'm1', provider: 'p1' }, tools: [{ name: 'read', description: 'd'.repeat(80) }] } } },
    { type: 'system/message', seq: 2, time: t(2), data: { message: { content: [{ type: 'text', text: 'sys '.repeat(40) }] } } },
    { type: 'user/message', seq: 3, time: t(3), data: { content: [{ type: 'text', text: 'hello world' }] } },
    { type: 'user/message', seq: 4, time: t(4), data: { message: { content: [{ type: 'text', text: 'injected ctx' }], source: { kind: 'plugin', plugin: 'dsh-x' } } } },
    { type: 'step/start', seq: 5, time: t(5), data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 6, time: t(6), data: { callId: 'a1', name: 'ask_user_question', arguments: '{"questions":[]}' } },
    { type: 'tool/result', seq: 7, time: t(16), data: { message: { isError: false, source: { callId: 'a1' }, content: [{ type: 'text', text: 'answer' }] } } },
    { type: 'approval/asked', seq: 8, time: t(17), data: { id: 'ap1' } },
    { type: 'approval/decided', seq: 9, time: t(23), data: { id: 'ap1' } },
    { type: 'tool/call', seq: 10, time: t(24), data: { callId: 'e1', name: 'edit', arguments: JSON.stringify({ file_path: '/tmp/a.js', old_string: 'a\nb\nc', new_string: 'x\ny' }) } },
    { type: 'tool/result', seq: 11, time: t(25), data: { meta: {}, message: { isError: false, source: { callId: 'e1' }, content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'tool/call', seq: 12, time: t(26), data: { callId: 'g1', name: 'grep', arguments: JSON.stringify({ pattern: 'nohit-xyz' }) } },
    { type: 'tool/result', seq: 13, time: t(27), data: { meta: { shape: 'matches', truncated: false, files: [] }, message: { isError: false, source: { callId: 'g1' }, content: [{ type: 'text', text: '' }] } } },
    {
      type: 'assistant/message', seq: 14, time: t(40),
      data: {
        turn: 1, step: 1,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 20 },
        stream: [
          { type: 'chunk', time: t(30), chunk: { type: 'text-delta', text: 'a' } },
          { type: 'chunk', time: t(32), chunk: { type: 'block-start', blockType: 'reasoning' } },
          { type: 'chunk', time: t(36), chunk: { type: 'block-start', blockType: 'text' } },
        ],
        message: { role: 'assistant', source: { kind: 'model', model: 'm1' }, content: [{ type: 'text', text: 'reply' }] },
      },
    },
    { type: 'compaction/start', seq: 15, time: t(41), data: {} },
    { type: 'compaction/summary', seq: 16, time: t(42), data: { shadowedTokenCount: 777, shadowedSeqs: [3] } },
    { type: 'user/message', seq: 17, time: t(43), data: { content: [{ type: 'text', text: 'after compaction' }] } },
    { type: 'turn/end', seq: 18, time: t(50), data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('上下文重放：快照构成 / 注入分类 / 压缩移除 / 锚点', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0) // UTC 02:00 → off-peak
  const fact = fold.foldSession('ctx-s1', ctxEvents(base))
  const ctx = fold.contextOf(fact)
  assert.ok(ctx.records.length >= 1, '至少一条请求快照')
  const r = ctx.records[0]
  assert.ok(r.sys > 0, 'system prompt 有价')
  assert.ok(r.tls > 0, '工具 schema 有价')
  assert.ok(r.usr > 0 && r.inj > 0, '用户/注入分桶')
  assert.equal(r.asst, 0, '快照在响应加入前')
  assert.equal(r.pr, 420, '计费输入 = in+cr+cw')
  assert.equal(r.out, 50)
  assert.ok(r.tot === r.sys + r.tls + r.usr + r.inj + r.skl + r.asst + r.tool, 'tot 自洽')
  // 压缩：锚点 + shadowedSeqs 在后续 surface 事件生效（最后一条快照的 usr 不含被移除节点）
  const anchors = ctx.anchors
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].freed, 777)
  assert.equal(anchors[0].kind, 'compaction')
  const last = ctx.records[ctx.records.length - 1]
  assert.ok(last.usr < r.usr + 30, '压缩后 usr 只含新消息')
  // 恶意形态不炸：shadowedSeqs 非数组
  const fact2 = fold.foldSession('ctx-s2', [{ type: 'session', seq: 0, time: base, data: {} }, { type: 'compaction/summary', seq: 1, time: base, data: { shadowedSeqs: 'x' } }])
  assert.ok(fact2)
})

test('注入与 skill 统计：injectTok / byInject / skillTok', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0)
  const fact = fold.foldSession('ctx-s1', ctxEvents(base))
  const day = Object.values(fact.days)[0]
  assert.ok(day.injectTok > 0, '注入 tokens 累计')
  assert.ok(day.byInject['dsh-x'] > 0, '按来源分桶')
  const agg = fold.aggregate([fact], { granularity: 'day', groupBy: 'inject' })
  assert.ok(agg.rows.some((row) => row.key === 'dsh-x' && row.values.injectTok > 0), 'inject 维度聚合')
})

test('人的时间：ask_user 窗口 + 审批等待', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0)
  const fact = fold.foldSession('ctx-s1', ctxEvents(base))
  const day = Object.values(fact.days)[0]
  assert.equal(day.askUser, 1)
  assert.equal(day.approvals, 1)
  assert.equal(day.waitMs, 16000, '问答 10s + 审批 6s')
  const agg = fold.aggregate([fact], { granularity: 'day', groupBy: '' })
  assert.equal(agg.rows[0].values.waitMin, 0.3)
})

test('文件活动：行增删 / 搜索命中 / 无效搜索率', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0)
  const fact = fold.foldSession('ctx-s1', ctxEvents(base))
  const day = Object.values(fact.days)[0]
  assert.equal(day.fileWrites, 1)
  assert.equal(day.linesAdded, 2, 'edit new_string 2 行')
  assert.equal(day.linesRemoved, 3, 'edit old_string 3 行')
  assert.equal(day.searches, 1)
  assert.equal(day.searchesEmpty, 1, '完整 meta 且零命中')
  const agg = fold.aggregate([fact], { granularity: 'day', groupBy: 'file' })
  const row = agg.rows.find((r) => r.key === '/tmp/a.js')
  assert.ok(row, 'file 维度')
  assert.equal(row.values.fileWrites, 1)
  assert.equal(row.values.linesAdded, 2)
  const aggAll = fold.aggregate([fact], { granularity: 'day', groupBy: '' })
  assert.equal(aggAll.rows[0].values.searchMissRate, 100)
  const ins = fold.insights([fact], {}, {})
  assert.ok(ins.hotFiles.some((f) => f.file === '/tmp/a.js' && f.writes === 1), '热点文件榜')
})

test('TTFT 与解码分桶', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0)
  const fact = fold.foldSession('ctx-s1', ctxEvents(base))
  const day = Object.values(fact.days)[0]
  assert.equal(day.ttftSamples, 1)
  assert.equal(day.ttftMs, 25000, 'step 05s → 首 token 30s')
  assert.equal(day.reasoningMs, 4000, 'block-start 32s→36s')
  assert.equal(day.textMs, 4000, 'block-start 36s→assistant 40s')
  const agg = fold.aggregate([fact], { granularity: 'day', groupBy: '' })
  const v = agg.rows[0].values
  assert.equal(v.ttftAvg, 25000)
  assert.equal(v.thinkShare, 50)
  const dist = fold.speedDist([fact], { kind: 'ttft' })
  assert.equal(dist.kind, 'ttft')
})

test('峰谷成本：off-peak 拆分 + 价格系数', () => {
  // 2026-09-23 是周三：UTC 07:00 在 06-10 峰值窗内；UTC 12:00 为 off-peak
  assert.equal(new Date(Date.UTC(2026, 8, 23)).getUTCDay(), 3)
  const pricing = { m1: { in: 1, out: 1, cr: 1, cw: 1, off: 0.5 } }
  const mk = (hour) => {
    const base = Date.UTC(2026, 8, 23, hour, 0, 0)
    return fold.foldSession('peak-' + hour, [
      { type: 'session', seq: 0, time: base, data: { cwd: '/tmp/p' } },
      { type: 'request/header', seq: 1, time: base + 1, data: { header: { config: { model: 'm1', provider: 'deepseek' }, tools: [{ n: 1 }] } } },
      { type: 'step/start', seq: 2, time: base + 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 3, time: base + 3000, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100 }, message: { source: { kind: 'model', model: 'm1' }, content: [] } } },
    ])
  }
  const peakFact = mk(7)
  const offFact = mk(12)
  const peakDay = Object.values(peakFact.days)[0]
  const offDay = Object.values(offFact.days)[0]
  assert.equal(peakDay.inTokOff, 0, '峰值时刻不进 off 桶')
  assert.equal(offDay.inTokOff, 1000, 'off-peak 拆分')
  assert.equal(offDay.outTokOff, 100)
  const aggPeak = fold.aggregate([peakFact], { granularity: 'day', groupBy: 'model', pricing })
  const aggOff = fold.aggregate([offFact], { granularity: 'day', groupBy: 'model', pricing })
  const peakCost = aggPeak.rows[0].values.cost
  const offCost = aggOff.rows[0].values.cost
  assert.ok(Math.abs(peakCost - 1100 / 1e6) < 1e-9, '峰值全价')
  assert.ok(Math.abs(offCost - 550 / 1e6) < 1e-9, 'off-peak 半价')
})

test('缓存命中率与压缩度量', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0)
  const fact = fold.foldSession('ctx-s1', ctxEvents(base))
  const agg = fold.aggregate([fact], { granularity: 'day', groupBy: '' })
  const v = agg.rows[0].values
  assert.ok(Math.abs(v.cacheHitRate - (300 / 420) * 100) < 0.1, '命中率 = cr/(in+cr+cw)')
  assert.ok(Math.abs(v.cacheWriteShare - (20 / 420) * 100) < 0.1)
  assert.equal(v.compactedTok, 777)
  assert.equal(v.compications ?? v.compactions, v.compactions)
  const ins = fold.insights([fact], {}, {})
  assert.ok(ins.compactionHeavy.length === 1 && ins.compactionHeavy[0].compactedTok === 777, '压缩大户带回收量')
})

test('dist kind=sessions 会话规模直方图', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0)
  const mkFact = (id, tok) => fold.foldSession(id, [
    { type: 'session', seq: 0, time: base, data: { cwd: '/tmp/p' } },
    { type: 'step/start', seq: 1, time: base + 1, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: base + 2000, data: { turn: 1, step: 1, usage: { inputTokens: tok, outputTokens: 1 }, message: { source: { kind: 'model', model: 'm' }, content: [] } } },
  ])
  const dist = fold.speedDist([mkFact('a', 100), mkFact('b', 5000), mkFact('c', 90000)], { kind: 'sessions' })
  assert.equal(dist.kind, 'sessions')
  assert.equal(dist.input.n, 3)
  assert.equal(dist.input.bins.length, 12)
  assert.ok(dist.input.p50 > 0)
})

test('图片统计：官方公式估价', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0)
  const fact = fold.foldSession('img-s1', [
    { type: 'session', seq: 0, time: base, data: { cwd: '/tmp/p' } },
    { type: 'user/message', seq: 1, time: base + 1, data: { content: [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { width: 800, height: 600 } },
      { type: 'image', attachment: { width: 100, height: 100 } },
    ] } },
  ])
  const day = Object.values(fact.days)[0]
  assert.equal(day.images, 2)
  assert.ok(day.imageTok >= 2 * 117, '每图不低于下限 117')
  assert.ok(day.imageTok <= 2 * 384, '每图不超上限 384')
})

test('turnsAborted 进入会话榜', () => {
  const base = Date.UTC(2026, 8, 23, 2, 0, 0)
  const fact = fold.foldSession('ab-s1', [
    { type: 'session', seq: 0, time: base, data: { cwd: '/tmp/p' } },
    { type: 'turn/start', seq: 1, time: base + 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: base + 2, data: { turn: 1, reason: { kind: 'aborted' } } },
  ])
  const ins = fold.insights([fact], {}, {})
  assert.ok(ins.mostAbortedSessions.length === 1 && ins.mostAbortedSessions[0].turnsAborted === 1)
})

test('新预设页与卡片定义全部通过 validatePage', async () => {
  const host = (await import('../src/index.js')).default
  assert.ok(host.__internals, '宿主内部校验器可导入')
  for (const page of presets.defaultPages()) {
    const v = host.__internals.validatePage(page)
    assert.ok(v.ok, `页面 ${page.id} 校验失败: ${v.errors.join('; ')}`)
  }
})
