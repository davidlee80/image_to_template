# AGENTS.md — 图片转可编辑模板：Agent 执行规程

本文件是给 AI 编程 agent（Claude Code / Codex CLI 等）的操作规程。当用户要求
"把某图片做成可编辑模板"时，按本规程执行。人类操作者的对应手册是
`docs/wiki/manual-extract.md`（流程同构，本文件是其自动化版本）。

## 任务定义

输入：一张页面图片（如 `input/travel_plan_page_0005.png`）。
输出：可编辑模板包（`<输出目录>/`：template.json + content.json + assets/ +
preview.png + diff.png + report.json 等），主要文字为真实文本节点、可改文案
重渲染，且全程**不调用任何外部模型 API**。

## 标准工作流（有视觉能力的 agent）

按顺序执行；每步的命令都必须真实运行，不得凭空编造输出。

### 第 1 步：生成尺寸锚定提示词（必须）

```powershell
npx tsx src/cli.ts prompt <输入图片> --output .agent/prompt.txt
```

读取 `.agent/prompt.txt`，记下其中"画布实际尺寸是 W × H 像素"。
**硬约束：这对尺寸只能来自该命令的输出，禁止手写或估算。**
你的 SceneSpec 的 canvas 与所有元素坐标都必须使用这对尺寸。

### 第 2 步：读图并生成 SceneSpec

1. 用读图能力查看输入图片。
2. 按 `.agent/prompt.txt` 中的规则与 JSON Schema，在上下文中构造 SceneSpec：
   - 每个独立标题/段落/标签/时间/编号 = 一个 text 元素（正文写进 `text` 字段）；
   - 照片与复杂图标 = image 元素（`src` 留空 `""`）；
   - 背景/线条/边框/底色 = box 元素；
   - 逐字转录可见文字，不改写不纠错；不确定项写进 notes。
3. 写入 `.agent/spec.json`（UTF-8，无 BOM）。

### 第 3 步：快速校验（不跑提取，秒级反馈）

```powershell
npx tsx src/cli.ts validate-spec .agent/spec.json <输入图片>
```

- 退出码 0：通过（stdout 有元素统计）。进入第 4 步。
- 退出码 1：失败。stderr 的消息带具体路径与原因（如
  `[OUT_OF_CANVAS] elements[3]: 元素 hotel_name 下边界越出画布：y=2300 + height=60 > 2339`）。
  **只修复消息点名的元素**，不要重写整个 spec，改完重新执行本步。

**迭代上限：校验修复最多 5 轮。** 连续失败 5 轮则停止，向用户报告剩余错误原文。

### 第 4 步：提取模板包

```powershell
npx tsx src/cli.ts extract <输入图片> <输出目录> --spec .agent/spec.json
```

该命令自动完成校验、正文分离（text→content.json）、素材裁剪（image 坐标→
assets/*.png）、渲染（preview.png）、与原图对比（diff.png/overlay.png）。
退出码非 0 时读 stderr 修复（同第 3 步规则），重跑本步。

### 第 5 步：视觉自检（有视觉能力时）

1. 读 `<输出目录>/diff.png`：红/黄密集区域 = 偏差大的位置。
2. 读 `<输出目录>/report.json` 的 `comparison.regionScores`
   （header/timeline/photos/sidebar 四个区域的 mismatchRatio；这是辅助指标，
   **不是还原率**）。
3. 若某主要区域明显偏差（如 diff 图显示标题块整体偏移）：只调整对应元素的
   x/y/width/height 后回到第 3 步（validate-spec 再快速确认没改坏）。

**迭代上限：视觉调优最多 3 轮。** 不追求零差异；主要文字位置正确、照片框对齐
即为可交付。每轮调优只改出问题的元素。

### 第 6 步：交付报告

向用户报告：
- 输出目录路径与产物清单；
- 元素统计（text/image/box 数量）；
- 全页 mismatchRatio 与四个区域分数（注明"辅助指标，非还原率"）；
- report.json 中剩余的 reviewItems（如文字与图片相交的复查项）；
- 说明后续改文案只需编辑 content.json + 重跑 render（不需要模型）。

## 降级工作流（无视觉能力的 agent）

若你无法读取图片：**不要编造 spec**。改为执行用户已按
`docs/wiki/manual-extract.md` 步骤 1～3 准备好的 spec 文件：

1. `validate-spec` 校验用户给的 spec；
2. 失败 → 按错误消息修复（错误修复不需要视觉）；
3. 通过 → 执行第 4～6 步（提取/对比/报告全部是程序命令）。

## 硬约束（任何情况下不可违反）

1. **画布尺寸只来自 prompt 命令输出**；禁止手写、估算或从文件名猜。
2. **禁止把整页或包含大段文字的区域做成 image**（用截图伪装还原）。
3. **禁止同一文字既出现在 text 又被裁进图片**。
4. **只产出数据（JSON）**；本仓库 CLI 不执行模型返回的任何代码/HTML/CSS，
   你也不要绕过 CLI 直接改模板包产物。
5. **失败即报**：校验/提取失败必须把真实错误转达用户或定点修复，
   不得删除报错元素来"通过"（丢内容不是修复）。
6. **迭代上限**：校验修复 5 轮、视觉调优 3 轮；超限停止并如实报告。
7. spec 是一次性输入：提取成功后模板包自洽（template/content/assets），
   后续重渲染不依赖 .agent/spec.json。

## 环境

- Node ≥ 20；命令统一在仓库根目录执行；Windows 下 PowerShell 语句分隔用 `;`。
- `.agent/` 为工作目录（spec 与提示词中间产物），不要提交到 git。
- 完整命令参考：`npx tsx src/cli.ts --help`；人类手册：`docs/wiki/manual-extract.md`。
