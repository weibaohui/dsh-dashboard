# @weibaohui/dsh-dashboard

[![DSH plugin](https://img.shields.io/badge/dsh-plugin-green)](https://github.com/topics/dsh-plugin)
[![npm version](https://img.shields.io/npm/v/@weibaohui/dsh-dashboard)](https://www.npmjs.com/package/@weibaohui/dsh-dashboard)
[![CI](https://github.com/weibaohui/dsh-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/weibaohui/dsh-dashboard/actions/workflows/ci.yml)

**使用量仪表盘**：离线扫描本机全部 dsh 会话日志，把每天/每周/每月的 token 用量、估算费用、模型/工具/技能/命令榜、输出速度、工作时段与质量错误做成可编排的 Dashboard——gridstack 拖拽卡片 + ECharts 图表 + GitHub 同款日历热力图，支持自定义公式、AI 编排整页配置，不监听任何运行时事件、全部统计在本地完成。

## 效果演示

![demo：七个预设页巡游 + 会话下钻（17s 循环）](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/demo.gif)

| | | |
|---|---|---|
| ![概览](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/shots/overview.png) | ![Token 与费用](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/shots/cost.png) | ![模型与质量](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/shots/quality.png) |
| *概览：四统计卡 + 热力图 + 趋势 + 模型榜* | *Token 与费用：趋势/构成/命中率/明细* | *模型与质量：速度/错误率/明细/重试榜* |
| ![命令与技能](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/shots/tools.png) | ![工作时段与会话](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/shots/work.png) | ![错误分析](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/shots/errors.png) |
| *命令与技能：四类调用榜* | *工作时段热力图 + 会话明细* | *专项洞察 + 错误码分类 + 聚簇* |
| ![输入与时长](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/shots/input.png) | ![会话下钻](https://cdn.jsdelivr.net/gh/weibaohui/dsh-dashboard@main/docs/shots/drill.png) | |
| *输入与时长：次数/长度/运行时长* | *会话下钻：单会话完整画像* | |

## 核心功能

- **六个出厂预设页**：概览（四统计卡 + 52 周热力图 + token 趋势 + 模型榜）、Token 与费用、模型与质量、命令与技能、工作时段与会话、错误分析——装上即有完整 Dashboard
- **深度错误分析**：供应商 × 错误码分类表（限流/配额、服务端 5xx、超时、空响应、传输——宿主重试策略自带分类学）、错误聚簇 Top（归一化计数，如「429 请求频率过高」×162）、错误样本表、异常日排行（回合错误率）、工具报错榜
- **专项洞察**：Token 异常日（相对中位数倍数）、最贵会话、错误最多会话、重试风暴（按供应商）、慢工具榜（平均耗时）、命令失败率（按 bash 首词分类）、上下文压缩大户
- **三级下钻**：热力图点某天 → 当日明细（会话/工具/技能/命令/错误/小时热度）；模型榜点某模型 → 模型画像（逐日趋势/速度/重试/费用/Top 会话）；会话行点某行 → 会话画像（按天分解/模型分布/工具统计/错误样本）
- **输出速度精确计量**：每条 assistant 消息内嵌流式 chunk 时序（delta 时间戳数组），解码窗口首尾相减得 tokens/s——按模型/按日出 p50 级精度，而非粗糙估算
- **估算费用**：内置常见模型占位价格表，按模型 × in/out/缓存读写单价换算，UI 明示「估算」并列出未定价模型；价格表可视化编辑
- **可编排**：gridstack 拖拽/缩放、加卡片、建页/改名/删页，布局与卡片配置即 JSON 自动持久化
- **22 种图类**：堆叠柱、矩形树图（项目→模型构成）、旭日图、桑基流向图、主题河流、雷达（模型质量五维）、平行坐标（会话多维）、箱线图（速度分布）、K 线（每日速度区间）、直方图（输入长度分布）、费用预算仪表盘
- **自定义公式**：卡片支持安全表达式（Pratt 解析器，禁 eval）——`pct(cacheReadTok, cacheReadTok + inTok)`、`perSec(decodeTok, decodeMs)`，序列函数 `ma(x,n)` 移动平均、`delta(x)` 环比
- **AI 编排**：描述需求 → 生成带指标目录与 JSON Schema 的提示词 → 交给任意 agent 会话 → 返回 JSON 一键导入，宿主按 Schema + 指标白名单双校验，坏配置进不来
- **入口可选**：默认左侧栏 Global panels 最上方（完整主面板形态）；⚙ 设置里可切换为设置页内 / 两者都显示
- **性能自律**：多帧 zstd 逐帧解压（结构化扫帧，不用一次性解压 API 防静默截断）、mtime 增量扫描日常秒级、事实表内存缓存 + storage 持久化、零 npm 运行时依赖

## 安装

```bash
dsh plugin --profile web add @weibaohui/dsh-dashboard -w
```

装完重启 `dsh web` 即生效，启动后自动增量扫描 `~/.dsh/sessions`。入口：**左侧栏最上方 📊 仪表盘**（⚙ 设置里可切换为设置页内 / 两者）。

## 使用

1. 装上即有**六个出厂预设页**：概览 / Token 与费用 / 模型与质量 / 命令与技能 / 工作时段与会话 / 错误分析，页签直接切换
2. **编辑布局**：进入编辑模式拖拽/缩放卡片、加卡片、新建页/改名/删页，改动自动保存
3. **下钻**：热力图点某一天、模型榜点某个模型、会话表点某一行、洞察条目点击——逐级从总览定位到单个会话
4. **AI 编排**：设置 → AI 编排新页面 → 描述需求生成提示词 → 交给任意 dsh agent 会话 → 把返回 JSON 粘回导入
5. **费用**：默认按内置价格表估算；设置 → 编辑价格表按模型调整单价（每 M token，含缓存读写）；⚙ 设置里可设月预算，Token 与费用页的预算仪表盘实时显示达成率
6. **扫描**：启动自动增量扫描（按文件 mtime 跳过）；设置里可手动增量重扫 / 全量重扫
7. **自定义公式**：卡片编辑器填公式（优先于指标），支持 `pct(a,b)`、`perSec(tokens,ms)`、序列级 `ma(x,n)`、`delta(x)`
8. **输入与时长分析**：输入次数/字符量趋势、平均输入长度、会话运行时长排行、子代理调用量

## 页面 → 板块

| 预设页 | 卡片 |
|---|---|
| 概览 | 今日费用/tokens/活跃会话/平均速度四卡 · GitHub 同款热力图 · 每日 token 趋势 · 模型榜 |
| Token 与费用 | 每日费用趋势 · 费用构成饼图 · 缓存命中率（公式卡） · 按模型明细表 |
| 模型与质量 | 输出速度趋势（按模型） · 回合错误率 · 模型质量明细 · 重试榜 |
| 命令与技能 | shell 命令榜 · skill 调用榜 · 工具调用榜 · 斜杠命令榜 |
| 工作时段与会话 | 星期 × 小时热力图 · 最近会话表 · 回合与错误趋势 · 项目榜 |
| 错误分析 | 专项洞察 · 错误趋势 · 供应商 × 错误码 · 错误样本与聚簇 · 工具报错榜 |
| 输入与时长 | 输入次数/运行时长统计卡 · 输入趋势 · 平均输入长度 · 直方图 · 会话明细 |

## 卡片配置 schema（页面 JSON）

页面配置即 JSON（gridstack 布局 + 卡片定义），存宿主 storageDomain；手排、AI 排都是改这份 JSON。

```js
{
  id: 'overview', title: '概览', cols: 12,
  layout: [{ i: 'ov-today-cost', x: 0, y: 0, w: 3, h: 2 }, …],
  cards: {
    'ov-today-cost': {
      type: 'stat',              // stat|line|bar|pie|table|calendarHeatmap|punchcard|sessions
                                 // errorSamples|retryCodes|insights|stack|treemap|sunburst
                                 // sankey|themeRiver|radar|parallel|boxplot|candle|histogram|gauge
      title: '今日估算费用',
      query: {
        measures: ['cost'],      // 指标名（见 /api/catalog 指标目录）
        granularity: 'day',      // day | week | month
        range: 'today',          // today | 7 | 30 | 90 | 365 | all
        groupBy: '',             // model|tool|skill|cmd|slash|project|session|''
        scope: 'all',            // all 含子代理 | top 仅顶层会话
        project: '',             // 按项目名过滤
      },
      options: { unit: 'USD', top: 8, stack: true },
    },
  },
}
```

### 指标目录（measures）

`msgs` 模型响应数 · `inTok/outTok/cacheReadTok/cacheWriteTok/totalTok` · `turns/turnsError` 等 · `retries/retryExhausted` · `toolCalls/toolErrors/toolMs` · `llmMs/decodeMs/decodeTok` · `speed` 输出速度 · `sessions/skills/cmds/slashCmds` · `cost` 估算费用 · `errorRate` 回合错误率

### 公式

```
算子   + - * / % ( )，数字字面量，除零得 0
行级   pct(a,b) = a/b*100      perSec(tokens, ms) = 每秒速率
序列   delta(x) = 环比差        ma(x, n) = n 期移动平均
示例   pct(cacheReadTok, cacheReadTok + inTok)      缓存命中率
       perSec(decodeTok, decodeMs)                  输出速度 tok/s
       pct(turnsError, turns)                       回合错误率 %
```

## 指标 → 数据源

| 指标 | 日志事件 | 说明 |
|---|---|---|
| token 用量 | `assistant/message` 的 `usage` | inputTokens 按请求累计，与账单同口径；部分 provider 另报 cacheRead/Write |
| 模型 / 速度 | 同上 `message.source` + `stream[].dt` | 逐 chunk delta 时序首尾相减得解码窗口；速度 = decodeTok/decodeMs |
| LLM 重试分类 | `llm/retry` | 宿主自带错误码：RATE_LIMIT/SERVER/TIMEOUT/EMPTY_RESPONSE/TRANSPORT + 原始 message + delayMs |
| 回合错误 | `turn/end` 的 `reason.kind/error.message` | completed/error/aborted/interrupted/max-tokens/user 七种 + 错误文本归类 |
| 工具 / 报错 | `tool/call` + `tool/result`（callId 配对） | 调用数、耗时、`isError` 分类（权限/不存在/命令失败/超时…） |
| skill 调用 | `tool/call` name=skill | `arguments.name` 计数 |
| shell 命令 | `tool/call` name=bash | `arguments.command` 首词分类，只存类别 + 计数不存原文 |
| 工作时段 | 全事件 `time` | 本地时区 星期 × 小时 168 格热度 |
| 会话 | session 头 + `turn/*`、`user/message` | 每项目会话数/回合数；`delegationDepth` 区分子代理 |

## 实现说明

```
离线扫描器（host）                          查询层                        展示层（client）
─────────────────────                      ────────────────              ─────────────────
~/.dsh/sessions/**/*.zstd                  /api/catalog 指标目录          gridstack 拖拽网格
  ↓ 结构化扫帧 + 逐帧 zstdDecompressSync    /api/cube   立方体聚合         ECharts 八类 + 三专项卡片
事件流 ──fold──▶ 事实表(会话×日)            /api/summary /sessions         calendar 热力图 / punchcard
  │           └─▶ storage 域持久化          /api/errors /insights          公式求值器（Pratt 解析）
  ▼ mtime 增量                              /api/day|model|session 下钻    settings.section + 侧边栏入口
 FactsById 内存缓存                         /api/pages /pricing /config    布局+卡片 JSON 持久化
```

- **扫描器**：会话日志是「多帧 zstd 拼接容器」（宿主每批次 append 一帧），node:zlib 的一次性解压与解压流都只解第一帧——必须结构化扫帧（按帧格式跳步，不解压块）后逐帧 `zstdDecompressSync`；按文件 mtime 增量，130 个文件全量 4s
- **事实表**：每行 = 会话 × 本地日，聚合出全部榜单与趋势；`storageDomain`（域 `dsh_dashboard`）持久化 + 内存缓存；存储域打开失败（如重启窗口期被占用）自动退化内存模式并在 `/api/status` 标注
- **host**：`inject ['webServer','connection','storageDomain']`，全部路由走 `connection.requestRejection` 信任栅栏；配置（页面/价格表/入口）与事实同域分表
- **client**：`slots` 双入口挂载——`sidebar.panellist`（order -100 置顶图标）+ `main` 主面板（`variant:'panel'`，JS 钉高使 wrap 自身滚动），`settings.section`（`variant:'settings'`，跟随弹窗滚动）；ECharts + gridstack 由 esbuild 构建期内联，React 是宿主平台模块
- **响应头**：全部 API 带 `Cache-Control: no-store`，保证写后读一致

## HTTP API（宿主）

| 路由 | 说明 |
|---|---|
| `GET /dsh-dashboard/api/status` | 扫描状态/进度/存储模式/usage 覆盖率 |
| `POST /dsh-dashboard/api/scan` | 触发扫描 `{ full?: bool }` |
| `GET /dsh-dashboard/api/catalog` | 指标目录 + 卡片类型 + 公式说明 |
| `GET /dsh-dashboard/api/cube` | 立方体聚合 `?granularity&range&groupBy&scope&project` |
| `GET /dsh-dashboard/api/summary` | 今日/7 天/30 天/累计汇总 |
| `GET /dsh-dashboard/api/sessions` | 会话明细行（按最近活动排序） |
| `GET /dsh-dashboard/api/heat` | 星期 × 小时热度（168 格） |
| `GET /dsh-dashboard/api/errors` | 错误专项：分类/聚簇/趋势/样本 |
| `GET /dsh-dashboard/api/insights` | 专项洞察（异常日/最贵会话/慢工具/命令失败率…） |
| `GET /dsh-dashboard/api/day/:date` | 单日下钻（会话/工具/错误/小时热度） |
| `GET /dsh-dashboard/api/model/:model` | 模型下钻（逐日趋势/错误码/Top 会话） |
| `GET /dsh-dashboard/api/session/:id` | 会话下钻（完整单会话画像） |
| `GET /dsh-dashboard/api/projects` | 项目列表 |
| `GET|PUT /dsh-dashboard/api/pages` | 页面配置 CRUD（Schema 校验） |
| `POST /dsh-dashboard/api/pages/validate` | 单页校验（AI 导入用） |
| `POST /dsh-dashboard/api/pages/import` | 校验 + 导入一个页面 |
| `POST /dsh-dashboard/api/pages/reset` | 恢复出厂预设页 |
| `GET|PUT /dsh-dashboard/api/pricing` | 模型价格表 |
| `GET|PUT /dsh-dashboard/api/config` | 界面配置（入口位置等） |
| `GET /dsh-dashboard/api/ai/prompt` | AI 编排提示词生成 |

## 开发

```bash
npm run check          # 语法检查（src + client + formula）
npm test               # 20 项离线测试（fold 分类/聚合/公式求值/下钻/校验）
npm run build:client   # esbuild 打包 echarts + gridstack + formula → client/bundle.js
```

link 安装的实例改完源码：host 改动重启 `dsh web`，client 改动 `npm run build:client` 后刷新页面即生效。

## 隐私

全部统计在本地完成；bash 命令只保留「首词分类 + 计数」，不落命令原文；错误样本截断 200 字符且仅本地存储。

## 联系我 :飞书群

![link](https://foruda.gitee.com/images/1774880015525784725/4fd67005_77493.png "link")

## 版本兼容性

本插件与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的版本对应关系：

| 插件版本 | 适配 dsh 版本 | 备注 |
|---------|--------------|------|
| 0.1.1 | 0.1.7-rc.2 | 新增输入/时长/子代理统计与 11 种新图类（堆叠柱/树图/桑基/河流/雷达/平行坐标/箱线/K线/直方/仪表），当前验证版本 |
| 0.1.0 | 0.1.7-rc.2 | 首个版本 |

> **发版约定**：每次发布新版本时，请在上表追加一行，记录该插件版本实际验证所用的 `@deepseek-ai/dsh` 版本。`package.json` 的 `engines.dsh` 声明最低支持版本；本表记录实际验证版本，二者配合使用。

## License

MIT
