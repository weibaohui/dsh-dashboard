# @weibaohui/dsh-dashboard

dsh 插件 · 使用量仪表盘：**离线扫描**会话日志，把每天/每周/每月的 token 用量、
估算费用、模型/工具/技能/命令榜、输出速度、工作时段与质量指标做成可编排的
Dashboard（gridstack 拖拽 + ECharts，GitHub 同款日历热力图）。

![dsh](https://img.shields.io/badge/dsh-0.1.7--rc.2-2563eb)

## 它能看什么

| 板块 | 内容 |
|------|------|
| 概览 | 今日费用 / tokens / 活跃会话 / 平均输出速度四卡 + 52 周热力图 + 30 天 token 趋势 + 模型榜 |
| Token 与费用 | 每日费用趋势、按模型费用构成、缓存命中率、模型明细表 |
| 模型与质量 | 各模型输出速度（tok/s）、回合错误率、质量明细（重试/错误/速度）、重试榜 |
| 命令与技能 | shell 命令榜（bash 首词分类）、skill 调用榜、工具调用榜、斜杠命令榜 |
| 工作时段与会话 | 星期 × 小时活动热力图、最近会话明细、回合与错误趋势、项目榜 |
| 错误分析 | 专项洞察（异常日/Token 异常/最贵会话/慢工具/命令失败率/错误聚簇）、错误趋势、供应商 × 错误码、错误样本表、工具报错榜 |

出厂带六个预设页，装上即有完整 Dashboard。

## 入口位置

`入口` 下拉可切换仪表盘入口显示位置：**侧边栏**（默认，置于左侧栏 Global panels
最上方）/ **设置页** / **两者**。切换后刷新页面生效。

## 下钻分析

- 热力图点击任意一天 → 当日明细（会话列表、工具/技能/命令计数、错误样本、小时热度）
- 模型榜点击某模型 → 模型详情（逐日趋势、速度、重试、费用、Top 会话）
- 会话表点击某行 → 会话画像（按天分解、模型分布、工具/技能/命令、错误样本）
- 洞察与错误样本条目可直接点击跳转对应下钻

## 数据从哪来

纯离线扫描 `~/.dsh/sessions/**/session.v*.jsonl.zstd`（多帧 zstd 容器逐帧解压，
事件 fold 成「会话 × 本地日」事实表），**不监听任何运行时事件**：

- 启动后自动增量扫描（按文件 mtime 跳过未变化文件），可手动「重扫 / 全量重扫」；
- token 口径与账单一致（inputTokens 按请求累计）；速度按 `assistant/message` 内嵌
  流式 chunk 时序精确计算；质量 = turn 结束原因分布 + llm/retry 错误码
  （限流/配额、服务端 5xx、超时、空响应、传输）+ 工具报错分类；
- 费用为**估算**：内置常见模型占位价格表，可在「价格表」里按模型改
  （in / out / 缓存读 / 缓存写，每 M token），未收录模型费用按 0 计并在表里列出；
- usage 覆盖率（无 usage 的消息占比）在扫描状态里可见，当前宿主基本 100% 覆盖。

## 编排能力

- **手排**：「编辑布局」进入 gridstack 拖拽/缩改，加卡片、删卡片、建页/改名/删页，
  自动保存（页面配置 JSON 存宿主 storageDomain）；
- **AI 排**：「AI 编排」→ 描述需求 → 生成带指标目录与 Schema 的提示词 → 交给任意
  dsh agent 会话 → 把返回的 JSON 粘回导入。host 按 Schema + 指标白名单双校验，
  坏配置进不来；
- **自定义公式**：卡片支持公式（优先于指标），如 `pct(cacheReadTok, cacheReadTok + inTok)`、
  `perSec(decodeTok, decodeMs)`，序列函数 `ma(x,n)` / `delta(x)` 可做移动平均与环比；
- **重置**：「重置」恢复出厂五页。

## 安装

```sh
dsh plugin --profile web add link:/path/to/dsh-dashboard   # 本地源码安装
# 或 npm 源
dsh plugin --profile web add @weibaohui/dsh-dashboard
```

重启宿主（`dsh web`）后在 Web UI 设置里打开「仪表盘」。

## 隐私

全部统计在本地完成；bash 命令只保留「首词分类 + 计数」，不落命令原文；
错误样本截断 200 字符且仅本地存储。

## 版本兼容性

本插件与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的版本对应关系：

| 插件版本 | 适配 dsh 版本 | 备注 |
|---------|--------------|------|
| 0.1.0 | 0.1.7-rc.2 | 当前版本，已在 @deepseek-ai/dsh@0.1.7-rc.2 下验证运行 |

> **发版约定**：每次发布新版本时，请在上表追加一行，记录该插件版本实际验证所用的
> `@deepseek-ai/dsh` 版本。`package.json` 的 `engines.dsh` 声明最低支持版本；本表记录
> 实际验证版本，二者配合使用。

## 设计文档

见仓库根目录 `dsh-dashboard-design.md`（数据源实证、指标口径、架构与选型调研）。
