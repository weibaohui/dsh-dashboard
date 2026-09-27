'use strict'
/**
 * dsh-dashboard — Client 半体
 *
 * settings.section 仪表盘页：gridstack 拖拽网格 + ECharts 卡片（stat/line/bar/
 * pie/table/calendarHeatmap/punchcard/sessions），数据来自 host 半体
 * /dsh-dashboard/api/*。编辑模式拖拽/缩放布局，页面配置 JSON 持久化在宿主
 * storageDomain；「AI 编排」走提示词往返：生成提示词 → 交给任意 agent 会话 →
 * 粘回 JSON → 校验导入。
 *
 * 构建期内联 echarts/gridstack（esbuild），react 是平台模块经 require 注入；
 * 公式求值器在 client/formula.js（与 node 单测共用源码）。
 */

const React = require('react')
const echarts = require('echarts/core')
const { LineChart, BarChart, PieChart, HeatmapChart } = require('echarts/charts')
const {
  GridComponent, TooltipComponent, LegendComponent, TitleComponent,
  CalendarComponent, VisualMapComponent,
} = require('echarts/components')
const { CanvasRenderer } = require('echarts/renderers')
const { GridStack } = require('gridstack')
const { compileFormula } = require('./formula.js')

echarts.use([
  LineChart, BarChart, PieChart, HeatmapChart,
  GridComponent, TooltipComponent, LegendComponent, TitleComponent,
  CalendarComponent, VisualMapComponent, CanvasRenderer,
])

const API = '/dsh-dashboard/api'
const PLUGIN_ID = '@weibaohui/dsh-dashboard'
const SLOT_ORDER = 36

// ── 样式注入（gridstack 必需子集 + 卡片外观）────────────────────────────────
const CSS = `
.dshd-wrap, .dshd-wrap * { box-sizing: border-box; }
.dshd-wrap { font: 13px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; color: var(--dshd-text, #24292f); padding: 12px 16px 16px; box-sizing: border-box; overflow-y: auto; position: relative; }
/* 主面板模式下由 JS 钉高（视口高 − 顶部偏移），使 wrap 自身成为滚动容器 */
.dshd-pop-bg { position: fixed; inset: 0; z-index: 9990; }
.dshd-pop { position: absolute; top: 46px; right: 16px; z-index: 9995; background: var(--dshd-card,#fff); color: var(--dshd-text,#24292f); border: 1px solid var(--dshd-border2,rgba(90,100,110,0.55)); border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.2); padding: 10px 10px 6px; width: 320px; }
.dshd-sec-t { font-size: 11px; opacity: 0.55; margin: 10px 2px 4px; }
.dshd-sec-t:first-of-type { margin-top: 2px; }
.dshd-mi { display: block; width: 100%; text-align: left; background: transparent; border: none; border-radius: 8px; padding: 7px 8px; cursor: pointer; color: inherit; font: inherit; }
.dshd-mi:hover { background: rgba(127,127,127,0.14); }
.dshd-mi-t { display: block; font-weight: 600; font-size: 13px; }
.dshd-mi-d { display: block; font-size: 11px; opacity: 0.6; margin-top: 1px; }
.dshd-pop-foot { border-top: 1px solid var(--dshd-border,#d0d7de); margin-top: 8px; padding-top: 8px; font-size: 11px; opacity: 0.6; display: flex; justify-content: space-between; gap: 8px; }
.dshd-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
.dshd-tab { padding:4px 12px; border:1px solid var(--dshd-border,#d0d7de); border-radius:6px; cursor:pointer; background:var(--dshd-card,#fff); user-select:none; }
.dshd-tab.active { background:#2563eb; border-color:#2563eb; color:#fff; }
.dshd-btn { padding:4px 10px; border:1px solid var(--dshd-border,#d0d7de); border-radius:6px; cursor:pointer; background:var(--dshd-card,#fff); }
.dshd-btn:hover { filter:brightness(0.97); }
.dshd-btn.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
.dshd-btn.danger { color:#cf222e; border-color:#cf222e; }
.dshd-btn.on { background:#16a34a; border-color:#16a34a; color:#fff; }
.dshd-scan { font-size:12px; opacity:0.75; }
.dshd-grid { position:relative; min-height:420px; /* gridstack 内联高度不含底部 margin，留出呼吸空间避免末行边框被裁 */ padding-bottom: 14px; box-sizing: content-box; }
/* gridstack 官方 CSS 的必需子集：item 绝对定位 + 消费容器上的间距变量
   （v12 把 margin 放进 --gs-item-margin-* 变量，样式表不消费则卡片互相贴死） */
.grid-stack-item { position:absolute; top:0; left:0; padding: var(--gs-item-margin-top,3px) var(--gs-item-margin-right,3px) var(--gs-item-margin-bottom,3px) var(--gs-item-margin-left,3px); }
.grid-stack-item-content { width:100%; height:100%; overflow:hidden; }
.dshd-card { display:flex; flex-direction:column; height:100%; background:var(--dshd-card,#fff); border:1px solid var(--dshd-border2,rgba(90,100,110,0.55)); border-radius:8px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,0.08); }
.dshd-card-head { display:flex; align-items:center; gap:6px; padding:6px 10px; font-weight:600; font-size:12px; cursor:default; border-bottom:1px solid var(--dshd-border,#d0d7de); background:var(--dshd-card2,rgba(127,127,127,0.04)); }
.dshd-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshd-card-body { flex:1; min-height:0; position:relative; }
.dshd-chart { position:absolute; inset:0; }
.dshd-card.editing .dshd-card-head { cursor:grab; background:rgba(37,99,235,0.10); }
/* 悬停显示「编辑 / 复制」；✕ 删除仅编辑模式 */
.dshd-card-edit, .dshd-card-copy { color:#2563eb; cursor:pointer; padding:0 4px; border-radius:4px; display:none; font-weight:400; flex:none; }
.dshd-card-edit:hover, .dshd-card-copy:hover { background:rgba(37,99,235,0.12); }
.dshd-card:hover .dshd-card-edit, .dshd-card:hover .dshd-card-copy { display:inline; }
.dshd-card-copy.done { color:#16a34a; }
.dshd-card-del { color:#cf222e; cursor:pointer; font-weight:700; padding:0 4px; display:none; flex:none; }
.dshd-card.editing .dshd-card-del { display:inline; }
.grid-stack-placeholder > .placeholder-content { background:rgba(37,99,235,0.12); border:2px dashed #2563eb; border-radius:8px; }
.grid-stack-item-removing { opacity:0.4; }
.dshd-stat { display:flex; flex-direction:column; justify-content:center; padding:2px 12px; height:100%; }
.dshd-stat-v { font-size:20px; font-weight:700; letter-spacing:-0.5px; line-height:1.25; }
.dshd-stat-u { font-size:10px; opacity:0.65; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dshd-tablewrap { position:absolute; inset:0; overflow:auto; }
.dshd-table { width:100%; border-collapse:collapse; font-size:12px; }
.dshd-table th,.dshd-table td { text-align:right; padding:3px 8px; border-bottom:1px solid var(--dshd-border,#d0d7de); white-space:nowrap; }
.dshd-table th:first-child,.dshd-table td:first-child { text-align:left; max-width:180px; overflow:hidden; text-overflow:ellipsis; }
.dshd-ellip { max-width:130px; overflow:hidden; text-overflow:ellipsis; }
.dshd-table thead th { position:sticky; top:0; background:var(--dshd-card,#fff); }
.dshd-modal-bg { position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:10000; display:flex; align-items:center; justify-content:center; }
.dshd-modal { background:var(--dshd-card,#fff); color:var(--dshd-text,#24292f); border-radius:10px; padding:16px; width:min(720px,92vw); max-height:86vh; overflow:auto; box-shadow:0 12px 40px rgba(0,0,0,0.25); }
.dshd-modal h3 { margin:0 0 10px; font-size:15px; }
.dshd-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
.dshd-row label { font-size:12px; opacity:0.8; }
.dshd-input, .dshd-select, .dshd-textarea { border:1px solid var(--dshd-border,#d0d7de); border-radius:6px; padding:4px 8px; font:inherit; background:var(--dshd-card,#fff); color:inherit; }
.dshd-textarea { width:100%; min-height:140px; font-family:ui-monospace,Menlo,monospace; font-size:12px; }
.dshd-err { color:#cf222e; font-size:12px; white-space:pre-wrap; }
.dshd-measures { display:flex; gap:4px 10px; flex-wrap:wrap; max-width:100%; }
.dshd-measures label { font-size:12px; display:flex; gap:3px; align-items:center; }
.dshd-muted { opacity:0.65; font-size:12px; }
`
function injectCss() {
  if (typeof document === 'undefined') return
  if (document.getElementById('dshd-css')) return
  const el = document.createElement('style')
  el.id = 'dshd-css'
  el.textContent = CSS
  document.head.appendChild(el)
}

// ── 主题探测（跟随页面明暗）──────────────────────────────────────────────────
function luminance(color) {
  const m = /rgba?\(([^)]+)\)/.exec(color || '')
  if (!m) return 1
  const [r, g, b] = m[1].split(',').map((x) => parseFloat(x))
  return (0.299 * (r || 255) + 0.587 * (g || 255) + 0.114 * (b || 255)) / 255
}
function themeColors() {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.body) : null
  const bg = (cs && cs.backgroundColor) || '#ffffff'
  const text = (cs && cs.color) || '#24292f'
  const dark = luminance(bg) < 0.5
  return {
    dark,
    text,
    sub: dark ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.5)',
    border: dark ? 'rgba(255,255,255,0.14)' : '#d0d7de',
    card: dark ? 'rgba(255,255,255,0.045)' : '#ffffff',
    axis: dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)',
    split: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
    tooltipBg: dark ? '#1f2328' : '#ffffff',
    palette: ['#5b8ff9', '#5ad8a6', '#f6bd16', '#e8684a', '#6dc8ec', '#9270ca', '#ff9d4d', '#269a99', '#ff99c3', '#a0d911', '#5d7092', '#f04864'],
  }
}

// ── API 与格式化 ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* 空 body */ }
  if (!res.ok) throw new Error((json && (json.error || (json.errors && json.errors.join('\n')))) || `HTTP ${res.status}`)
  return json
}

function fmtNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '0'
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(Math.round(v * 100) / 100)
}
function fmtMoney(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '$0'
  if (Math.abs(v) >= 100) return '$' + v.toFixed(0)
  if (Math.abs(v) >= 1) return '$' + v.toFixed(2)
  return '$' + v.toFixed(4)
}
function fmtDuration(min) {
  if (typeof min !== 'number' || !Number.isFinite(min) || min <= 0) return '-'
  if (min >= 2880) return (min / 1440).toFixed(1) + ' 天'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h > 0) return h + ' 小时' + (m ? m + ' 分' : '')
  return m + ' 分钟'
}
function fmtMeasure(measure, v) {
  if (measure === 'cost') return fmtMoney(v)
  if (measure === 'speed') return fmtNum(v) + ' tok/s'
  if (measure === 'errorRate') return v.toFixed(1) + '%'
  if (measure === 'userMsgs') return fmtNum(v) + ' 次'
  if (measure === 'userInputChars') return fmtNum(v) + ' 字'
  if (measure === 'inputAvg') return fmtNum(v) + ' 字/条'
  if (measure === 'activeMin') return fmtDuration(v)
  if (measure === 'subagents') return fmtNum(v) + ' 次'
  return fmtNum(v)
}
const MEASURE_UNITS = { cost: 'USD', speed: 'tok/s', errorRate: '%', userMsgs: '次', userInputChars: '字', inputAvg: '字/条', activeMin: '分钟', subagents: '次' }

// ── 卡片数据获取（带 60s 缓存，重挂载不重新打后端）───────────────────────────
const dataCache = new Map()
async function cachedFetch(key, fn) {
  const hit = dataCache.get(key)
  if (hit && Date.now() - hit.at < 60000) return hit.data
  const data = await fn()
  dataCache.set(key, { at: Date.now(), data })
  return data
}
function clearDataCache() { dataCache.clear() }

function rangeQuery(q) {
  const p = new URLSearchParams()
  p.set('granularity', q.granularity || 'day')
  if (q.range) p.set('range', String(q.range))
  if (q.groupBy) p.set('groupBy', q.groupBy)
  if (q.scope) p.set('scope', q.scope || 'all')
  if (q.project) p.set('project', q.project)
  return p.toString()
}

/** 拉取卡片数据 → 统一形状 { series:[{key,bucket,values}] } 或专用形状。 */
async function loadCardData(card) {
  const q = card.query || {}
  const type = card.type
  if (type === 'stat') {
    const range = q.range === 'today' ? 'today' : q.range === '7' ? 'd7' : q.range === '30' ? 'd30' : 'all'
    const data = await cachedFetch('summary|' + (q.scope || 'all'), () => api('GET', '/summary?scope=' + (q.scope || 'all')))
    const bucket = data[range] || {}
    return { stat: bucket, rangeKey: range }
  }
  if (type === 'sessions') {
    return cachedFetch('sessions|' + rangeQuery(q), () => api('GET', '/sessions?' + rangeQuery(q) + '&limit=60'))
  }
  if (type === 'punchcard') {
    return cachedFetch('heat|' + rangeQuery(q), () => api('GET', '/heat?' + rangeQuery(q)))
  }
  if (type === 'errorSamples' || type === 'retryCodes') {
    return loadErrors(q)
  }
  if (type === 'insights') {
    return loadInsights(q)
  }
  const data = await cachedFetch('cube|' + rangeQuery(q), () => api('GET', '/cube?' + rangeQuery(q)))
  return data
}

/** 深度数据：错误专项 / 专项洞察。 */
async function loadErrors(q) {
  return cachedFetch('errors|' + rangeQuery(q), () => api('GET', '/errors?' + rangeQuery(q)))
}
async function loadInsights(q) {
  return cachedFetch('insights|' + rangeQuery(q), () => api('GET', '/insights?' + rangeQuery(q)))
}

// ── ECharts 通用 ─────────────────────────────────────────────────────────────
function baseOption(theme) {
  return {
    animation: false,
    textStyle: { color: theme.text, fontSize: 11 },
    color: theme.palette,
    tooltip: {
      confine: true,
      backgroundColor: theme.tooltipBg,
      borderColor: theme.border,
      textStyle: { color: theme.text, fontSize: 11 },
    },
    legend: { textStyle: { color: theme.text, fontSize: 10 }, type: 'scroll', top: 0, pageIconColor: theme.text, pageTextStyle: { color: theme.sub } },
    grid: { left: 8, right: 14, top: 26, bottom: 6, containLabel: true },
  }
}

function useECharts(option, onClick) {
  const ref = React.useRef(null)
  const chartRef = React.useRef(null)
  const clickRef = React.useRef(onClick)
  clickRef.current = onClick
  React.useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    chartRef.current = chart
    const ro = new ResizeObserver(() => { try { chart.resize() } catch { /* 已销毁 */ } })
    ro.observe(ref.current)
    const clickHandler = (params) => {
      try {
        window.__chartClicks = (window.__chartClicks || 0) + 1
        window.__lastChartClick = { componentType: params && params.componentType, seriesType: params && params.seriesType, name: params && params.name, value: params && params.value }
      } catch { /* ignore */ }
      if (typeof clickRef.current === 'function') clickRef.current(params)
    }
    try { chart.on('click', clickHandler) } catch { /* ignore */ }
    return () => {
      ro.disconnect()
      try { chart.off('click', clickHandler) } catch { /* ignore */ }
      try { chart.dispose() } catch { /* ignore */ }
      chartRef.current = null
    }
  }, [])
  React.useEffect(() => {
    if (chartRef.current && option) {
      try { chartRef.current.setOption(option, true) } catch (e) { /* option 异常不拖垮页面 */ }
    }
  }, [option])
  return ref
}

// ── 行变换：cube rows → 视图数据 ─────────────────────────────────────────────
function rowsToSeries(cube, card) {
  const q = card.query || {}
  const rows = cube.rows || []
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort()
  let evalValues = null
  if (q.formula) {
    let compiled = null
    try { compiled = compileFormula(q.formula) } catch { compiled = null }
    evalValues = (values) => {
      if (!compiled) return 0
      try { return compiled.evalSeries([values || {}])[0] || 0 } catch { return 0 }
    }
  }
  const measureNames = evalValues ? [q.formula] : (q.measures && q.measures.length ? q.measures : ['outTok'])
  const valueOf = (values, m) => {
    if (evalValues) return evalValues(values)
    const v = (values || {})[m]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  if (!q.groupBy) {
    const byBucket = new Map(rows.map((r) => [r.bucket, r.values || {}]))
    return {
      names: measureNames,
      buckets,
      data: measureNames.map((m) => buckets.map((b) => valueOf(byBucket.get(b), m))),
    }
  }
  const byKey = new Map()
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, new Map())
    byKey.get(r.key).set(r.bucket, valueOf(r.values, measureNames[0]))
  }
  const totals = [...byKey.entries()].map(([k, m]) => [k, [...m.values()].reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0)])
  totals.sort((a, b) => b[1] - a[1])
  const top = Math.max(1, Math.min(12, Number(card.options && card.options.top) || 8))
  const names = totals.slice(0, top).map(([k]) => k)
  return {
    names,
    buckets,
    data: names.map((k) => buckets.map((b) => {
      const m = byKey.get(k)
      const v = m && m.get(b)
      return Number.isFinite(v) ? v : 0
    })),
    totals,
  }
}

// ── 各卡片类型渲染 ───────────────────────────────────────────────────────────

function StatBody({ card, data, theme }) {
  const measure = (card.query && card.query.measures && card.query.measures[0]) || 'outTok'
  const v = data.stat ? data.stat[measure] : 0
  const unit = (card.options && card.options.unit) || MEASURE_UNITS[measure] || ''
  const label = { today: '今日', d7: '近 7 天', d30: '近 30 天', all: '累计' }[data.rangeKey] || ''
  const shown = measure === 'cost' ? fmtMoney(v) : measure === 'speed' ? fmtNum(v) : fmtNum(v)
  return React.createElement('div', { className: 'dshd-stat' },
    React.createElement('div', { className: 'dshd-stat-v', style: { color: theme.text } }, shown),
    React.createElement('div', { className: 'dshd-stat-u' }, `${label} · ${measure}${unit ? ' (' + unit + ')' : ''}`),
  )
}

function LineBody({ card, cube, theme }) {
  const q = card.query || {}
  const option = React.useMemo(() => {
    const themeNow = theme
    const base = baseOption(themeNow)
    const s = rowsToSeries(cube, card)
    const series = s.names.map((name, i) => ({
      name,
      type: 'line',
      showSymbol: s.buckets.length < 40,
      smooth: true,
      stack: card.options && card.options.stack ? 'total' : undefined,
      areaStyle: card.options && card.options.stack ? {} : undefined,
      data: s.data[i],
    }))
    return {
      ...base,
      xAxis: { type: 'category', data: s.buckets, axisLabel: { color: themeNow.sub, fontSize: 10 }, axisLine: { lineStyle: { color: themeNow.axis } } },
      yAxis: { type: 'value', axisLabel: { color: themeNow.sub, fontSize: 10, formatter: (v) => fmtNum(v) }, splitLine: { lineStyle: { color: themeNow.split } } },
      series,
    }
  }, [cube, card, theme])
  const ref = useECharts(option)
  return React.createElement('div', { className: 'dshd-chart', ref })
}

function BarBody({ card, cube, theme, onDrill }) {
  const option = React.useMemo(() => {
    const s = rowsToSeries(cube, card)
    const totals = (s.totals || []).slice().reverse()
    const measure = (card.query && card.query.measures && card.query.measures[0]) || 'outTok'
    const groupBy = (card.query && card.query.groupBy) || ''
    return {
      ...baseOption(theme),
      legend: { show: false },
      grid: { left: 8, right: 44, top: 8, bottom: 6, containLabel: true },
      tooltip: { ...baseOption(theme).tooltip, trigger: 'item' },
      xAxis: { type: 'value', axisLabel: { color: theme.sub, fontSize: 10, formatter: (v) => fmtNum(v) }, splitLine: { lineStyle: { color: theme.split } } },
      yAxis: { type: 'category', data: totals.map(([k]) => k), axisLabel: { color: theme.text, fontSize: 10, width: 130, overflow: 'truncate' }, axisLine: { lineStyle: { color: theme.axis } } },
      series: [{
        type: 'bar', barMaxWidth: 14,
        data: totals.map(([k, v]) => ({ value: Math.round(v * 100) / 100, name: k })),
        label: { show: true, position: 'right', color: theme.sub, fontSize: 10, formatter: (p) => fmtMeasure(measure, p.value) },
        cursor: groupBy === 'model' ? 'pointer' : 'default',
      }],
    }
  }, [cube, card, theme])
  const ref = useECharts(option, (params) => {
    if ((card.query && card.query.groupBy) === 'model' && params && params.name && typeof onDrill === 'function') {
      onDrill({ kind: 'model', key: params.name })
    }
  })
  return React.createElement('div', { className: 'dshd-chart', ref })
}

function PieBody({ card, cube, theme }) {
  const option = React.useMemo(() => {
    const s = rowsToSeries(cube, card)
    const top = Math.max(2, Math.min(12, Number(card.options && card.options.top) || 8))
    let items = (s.totals || []).slice(0, top).map(([k, v]) => ({ name: k, value: Math.round(v * 100) / 100 }))
    const rest = (s.totals || []).slice(top).reduce((sum, [, v]) => sum + v, 0)
    if (rest > 0) items.push({ name: '其他', value: Math.round(rest * 100) / 100 })
    return {
      ...baseOption(theme),
      legend: { ...baseOption(theme).legend, orient: 'vertical', right: 4, top: 'middle', bottom: 0 },
      tooltip: { ...baseOption(theme).tooltip, trigger: 'item', valueFormatter: (v) => fmtNum(v) },
      series: [{ type: 'pie', radius: ['38%', '72%'], center: ['38%', '52%'], data: items, label: { show: false } }],
    }
  }, [cube, card, theme])
  const ref = useECharts(option)
  return React.createElement('div', { className: 'dshd-chart', ref })
}

function TableBody({ card, cube }) {
  const q = card.query || {}
  const measures = (q.measures && q.measures.length ? q.measures : ['msgs', 'outTok', 'cost'])
  const byKey = new Map()
  for (const r of cube.rows || []) {
    const k = q.groupBy ? r.key : '汇总'
    const cur = byKey.get(k)
    if (cur) {
      for (const m of measures) cur[m] = (cur[m] || 0) + ((r.values || {})[m] || 0)
    } else {
      const obj = {}
      for (const m of measures) obj[m] = (r.values || {})[m] || 0
      byKey.set(k, obj)
    }
  }
  const rows = [...byKey.entries()]
  rows.sort((a, b) => (b[1][measures[0]] || 0) - (a[1][measures[0]] || 0))
  const top = Math.max(1, Math.min(20, Number(card.options && card.options.top) || 12))
  return React.createElement('div', { className: 'dshd-tablewrap' },
    React.createElement('table', { className: 'dshd-table' },
      React.createElement('thead', null, React.createElement('tr', null,
        React.createElement('th', null, q.groupBy || '指标'),
        measures.map((m) => React.createElement('th', { key: m }, m)))),
      React.createElement('tbody', null,
        rows.slice(0, top).map(([k, vals]) => React.createElement('tr', { key: k },
          React.createElement('td', { title: k }, k),
          measures.map((m) => React.createElement('td', { key: m }, fmtMeasure(m, vals[m] || 0))))))))
}

function CalendarBody({ card, cube, theme, onDrill }) {
  const option = React.useMemo(() => {
    const q = card.query || {}
    const values = new Map()
    for (const r of cube.rows || []) {
      if (r.key !== '') continue
      const values_ = r.values || {}
      let v
      if (q.formula) {
        try { v = compileFormula(q.formula).evalSeries([values_])[0] } catch { v = 0 }
      } else {
        v = values_[(q.measures && q.measures[0]) || 'totalTok'] || 0
      }
      values.set(r.bucket, v)
    }
    const data = [...values.entries()].map(([date, v]) => [date, Math.round(v * 100) / 100])
    const nums = data.map(([, v]) => v).filter((v) => v > 0).sort((a, b) => a - b)
    const max = nums.length ? nums[Math.floor(nums.length * 0.97)] || nums[nums.length - 1] : 1
    const today = new Date()
    const start = new Date(Date.now() - 364 * 86400000)
    const p = (n) => String(n).padStart(2, '0')
    const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    const measure = (q.measures && q.measures[0]) || 'totalTok'
    return {
      ...baseOption(theme),
      tooltip: { ...baseOption(theme).tooltip, formatter: (p) => `${p.value[0]}<br/>${fmtMeasure(measure, p.value[1])}` },
      visualMap: {
        min: 0, max: max || 1, show: false, type: 'continuous',
        inRange: { color: theme.dark ? ['#0e4429', '#00a632', '#26d648', '#7ee787'] : ['#ebedf0', '#9be9a8', '#40c463', '#216e39'] },
      },
      calendar: {
        top: 24, left: 36, right: 10, cellSize: ['auto', 13], range: [iso(start), iso(today)],
        splitLine: { show: false },
        yearLabel: { show: false },
        monthLabel: { color: theme.sub, fontSize: 9 },
        dayLabel: { color: theme.sub, fontSize: 9, firstDay: 1, nameMap: ['日', '一', '二', '三', '四', '五', '六'] },
        itemStyle: { color: theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', borderColor: 'transparent', borderWidth: 1 },
      },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
    }
  }, [cube, card, theme])
  const ref = useECharts(option, (params) => {
    const date = params && params.value && params.value[0]
    if (date && typeof onDrill === 'function') onDrill({ kind: 'day', key: date })
  })
  return React.createElement('div', { className: 'dshd-chart', ref })
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
function PunchBody({ card, data, theme }) {
  const option = React.useMemo(() => {
    const heat = (data && data.heat) || new Array(168).fill(0)
    // fold.js 索引 = getDay()*24+hour（0=周日）；展示按周一在上
    const rowOfDay = (d) => (d === 0 ? 6 : d - 1)
    const cells = []
    let max = 0
    for (let d = 0; d < 7; d++) {
      for (let hh = 0; hh < 24; hh++) {
        const v = heat[d * 24 + hh] || 0
        if (v > max) max = v
        cells.push([hh, rowOfDay(d), v])
      }
    }
    return {
      ...baseOption(theme),
      legend: { show: false },
      grid: { left: 8, right: 60, top: 8, bottom: 6, containLabel: true },
      tooltip: { ...baseOption(theme).tooltip, formatter: (p) => `${WEEKDAYS[p.value[1]]} ${p.value[0]}:00<br/>活动 ${p.value[2]}` },
      xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => String(i)), axisLabel: { color: theme.sub, fontSize: 9 }, axisLine: { show: false } },
      yAxis: { type: 'category', data: WEEKDAYS, axisLabel: { color: theme.text, fontSize: 10 }, axisLine: { show: false } },
      visualMap: {
        min: 0, max: max || 1, calculable: false, orient: 'vertical', right: 6, top: 'middle',
        itemHeight: 80, textStyle: { color: theme.sub, fontSize: 9 },
        inRange: { color: theme.dark ? ['#12233d', '#1c4e91', '#3b82f6', '#93c5fd'] : ['#ebedf0', '#bfd7f8', '#5b8ff9', '#1d5dd8'] },
      },
      series: [{ type: 'heatmap', data: cells, label: { show: false } }],
    }
  }, [data, card, theme])
  const ref = useECharts(option)
  return React.createElement('div', { className: 'dshd-chart', ref })
}

function SessionsBody({ card, data, onDrill }) {
  const rows = (data && data.rows) || []
  return React.createElement('div', { className: 'dshd-tablewrap' },
    React.createElement('table', { className: 'dshd-table' },
      React.createElement('thead', null, React.createElement('tr', null,
        ['会话', '项目', '输入', '回合', 'tokens', '时长', '费用'].map((h) => React.createElement('th', { key: h }, h)))),
      React.createElement('tbody', null,
        rows.slice(0, 40).map((r) => React.createElement('tr', {
          key: r.sessionId,
          title: r.title || r.sessionId,
          style: { cursor: 'pointer' },
          onClick: () => typeof onDrill === 'function' && onDrill({ kind: 'session', key: r.sessionId }),
        },
          React.createElement('td', { title: (r.title || r.sessionId) }, (r.title || r.sessionId).slice(0, 28)),
          React.createElement('td', { className: 'dshd-ellip', title: r.project || '-' }, (r.project || '-').slice(0, 24)),
          React.createElement('td', null, r.userMsgs),
          React.createElement('td', null, r.turns + (r.turnsError ? `（败${r.turnsError}）` : '')),
          React.createElement('td', null, fmtNum(r.totalTok)),
          React.createElement('td', null, fmtDuration(r.durationMin)),
          React.createElement('td', null, fmtMoney(r.cost)))))))
}

// ── 错误专项卡片 ─────────────────────────────────────────────────────────────
const KIND_LABELS = {
  RATE_LIMIT: '限流/配额', SERVER: '服务端 5xx', TIMEOUT: '超时', EMPTY_RESPONSE: '空响应',
  TRANSPORT: '传输', NETWORK: '网络', AUTH: '认证', ABORTED: '中止',
  PERMISSION: '权限', NOT_FOUND: '不存在', COMMAND_FAILED: '命令失败', TOOL: '工具', OTHER: '其他',
}
const kindLabel = (k) => KIND_LABELS[k] || k
const statChip = (label, value) => React.createElement('span', { key: label, style: { marginRight: 14, fontSize: 12 } }, label + ' ', React.createElement('b', null, value))

function RetryCodesBody({ card, data }) {
  const providers = Object.entries((data && data.byRetryProvider) || {})
  if (!providers.length) return React.createElement('div', { style: { padding: 12, opacity: 0.6, fontSize: 12 } }, '区间内没有 LLM 重试记录。')
  const codeSet = new Set()
  for (const [, codes] of providers) for (const c of Object.keys(codes)) codeSet.add(c)
  const codes = [...codeSet].sort((a, b) => b.localeCompare(a))
  return React.createElement('div', { className: 'dshd-tablewrap' },
    React.createElement('table', { className: 'dshd-table' },
      React.createElement('thead', null, React.createElement('tr', null,
        ['供应商', ...codes.map((c) => kindLabel(c)), '合计'].map((h) => React.createElement('th', { key: h }, h)))),
      React.createElement('tbody', null,
        providers.sort((a, b) => b[1] && (Object.values(b[1]).reduce((x, y) => x + y, 0)) - (Object.values(a[1] || {}).reduce((x, y) => x + y, 0)))
          .map(([provider, codesMap]) => {
            const total = Object.values(codesMap).reduce((x, y) => x + y, 0)
            return React.createElement('tr', { key: provider },
              React.createElement('td', { title: provider }, provider),
              codes.map((c) => React.createElement('td', { key: c, style: (codesMap[c] || 0) > 0 && c === 'RATE_LIMIT' ? { color: '#cf222e', fontWeight: 600 } : null }, codesMap[c] || 0)),
              React.createElement('td', null, React.createElement('b', null, total)))
          }))))
}

function ErrorSamplesBody({ card, data }) {
  const eb = data || {}
  const samples = (eb.samples || []).slice(0, 30)
  const clusters = (eb.clusters || []).slice(0, 6)
  return React.createElement('div', { className: 'dshd-tablewrap' },
    clusters.length > 0 && React.createElement('div', { style: { padding: '6px 10px', borderBottom: '1px solid var(--dshd-border,#d0d7de)' } },
      React.createElement('div', { className: 'dshd-muted', style: { marginBottom: 4 } }, '错误聚簇 Top（归一后计数）'),
      clusters.map((c) => React.createElement('div', { key: c.key, style: { fontSize: 11, display: 'flex', gap: 8 } },
        React.createElement('span', { style: { fontWeight: 700, flex: 'none' } }, '×' + c.n),
        React.createElement('span', { style: { opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: c.key }, c.key)))),
    React.createElement('table', { className: 'dshd-table', style: { marginTop: clusters.length ? 0 : 0 } },
      React.createElement('thead', null, React.createElement('tr', null,
        ['时间', '类别', '来源', '内容'].map((h) => React.createElement('th', { key: h }, h)))),
      React.createElement('tbody', null,
        samples.map((e, i) => React.createElement('tr', { key: i },
          React.createElement('td', { title: e.time ? new Date(e.time).toLocaleString() : '' }, e.time ? new Date(e.time).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'),
          React.createElement('td', null, kindLabel(e.kind || 'OTHER')),
          React.createElement('td', null, (e.source === 'model' ? e.provider || '模型' : e.tool) || '-'),
          React.createElement('td', { title: e.text, style: { maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.text || '-'))))))
}

function InsightsBody({ card, data, onDrill }) {
  const ins = data || {}
  const section = (title, rows, render) => rows && rows.length > 0 && React.createElement('div', { style: { marginBottom: 10 } },
    React.createElement('div', { className: 'dshd-muted', style: { marginBottom: 2 } }, title),
    ...rows.map(render))
  const item = (label, value, drill) => React.createElement('div', {
    key: label + value,
    style: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '1px 0', cursor: drill ? 'pointer' : 'default' },
    onClick: drill || undefined, title: drill ? '点击下钻' : undefined,
  },
    React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
    React.createElement('span', { style: { fontWeight: 600, flex: 'none' } }, value))
  return React.createElement('div', { className: 'dshd-tablewrap', style: { padding: '8px 10px', overflow: 'auto' } },
    section('异常日（回合错误率最高）', ins.worstErrorDays, (d) => item(`${d.date} · ${d.turns} 回合`, `${d.errorRate}% 失败`, () => onDrill({ kind: 'day', key: d.date }))),
    section('Token 异常日（相对中位数）', ins.tokenSpikeDays, (d) => item(`${d.date} · ${d.sessions} 会话`, `${fmtNum(d.totalTok)}（×${d.vsMedian}）`, () => onDrill({ kind: 'day', key: d.date }))),
    section('输入最多会话', ins.topInputSessions, (s) => item(s.title || s.sessionId, s.userMsgs + ' 次', () => onDrill({ kind: 'session', key: s.sessionId }))),
    section('运行最长会话', ins.longestSessions, (s) => item(s.title || s.sessionId, fmtDuration(s.durationMin), () => onDrill({ kind: 'session', key: s.sessionId }))),
    section('最贵会话', ins.topCostSessions, (s) => item(s.title || s.sessionId, fmtMoney(s.cost), () => onDrill({ kind: 'session', key: s.sessionId }))),
    section('错误最多会话', ins.mostErrorSessions, (s) => item(s.title || s.sessionId, `${s.turnsError} 次失败`, () => onDrill({ kind: 'session', key: s.sessionId }))),
    section('重试风暴（按供应商）', ins.retryTopProviders, (p) => item(p.provider, `${p.retries} 次`)),
    section('慢工具（平均耗时）', ins.slowTools, (t) => item(t.tool, Math.round(t.avgMs / 1000) + 's')),
    section('命令失败率（≥5 次）', ins.cmdFailRate, (c) => item(c.cmd, `${c.failRate}%（${c.errs}/${c.calls}）`)),
    section('上下文压缩大户', ins.compactionHeavy, (s) => item(s.title || s.sessionId, `${s.compactions} 次`, () => onDrill({ kind: 'session', key: s.sessionId }))),
    section('错误聚簇 Top', ins.errorClusters, (c) => item(c.key, '×' + c.n)),
    React.createElement('div', { className: 'dshd-muted' }, '（空 = 区间内无此类信号）'),
  )
}

// ── 下钻弹窗 ────────────────────────────────────────────────────────────────
function DrillModal({ drill, onClose }) {
  const [state, setState] = React.useState({ loading: true, data: null })
  React.useEffect(() => {
    let alive = true
    const path = drill.kind === 'day' ? '/day/' + drill.key
      : drill.kind === 'model' ? '/model/' + encodeURIComponent(drill.key) + '?range=30'
        : '/session/' + encodeURIComponent(drill.key)
    api('GET', path).then((data) => { if (alive) setState({ loading: false, data }) })
      .catch((e) => { if (alive) setState({ loading: false, data: { __error: String(e.message || e) } }) })
    return () => { alive = false }
  }, [drill.kind, drill.key])
  const theme = themeColors()
  let body = null
  if (state.loading) body = React.createElement('div', { style: { padding: 12, opacity: 0.6 } }, '加载中…')
  else if (state.data && state.data.__error) body = React.createElement('div', { className: 'dshd-err' }, state.data.__error)
  else body = React.createElement(DrillBody, { key: drill.kind + ':' + drill.key, drill, data: state.data, theme })
  const titles = { day: '当日明细', model: '模型详情', session: '会话详情' }
  return React.createElement(Modal, { title: (titles[drill.kind] || '详情') + ' · ' + (drill.key || ''), onClose, wide: true }, body)
}

function DrillBody({ drill, data, theme }) {
  if (drill.kind === 'day') {
    const d = data
    return React.createElement('div', null,
      React.createElement('div', { style: { marginBottom: 8 } },
        statChip('回合', d.totals.turns), statChip('失败', d.totals.turnsError), statChip('tokens', fmtNum(d.totals.totalTok)),
        statChip('费用', fmtMoney(d.totals.cost)), statChip('会话', d.totals.sessions)),
      React.createElement('table', { className: 'dshd-table' },
        React.createElement('thead', null, React.createElement('tr', null, ['会话', '项目', '回合', 'tokens', '费用'].map((h) => React.createElement('th', { key: h }, h)))),
        React.createElement('tbody', null, d.sessions.map((s) => React.createElement('tr', { key: s.sessionId, title: s.title || s.sessionId },
          React.createElement('td', null, (s.title || s.sessionId).slice(0, 34)),
          React.createElement('td', { className: 'dshd-ellip', title: s.project || '-' }, (s.project || '-').slice(0, 24)),
          React.createElement('td', null, s.turns + (s.turnsError ? `（败${s.turnsError}）` : '')),
          React.createElement('td', null, fmtNum(s.totalTok)),
          React.createElement('td', null, fmtMoney(s.cost)))))),
      Object.keys(d.errors || {}).length >= 0 && d.errors.length > 0 && React.createElement('div', { style: { marginTop: 10 } },
        React.createElement('div', { className: 'dshd-muted' }, '当日错误样本'),
        d.errors.slice(0, 8).map((e, i) => React.createElement('div', { key: i, style: { fontSize: 11 } },
          React.createElement('b', null, kindLabel(e.kind || 'OTHER')), ' · ', (e.text || '').slice(0, 120)))),
    )
  }
  if (drill.kind === 'model') {
    const d = data
    const option = React.useMemo(() => ({
      ...baseOption(theme),
      legend: { show: false },
      grid: { left: 8, right: 12, top: 8, bottom: 4, containLabel: true },
      xAxis: { type: 'category', data: (d.days || []).map((x) => x.date), axisLabel: { color: theme.sub, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: theme.sub, fontSize: 10, formatter: (v) => fmtNum(v) }, splitLine: { lineStyle: { color: theme.split } } },
      series: [{ type: 'line', smooth: true, data: (d.days || []).map((x) => x.outTok) }],
    }), [d, theme])
    return React.createElement('div', null,
      React.createElement('div', { style: { marginBottom: 8 } },
        statChip('响应', d.totals.msgs), statChip('输入', fmtNum(d.totals.inTok)), statChip('输出', fmtNum(d.totals.outTok)),
        statChip('速度', d.totals.speed + ' tok/s'), statChip('重试', d.totals.retries), statChip('费用', fmtMoney(d.totals.cost)), statChip('定价', d.totals.priced ? '已配置' : '未配置')),
      React.createElement('div', { ref: useECharts(option), style: { height: 180 } }),
      React.createElement('table', { className: 'dshd-table', style: { marginTop: 8 } },
        React.createElement('thead', null, React.createElement('tr', null, ['会话', '项目', '输出 tokens', '条数'].map((h) => React.createElement('th', { key: h }, h)))),
        React.createElement('tbody', null, (d.topSessions || []).map((s) => React.createElement('tr', { key: s.sessionId },
          React.createElement('td', null, (s.title || s.sessionId).slice(0, 36)),
          React.createElement('td', { className: 'dshd-ellip', title: s.project || '-' }, (s.project || '-').slice(0, 24)),
          React.createElement('td', null, fmtNum(s.outTok)),
          React.createElement('td', null, s.msgs))))),
    )
  }
  // session
  const d = data
  const costTotal = (d.days || []).reduce((s, x) => s + (x.cost || 0), 0)
  return React.createElement('div', null,
    React.createElement('div', { style: { marginBottom: 8 } },
      statChip('项目', d.project || '-'), statChip('活跃天数', (d.days || []).length), statChip('费用', fmtMoney(costTotal)),
      statChip('模型数', Object.keys(d.models || {}).length)),
    React.createElement('div', { className: 'dshd-muted', style: { marginBottom: 4 } }, '按模型'),
    ...Object.entries(d.models || {}).map(([m, v]) => statChip(m, `${v.msgs} 条 / ${fmtNum(v.outTok)} out`)),
    React.createElement('div', { className: 'dshd-muted', style: { margin: '8px 0 4px' } }, '工具调用'),
    React.createElement('div', null, Object.entries(d.tools || {}).sort((a, b) => b[1].calls - a[1].calls).slice(0, 12).map(([t, v]) =>
      statChip(t, `${v.calls}${v.errs ? '（错' + v.errs + '）' : ''}`))),
    (d.errors || []).length > 0 && React.createElement('div', { style: { marginTop: 10 } },
      React.createElement('div', { className: 'dshd-muted' }, '错误样本'),
      d.errors.slice(-8).map((e, i) => React.createElement('div', { key: i, style: { fontSize: 11 } },
        React.createElement('b', null, kindLabel(e.kind || 'OTHER')), ' · ', (e.text || '').slice(0, 120)))),
  )
}

// ── CardView：按类型取数渲染 ────────────────────────────────────────────────
function CardView({ card, editing, onDelete, onEdit, theme, onDrill }) {
  const [state, setState] = React.useState({ loading: true, error: '', data: null })
  const [copied, setCopied] = React.useState(false)
  const reloadTick = React.useRef(0)
  React.useEffect(() => {
    let alive = true
    setState({ loading: true, error: '', data: null })
    loadCardData(card)
      .then((data) => { if (alive) setState({ loading: false, error: '', data }) })
      .catch((e) => { if (alive) setState({ loading: false, error: String((e && e.message) || e), data: null }) })
    return () => { alive = false }
  }, [JSON.stringify(card.query), card.type, reloadTick.current])
  // 复制当前卡片的定义信息（type/title/query/options JSON）到剪贴板
  const copyDef = () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(card, null, 2)).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }).catch(() => {})
    } catch { /* 剪贴板不可用 */ }
  }

  let body = null
  if (state.loading) body = React.createElement('div', { style: { padding: 12, opacity: 0.6, fontSize: 12 } }, '加载中…')
  else if (state.error) body = React.createElement('div', { className: 'dshd-err', style: { padding: 10 } }, state.error)
  else {
    const d = state.data
    switch (card.type) {
      case 'stat': body = React.createElement(StatBody, { card, data: d, theme }); break
      case 'line': body = React.createElement(LineBody, { card, cube: d, theme }); break
      case 'bar': body = React.createElement(BarBody, { card, cube: d, theme, onDrill }); break
      case 'pie': body = React.createElement(PieBody, { card, cube: d, theme }); break
      case 'table': body = React.createElement(TableBody, { card, cube: d }); break
      case 'calendarHeatmap': body = React.createElement(CalendarBody, { card, cube: d, theme, onDrill }); break
      case 'punchcard': body = React.createElement(PunchBody, { card, data: d, theme }); break
      case 'sessions': body = React.createElement(SessionsBody, { card, data: d, onDrill }); break
      case 'errorSamples': body = React.createElement(ErrorSamplesBody, { card, data: d }); break
      case 'retryCodes': body = React.createElement(RetryCodesBody, { card, data: d }); break
      case 'insights': body = React.createElement(InsightsBody, { card, data: d, onDrill }); break
      default: body = React.createElement('div', { style: { padding: 10, opacity: 0.6 } }, `未知类型：${card.type}`)
    }
  }
  return React.createElement('div', { className: 'dshd-card' + (editing ? ' editing' : '') },
    React.createElement('div', { className: 'dshd-card-head' },
      React.createElement('span', { className: 'dshd-title', title: card.title || card.type }, card.title || card.type),
      React.createElement('span', { className: 'dshd-card-edit', title: '编辑卡片定义', onClick: onEdit }, '编辑'),
      React.createElement('span', {
        className: 'dshd-card-copy' + (copied ? ' done' : ''),
        title: '复制卡片定义 JSON',
        onClick: copyDef,
      }, copied ? '已复制' : '复制'),
      React.createElement('span', { className: 'dshd-card-del', title: '删除卡片', onClick: onDelete }, '✕'),
    ),
    React.createElement('div', { className: 'dshd-card-body' }, body),
  )
}

// ── GridCanvas：gridstack 挂载 ──────────────────────────────────────────────
function GridCanvas({ page, editing, theme, onLayoutChange, renderCard }) {
  const containerRef = React.useRef(null)
  const gridRef = React.useRef(null)
  const layoutRef = React.useRef(null)
  // grid.on('change') 在挂载时注册一次，闭包会过期：经 ref 取最新回调
  const notifyRef = React.useRef(onLayoutChange)
  React.useEffect(() => { notifyRef.current = onLayoutChange })

  React.useEffect(() => {
    if (!containerRef.current) return
    layoutRef.current = page.layout.map((it) => ({ ...it }))
    const grid = GridStack.init({
      column: page.cols || 12,
      cellHeight: 40,
      margin: 8,
      float: true,
      disableOneColumnMode: true,
      draggable: { handle: '.dshd-card-head' },
      staticGrid: !editing,
    }, containerRef.current)
    gridRef.current = grid
    const onChange = (_evt, nodes) => {
      if (!Array.isArray(nodes)) return
      for (const n of nodes) {
        if (!n || !n.id) continue
        const it = layoutRef.current.find((x) => x.i === n.id)
        if (it) { it.x = n.x; it.y = n.y; it.w = n.w; it.h = n.h }
      }
      notifyRef.current(layoutRef.current.map((it) => ({ ...it })))
    }
    grid.on('change', onChange)
    return () => {
      try { grid.off('change') } catch { /* ignore */ }
      try { grid.destroy() } catch { /* ignore */ }
      gridRef.current = null
    }
  }, [page.id, page.cols, page.layout.map((i) => i.i).join(','), page.layout.length])

  React.useEffect(() => {
    if (gridRef.current) { try { gridRef.current.setStatic(!editing) } catch { /* ignore */ } }
  }, [editing])

  return React.createElement('div', {
    ref: containerRef,
    className: 'grid-stack dshd-grid',
    style: { column: undefined },
  }, page.layout.map((it) => {
    const card = page.cards[it.i]
    if (!card) return null
    const attrs = {
      key: it.i,
      className: 'grid-stack-item',
      'gs-id': it.i,
      'gs-x': String(it.x),
      'gs-y': String(it.y),
      'gs-w': String(it.w),
      'gs-h': String(it.h),
    }
    return React.createElement('div', attrs,
      React.createElement('div', { className: 'grid-stack-item-content' },
        renderCard(card, it),
      ),
    )
  }))
}

// ── 弹窗 ────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide }) {
  return React.createElement('div', { className: 'dshd-modal-bg', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
    React.createElement('div', { className: 'dshd-modal', style: wide ? { width: 'min(860px,94vw)' } : undefined },
      React.createElement('h3', null, title),
      children,
    ))
}

function CardEditor({ catalog, card, isNew, projects, onSave, onClose }) {
  const [draft, setDraft] = React.useState(() => JSON.parse(JSON.stringify(card)))
  const q = draft.query || {}
  const setQ = (patch) => setDraft((d) => ({ ...d, query: { ...d.query, ...patch } }))
  const toggleMeasure = (m) => {
    const cur = (q.measures || []).slice()
    const i = cur.indexOf(m)
    if (i >= 0) cur.splice(i, 1)
    else cur.push(m)
    setQ({ measures: cur })
  }
  const measureKeys = Object.keys(catalog.measures || {})
  return React.createElement(Modal, { title: isNew ? '新增卡片' : '编辑卡片', onClose },
    React.createElement('div', { className: 'dshd-row' },
      React.createElement('label', null, '类型'),
      React.createElement('select', { className: 'dshd-select', value: draft.type, onChange: (e) => setDraft((d) => ({ ...d, type: e.target.value })) },
        Object.entries(catalog.cardTypes || {}).map(([k, v]) => React.createElement('option', { key: k, value: k }, `${k} · ${v}`))),
      React.createElement('label', null, '标题'),
      React.createElement('input', { className: 'dshd-input', style: { width: 220 }, value: draft.title || '', onChange: (e) => setDraft((d) => ({ ...d, title: e.target.value })) }),
    ),
    React.createElement('div', { className: 'dshd-row' },
      React.createElement('label', null, '区间'),
      React.createElement('select', { className: 'dshd-select', value: q.range || '30', onChange: (e) => setQ({ range: e.target.value }) },
        (catalog.ranges || []).map((r) => React.createElement('option', { key: r, value: r }, r === 'today' ? '今日' : r === 'all' ? '全部' : `近 ${r} 天`))),
      React.createElement('label', null, '粒度'),
      React.createElement('select', { className: 'dshd-select', value: q.granularity || 'day', onChange: (e) => setQ({ granularity: e.target.value }) },
        (catalog.granularities || []).map((g) => React.createElement('option', { key: g, value: g }, g))),
      React.createElement('label', null, '分组'),
      React.createElement('select', { className: 'dshd-select', value: q.groupBy != null ? q.groupBy : '', onChange: (e) => setQ({ groupBy: e.target.value }) },
        React.createElement('option', { value: '' }, '（不分组）'),
        (catalog.groupBys || []).filter(Boolean).map((g) => React.createElement('option', { key: g, value: g }, g))),
      React.createElement('label', null, '范围'),
      React.createElement('select', { className: 'dshd-select', value: q.scope || 'all', onChange: (e) => setQ({ scope: e.target.value }) },
        React.createElement('option', { value: 'all' }, '含子代理'),
        React.createElement('option', { value: 'top' }, '仅顶层会话')),
    ),
    draft.type !== 'punchcard' && draft.type !== 'sessions' && React.createElement('div', { className: 'dshd-row' },
      React.createElement('label', null, '指标'),
      React.createElement('div', { className: 'dshd-measures' },
        measureKeys.map((m) => React.createElement('label', { key: m },
          React.createElement('input', { type: 'checkbox', checked: (q.measures || []).includes(m), onChange: () => toggleMeasure(m) }), m)))),
    draft.type !== 'punchcard' && draft.type !== 'sessions' && React.createElement('div', { className: 'dshd-row' },
      React.createElement('label', null, '公式（可选，优先于指标）'),
      React.createElement('input', { className: 'dshd-input', style: { flex: 1, fontFamily: 'ui-monospace,monospace' }, placeholder: 'pct(cacheReadTok, cacheReadTok + inTok)', value: q.formula || '', onChange: (e) => setQ({ formula: e.target.value }) })),
    React.createElement('div', { className: 'dshd-row' },
      React.createElement('label', null, '项目过滤'),
      React.createElement('input', { className: 'dshd-input', list: 'dshd-projects', value: q.project || '', onChange: (e) => setQ({ project: e.target.value }) }),
      React.createElement('datalist', { id: 'dshd-projects' }, projects.map((p) => React.createElement('option', { key: p.project, value: p.project }))),
      React.createElement('label', null, 'Top N'),
      React.createElement('input', { className: 'dshd-input', type: 'number', min: 1, max: 20, style: { width: 64 }, value: (draft.options && draft.options.top) || 8, onChange: (e) => setDraft((d) => ({ ...d, options: { ...d.options, top: Number(e.target.value) || 8 } })) }),
      draft.type === 'line' && React.createElement('label', null,
        React.createElement('input', { type: 'checkbox', checked: !!(draft.options && draft.options.stack), onChange: (e) => setDraft((d) => ({ ...d, options: { ...d.options, stack: e.target.checked } })) }), '堆叠'),
      draft.type === 'stat' && React.createElement('label', null, '单位',
        React.createElement('input', { className: 'dshd-input', style: { width: 80 }, value: (draft.options && draft.options.unit) || '', onChange: (e) => setDraft((d) => ({ ...d, options: { ...d.options, unit: e.target.value } })) })),
    ),
    React.createElement('div', { className: 'dshd-row', style: { justifyContent: 'flex-end' } },
      React.createElement('button', { className: 'dshd-btn', onClick: onClose }, '取消'),
      React.createElement('button', { className: 'dshd-btn primary', onClick: () => onSave(draft) }, '保存')),
  )
}

function ImportModal({ onClose, onImported }) {
  const [request, setRequest] = React.useState('')
  const [prompt, setPrompt] = React.useState('')
  const [json, setJson] = React.useState('')
  const [err, setErr] = React.useState('')
  const genPrompt = async () => {
    try {
      const r = await api('GET', '/ai/prompt?request=' + encodeURIComponent(request || '综合概览页'))
      setPrompt(r.prompt)
    } catch (e) { setErr(String(e.message || e)) }
  }
  const doImport = async () => {
    setErr('')
    try {
      const text = json.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim()
      const page = JSON.parse(text)
      const r = await api('POST', '/pages/import', { page })
      if (r.ok) onImported(r.page)
    } catch (e) { setErr('导入失败：' + String(e.message || e)) }
  }
  return React.createElement(Modal, { title: 'AI 编排（提示词往返）', onClose, wide: true },
    React.createElement('div', { className: 'dshd-muted', style: { marginBottom: 8 } },
      '第 1 步：描述你想要的页面 → 生成提示词 → 粘贴到任意 dsh agent 会话；第 2 步：把 AI 返回的 JSON 粘到下面 → 导入（host 会校验 Schema，坏配置进不来）。'),
    React.createElement('div', { className: 'dshd-row' },
      React.createElement('input', { className: 'dshd-input', style: { flex: 1 }, placeholder: '例如：给我一个成本分析页，突出费用趋势和最贵的模型', value: request, onChange: (e) => setRequest(e.target.value) }),
      React.createElement('button', { className: 'dshd-btn primary', onClick: genPrompt }, '生成提示词')),
    prompt && React.createElement('div', null,
      React.createElement('div', { className: 'dshd-row', style: { justifyContent: 'space-between' } },
        React.createElement('label', null, '提示词（复制给 agent）'),
        React.createElement('button', { className: 'dshd-btn', onClick: () => { try { navigator.clipboard.writeText(prompt) } catch { /* ignore */ } } }, '复制')),
      React.createElement('textarea', { className: 'dshd-textarea', readOnly: true, value: prompt, style: { minHeight: 180 } })),
    React.createElement('div', { className: 'dshd-row', style: { marginTop: 8 } }, React.createElement('label', null, 'AI 返回的页面 JSON')),
    React.createElement('textarea', { className: 'dshd-textarea', placeholder: '{ "id": "cost-analysis", ... }', value: json, onChange: (e) => setJson(e.target.value) }),
    err && React.createElement('div', { className: 'dshd-err' }, err),
    React.createElement('div', { className: 'dshd-row', style: { justifyContent: 'flex-end', marginTop: 8 } },
      React.createElement('button', { className: 'dshd-btn', onClick: onClose }, '关闭'),
      React.createElement('button', { className: 'dshd-btn primary', onClick: doImport }, '校验并导入')),
  )
}

function PricingModal({ onClose, onSaved }) {
  const [prices, setPrices] = React.useState(null)
  const [models, setModels] = React.useState([])
  const [err, setErr] = React.useState('')
  React.useEffect(() => {
    Promise.all([api('GET', '/pricing'), api('GET', '/cube?range=all&groupBy=model')])
      .then(([p, cube]) => {
        setPrices(p.prices || {})
        const used = new Set([...Object.keys(p.prices || {}), ...(cube.rows || []).map((r) => r.key)])
        setModels([...used].sort())
      })
      .catch((e) => setErr(String(e.message || e)))
  }, [])
  const setField = (model, field, value) => {
    setPrices((prev) => {
      const next = { ...prev }
      next[model] = { in: 0, out: 0, cr: 0, cw: 0, ...(next[model] || {}) }
      next[model][field] = Number(value) || 0
      return next
    })
  }
  const save = async () => {
    try {
      await api('PUT', '/pricing', { prices })
      clearDataCache()
      onSaved()
    } catch (e) { setErr(String(e.message || e)) }
  }
  if (!prices) return React.createElement(Modal, { title: '模型价格表（每 M token · USD）', onClose }, err || '加载中…')
  return React.createElement(Modal, { title: '模型价格表（每 M token · USD，费用为估算）', onClose, wide: true },
    React.createElement('div', { className: 'dshd-muted', style: { marginBottom: 6 } }, '模型名取斜杠后一段匹配（如 zhanlu/glm-5.2 匹配 glm-5.2）。字段：in=输入 out=输出 cr=缓存读 cw=缓存写'),
    React.createElement('div', { className: 'dshd-tablewrap', style: { position: 'static', maxHeight: 380 } },
      React.createElement('table', { className: 'dshd-table' },
        React.createElement('thead', null, React.createElement('tr', null, ['模型', 'in', 'out', 'cr', 'cw'].map((h) => React.createElement('th', { key: h }, h)))),
        React.createElement('tbody', null,
          models.map((m) => {
            const p = prices[m] || { in: 0, out: 0, cr: 0, cw: 0 }
            return React.createElement('tr', { key: m },
              React.createElement('td', { title: m }, m),
              ['in', 'out', 'cr', 'cw'].map((f) => React.createElement('td', { key: f },
                React.createElement('input', { className: 'dshd-input', style: { width: 84, textAlign: 'right' }, type: 'number', step: '0.01', min: '0', value: p[f], onChange: (e) => setField(m, f, e.target.value) }))))
          })))),
    err && React.createElement('div', { className: 'dshd-err' }, err),
    React.createElement('div', { className: 'dshd-row', style: { justifyContent: 'flex-end', marginTop: 8 } },
      React.createElement('button', { className: 'dshd-btn', onClick: onClose }, '取消'),
      React.createElement('button', { className: 'dshd-btn primary', onClick: save }, '保存价格表')),
  )
}

// ── 主面板 ──────────────────────────────────────────────────────────────────
function DashboardPanel({ variant }) {
  const [pages, setPages] = React.useState(null)
  const [activeId, setActiveId] = React.useState(null)
  const [editing, setEditing] = React.useState(false)
  const [status, setStatus] = React.useState(null)
  const [catalog, setCatalog] = React.useState(null)
  const [projects, setProjects] = React.useState([])
  const [modal, setModal] = React.useState(null) // {kind, ...}
  const [pop, setPop] = React.useState(false) // ⚙ 设置小窗
  const [err, setErr] = React.useState('')
  const [entry, setEntryUi] = React.useState(ENTRY_STATE.entry)
  const wrapRef = React.useRef(null)
  // 主面板模式：宿主把 slot 内容挂在高度不定(通常 0/auto)的容器里，外层
  // centerCol 固定高 + overflow hidden —— height:100% 解析不出、底部被裁。
  // 显式把 wrap 钉成「视口高 − 顶部偏移」，让它自身成为滚动容器。
  React.useEffect(() => {
    if (variant !== 'panel') return
    const el = wrapRef.current
    if (!el) return
    const fit = () => {
      try {
        const r = el.getBoundingClientRect()
        const h = window.innerHeight - r.top - 6
        if (h > 300) el.style.height = Math.round(h) + 'px'
      } catch { /* ignore */ }
    }
    fit()
    const t1 = setTimeout(fit, 300)
    const t2 = setTimeout(fit, 1500)
    window.addEventListener('resize', fit)
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener('resize', fit) }
  }, [variant])
  React.useEffect(() => {
    const onUpdate = (v) => setEntryUi(v)
    ENTRY_STATE.listeners.push(onUpdate)
    return () => {
      const i = ENTRY_STATE.listeners.indexOf(onUpdate)
      if (i >= 0) ENTRY_STATE.listeners.splice(i, 1)
    }
  }, [])
  // 调试/自动化测试钩子：触发下钻（真实点击走 CardView onDrill 同一入口）
  React.useEffect(() => {
    window.__dshDashboardDrill = (d) => setModal({ kind: 'drill', drill: d })
  })
  const [theme, setTheme] = React.useState(() => (typeof document !== 'undefined' ? themeColors() : {}))
  const saveTimer = React.useRef(null)

  const refreshAll = React.useCallback(() => {
    clearDataCache()
    api('GET', '/pages').then((r) => {
      setPages(r.pages)
      setActiveId((cur) => (cur && r.pages.some((p) => p.id === cur) ? cur : r.pages[0] && r.pages[0].id))
    }).catch((e) => setErr('页面加载失败：' + String(e.message || e)))
  }, [])

  React.useEffect(() => {
    injectCss()
    setTheme(themeColors())
    refreshAll()
    api('GET', '/catalog').then(setCatalog).catch(() => {})
    api('GET', '/projects').then((r) => setProjects(r.projects || [])).catch(() => {})
    let stop = false
    const poll = async () => {
      try {
        const s = await api('GET', '/status')
        if (!stop) setStatus(s)
        return s
      } catch { return null }
    }
    poll().then((s) => {
      if (s && (s.scanning || s.progress.total > s.progress.done)) {
        const t = setInterval(async () => {
          const cur = await poll()
          if (stop || (cur && !cur.scanning && cur.lastScanAt > 0)) { clearInterval(t); refreshAll() }
        }, 2500)
      }
    })
    return () => { stop = true }
  }, [refreshAll])

  const page = pages && (pages.find((p) => p.id === activeId) || pages[0])

  const persistPages = React.useCallback((next) => {
    setPages(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      api('PUT', '/pages', { pages: next }).catch((e) => setErr('保存失败：' + String(e.message || e)))
    }, 700)
  }, [])

  const onLayoutChange = (layout) => {
    if (!editing || !page) return
    const next = pages.map((p) => (p.id === page.id ? { ...p, layout } : p))
    persistPages(next)
  }
  const updateCard = (cardId, card) => {
    const next = pages.map((p) => {
      if (p.id !== page.id) return p
      const cards = { ...p.cards, [cardId]: card }
      return { ...p, cards }
    })
    persistPages(next)
  }
  const deleteCard = (cardId) => {
    const next = pages.map((p) => {
      if (p.id !== page.id) return p
      const cards = { ...p.cards }
      delete cards[cardId]
      return { ...p, cards, layout: p.layout.filter((it) => it.i !== cardId) }
    })
    persistPages(next)
  }
  const addCard = () => setModal({ kind: 'card', isNew: true, cardId: 'c' + Date.now().toString(36), card: { type: 'line', title: '新卡片', query: { measures: ['outTok'], range: '30', granularity: 'day', scope: 'all' }, options: {} } })
  const saveCard = (cardId, card, isNew) => {
    const next = pages.map((p) => {
      if (p.id !== page.id) return p
      const cards = { ...p.cards, [cardId]: card }
      let layout = p.layout
      if (isNew && !p.layout.some((it) => it.i === cardId)) {
        const maxY = p.layout.reduce((m, it) => Math.max(m, it.y + it.h), 0)
        layout = [...p.layout, { i: cardId, x: 0, y: maxY, w: card.type === 'stat' ? 3 : 6, h: card.type === 'stat' ? 2 : 5 }]
      }
      return { ...p, cards, layout }
    })
    persistPages(next)
    setModal(null)
    refreshAll()
  }
  const addPage = () => {
    const id = 'page-' + Date.now().toString(36)
    const next = [...pages, { id, title: '新页面 ' + (pages.length + 1), cols: 12, layout: [], cards: {} }]
    persistPages(next)
    setActiveId(id)
    setEditing(true)
  }
  const deletePage = () => {
    if (!page || pages.length <= 1) return
    if (!confirm(`删除页面「${page.title}」？`)) return
    const next = pages.filter((p) => p.id !== page.id)
    persistPages(next)
    setActiveId(next[0].id)
  }
  const renamePage = () => {
    const t = prompt('页面标题', page.title)
    if (t && t.trim()) persistPages(pages.map((p) => (p.id === page.id ? { ...p, title: t.trim() } : p)))
  }
  const resetPages = async () => {
    if (!confirm('恢复出厂五个预设页？自定义页面会丢失。')) return
    try {
      const r = await api('POST', '/pages/reset')
      setPages(r.pages)
      setActiveId(r.pages[0].id)
      clearDataCache()
    } catch (e) { setErr(String(e.message || e)) }
  }
  const triggerScan = async (full) => {
    try {
      await api('POST', '/scan', { full })
      const s = await api('GET', '/status')
      setStatus(s)
      if (s.scanning) {
        const t = setInterval(async () => {
          const cur = await api('GET', '/status').catch(() => null)
          if (cur) setStatus(cur)
          if (!cur || !cur.scanning) { clearInterval(t); clearDataCache(); refreshAll() }
        }, 2500)
      } else { clearDataCache(); refreshAll() }
    } catch (e) { setErr(String(e.message || e)) }
  }

  if (!pages || !catalog) {
    return React.createElement('div', { className: 'dshd-wrap', ref: wrapRef },
      React.createElement('div', { style: { padding: 20, opacity: 0.6 } }, '仪表盘加载中…'),
      err && React.createElement('div', { className: 'dshd-err', style: { padding: '0 20px' } }, err))
  }

  const scanLabel = status
    ? (status.scanning
      ? `扫描中 ${status.progress.done}/${status.progress.total}…`
      : `${status.sessionCount} 会话 · ${new Date(status.lastScanAt || Date.now()).toLocaleTimeString()} 增量扫描完成`)
    : ''

  return React.createElement('div', { className: 'dshd-wrap', ref: wrapRef },
    React.createElement('div', { className: 'dshd-head' },
      pages.map((p) => React.createElement('span', {
        key: p.id,
        className: 'dshd-tab' + (p.id === (page && page.id) ? ' active' : ''),
        onClick: () => setActiveId(p.id),
      }, p.title)),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('span', { className: 'dshd-scan' }, scanLabel),
      React.createElement('button', { className: 'dshd-btn' + (editing ? ' on' : ''), onClick: () => setEditing(!editing) }, editing ? '完成编排' : '编辑布局'),
      !editing && React.createElement('button', { className: 'dshd-btn', onClick: addCard }, '加卡片'),
      editing && React.createElement('button', { className: 'dshd-btn', onClick: addPage }, '新建页'),
      editing && React.createElement('button', { className: 'dshd-btn', onClick: renamePage }, '改名'),
      editing && page && React.createElement('button', { className: 'dshd-btn danger', onClick: deletePage }, '删页'),
      React.createElement('button', {
        className: 'dshd-btn' + (pop ? ' on' : ''),
        title: '扫描、编排与设置',
        onClick: () => setPop((v) => !v),
      }, '设置'),
    ),
    err && React.createElement('div', { className: 'dshd-err', style: { marginBottom: 8 } }, err),
    status && status.scanErrors && status.scanErrors.length > 0 && React.createElement('div', { className: 'dshd-muted', style: { marginBottom: 6 } },
      '扫描跳过：' + status.scanErrors.join('；')),
    page && React.createElement(GridCanvas, {
      key: page.id + ':' + page.layout.map((i) => i.i).join(',') + ':' + page.layout.length,
      page,
      editing,
      theme,
      onLayoutChange,
      renderCard: (card) => React.createElement(CardView, {
        card,
        editing,
        theme,
        onDrill: (d) => !editing && setModal({ kind: 'drill', drill: d }),
        onDelete: () => editing && deleteCard(cardIdOf(page, card)),
        onEdit: () => setModal({ kind: 'card', isNew: false, cardId: cardIdOf(page, card), card }),
      }),
    }),
    !page && React.createElement('div', { className: 'dshd-muted', style: { padding: 20 } }, '当前没有页面，点「新建页」开始。'),
    modal && modal.kind === 'drill' && React.createElement(DrillModal, {
      drill: modal.drill,
      onClose: () => setModal(null),
    }),
    modal && modal.kind === 'card' && React.createElement(CardEditor, {
      catalog,
      projects,
      isNew: modal.isNew,
      card: modal.card,
      onClose: () => setModal(null),
      onSave: (draft) => saveCard(modal.cardId, draft, modal.isNew),
    }),
    modal && modal.kind === 'ai' && React.createElement(ImportModal, {
      onClose: () => setModal(null),
      onImported: (p) => { setModal(null); refreshAll(); setActiveId(p.id) },
    }),
    modal && modal.kind === 'pricing' && React.createElement(PricingModal, {
      onClose: () => setModal(null),
      onSaved: () => { setModal(null); refreshAll() },
    }),
    // ⚙ 设置弹窗：扫描 / 编排 / 费用 / 界面，分区菜单
    pop && React.createElement('div', { className: 'dshd-pop-bg', onMouseDown: () => setPop(false) },
      React.createElement('div', { className: 'dshd-pop', onMouseDown: (e) => e.stopPropagation() },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
          React.createElement('span', { style: { fontWeight: 700 } }, '仪表盘设置'),
          React.createElement('span', { style: { cursor: 'pointer', opacity: 0.6, padding: '0 4px' }, onClick: () => setPop(false) }, '✕')),

        React.createElement('div', { className: 'dshd-sec-t' }, '数据扫描'),
        React.createElement('button', { className: 'dshd-mi', onClick: () => { setPop(false); triggerScan(false) } },
          React.createElement('span', { className: 'dshd-mi-t' }, '增量重扫'),
          React.createElement('span', { className: 'dshd-mi-d' }, '扫描新增或变化的会话日志（日常用这个）')),
        React.createElement('button', { className: 'dshd-mi', onClick: () => { setPop(false); triggerScan(true) } },
          React.createElement('span', { className: 'dshd-mi-t' }, '全量重扫'),
          React.createElement('span', { className: 'dshd-mi-d' }, '丢弃缓存，全部会话重新计算')),

        React.createElement('div', { className: 'dshd-sec-t' }, '页面与编排'),
        React.createElement('button', { className: 'dshd-mi', onClick: () => { setPop(false); setModal({ kind: 'ai' }) } },
          React.createElement('span', { className: 'dshd-mi-t' }, 'AI 编排新页面'),
          React.createElement('span', { className: 'dshd-mi-d' }, '描述需求生成提示词，AI 返回整页配置一键导入')),
        React.createElement('button', { className: 'dshd-mi', onClick: () => { setPop(false); resetPages() } },
          React.createElement('span', { className: 'dshd-mi-t' }, '恢复出厂预设页'),
          React.createElement('span', { className: 'dshd-mi-d' }, '还原六个出厂页面，自定义页面会丢失')),

        React.createElement('div', { className: 'dshd-sec-t' }, '费用'),
        React.createElement('button', { className: 'dshd-mi', onClick: () => { setPop(false); setModal({ kind: 'pricing' }) } },
          React.createElement('span', { className: 'dshd-mi-t' }, '编辑价格表'),
          React.createElement('span', { className: 'dshd-mi-d' }, '按模型配置单价，费用为本地估算')),

        React.createElement('div', { className: 'dshd-sec-t' }, '界面'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 8px 4px' } },
          React.createElement('span', { style: { fontSize: 12, flex: 'none' } }, '入口位置'),
          React.createElement('select', {
            className: 'dshd-select', value: entry, style: { flex: 1 },
            onChange: (e) => {
              const v = e.target.value
              setEntryUi(v)
              api('PUT', '/config', { entry: v }).catch(() => {})
              setEntry(v)
            },
          },
            React.createElement('option', { value: 'sidebar' }, '侧边栏最上方（默认）'),
            React.createElement('option', { value: 'settings' }, '设置页内'),
            React.createElement('option', { value: 'both' }, '两者都显示'))),

        React.createElement('div', { className: 'dshd-pop-foot' },
          React.createElement('span', null, status ? `${status.sessionCount} 会话` : '…'),
          React.createElement('span', null, status && status.storage === 'memory' ? '存储：内存（重启丢失）' : '存储：本地')),
      ),
    ),
  )
}

function cardIdOf(page, card) {
  for (const [id, c] of Object.entries(page.cards)) {
    if (c === card) return id
  }
  return ''
}

// ── 入口挂载：侧边栏最上（sidebar.panellist + main）/ 设置页 / 两者 ─────────
// 位置由宿主 storage 的 config 表决定（默认 sidebar=侧边栏最上方，order -100），
// 面板内「入口」下拉可在线切换，slots 的 subscribe 机制支持动态重注册。

const ENTRY_STATE = { entry: 'sidebar', listeners: [] }
const SLOT_ID = 'dsh-dashboard'
function setEntry(entry) {
  ENTRY_STATE.entry = entry
  for (const fn of ENTRY_STATE.listeners.slice()) {
    try { fn(entry) } catch { /* 单个监听失败不影响其他 */ }
  }
}

module.exports = {
  name: PLUGIN_ID,
  inject: ['slots'],

  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    let disposers = []
    function unregisterAll() {
      for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* ignore */ } }
      disposers = []
    }
    // 每个入口只注册一次：反复 unregister/register 会触发宿主 slot 去重竞态，
    // 导致主面板偶发渲染为空。入口切换后刷新页面生效。
    const registered = { sidebar: false, settings: false }
    function registerSidebar() {
      if (registered.sidebar) return
      registered.sidebar = true
      // 侧边栏入口：panellist 提供（排序 + 图标），main 提供面板内容。
      // id/key 用简单串（不含 @/），keyed slot 的匹配对特殊字符不稳。
      disposers.push(slots.inject('sidebar.panellist', () => slots.register(
        { name: 'sidebar.panellist', id: SLOT_ID, label: '仪表盘', order: -100 },
        (props) => React.createElement('span', {
          'aria-hidden': 'true',
          style: { display: 'inline-flex', width: (props && props.size) || 18, height: (props && props.size) || 18, alignItems: 'center', justifyContent: 'center', fontSize: ((props && props.size) || 18) - 4 },
        }, '📊'),
      )))
      disposers.push(slots.inject('main', () => slots.register(
        { name: 'main', key: SLOT_ID },
        () => React.createElement(DashboardPanel, { variant: 'panel' }),
      )))
    }
    function registerSettings() {
      if (registered.settings) return
      registered.settings = true
      disposers.push(slots.inject('settings.section', () => slots.register(
        {
          name: 'settings.section',
          id: PLUGIN_ID,
          order: SLOT_ORDER,
          label: () => '仪表盘',
        },
        () => React.createElement(DashboardPanel, { variant: 'settings' }),
      )))
    }
    function applyEntries(entry) {
      if (entry === 'sidebar' || entry === 'both') registerSidebar()
      if (entry === 'settings' || entry === 'both') registerSettings()
    }

    // 先按默认（侧边栏置顶）同步注册，配置回来后再校正（已注册的不动）
    applyEntries(ENTRY_STATE.entry)
    ENTRY_STATE.listeners.push((entry) => applyEntries(entry))
    fetch(API + '/config').then((r) => r.json()).then((cfg) => {
      if (cfg && cfg.entry && cfg.entry !== ENTRY_STATE.entry) setEntry(cfg.entry)
    }).catch(() => { /* 配置不可达：保持默认 */ })

    ctx.effect(() => () => unregisterAll(), 'dsh-dashboard: entries')
  },
}
