'use strict'
/**
 * dsh-dashboard — 卡片公式求值器（纯函数，node 单测与 client bundle 共用）
 *
 * 语法：数字、指标名（标识符）、+ - * / %、括号、一元负号；
 * 函数：pct(a,b)=a/b*100、perSec(tokens,ms)=每秒速率、
 *       delta(x)=环比差（序列级）、ma(x,n)=n 期移动平均（序列级）。
 * 除零/缺指标一律得 0，公式错误 throw（调用方捕获后展示错误文案）。
 */

const FUNCTIONS = Object.freeze({
  pct: { args: 2, series: false },
  perSec: { args: 2, series: false },
  delta: { args: 1, series: true },
  ma: { args: 2, series: true },
})

// ── Tokenizer ───────────────────────────────────────────────────────────────

function tokenize(src) {
  const tokens = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i += 1; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1
      tokens.push({ type: 'num', value: Number(src.slice(i, j)) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1
      tokens.push({ type: 'ident', value: src.slice(i, j) })
      i = j
      continue
    }
    if ('+-*/%(),' .includes(c)) {
      tokens.push({ type: 'op', value: c })
      i += 1
      continue
    }
    throw new Error(`公式含非法字符：${c}`)
  }
  return tokens
}

// ── Parser（递归下降）───────────────────────────────────────────────────────

function parse(src) {
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  function parseExpr() {
    let node = parseTerm()
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value
      node = { kind: 'bin', op, left: node, right: parseTerm() }
    }
    return node
  }
  function parseTerm() {
    let node = parseFactor()
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = next().value
      node = { kind: 'bin', op, left: node, right: parseFactor() }
    }
    return node
  }
  function parseFactor() {
    const t = peek()
    if (!t) throw new Error('公式意外结束')
    if (t.type === 'op' && t.value === '-') {
      next()
      return { kind: 'neg', value: parseFactor() }
    }
    if (t.type === 'op' && t.value === '+') { next(); return parseFactor() }
    if (t.type === 'op' && t.value === '(') {
      next()
      const inner = parseExpr()
      const close = next()
      if (!close || close.value !== ')') throw new Error('括号不匹配')
      return inner
    }
    if (t.type === 'num') { next(); return { kind: 'num', value: t.value } }
    if (t.type === 'ident') {
      next()
      if (peek() && peek().type === 'op' && peek().value === '(') {
        next()
        const args = []
        if (!(peek() && peek().value === ')')) {
          args.push(parseExpr())
          while (peek() && peek().value === ',') { next(); args.push(parseExpr()) }
        }
        const close = next()
        if (!close || close.value !== ')') throw new Error('函数括号不匹配')
        const spec = FUNCTIONS[t.value]
        if (!spec) throw new Error(`未知函数：${t.value}`)
        if (args.length !== spec.args) throw new Error(`函数 ${t.value} 需要 ${spec.args} 个参数`)
        return { kind: 'call', name: t.value, series: spec.series, args }
      }
      return { kind: 'ident', value: t.value }
    }
    throw new Error(`公式语法错误：${t.value}`)
  }

  const ast = parseExpr()
  if (pos < tokens.length) throw new Error('公式有多余内容')
  return ast
}

// ── 求值 ────────────────────────────────────────────────────────────────────

function safeDiv(a, b) {
  return b === 0 || !Number.isFinite(b) ? 0 : a / b
}

/** 行级求值（ma/delta 出现在行级上下文时报错）。 */
function evalRow(node, values) {
  switch (node.kind) {
    case 'num': return node.value
    case 'ident': {
      const v = values[node.value]
      return typeof v === 'number' && Number.isFinite(v) ? v : 0
    }
    case 'neg': return -evalRow(node.value, values)
    case 'bin': {
      const a = evalRow(node.left, values)
      const b = evalRow(node.right, values)
      switch (node.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/': return safeDiv(a, b)
        case '%': return b === 0 ? 0 : a % b
        default: return 0
      }
    }
    case 'call': {
      if (node.series) throw new Error(`${node.name}() 只能作为公式整体使用（序列函数）`)
      if (node.name === 'pct') return safeDiv(evalRow(node.args[0], values), evalRow(node.args[1], values)) * 100
      if (node.name === 'perSec') {
        const ms = evalRow(node.args[1], values)
        return ms > 0 ? evalRow(node.args[0], values) / (ms / 1000) : 0
      }
      throw new Error(`未知函数：${node.name}`)
    }
    default: throw new Error('公式节点未知')
  }
}

/** 序列级求值：rows = values 对象数组，返回数值数组（ma/delta 在此实现）。 */
function evalSeries(ast, rows) {
  if (ast.kind === 'call' && ast.series) {
    const inner = evalSeries(ast.args[0], rows)
    if (ast.name === 'delta') {
      return inner.map((v, i) => (i === 0 ? 0 : v - inner[i - 1]))
    }
    // ma(x, n)
    let n = 1
    const nArg = ast.args[1]
    if (nArg.kind === 'num' && nArg.value >= 1) n = Math.round(nArg.value)
    return inner.map((_, i) => {
      const start = Math.max(0, i - n + 1)
      let sum = 0
      for (let j = start; j <= i; j++) sum += inner[j]
      return sum / (i - start + 1)
    })
  }
  return rows.map((values) => evalRow(ast, values))
}

/** 编译公式 → {evalSeries(rows)}。compile 期做语法校验。 */
function compileFormula(src) {
  const ast = parse(String(src || ''))
  return { evalSeries: (rows) => evalSeries(ast, rows) }
}

module.exports = { tokenize, parse, evalRow, evalSeries, compileFormula, FUNCTIONS }
