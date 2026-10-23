# AGENTS.md — 行程参考图转可编辑 HTML 模板：Agent 执行规程

本文件是给 AI 编程 agent（Claude Code / Codex CLI 等）的操作规程。当用户要求
"把 input 下的模板文件夹做成可编辑网页模板"时，按本规程执行。单页提取命令
参考 `docs/wiki/manual-extract.md`；双页输入与 HTML 交付要求以本文件为准。

## 任务定义

输入：`input/` 下用户指定的一个模板文件夹（如 `input/<模板名>/`），文件夹内
固定包含两张参考图片，文件名与页面含义如下：

| 文件 | 页面含义 | 对应网页模板 |
| --- | --- | --- |
| `000.png` | 行程规划总览页 | 总览页 HTML 模板（`overview/preview.html`） |
| `001.png` | 行程规划单日页 | 单日页 HTML 模板（`daily/preview.html`） |

必须同时读取两张图片，分别还原两类页面，并保持参考图中的共同视觉样式。
任意一张图片缺失或无法读取时，报告具体路径与原因，不得猜测页面内容或只交付
其中一类页面。

输出：一个包含上述两类 **HTML 网页模板**的可编辑模板包，默认放在
`output/<模板名>/`（用户指定输出目录时按其要求）。目录结构如下：

```text
<输出目录>/
  overview/                 # 对应 000.png：行程规划总览页
    preview.html            # 可在浏览器中查看的 HTML 网页模板
    template.json           # 布局与样式
    content.json            # 可编辑文案
    assets/                 # 照片、复杂图标等素材
    preview.png
    diff.png
    overlay.png
    report.json
    ...                     # CLI 生成的其他配套文件
  daily/                    # 对应 001.png：行程规划单日页，产物同上
```

最终结果必须包含总览页和单日页的 HTML，而非只提供 JSON 或预览图片。主要文字
必须为真实文本节点，支持编辑各页 `content.json` 后重渲染；全程
**不调用任何外部模型 API**。

还原目标：两类网页在各自参考图的原始画布尺寸下，应分别与 `000.png`、`001.png`
视觉一致，包括布局、文字内容、字体字号、颜色、间距、背景装饰及图片位置与裁剪。
不得用整页截图代替网页，也不得仅做风格相似的页面；剩余差异必须在交付报告中说明。

## 标准工作流（有视觉能力的 agent）

先检查模板文件夹中两张参考图是否齐全。当前 CLI 按单张图片处理，必须对两类
页面分别执行第 1～5 步，最后在第 6 步汇总交付；每步的命令都必须真实运行，
不得凭空编造输出。以下命令中的占位符按本表替换，不能把文件夹直接传给单图命令：

| 占位符 | 总览页 | 单日页 |
| --- | --- | --- |
| `<输入图片>` | `input/<模板名>/000.png` | `input/<模板名>/001.png` |
| `<页面类型>` | `overview` | `daily` |
| `<页面输出目录>` | `<输出目录>/overview` | `<输出目录>/daily` |

两页各自使用 `.agent/<页面类型>/` 保存中间产物，不得覆盖或混用提示词与 spec。

### 第 1 步：生成尺寸锚定提示词（必须）

```powershell
npx tsx src/cli.ts prompt <输入图片> --output .agent/<页面类型>/prompt.txt
```

读取该页的 `.agent/<页面类型>/prompt.txt`，记下其中"画布实际尺寸是 W × H 像素"。
**硬约束：每页尺寸只能来自该页 prompt 命令的输出，禁止手写、估算或套用另一页尺寸。**
该页 SceneSpec 的 canvas 与所有元素坐标都必须使用这对尺寸。

### 第 2 步：读图并生成 SceneSpec

1. 用读图能力查看两张参考图，确认总览页与单日页的结构，再分别描述当前页面。
2. 按当前页 `.agent/<页面类型>/prompt.txt` 中的规则与 JSON Schema，构造 SceneSpec：
   - 每个独立标题/段落/标签/时间/编号 = 一个 text 元素（正文写进 `text` 字段）；
   - 照片与复杂图标 = image 元素（`src` 留空 `""`）；
   - 背景/线条/边框/底色 = box 元素；
   - 逐字转录可见文字，不改写不纠错；不确定项写进 notes。
3. 写入 `.agent/<页面类型>/spec.json`（UTF-8，无 BOM）。

### 第 3 步：快速校验（不跑提取，秒级反馈）

```powershell
npx tsx src/cli.ts validate-spec .agent/<页面类型>/spec.json <输入图片>
```

- 退出码 0：通过（stdout 有元素统计）。进入第 4 步。
- 退出码 1：失败。stderr 的消息带具体路径与原因（如
  `[OUT_OF_CANVAS] elements[3]: 元素 hotel_name 下边界越出画布：y=2300 + height=60 > 2339`）。
  **只修复消息点名的元素**，不要重写整个 spec，改完重新执行本步。

**迭代上限：每页校验修复最多 5 轮。** 连续失败 5 轮则停止，向用户报告页面类型与
剩余错误原文，不得将不完整模板包报告为已完成。

### 第 4 步：提取页面模板并生成 HTML

```powershell
npx tsx src/cli.ts extract <输入图片> <页面输出目录> --spec .agent/<页面类型>/spec.json
```

该命令自动完成校验、正文分离（text→content.json）、素材裁剪（image 坐标→
assets/*.png）、网页生成与渲染（preview.html/preview.png）、与该页原图对比
（diff.png/overlay.png）。退出码非 0 时读 stderr 修复（同第 3 步规则），重跑本步。
修复或调优后需要覆盖当前页面的既有受管产物时，为本步命令追加 `--overwrite`。

### 第 5 步：视觉自检（有视觉能力时）

1. 在浏览器中打开 `<页面输出目录>/preview.html`，核对页面与对应参考图的文字、
   排版及素材；读取 `preview.png` 与 `diff.png`，红/黄密集区域 = 偏差大的位置。
2. 读 `<页面输出目录>/report.json` 的 `comparison.regionScores`
   （header/timeline/photos/sidebar 四个区域的 mismatchRatio；这是辅助指标，
   **不是还原率**）。
3. 若某主要区域明显偏差（如 diff 图显示标题块整体偏移）：只调整对应元素的
   坐标、尺寸或样式字段后回到第 3 步，校验通过后重跑第 4 步生成 HTML 与对比产物。

**迭代上限：每页视觉调优最多 3 轮。** 每轮只改出问题的元素。按任务定义逐页检查
视觉一致性，不以单一分数代替验收；达到上限仍有明显差异时，说明页面与具体差异，
不得宣称已与参考图一致。

### 第 6 步：交付报告

向用户报告：

- 模板文件夹名称、两张参考图路径、输出目录路径与产物清单；
- 总览页与单日页各自的 HTML 入口（`overview/preview.html`、`daily/preview.html`）；
- 分别列出两页的元素统计（text/image/box 数量）；
- 分别列出两页的全页 mismatchRatio 与四个区域分数（注明"辅助指标，非还原率"）；
- 两页 report.json 中剩余的 reviewItems，以及尚未消除的视觉差异；
- 说明后续改文案只需编辑对应页面的 content.json + 重跑 render（不需要模型）：

```powershell
npx tsx src/cli.ts render <输出目录>/overview
npx tsx src/cli.ts render <输出目录>/daily
```

## 降级工作流（无视觉能力的 agent）

若你无法读取图片：**不要编造 spec**。改为执行用户已按
`docs/wiki/manual-extract.md` 步骤 1～3 为两张参考图分别准备好的 spec 文件。
缺少任一页 spec 时，报告缺失项，不得编造或复制另一页的 spec：

1. `validate-spec` 校验用户给的 spec；
2. 失败 → 按错误消息修复（错误修复不需要视觉）；
3. 两页分别通过 → 执行第 4～6 步中的程序命令并汇总报告；明确说明未进行视觉自检，
   不得仅凭比较分数宣称网页与参考图视觉一致。

## 硬约束（任何情况下不可违反）

1. **每页画布尺寸只来自对应 prompt 命令输出**；禁止手写、估算、从文件名猜或混用。
2. **禁止把整页或包含大段文字的区域做成 image**（用截图伪装还原）。
3. **禁止同一文字既出现在 text 又被裁进图片**。
4. **SceneSpec 中间输入只产出数据（JSON），最终交付必须包含 HTML 网页模板**；
   HTML/CSS 由本仓库 CLI 根据 JSON 生成，CLI 不执行模型返回的代码/HTML/CSS。
   提取与视觉调优时不要绕过 CLI 直接修改模板包产物，应修订 spec 后重新提取；
   后续改文案可编辑对应页面的 content.json 并运行 render。
5. **失败即报**：校验/提取失败必须把真实错误转达用户或定点修复，
   不得删除报错元素来"通过"（丢内容不是修复）。
6. **每页迭代上限**：校验修复 5 轮、视觉调优 3 轮；超限停止并如实报告。
7. spec 是一次性输入：提取成功后两页模板包分别自洽（template/content/assets），
   后续重渲染不依赖 `.agent/<页面类型>/spec.json`。
8. **两类页面必须齐全且分别对应原图**；不得把总览页当作单日页、合并两张参考图
   为一个页面，或遗漏其中一类 HTML 模板。

## 环境

- Node ≥ 20；命令统一在仓库根目录执行；Windows 下 PowerShell 语句分隔用 `;`。
- `.agent/` 为工作目录（spec 与提示词中间产物），不要提交到 git。
- 完整命令参考：`npx tsx src/cli.ts --help`；人类手册：`docs/wiki/manual-extract.md`。
