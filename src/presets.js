'use strict'
/**
 * dsh-dashboard — 出厂预设：五个页面、指标目录、默认价格表。
 * 页面配置即 JSON（gridstack 布局 + 卡片定义），用户手排 / AI 排都是改这份 JSON。
 */

/** 卡片类型目录（client 端渲染器同名 switch）。 */
const CARD_TYPES = Object.freeze({
  stat: '大数字卡（区间汇总 + 环比）',
  line: '趋势折线（日/周/月粒度，支持多序列堆叠）',
  bar: '横向条形榜（Top N）',
  pie: '占比饼图',
  table: '明细表（按维度列出多项指标）',
  calendarHeatmap: 'GitHub 同款日历热力图（52 周）',
  punchcard: '工作时段热力图（星期 × 小时）',
  sessions: '会话明细表（按最近活动排序）',
  errorSamples: '错误样本表（分类 + 聚簇 + 最新原文）',
  retryCodes: '供应商 × 错误码榜（LLM 重试分类）',
  insights: '专项洞察（异常日/最贵会话/慢工具/命令失败率）',
  stack: '竖向堆叠柱（时间 × 维度构成）',
  treemap: '层级矩形树图（项目 → 模型 构成，style=sunburst 切旭日）',
  sankey: '供应商 → 项目 流向图',
  themeRiver: '模型活跃主题河流',
  radar: '模型质量雷达（速度/经济性/稳定性/规模/可靠性）',
  parallel: '会话多维平行坐标',
  boxplot: '速度分布箱线图（按模型）',
  candle: '每日速度区间 K 线',
  histogram: '输入长度分布直方图',
  gauge: '费用预算仪表盘（需在设置里配置月预算）',
})

/** 查询字段目录。 */
const QUERY_FIELDS = Object.freeze({
  measures: '基础指标名（数组，逗号可多于一个；line/table 用）',
  formula: '自定义公式（对 measures 求值，如 pct(inTok, totalTok)）',
  granularity: 'day | week | month',
  range: '天数（如 30）或 "today" | "all"',
  groupBy: 'model | tool | skill | cmd | slash | project | session |（空=总量）',
  scope: 'all | top（top=不含子代理会话）',
  project: '按项目名过滤（空=全部）',
})

const GRANULARITIES = ['day', 'week', 'month']
const GROUP_BYS = ['model', 'project_model', 'tool', 'skill', 'cmd', 'slash', 'project', 'session', '']
const RANGES = ['today', '7', '30', '90', '365', 'all']

/** /api/catalog 返回体（client 卡片编辑器和 AI 提示词共用）。 */
function catalog() {
  return {
    cardTypes: CARD_TYPES,
    queryFields: QUERY_FIELDS,
    granularities: GRANULARITIES,
    groupBys: GROUP_BYS,
    ranges: RANGES,
    formulaHelp: [
      '算子：+ - * / % ( )；数字字面量；除零得 0',
      '函数：pct(a,b)=a/b*100；perSec(tokens,ms)=每秒速率；delta(x)=环比差；ma(x,n)=n 期移动平均',
      '示例：perSec(decodeTok, decodeMs)；pct(turnsError, turns)；outTok * 0.000014',
    ],
  }
}

/** 默认价格表（每 M token，USD；占位估值，用户可在设置里改）。 */
const DEFAULT_PRICING = {
  'glm-5.2': { in: 0.6, out: 2.2, cr: 0.11, cw: 0.3 },
  'glm-5.3': { in: 0.8, out: 2.8, cr: 0.15, cw: 0.4 },
  'glm-5.3-flash': { in: 0.2, out: 0.8, cr: 0.04, cw: 0.1 },
  'kimi-k3': { in: 0.6, out: 2.5, cr: 0.12, cw: 0.3 },
  'hy3': { in: 0.5, out: 2.0, cr: 0.1, cw: 0.25 },
  'deepseek-v4-flash': { in: 0.27, out: 1.1, cr: 0.05, cw: 0.14 },
}

/** 布局小工具：生成 gridstack 的 {x,y,w,h}。 */
const cell = (x, y, w, h) => ({ x, y, w, h })

/** 七个出厂页。卡片 id 稳定，用户改布局后仍是同一份 JSON 的 patch。 */
function defaultPages() {
  return [
    {
      id: 'overview',
      title: '概览',
      cols: 12,
      layout: [
        { i: 'ov-today-cost', ...cell(0, 0, 3, 2) },
        { i: 'ov-today-tok', ...cell(3, 0, 3, 2) },
        { i: 'ov-today-sessions', ...cell(6, 0, 3, 2) },
        { i: 'ov-today-speed', ...cell(9, 0, 3, 2) },
        { i: 'ov-heat', ...cell(0, 2, 12, 5) },
        { i: 'ov-trend', ...cell(0, 7, 8, 6) },
        { i: 'ov-model', ...cell(8, 7, 4, 6) },
      ],
      cards: {
        'ov-today-cost': { type: 'stat', title: '今日估算费用', query: { measures: ['cost'], range: 'today', granularity: 'day', scope: 'all' }, options: { unit: 'USD' } },
        'ov-today-tok': { type: 'stat', title: '今日 tokens', query: { measures: ['totalTok'], range: 'today', granularity: 'day', scope: 'all' }, options: {} },
        'ov-today-sessions': { type: 'stat', title: '今日活跃会话', query: { measures: ['sessions'], range: 'today', granularity: 'day', scope: 'all' }, options: {} },
        'ov-today-speed': { type: 'stat', title: '今日平均输出速度', query: { measures: ['speed'], range: 'today', granularity: 'day', scope: 'all' }, options: { unit: 'tok/s' } },
        'ov-heat': { type: 'calendarHeatmap', title: '活跃热力图（全部 tokens）', query: { measures: ['totalTok'], range: '365', granularity: 'day', scope: 'all' }, options: {} },
        'ov-trend': { type: 'line', title: '每日 token 趋势（30 天）', query: { measures: ['inTok', 'outTok', 'cacheReadTok'], range: '30', granularity: 'day', scope: 'all' }, options: { stack: true } },
        'ov-model': { type: 'bar', title: '模型榜（30 天 · 输出 tokens）', query: { measures: ['outTok'], range: '30', granularity: 'day', groupBy: 'model', scope: 'all' }, options: { top: 8 } },
      },
    },
    {
      id: 'cost',
      title: 'Token 与费用',
      cols: 12,
      layout: [
        { i: 'cost-gauge', ...cell(0, 0, 3, 4) },
        { i: 'cost-trend', ...cell(3, 0, 9, 4) },
        { i: 'cost-stack', ...cell(0, 4, 12, 4) },
        { i: 'cost-treemap', ...cell(0, 8, 6, 6) },
        { i: 'cost-sankey', ...cell(6, 8, 6, 6) },
        { i: 'cost-cache', ...cell(0, 14, 6, 5) },
        { i: 'cost-pie', ...cell(6, 14, 3, 5) },
        { i: 'cost-table', ...cell(9, 14, 3, 5) },
      ],
      cards: {
        'cost-gauge': { type: 'gauge', title: '本月费用预算', query: { range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'cost-trend': { type: 'line', title: '每日费用趋势（90 天）', query: { measures: ['cost'], range: '90', granularity: 'day', scope: 'all' }, options: {} },
        'cost-stack': { type: 'stack', title: '每日 token 按模型堆叠（30 天）', query: { measures: ['totalTok'], range: '30', granularity: 'day', groupBy: 'model', scope: 'all' }, options: { top: 6 } },
        'cost-treemap': { type: 'treemap', title: '项目 → 模型 费用构成（30 天）', query: { measures: ['cost'], range: '30', granularity: 'day', groupBy: 'project_model', scope: 'all' }, options: {} },
        'cost-sankey': { type: 'sankey', title: '供应商 → 项目 费用流向（30 天）', query: { measures: ['cost'], range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'cost-cache': { type: 'line', title: '缓存命中率 %（30 天）', query: { measures: ['cacheReadTok', 'inTok'], formula: 'pct(cacheReadTok, cacheReadTok + inTok)', range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'cost-pie': { type: 'pie', title: '费用构成 · 按模型（30 天）', query: { measures: ['cost'], range: '30', granularity: 'day', groupBy: 'model', scope: 'all' }, options: { top: 8 } },
        'cost-table': { type: 'table', title: '按模型明细（30 天）', query: { measures: ['msgs', 'inTok', 'outTok', 'cost', 'speed'], range: '30', granularity: 'day', groupBy: 'model', scope: 'all' }, options: { top: 12 } },
      },
    },
    {
      id: 'quality',
      title: '模型与质量',
      cols: 12,
      layout: [
        { i: 'q-speed', ...cell(0, 0, 6, 5) },
        { i: 'q-errrate', ...cell(6, 0, 6, 5) },
        { i: 'q-radar', ...cell(0, 5, 4, 7) },
        { i: 'q-box', ...cell(4, 5, 4, 7) },
        { i: 'q-candle', ...cell(8, 5, 4, 7) },
        { i: 'q-table', ...cell(0, 12, 8, 6) },
        { i: 'q-retry', ...cell(8, 12, 4, 6) },
      ],
      cards: {
        'q-speed': { type: 'line', title: '输出速度 tokens/s（30 天，按模型）', query: { measures: ['decodeTok', 'decodeMs'], formula: 'perSec(decodeTok, decodeMs)', range: '30', granularity: 'day', groupBy: 'model', scope: 'all' }, options: { top: 6 } },
        'q-errrate': { type: 'line', title: '回合错误率 %（30 天）', query: { measures: ['turnsError', 'turns'], formula: 'pct(turnsError, turns)', range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'q-radar': { type: 'radar', title: '模型质量雷达（30 天）', query: { range: '30', granularity: 'day', groupBy: 'model', scope: 'all' }, options: { top: 5 } },
        'q-box': { type: 'boxplot', title: '速度分布箱线图 · 按模型（30 天）', query: { range: '30', granularity: 'day', scope: 'all' }, options: { top: 6 } },
        'q-candle': { type: 'candle', title: '每日速度区间 K 线（30 天）', query: { range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'q-table': { type: 'table', title: '模型质量明细（30 天）', query: { measures: ['msgs', 'retries', 'errorRate', 'speed', 'turnsError'], range: '30', granularity: 'day', groupBy: 'model', scope: 'all' }, options: { top: 12 } },
        'q-retry': { type: 'bar', title: '重试榜 · 按模型（30 天）', query: { measures: ['retries'], range: '30', granularity: 'day', groupBy: 'model', scope: 'all' }, options: { top: 8 } },
      },
    },
    {
      id: 'tools',
      title: '命令与技能',
      cols: 12,
      layout: [
        { i: 't-cmd', ...cell(0, 0, 6, 7) },
        { i: 't-skill', ...cell(6, 0, 6, 7) },
        { i: 't-tool', ...cell(0, 7, 6, 7) },
        { i: 't-slash', ...cell(6, 7, 6, 7) },
      ],
      cards: {
        't-cmd': { type: 'bar', title: 'shell 命令榜（30 天）', query: { measures: ['cmds'], range: '30', granularity: 'day', groupBy: 'cmd', scope: 'all' }, options: { top: 12 } },
        't-skill': { type: 'bar', title: 'skill 调用榜（30 天）', query: { measures: ['skills'], range: '30', granularity: 'day', groupBy: 'skill', scope: 'all' }, options: { top: 12 } },
        't-tool': { type: 'bar', title: '工具调用榜（30 天）', query: { measures: ['toolCalls'], range: '30', granularity: 'day', groupBy: 'tool', scope: 'all' }, options: { top: 12 } },
        't-slash': { type: 'bar', title: '斜杠命令榜（30 天）', query: { measures: ['slashCmds'], range: '30', granularity: 'day', groupBy: 'slash', scope: 'all' }, options: { top: 12 } },
      },
    },
    {
      id: 'work',
      title: '工作时段与会话',
      cols: 12,
      layout: [
        { i: 'w-punch', ...cell(0, 0, 7, 7) },
        { i: 'w-sessions', ...cell(7, 0, 5, 7) },
        { i: 'w-turns', ...cell(0, 7, 7, 6) },
        { i: 'w-proj', ...cell(7, 7, 5, 6) },
        { i: 'w-parallel', ...cell(0, 13, 12, 6) },
      ],
      cards: {
        'w-punch': { type: 'punchcard', title: '工作时段（90 天 · 星期 × 小时）', query: { range: '90', scope: 'all' }, options: {} },
        'w-sessions': { type: 'sessions', title: '最近会话（30 天）', query: { range: '30', scope: 'all' }, options: {} },
        'w-turns': { type: 'line', title: '每日回合与错误（30 天）', query: { measures: ['turns', 'turnsError'], range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'w-proj': { type: 'bar', title: '项目榜（30 天 · 输出 tokens）', query: { measures: ['outTok'], range: '30', granularity: 'day', groupBy: 'project', scope: 'all' }, options: { top: 10 } },
        'w-parallel': { type: 'parallel', title: '会话多维对比（30 天 · Top 30）', query: { range: '30', scope: 'all' }, options: {} },
      },
    },
    {
      id: 'errors',
      title: '错误分析',
      cols: 12,
      layout: [
        { i: 'e-insights', ...cell(0, 0, 12, 6) },
        { i: 'e-trend', ...cell(0, 6, 8, 6) },
        { i: 'e-codes', ...cell(8, 6, 4, 6) },
        { i: 'e-samples', ...cell(0, 12, 8, 7) },
        { i: 'e-tools', ...cell(8, 12, 4, 7) },
      ],
      cards: {
        'e-insights': { type: 'insights', title: '专项洞察（30 天）', query: { range: '30', scope: 'all' }, options: {} },
        'e-trend': { type: 'line', title: '错误趋势：回合错误 / 重试 / 工具报错（30 天）', query: { measures: ['turnsError', 'retries', 'toolErrors'], range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'e-codes': { type: 'retryCodes', title: '供应商 × 错误码（30 天）', query: { range: '30', scope: 'all' }, options: {} },
        'e-samples': { type: 'errorSamples', title: '错误样本与聚簇（30 天）', query: { range: '30', scope: 'all' }, options: {} },
        'e-tools': { type: 'bar', title: '工具报错榜（30 天）', query: { measures: ['toolErrors'], range: '30', granularity: 'day', groupBy: 'tool', scope: 'all' }, options: { top: 10 } },
      },
    },
    {
      id: 'input',
      title: '输入与时长',
      cols: 12,
      layout: [
        { i: 'i-in-today', ...cell(0, 0, 3, 2) },
        { i: 'i-in-all', ...cell(3, 0, 3, 2) },
        { i: 'i-dur-today', ...cell(6, 0, 3, 2) },
        { i: 'i-dur-all', ...cell(9, 0, 3, 2) },
        { i: 'i-in-trend', ...cell(0, 2, 6, 6) },
        { i: 'i-len-trend', ...cell(6, 2, 6, 6) },
        { i: 'i-sess', ...cell(0, 8, 12, 7) },
        { i: 'i-hist', ...cell(0, 15, 12, 5) },
      ],
      cards: {
        'i-in-today': { type: 'stat', title: '今日输入次数', query: { measures: ['userMsgs'], range: 'today', granularity: 'day', scope: 'all' }, options: { unit: '次' } },
        'i-in-all': { type: 'stat', title: '累计输入次数', query: { measures: ['userMsgs'], range: 'all', granularity: 'day', scope: 'all' }, options: { unit: '次' } },
        'i-dur-today': { type: 'stat', title: '今日运行时长', query: { measures: ['activeMin'], range: 'today', granularity: 'day', scope: 'all' }, options: { unit: '分钟' } },
        'i-dur-all': { type: 'stat', title: '累计运行时长', query: { measures: ['activeMin'], range: 'all', granularity: 'day', scope: 'all' }, options: { unit: '分钟' } },
        'i-in-trend': { type: 'line', title: '每日输入次数与字符量（30 天）', query: { measures: ['userMsgs', 'userInputChars'], range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'i-len-trend': { type: 'line', title: '平均输入长度（30 天，字符/条）', query: { formula: 'userInputChars / userMsgs', range: '30', granularity: 'day', scope: 'all' }, options: {} },
        'i-sess': { type: 'sessions', title: '会话明细（输入 / 运行时长 / 费用）', query: { range: '30', scope: 'all' }, options: {} },
        'i-hist': { type: 'histogram', title: '输入长度分布（30 天）', query: { range: '30', granularity: 'day', scope: 'all' }, options: {} },
      },
    },
  ]
}

module.exports = { CARD_TYPES, QUERY_FIELDS, GRANULARITIES, GROUP_BYS, RANGES, catalog, DEFAULT_PRICING, defaultPages }
