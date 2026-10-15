# image-to-template

将旅行攻略图片转换为**内容与样式分离的可编辑模板**：视觉识别 → 独立素材裁剪 →
内容分离 → 通用渲染器（HTML / PNG / PDF）→ 差异对比与溢出报告 → 受限自动校准。
作为独立功能模块交付：Node.js SDK（`@image-to-template/core`）与跨语言 CLI
（`img-to-template`）共用同一核心流水线。

设计文档：`docs/design/img_to_template_design.md`
实施计划：`docs/superpowers/plans/2026-10-13-img-to-template-implementation-plan.md`
基准记录：`docs/wiki/baseline.md`　使用手册：`docs/wiki/usage.md`
评估：`docs/wiki/evaluation.md`　接入：`docs/wiki/integration.md`
人工提取（对话式 LLM，零 API）：`docs/wiki/manual-extract.md`

## 当前状态

A（定位式 MVP）/ B（稳定识别离线部分）/ C（组件模板、adaptive、分页、PDF）/
D（受限补丁与自动校准）/ E（严格检查、版本管理、批量、独立模块交付）已完成。
独立接入验收：`npm run test:package`（归档 → 仓库外安装 → Node SDK/Python CLI
消费 → 含空格路径迁移）。

T08（真实旅行图验收）与 T10 步骤 7（3～5 张真实样本评估）待真实素材
（模型配置、类似图片）到位后执行；在此之前离线测试全部使用合成 fixture，
不代表真实识别验收完成。字体已就位：`fonts/` 携带思源黑体/宋体与
Source Sans 3（SIL OFL 1.1，可免费商用/再分发/嵌入），携带字体的模板包
严格模式中文渲染已验证。

## 环境要求

- Node.js ≥ 20（锁定版本见 `docs/wiki/baseline.md`）
- npm（依赖版本以 `package-lock.json` 为准）

## 安装

```powershell
Set-Location <仓库根目录>
npm ci
npx playwright install chromium
```

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run check` | TypeScript 类型检查（tsc --noEmit，strict） |
| `npm test` | 运行离线测试（unit + integration；不调用付费模型） |
| `npm run test:package` | 独立模块验收（build→pack→仓库外安装→Node/Python 消费） |
| `npm run build` | 构建到 `dist/`（ESM + 类型声明，用于打包） |
| `npm run extract -- <输入图片> <输出目录> [--layout hybrid] [--spec <spec.json>]` | 提取模板包；--spec 为人工对话式生成（零模型），hybrid 另产 LayoutSpec |
| `npx tsx src/cli.ts prompt <输入图片> [--output <文件>]` | 生成"人工对话式提取"提示词（见 docs/wiki/manual-extract.md） |
| `npm run render -- <模板目录> [--mode/--overflow/--format/--scale/--data/--output/--strict]` | 重渲染（不调用模型；adaptive 支持 grow/paginate、PNG/PDF） |
| `npm run compare -- <模板目录> [--reference/--force]` | 差异对比（含区域分数） |
| `npm run validate -- <模板目录> [--strict]` | 交付检查（阻断项/复查项/版本哈希） |
| `npm run calibrate -- <模板目录> [--iterations/--max-requests]` | 受限自动校准（快照/回滚/预算） |
| `npm run batch -- <清单.json> [--strict]` | 批量任务（独立输出、汇总报告） |

> 所有命令支持 `--json`（stdout 仅一个 JSON 结果对象，日志走 stderr）。
> 完整命令说明与示例见 `docs/wiki/usage.md`。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 完成且满足当前策略（非严格模式下 needs_review 视为完成） |
| 1 | 执行或校验失败 |
| 2 | 严格模式待复查 |
| 64 | 参数错误 |

### 编辑内容后重渲染

```powershell
npm run render -- --template output/travel --data tests/fixtures/updated-content.json --output output/edited.png --strict
```

`--output` 指向单 PNG 时输出到该路径；资源根仍是 template.json 所在包目录。
编辑后 compare 默认跳过原图差异（可用 --reference 提供新基准）。

## 目录结构

```text
src/          SDK 公开入口（index.ts / sdk.ts / errors.ts）与各阶段模块
tests/        离线测试（unit / integration / package；fixture 不联网）
scripts/      开发工具（fixture 再生成等）
input/        真实基准图（已就位，见 input/README.md）
fonts/        固定字体与 manifest（思源字体 SIL OFL 1.1，已就位）
examples/     Node SDK 与 Python CLI 消费示例（仅公开契约）
output/       运行产物（git 忽略）
.cache/       识别缓存（git 忽略）
```

## 模型配置与人工提取

提取图片有两条等价路径：

1. **API 自动化**：配置 `OPENAI_API_KEY` / `OPENAI_MODEL`（.env，密钥不提交）。
2. **人工对话式（零 API 密钥）**：`prompt` 命令生成提示词 → 粘贴到对话式
   LLM 网页 + 传图 → 保存模型输出的 JSON → `extract --spec <文件>`。
   详见 `docs/wiki/manual-extract.md`。

SDK 本身不读取 `.env`，仅 CLI 启动时将其转换为显式配置。
`render / compare / validate` 不需要模型。

## 字体授权

`fonts/` 携带 Adobe/Google 思源字体（SIL Open Font License 1.1）：
思源黑体 CN（sans 400/700）、思源宋体 CN（serif 400）、Source Sans 3
（latin 400/700）。可免费商用、再分发与嵌入；来源 URL 与 SHA-256 记于
`fonts/manifest.json`。

## 许可

未定（当前为私有项目，UNLICENSED）。第三方资源（字体、图片）授权随
`fonts/manifest.json` 与模板包 manifest 记录。
