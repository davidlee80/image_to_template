---
name: image-to-template
description: 把页面图片（旅行攻略、海报等）转换为内容与样式分离的可编辑模板包：读取图片生成 SceneSpec 结构化模板、自动校验与错误修复迭代、素材裁剪、渲染对比与调优，全程零外部模型 API 调用。Use when the user asks to convert an image into an editable template, 提取模板, 把图片做成模板, 图片转模板, or mentions AGENTS.md 工作流 for image_to_template.
---

# 图片转可编辑模板（image-to-template）

把一张页面图片变成可编辑模板包：主要文字为真实文本节点（可改文案重渲染）、
照片自动裁剪为独立素材、附 diff 对比与报告。**全程不调用外部模型 API**——
"图片→结构"由你（执行本 skill 的 agent）读图完成。

## 工作流

依次执行；每条命令必须真实运行，禁止编造输出。

### 第 1 步：生成尺寸锚定提示词（必须）

```powershell
npx tsx src/cli.ts prompt <输入图片> --output .agent/prompt.txt
```

读取 `.agent/prompt.txt`，记下"画布实际尺寸是 W × H 像素"。
**画布尺寸只能来自该命令输出，禁止手写或估算。**

### 第 2 步：读图生成 SceneSpec

1. 用读图能力查看输入图片。
2. 按 `.agent/prompt.txt` 的规则与 JSON Schema 构造 SceneSpec：
   - 独立标题/段落/标签/时间/编号 = text 元素（正文写进 `text` 字段）；
   - 照片与复杂图标 = image 元素（`src` 留空 `""`）；
   - 背景/线条/边框/底色 = box 元素；
   - 逐字转录可见文字，不改写不纠错；不确定项写 notes。
3. 写入 `.agent/spec.json`（UTF-8 无 BOM）。

### 第 3 步：快速校验（秒级，不跑提取）

```powershell
npx tsx src/cli.ts validate-spec .agent/spec.json <输入图片>
```

- 退出码 0 → 第 4 步。
- 退出码 1 → stderr 消息带具体路径与元素 ID（如
  `[OUT_OF_CANVAS] elements[3]: 元素 hotel_name 下边界越出画布：y=2300 + height=60 > 2339`）。
  **只修复消息点名的元素**，不重写整个 spec，改完重跑本步。

**校验修复上限 5 轮**；超限停止，向用户报告剩余错误原文。

### 第 4 步：提取模板包

```powershell
npx tsx src/cli.ts extract <输入图片> <输出目录> --spec .agent/spec.json
```

自动完成：校验 → 正文分离（text→content.json）→ 素材裁剪（坐标→assets/*.png）→
渲染（preview.png）→ 与原图对比（diff.png/overlay.png）。
退出码非 0 时按 stderr 修复（同第 3 步规则）重跑。

### 第 5 步：视觉自检（有视觉能力时）

1. 读 `<输出目录>/diff.png`：红/黄密集区 = 偏差位置。
2. 读 `<输出目录>/report.json` 的 `comparison.regionScores`
   （header/timeline/photos/sidebar；辅助指标，**不是还原率**）。
3. 主要区域明显偏差时只调对应元素 x/y/width/height，回到第 3 步。

**视觉调优上限 3 轮**。主要文字位置正确、照片框对齐即为可交付，不追求零差异。

### 第 6 步：交付报告

报告：输出目录与产物清单；元素统计（text/image/box）；全页与区域
mismatchRatio（注明"辅助指标，非还原率"）；剩余 reviewItems；后续改文案只需
编辑 content.json + `npx tsx src/cli.ts render <输出目录>`（不需要模型）。

## 降级工作流（无视觉能力时）

无法读图时**禁止编造 spec**。改用用户已按 `docs/wiki/manual-extract.md`
步骤 1～3 准备的 spec 文件：`validate-spec` 校验 → 失败按消息修复（错误修复
不需要视觉）→ 通过后执行第 4～6 步。

## 硬约束

1. 画布尺寸只来自 `prompt` 命令输出；禁止手写、估算、从文件名猜。
2. 禁止把整页或大段文字区域做成 image（截图伪装还原）。
3. 禁止同一文字既在 text 又被裁进图片。
4. 只产出数据（JSON）；不绕过 CLI 直接改模板包产物。
5. 失败即报：不得删除报错元素来"通过"（丢内容不是修复）。
6. 迭代上限：校验修复 5 轮、视觉调优 3 轮；超限如实报告。
7. spec 为一次性输入：提取成功后模板包自洽，不依赖 `.agent/spec.json`。

## 参考

- spec 字段核对表与常见错误处理：[reference.md](reference.md)
- 人类操作手册（流程同构）：`docs/wiki/manual-extract.md`
- 仓库根 `AGENTS.md` 为本规程的原始版本
- 完整命令：`npx tsx src/cli.ts --help`
