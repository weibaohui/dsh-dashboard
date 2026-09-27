# dsh-dashboard 图表类型选型分析报告

> 2026-09-27。目标：把 ECharts 的图类库与我们手里真实拥有的数据做一次系统性的匹配，
> 回答三个问题——①现有 11 种卡片覆盖了哪些；②还有哪些图类**准确**适配我们的数据；
③哪些需要补采集才能画。结论先行：**可新增 9 种图类（7 种零采集成本），3 种需补
采样采集，4 种明确不适用**。

## 0. 选型三原则

1. **数据结构决定图类**：时间序列 → 线/柱/河流；分布 → 箱线/直方；构成 → 饼/树图/
   旭日；流向 → 桑基；多维对比 → 雷达/平行坐标。图类是数据的投影，不是装饰。
2. **感知准确性优先**：饼图超过 5 类即失真；玫瑰图（roseType）面积与数值非线性，
   只适合"大小差异悬殊"的榜；双 Y 轴慎用（我们 token 量级差 4 个数量级，堆叠面积
   图会让小序列不可见——已用分离序列规避）。
3. **卡片密度约束**：卡片最小 3×2（120px 高），复杂图（桑基/平行坐标/树图）需要
   6×6 以上大卡；小卡优先 stat/柱/线。

## 1. 我们的数据资产盘点

| 维度 | 粒度 | 字段 | 来源 |
|---|---|---|---|
| 时间 × 指标 | 日/周/月 | 28 个基础 measure（token/费用/回合/错误/重试/工具/输入/时长…） | fact.days 折叠 |
| 时间 × 模型 | 日 × provider/model | msgs/in/out/cache/decode/retries | day.byModel |
| 模型画像 | 会话期累计 | 同上 + 错误码分布 | day.byModel 聚合 |
| 供应商 → 项目 | 流 | outTok/cost（byModel key 自带 provider 段） | 实测 6 条流 |
| 时间 × 供应商 × 模型 | date × model × outTok | 143 个数据点（实测） | 同上 |
| 工具画像 | 工具 × 类别 | calls/errs/ms + errKinds{12 类} | day.byTool |
| 命令画像 | 首词 × 结果 | calls/errs | day.byCmd/byCmdErr |
| 技能/斜杠 | 名 × 计数 | — | day.bySkill/bySlash |
| 时段热度 | 星期 × 小时 | 168 格 | day.heat |
| 会话多维 | 会话 × 8 指标 | 输入/回合/tokens/时长/费用/错误/压缩/重试 | fact 聚合 |
| 错误样本 | 条 | 时间/类别/来源/文本（截 200） | fact.errors/modelErrors |
| **未采集（可补）** | 每消息速度样本 | tokens/s 逐条（现仅存 sum/count） | assistant/message |
| **未采集（可补）** | 输入长度样本 | 每条输入字符数（现仅存总和） | user/message |

## 2. ECharts 图类 × 我们数据 全量映射

### 2.1 已覆盖（11 种卡片）

| ECharts 类型 | 卡片 | 适配的数据 |
|---|---|---|
| line（含堆叠面积） | line | 全部时间序列；token 量级悬殊时用分离序列而非堆叠 |
| bar（横向条形） | bar | 榜单类：模型/工具/skill/命令/项目/重试 |
| pie（donut） | pie | 构成类：费用按模型（≤5 类不失真） |
| calendar + heatmap | calendarHeatmap | 日 token/费用热度（52 周） |
| heatmap | punchcard | 星期 × 小时工作时段 |
| —（HTML 表格） | table / sessions / errorSamples / retryCodes / insights | 明细与榜单 |

### 2.2 建议新增 P0（现有数据直接可画，零采集改动）

| 图类 | 建议卡片 | 数据结构 | 为什么准确 |
|---|---|---|---|
| **bar（竖向堆叠柱）** | stack | 日 × 模型/项目 的 in/out/cost | 堆叠**柱**比堆叠**面积**更适合离散日粒度：柱间边界清晰、单日可读、总量可比对；面积图适合连续密集序列 |
| **treemap** | treemap | 项目 → 模型 两层，值 = 费用或 outTok | 「钱花在哪」的最佳答案：面积即金额，层级即 项目⊃模型；比饼图多一个维度（饼只能单层） |
| **sunburst** | treemap 的 style 选项 | 同上 | 同数据第二种观感（环形层级），给用户选择权 |
| **sankey** | sankey | 供应商 → 项目，值 = outTok/cost（实测 6 条流） | 「供应商的钱流向哪些项目」的唯一准确表达；流向类数据用饼图/柱图都会失真 |
| **themeRiver** | themeRiver | date × model × outTok（143 点） | 多模型活跃度的"河流"观感：模型此消彼长的切换历史一眼可见；比多线折线更能表达"占据"关系 |
| **radar** | radar | 每模型六维归一：速度/错误率(反)/重试(反)/每 outTok 成本(反)/量/缓存命中 | 「模型质量对比」的正确图类：多维指标归一后叠加，一眼看出某模型"快但贵""稳但慢"；比四个独立柱状图信息密度高 4 倍 |
| **parallel** | parallel | 会话 × [输入次数/回合/tokens/时长/费用/错误率]（log 轴） | 会话多维对比：一条线一个会话，能看出"高输入低产出""长时长多错误"的形态聚类 |
| **markPoint/markLine（line 增强）** | line 选项 | 序列 max/min/avg 标注 | 异常日直接标注在趋势上（如 09-15 错误尖峰、09-14 token 峰值），不用另开图 |

### 2.3 建议新增 P1（需补采集——每消息/每输入样本 reservoir）

采集方案：fact.day 增加 `speedSamples[≤64]`（每消息 tok/s 蓄水池抽样）、
`inputLenSamples[≤64]`（每条输入字符数）、`byModel[m].speedSamples[≤32]`——
每天每模型 32 个浮点数，一年约 2MB，可承受。

| 图类 | 建议卡片 | 依赖采集 | 为什么准确 |
|---|---|---|---|
| **boxplot** | speedBox | byModel speedSamples | 「速度分布」的正确图类：p25/p50/p75 箱体 + 离群点；平均值会掩盖"有的请求 20 tok/s 有的 200"的双峰真相 |
| **candlestick** | speedCandle | 日速度分位数（min/p25/p50/p75/max → low/high/open/close 映射为 min/p25/p75/max） | 速度的"日 K 线"：实体 = IQR，影线 = 极值，连续看波动趋势 |
| **bar（直方图，分箱）** | inputHist | inputLenSamples | 输入长度分布：能看出"大量短命令 + 少量巨型上下文"的双峰；平均数完全表达不了 |

### 2.4 明确不适用（避免过度设计）

| 图类 | 不用理由 |
|---|---|
| gauge | 单 KPI 对目标的仪表——需要"预算"概念才有意义（用户设定月预算后可作 P2：今日费用/预算）；无目标的 gauge 是装饰 |
| funnel | agent 循环不是漏斗：输入→回合→工具调用之间没有转化率语义，强行漏斗会误导 |
| graph / tree | 会话数据无网络/树状关系（项目⊃模型层级用 treemap 已覆盖） |
| pictorialBar | 纯装饰（符号柱），信息量为零，且图标语义易误读 |
| liquidFill | 额外插件依赖，gauge 已覆盖 |
| effectScatter | 异常日标注用 line 的 markPoint 更省（同图内表达，不分裂卡片） |

## 3. 既有卡片的准确性改进（不加新图类）

| 卡片 | 改进 | 价值 |
|---|---|---|
| line | `options.logAxis`（Y 轴对数） | inTok 动辄 4.5B，把 outTok（百万级）压成贴地线——对数轴让多序列同图可读 |
| line | markLine 均值线 + markPoint 峰值标注 | 异常日（09-14 ×380）一眼可见 |
| line/bar | dataZoom 滑块（range ≥ 90 天时自动加） | 长区间先总览后放大 |
| bar | 双 measure 堆叠（如 toolCalls + toolErrors 同柱） | 调用量与报错量同柱对比 |
| pie | >8 类自动折叠「其他」+ 标签外置防重叠 | 类别多时不糊 |
| table | 列排序（点表头） | 明细表基本操作 |

## 4. 采集与实现清单

| 项 | 改动点 | 量级 |
|---|---|---|
| stack / treemap / sunburst / sankey / themeRiver / radar / parallel 卡片 | fold 增加 `groupBy: 'project_model'` 聚合 + client 七个渲染体 + 预设页改版 | 各 ~80-150 行，无采集改动 |
| 速度/输入长度 reservoir 采集 | fold：foldSession 内蓄水池（每模型 32 / 每天 64）+ SUM 之外单存；/api/speed-dist 端点 | ~60 行采集 + 查询 |
| boxplot / candlestick / inputHist 卡片 | client 分位数计算 + 三个渲染体 | ~200 行 |
| gauge + 预算设置 | pricing 页加预算字段 + gauge 渲染体 | ~80 行 |
| line 增强（logAxis/markPoint/dataZoom） | LineBody 选项 + 自动 dataZoom | ~40 行 |

## 5. 推荐落地顺序

1. **第一批（零采集，价值最高）**：stack 堆叠柱、treemap/sunburst、sankey、radar、themeRiver、line 增强（logAxis + markPoint）
   ——覆盖「钱与量去哪了」「模型质量对比」「供应商流向」三个当前完全缺失的分析视角
2. **第二批（补 reservoir 采集）**：boxplot 速度分布、candlestick 速度日 K、inputHist 输入长度分布
3. **第三批（需要新概念）**：gauge + 预算设置、parallel 会话多维对比
