# image-to-template

将旅行攻略图片转换为**内容与样式分离的可编辑模板**：视觉识别 → 独立素材裁剪 →
内容分离 → 通用渲染器（HTML / PNG，后续 PDF）→ 差异对比与溢出报告。
作为独立功能模块交付：Node.js SDK（`@image-to-template/core`）与跨语言 CLI
（`img-to-template`）共用同一核心流水线。

设计文档：`docs/design/img_to_template_design.md`
实施计划：`docs/superpowers/plans/2026-10-13-img-to-template-implementation-plan.md`
基准记录：`docs/wiki/baseline.md`

## 当前状态

A 阶段（定位式 MVP，T01～T07）与 B 阶段（稳定识别，T09/T10）离线部分已完成；
C 阶段已完成 T11（LayoutSpec/语义编译/迁移）、T12（旅行主题与七类组件）、
T13 核心算法（分页 + PDF 导出）。T13 剩余：adaptive 模式的渲染管线与 CLI
接线（--mode/--overflow/--format）。`validate / calibrate / batch` 分别在
T16 / T15 / T17 交付。

T08（真实旅行图验收）与 T10 步骤 7（3～5 张真实样本评估）待真实素材
（基准图、字体、模型配置）到位后执行；在此之前离线测试全部使用合成
fixture，不代表真实识别验收完成。

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
| `npm test` | 运行离线测试（Node test runner + tsx；不调用付费模型） |
| `npm run build` | 构建到 `dist/`（ESM + 类型声明，用于打包） |
| `npm run extract -- <输入图片> <输出目录>` | 提取模板包（识别→裁剪→渲染→对比） |
| `npm run render -- <模板目录>` | 重渲染（不调用模型；支持 --data/--output/--strict） |
| `npm run compare -- <模板目录>` | 差异对比（支持 --reference/--force） |

> 所有命令支持 `--json`（stdout 仅一个 JSON 结果对象，日志走 stderr）。
> `validate / calibrate / batch` 分别在 T16 / T15 / T17 交付。

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
input/        真实基准图（当前缺失，见 input/README.md）
fonts/        固定字体与 manifest（当前缺失，见 fonts/manifest.json）
output/       运行产物（git 忽略）
.cache/       识别缓存（git 忽略）
```

## 模型配置

`extract` 需要视觉识别模型。将 `.env.example` 复制为 `.env` 并填写
`OPENAI_API_KEY` / `OPENAI_MODEL`（密钥不提交）。SDK 本身不读取 `.env`，
仅 CLI 启动时将其转换为显式配置。`render / compare / validate` 不需要模型。

## 许可

未定（当前为私有项目，UNLICENSED）。第三方资源（字体、图片）授权随
`fonts/manifest.json` 与模板包 manifest 记录。
