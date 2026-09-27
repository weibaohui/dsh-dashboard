import { test } from 'node:test'
import assert from 'node:assert/strict'
import formula from '../client/formula.js'

test('基础算术与优先级', () => {
  const f = formula.compileFormula('1 + 2 * 3')
  assert.equal(f.evalSeries([{}])[0], 7)
  const g = formula.compileFormula('(1 + 2) * 3')
  assert.equal(g.evalSeries([{}])[0], 9)
  const h = formula.compileFormula('-2 + 10')
  assert.equal(h.evalSeries([{}])[0], 8)
})

test('除零与缺指标得 0，不抛错', () => {
  const f = formula.compileFormula('outTok / inTok')
  assert.equal(f.evalSeries([{ outTok: 10, inTok: 0 }])[0], 0)
  assert.equal(f.evalSeries([{}])[0], 0)
  const m = formula.compileFormula('5 % 0')
  assert.equal(m.evalSeries([{}])[0], 0)
})

test('pct / perSec', () => {
  const p = formula.compileFormula('pct(turnsError, turns)')
  assert.equal(p.evalSeries([{ turnsError: 3, turns: 12 }])[0], 25)
  const s = formula.compileFormula('perSec(decodeTok, decodeMs)')
  assert.equal(s.evalSeries([{ decodeTok: 200, decodeMs: 2000 }])[0], 100)
  assert.equal(s.evalSeries([{ decodeTok: 200, decodeMs: 0 }])[0], 0)
})

test('组合表达式', () => {
  const f = formula.compileFormula('pct(cacheReadTok, cacheReadTok + inTok)')
  assert.equal(f.evalSeries([{ cacheReadTok: 300, inTok: 700 }])[0], 30)
  const g = formula.compileFormula('outTok * 2 + inTok')
  assert.equal(g.evalSeries([{ outTok: 100, inTok: 50 }])[0], 250)
})

test('序列函数 delta / ma', () => {
  const d = formula.compileFormula('delta(outTok)')
  assert.deepEqual(d.evalSeries([{ outTok: 10 }, { outTok: 15 }, { outTok: 12 }]), [0, 5, -3])
  const m = formula.compileFormula('ma(outTok, 3)')
  assert.deepEqual(m.evalSeries([{ outTok: 3 }, { outTok: 6 }, { outTok: 9 }]), [3, 4.5, 6])
  const nested = formula.compileFormula('ma(pct(turnsError, turns), 2)')
  const rows = [{ turnsError: 1, turns: 10 }, { turnsError: 2, turns: 10 }]
  assert.deepEqual(nested.evalSeries(rows), [10, 15])
})

test('语法错误抛错', () => {
  assert.throws(() => formula.compileFormula('1 +'))
  assert.throws(() => formula.compileFormula('foo(1, 2)')) // 未知函数
  assert.throws(() => formula.compileFormula('pct(a)')) // 参数个数
  assert.throws(() => formula.compileFormula('(1 + 2'))
  assert.throws(() => formula.compileFormula('1 ? 2'))
  assert.throws(() => formula.compileFormula('ma(outTok) @ 2')) // 多余内容
})

test('行级上下文使用 ma 抛错', () => {
  const ast = formula.parse('ma(outTok, 2)')
  assert.throws(() => formula.evalRow(ast, {}), /序列函数/)
})
