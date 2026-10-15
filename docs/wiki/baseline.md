# 复刻基准记录（baseline）

本文件记录实施计划 T01 要求的工具链、输入与校对基准。真实资源到位后逐项更新；
**未提供的项目保持"缺失"状态，不得用合成 fixture 替代真实验收。**

## 1. 工具链（2026-10-14 锁定）

| 项 | 版本 / 说明 |
|---|---|
| 操作系统 | Windows 21H2（开发环境） |
| Node.js | v24.13.0 |
| npm | 11.8.0 |
| TypeScript | ^7.0.2（devDependency，`npm run check` 使用 tsc） |
| tsx | ^4.23.15（仅开发期运行，不进入运行依赖） |
| sharp | ^0.35.5 |
| playwright | ^1.64.0 |
| Chromium | playwright chromium v1248（Chrome for Testing 156.0.8078.4，`npx playwright install chromium` 安装） |
| pixelmatch | ^8.0.0（自带类型声明；API 与设计用法兼容，默认导出 + threshold/includeAA） |
| zod | ^3.25.76 |
| zod-to-json-schema | ^3.25.2 |
| 测试运行器 | Node.js 内置 test runner（`node --import tsx --test tests/`） |

精确版本以提交的 `package-lock.json` 为准。

## 2. 输入资源清单

| 输入 | 状态 | 记录 |
|---|---|---|
| 基准旅行图 `input/travel_plan_page_0005.png` | **已提供**（2026-10-14 记录） | PNG，真实尺寸 **1653×2339**（设计文档假设的 1060×1500 仅作参考，以实际为准）；SHA-256 `b3470e33a2ef9c3b1f0934bdd5159c49622a424ea6ccfd4d34aa05b79d9ba158`；文件 1,769,128 字节；内容结构：头部（Day 5/本溪水洞·天桥沟/副标题/全季酒店/日期天气）、左栏六段时间轴（天桥沟→小市羊汤→本溪水洞→入住全季→龙之梦晚餐→中街）、4 张照片网格、右栏六模块（必吃推荐 4 项/必体验·打卡·亲子 5 项/打卡点 4 项/停车指南 4 条/门票预约 4 条/餐厅推荐：本溪 2 家+沈阳 3 家）；已随仓库提交 |
| 文本校对基准 | **待建立** | 基准图已到位；需完整转录可见文字，重点核对店名、时间、价格、标点；不擅自改写原文（T08 步骤 1 逐项核对） |
| 字体文件 | **已提供**（2026-10-15 联网下载） | 思源字体（SIL OFL 1.1，可免费商用/再分发/嵌入）：sans=思源黑体 CN 2.005R Regular+Bold（8.4/8.6MB）、serif=思源宋体 CN Regular（11.6MB）、latin=Source Sans 3 3.052R Regular+Bold（约 330KB）；来源 URL、SHA-256 与授权记于 `fonts/manifest.json`（哈希篡改会被渲染检出 hash_mismatch） |
| 模型配置 | **未核查** | 需配置支持视觉输入与 JSON 输出的模型 ID（`OPENAI_MODEL`）与密钥（`OPENAI_API_KEY`），并完成一次真实调用（T08 验收） |
| 3～5 张类似图片 | **缺失** | 需覆盖双栏、小字、照片/图标、不同内容密度（T09/T10 使用） |
| 独立 OCR 实现 | **未选定** | 本地或服务适配器均可，需记录坐标约定、能力与调用成本（T10） |

## 3. 离线 fixture（工程链路验证用，非真实验收）

| fixture | 说明 |
|---|---|
| `tests/fixtures/images/synthetic-travel.png` | 800 × 600 合成旅行海报：头部色块、中文/拉丁文字、时间轴、编号圆点、照片框（渐变占位）、底部信息条 |
| `tests/fixtures/images/synthetic-travel.source.html` | 合成图来源 HTML（与截图同源，供人工检查） |
| `tests/fixtures/scenes/synthetic-travel.scene.json` | 人工 SceneSpec（version 1.0），元素坐标与合成图由 `scripts/generate-synthetic-fixture.mts` 同一来源生成 |

再生成 fixture：`npm exec tsx scripts/generate-synthetic-fixture.mts`（需 Chromium）。

## 4. 基准图逐字核对记录

**待真实图片到位后建立。** 核对范围（以原图实际内容为准）：
标题、日期/天气、酒店、六段时间轴、景点照片说明、美食、体验/亲子、打卡清单、
停车、预约及餐厅信息；数量以原图为准，逐项记录元素 ID 与核对结论。

## 5. 字体覆盖核查记录

**已核查（2026-10-15，随思源字体交付）：**

- 常用汉字：思源黑体/宋体 CN 子集覆盖 GB18030 简中全集（标题/正文/符号混合用例通过严格渲染，预览均值 244，非空白）；
- 数字与日期分隔符：`DAY 5`、`12–18`（en dash）渲染正常；
- 温度符号：`°C` 渲染正常；
- 中英文标点：`· ，。：（）→ ¥` 渲染正常；
- 回归用例：`tests/integration/fonts-delivery.test.ts`（哈希一致性 + 三槽位严格渲染 + 篡改检出）。

## 6. 环境注意事项（本机实测）

- PowerShell 处于 Constrained Language 模式：`[System.IO.File]::*`、`New-Object` 等 .NET 调用被禁；脚本写文件用 Python 或 npm 工具链。
- 控制台中文显示乱码（GBK 代码页）属显示问题，不代表文件内容有误；判定内容以工具读取为准。
- ~~本机 Playwright Chromium 无 CJK 字体，纯中文渲染为空白~~（2026-10-15 起已解除：模板包携带思源字体后严格渲染中文通过；不带字体的包仍会回退系统字体，无 CJK 环境下为空白——正式包必须携带 fonts/）。
- PowerShell 语句分隔用 `;`，不支持 `&&`。
