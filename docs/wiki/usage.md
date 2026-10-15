# 使用手册（usage）

面向使用 `@image-to-template/core` SDK 与 `img-to-template` CLI 的操作者。
命令示例与最终 CLI 一致（T17 验收项）；环境锁定记录见 `baseline.md`。

## 1. 首次安装

```powershell
Set-Location <仓库根目录>
npm ci
npx playwright install chromium
npm run check
npm test
```

- Node.js ≥ 20（本机锁定 v24.13.0；见 baseline.md 工具链表）。
- Playwright Chromium 是渲染与 PDF 导出的运行依赖，首次必须显式安装。
- PowerShell 配置：本机处于 Constrained Language 模式，`.NET` 直接调用被禁；
  脚本写文件请用 npm 工具链或 Node（详见 baseline.md 第 6 节）。

## 2. 模型配置（仅 API 提取需要）

提取有两条等价路径：

- **人工对话式（零 API，推荐无密钥时使用）**：见 `docs/wiki/manual-extract.md`
  （prompt 命令 → 对话生成 JSON → `extract --spec`）。
- **API 自动化**：`extract` 需要视觉识别模型；`render / compare / validate /
  batch(render,validate)` 不需要。

```powershell
Copy-Item .env.example .env
# 编辑 .env：OPENAI_API_KEY / OPENAI_MODEL
```

- SDK 不读取 `.env`；仅 CLI 启动时将环境变量转为显式配置。
- 密钥不写入命令示例、不提交仓库。

## 3. 单任务命令

### 3.1 提取（识别 → 裁剪 → 渲染 → 对比）

```powershell
# SceneSpec 1.0（A/B 阶段行为）
npm run extract -- input/travel_plan_page_0005.png output/travel

# hybrid 提取（C 阶段）：先保留 SceneSpec 再编译 LayoutSpec（自动迁移）
npm run extract -- --input input/travel_plan_page_0005.png --output output/travel-layout --layout hybrid
```

产物：reference.png、template.json、content.json、content.schema.json、manifest.json、
assets/、preview.html/png、diff/overlay.png、report.json；
hybrid 另有 scene.json、layout.json、id-mappings.json、migration.json。

### 3.2 渲染（不调用模型）

```powershell
# SceneSpec replica（固定画布）
npm run render -- output/travel

# 编辑正文后重渲染（不重新识别）
npm run render -- --template output/travel --data updated-content.json --output output/edited.png --strict

# LayoutSpec replica
npm run render -- --template output/travel-layout/layout.json --strict

# adaptive：保持宽度自动增高
npm run render -- --template output/travel-layout --mode adaptive --overflow grow --format png,pdf --output output/adaptive

# adaptive：保持页尺寸按块分页
npm run render -- --template output/travel-layout --mode adaptive --overflow paginate --format png,pdf --output output/paged --strict
```

- `--mode replica|adaptive`：SceneSpec 1.0 仅支持 replica（组合不支持直接报错）。
- `--overflow grow|paginate`：仅 adaptive；`error` 用于固定页检查（replica 语义）。
- `--format png,pdf`：可多选；PDF 与 PNG 来自同一页分配，页数一致。
- `--scale <倍数>`：0.25～4；仅改变 PNG 栅格分辨率，不改变逻辑排版与 PDF 页尺寸。
- paginate 输出：`pages/page-001.png…`（每页同尺寸）；首页同步 `preview.png`。
- 超大不可拆块 → `OVERSIZED_BLOCK`（failed；不静默裁切；请拆内容或改用 grow）。

### 3.3 对比

```powershell
npm run compare -- output/travel
# 内容已编辑：提供新的匹配基准
npm run compare -- output/travel --reference new-baseline.png
```

- 仅同内容、同画布、replica 可直接和原图比较；编辑后默认跳过（报告记录原因）。
- `--force`：显式对比发现不一致时报 failed。
- 报告含区域分数（comparison.regionScores：header/timeline/photos/sidebar；评分是
  辅助指标，不是还原度百分比）。

### 3.4 交付检查

```powershell
npm run validate -- output/travel
npm run validate -- output/travel --strict
```

- 汇总 schema、绑定、几何、正文完整性、字体、图片、溢出与遮挡。
- 状态：pass / needs_review / failed；阻断项（结构非法、资源缺失、正文被裁切等）
  → failed；低置信度、复杂遮挡 → needs_review。
- 复查结论与模板/内容哈希绑定：变化后旧结论失效（resolution_stale），需重新处理。

### 3.5 自动校准（D 阶段）

```powershell
npm run calibrate -- output/travel --iterations 3 --max-requests 5
```

- 仅对原始内容一致的 replica 有效（内容已编辑会明确拒绝）。
- 每轮补丁经白名单/幅度校验（位置每轮 8px、累计 24px；字号每轮 2px、累计 4px）
  与硬约束（内容哈希不变、无新增阻断、可编辑性不降低、区域不回退）。
- 改善才接受；每轮快照保存于 `history/snapshot-N/`；中断后可用最佳快照恢复。
- 停止条件：连续 2 次无改善 / 预算耗尽 / 迭代上限（默认 3、上限 5）。

## 4. 批量任务

```powershell
npm run batch -- tests/fixtures/batch.json --strict
```

清单结构（`manifestVersion: "1.0"`）：

```json
{
  "manifestVersion": "1.0",
  "maxRequests": 6,
  "tasks": [
    { "id": "a", "kind": "render",   "input": "output/travel", "output": "output/travel" },
    { "id": "b", "kind": "validate", "input": "output/travel" }
  ]
}
```

- 每任务独立输出目录与报告；默认顺序执行；`maxRequests` 为全局识别调用预算。
- 单项失败记录错误并继续；汇总报告落盘 `batch-report-<runId>.json`。
- 任一 failed → 汇总 failed；严格模式下 needs_review 也计入（退出码 2）。

## 5. 编辑内容与图片

- 编辑正文：修改 `content.json`（SceneSpec：`Record<textId, string>`；
  hybrid：`texts` / `assets` 结构化字段），再 `render`。无需模型调用、无需改模板。
- 替换图片：把新图放入 `assets/` 并更新 `content.json` 的 `assets.<id>.src`
  （或 SceneSpec 的 image src）；`objectFit: cover|contain` 支持横竖图无拉伸。
- 内容变化只更新内容版本；原图对比分数随之失效（不沿用旧分数）。

## 6. 缓存、预算与失败恢复

- 识别缓存：`.cache/`（键含图片哈希/提示词版本/模型等；`--no-cache` 禁用）。
- 共享预算：识别/区域/OCR/校准全部计入同一 `maxRequests` 与时间预算。
- 校准中断：`restoreBestSnapshot`（SDK）恢复最近接受的快照并重渲染。
- 严格失败不产出有效导出（旧 preview 被移除，不冒充本次结果）。

## 7. 常见问题

| 现象 | 说明与处理 |
|---|---|
| extract 报 INVALID_CONFIG | 未配置视觉识别（检查 OPENAI_API_KEY/OPENAI_MODEL 或 SDK vision 配置） |
| render 报 UNSUPPORTED（adaptive） | SceneSpec 1.0 仅 replica；先 `--layout hybrid` 提取或迁移 |
| 分页报 OVERSIZED_BLOCK | 不可拆块超一页；拆分内容或改 `--overflow grow` |
| 中文在测试环境渲染为空白 | 本机 Chromium 无 CJK 字体（见 evaluation.md 环境记录）；正式包需携带授权字体 |
| compare 跳过原图差异 | 内容已编辑；提供 `--reference` 新基准或 `--force` 显式对比 |
| needs_review 退出码 | 非严格 0；严格 2（阻断项才是 1） |
