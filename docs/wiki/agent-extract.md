# Agent 自动提取使用说明（agent-extract）

如何把"图片→可编辑模板"交给 AI 编程工具（Claude Code / Codex CLI 等）
自动执行。Agent 的执行规程有两份等价载体：

- 仓库根 `AGENTS.md`：Codex / Claude Code 自动读取；
- Skill 版本 `docs/skills/image-to-template/SKILL.md`：适用于 Qoder 等
  支持 Agent Skills 的工具（复制到 `.qoder/skills/` 或 `~/.qoder/skills/`
  即可被自动发现；description 含中英触发词）。

本文面向**使用者**：怎么下指令、两条使用场景、怎么验收结果。

三条提取路径的关系（产物完全相同，同一 schema 与下游管线）：

| 路径 | 识别者 | 需要 API 密钥 | 适用 |
|---|---|---|---|
| API 自动化（`extract` + OPENAI_*） | API 模型 | 是 | 无人值守批量 |
| 人工对话式（见 `manual-extract.md`） | 对话模型 + 你 | 否 | 无密钥、人工把控 |
| **Agent 自动（本手册）** | **编程工具里的模型** | **否** | **无密钥、要自动化** |

## 场景一：多模态 Agent 全自动（推荐）

适用：Claude Code 等可读图片的编程工具。

1. 把图片放进仓库（如 `input/my-page.png`）。
2. 对 agent 说一句话，例如：

   > 按 AGENTS.md 把 input/my-page.png 做成可编辑模板，输出到 output/my-page

3. Agent 会自动执行（规程见 `AGENTS.md`）：
   `prompt` 命令拿尺寸锚定 → 读图生成 SceneSpec → `validate-spec` 快速校验
   （失败自修复，上限 5 轮）→ `extract --spec` 提取 → 看 diff 图与区域分数
   调优（上限 3 轮）→ 报告产物与剩余复查项。
4. 你验收：看 `output/my-page/preview.png` 是否还原、diff 是否可接受；
   不满意就把具体问题（"标题偏下"）告诉 agent，它会按规程定点调整。

## 场景二：纯文本 Agent 半自动

适用：Codex 等暂不能读图片的工具。你完成"看图"部分，agent 完成
"执行与修复"部分：

1. 你先按 `docs/wiki/manual-extract.md` 步骤 1～3 准备 spec
   （prompt 命令 → 对话 UI 生成 → 保存 `my-spec.json`）。
2. 对 agent 说：

   > 按 AGENTS.md 的降级工作流，用 my-spec.json 把 input/my-page.png
   > 做成可编辑模板，输出到 output/my-page

3. Agent 执行：`validate-spec` 校验 → 失败按错误消息修复（错误修复不需要
   视觉，报错都带具体元素路径）→ `extract --spec` → 报告。
   校验/提取/对比/报告全部是程序命令，agent 不需要看图。

## 使用者验收要点

- **preview.png**：主要文字是否为真实文本（选中可复制）、照片框位置是否对齐；
- **diff.png / overlay.png**：偏差集中区是否可接受；
- **report.json**：`reviewItems` 里 agent 报告的待确认项（如文字压在照片上）；
- **改文案试一下**：编辑 `content.json` 任一键 → `npx tsx src/cli.ts render
  <输出目录>` → preview 更新即证明可编辑（全程不需要模型）。

## 边界与安全

- Agent 只产出数据（JSON spec）；CLI 不执行模型返回的代码/HTML/CSS；
  spec 走与 API 路径完全相同的校验（schema/几何/路径安全）。
- AGENTS.md 硬约束：画布尺寸只来自 `prompt` 命令、禁止整页截图伪装还原、
  禁止删元素"修复"报错、迭代上限（校验 5 轮/调优 3 轮）超限即如实报告。
- `.agent/` 是 agent 工作目录（git 忽略）；提取成功后模板包自洽，
  删除 `.agent/` 不影响后续 render/compare。
