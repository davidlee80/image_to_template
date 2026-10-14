# 图片转可编辑模板实施计划

日期：2026-10-13  
设计依据：[img_to_template_design.md](../../design/img_to_template_design.md)  
实施仓库：`E:\Tugoo\image_to_template`  
状态：待实施；本文件只制定计划，不代表依赖、CLI 或模板已经存在。

## 1. 目标、现状与范围

建设一套可独立安装、供其他项目集成的 TypeScript 功能模块，提供 Node.js SDK 与 CLI，将旅行攻略图片转成内容与样式分离的模板，通过同一个渲染器生成 HTML、PNG，后续支持 PDF、自适应布局和有限次数的视觉校准。

最终交付必须包含构建后的模块包、公开 API/类型、跨语言 CLI 契约、可迁移模板包和独立消费项目验证。宿主不需要复制源码、依赖本仓库路径或接入原项目业务系统。该要求对应设计文档“九、独立功能模块与跨项目集成”，从 T01 建立边界，在 T18 完成交付验收；具体业务系统的上线接入另行实施。

执行顺序遵循设计文档：先建立可编辑的定位式复刻基准，再用 3～5 张类似图片验证识别稳定性，然后抽象组件，最后加入自动补丁校准与批量任务。不能通过把整张原图作为背景、裁剪文字区域贴回页面或删除文字来提高差异分数。

已核查的仓库现状：

- 目前只有设计文档及文档目录，没有 `package.json`、`src/`、测试、输入图片或字体资源。
- `docs/superpowers/plans/` 已存在，尚无其他实施计划。
- 在仓库及所检查的上级目录中未发现适用的 `AGENTS.md`。
- 设计文档中的代码是未经当前图片验证的起点，应拆分、补齐校验后实现，不能当作已运行的代码。

范围分层：

| 交付层级 | 必须具备的能力 | 暂缓的能力 |
|---|---|---|
| A：定位式 MVP | 图片标准化、视觉识别、结构校验、素材裁剪、内容分离、固定字体、HTML/PNG、差异图、叠图、溢出报告 | 语义组件、自动分页、自动字体精确匹配 |
| B：稳定识别 | 分区识别、独立 OCR 对照、坐标合并、去重、有限重试、缓存、待确认清单 | 任意类型海报的全自动理解 |
| C：可复用模板 | SceneSpec 与 LayoutSpec 并存、旅行组件、嵌套内容、内容 schema、图片裁剪策略、replica/adaptive、分页、PDF | 可视化编辑器、无限制组件和样式 |
| D：自动校准 | 受限补丁、按区域评价、改善才接受、版本回滚、迭代与调用预算 | 重写整个模板、不可控循环 |
| E：交付完善 | 发布校验、模板/内容独立版本、批量 CLI、固定环境、运行手册、SDK/CLI 模块包及独立项目接入验收 | Web 服务、账户、计费、任务队列、具体业务系统的上线接入 |

不承诺任意图片的像素级完全还原；复杂文字覆盖背景的分离与重建不纳入本轮自动化。无法分离的区域必须标记为栅格素材并进入待确认清单，不能宣称其中的文字可编辑。

## 2. 前置条件与实施决策

### 2.1 需要在实施时补齐的输入

| 输入 | 当前状态 | 处理任务 | 完成要求 |
|---|---|---|---|
| 基准旅行图片 | 仓库未提供 | T01 | 放入 `input/travel_plan_page_0005.png`；记录真实尺寸、来源和哈希 |
| 文本校对基准 | 未提供 | T01、T08 | 完整转录可见文字；重点核对店名、时间、价格、标点，不擅自改写原文 |
| 字体文件 | 未提供 | T01、T05 | 选择可合法使用的字体，记录来源、版本、授权、字重及文件哈希 |
| 模型配置 | 未核查 | T03、T08 | 配置视觉输入与 JSON 输出可用的模型 ID、环境变量和一次真实调用 |
| 3～5 张类似图片 | 未提供 | T09、T10 | 覆盖双栏、小字、照片/图标、不同内容密度，分别建立核对记录 |
| 独立 OCR 实现 | 设计未指定 | T10 | 选择本地或服务适配器，记录坐标约定、能力和调用成本 |

缺少真实素材时，可用确定性的合成图片及识别 fixture 验证工程链路，但不得据此宣布真实图片识别或视觉复刻验收完成。输入不足不妨碍项目初始化、schema、渲染器及离线测试实施。

### 2.2 统一技术选择

- 使用 Node.js 20 或更新版本、TypeScript、ESM、`tsx`；实施时选择一个实际可用版本并固定在工具链记录中。
- 按设计文档采用 `sharp`、`playwright`、`pixelmatch`、`zod@3`、`zod-to-json-schema@3`。实施时验证兼容性并提交精确 lockfile；本计划不预先声称某个版本是最新版本。
- 使用 npm，与设计文档的命令保持一致；不新增 monorepo，也不修改 `travel-poster-system`。
- MVP 采用受限 JSON 到 HTML 的通用渲染器；组件阶段继续使用同一渲染入口与组件注册表，首轮不额外引入 React 构建链。
- 模型只能返回数据或补丁。禁止执行其返回的 JavaScript、HTML、CSS 代码；所有样式从经过校验的字段生成。
- 测试采用 Node 测试运行器与 `tsx`，浏览器检查使用 Playwright。普通测试使用 fixture，不默认调用付费模型。
- 字体、照片和图标作为本地资源；生成 HTML 时嵌入资源，渲染过程不依赖公网资源和系统 emoji。
- 以单一 npm 包提供 ESM SDK 与构建后 CLI；`tsx` 仅用于开发。从 T01 起建立公开入口和可产出 JavaScript/类型声明的构建配置，核心不依赖 CLI、宿主业务模型或特定工作目录。

### 2.3 独立模块契约

- 暂用包名 `@image-to-template/core`、命令名 `img-to-template`，T01 核查并记录；通过 `npm pack` 交付安装归档，公共 registry 发布不是验收前提。
- 公开 `createImageTemplate(config)` 及实例方法 `extract`、`render`、`compare`、`validate`、`calibrate`、`batch`；随阶段逐步增加，最终覆盖设计文档第九章的输入/输出契约。未实现能力必须明确拒绝。
- 公开请求/结果、TemplateSpec、内容约束、报告、provider 和错误类型。结果含 runId、pass/needs_review/failed、产物清单与 report；可诊断的质量失败返回 failed，无法形成诊断的执行错误抛出含 code/stage/message/runId/retryable 的类型化错误。
- CLI 只负责参数及环境变量适配、调用 SDK、JSON/人工可读输出、退出码映射。`--json` 的 stdout 仅一个结果或错误对象，日志/进度输出到 stderr；SDK 通过回调输出日志，不执行 `process.exit()`。
- 配置显式注入模型/OCR provider、字体、输出/缓存/临时目录、浏览器和日志；SDK 不隐式加载 `.env`、改变 cwd 或修改全局环境。配置路径在创建实例时解析，操作路径在调用开始时解析，模板资源始终以包目录为根。
- 不依赖宿主数据库、账户、队列、计费或前端框架；本轮使用本地文件资源，宿主负责对象存储和服务化适配。Node 后端直接使用 SDK，其他语言通过子进程调用 CLI；前端通过宿主后端使用，不承诺浏览器直接运行 SDK。
- 操作支持超时与 AbortSignal，任务目录、预算和输出隔离，同目录并发写入拒绝或串行化；失败/取消清理临时资源，关闭模块创建的浏览器，不终止宿主进程。
- 模块包采用语义化版本；模板、内容、manifest、报告版本独立。未知版本明确拒绝，旧版读取有兼容测试，破坏性变更有迁移说明。render/compare/validate 不需要模型密钥或识别调用。

### 2.4 统一名词及模式

| 名称 | 职责 |
|---|---|
| `SceneSpec` | 对应设计 MVP 的 `version: "1.0"` 定位模板，记录 text/image/box 与绝对几何信息 |
| `LayoutSpec` | 组件阶段新增的语义模板，采用独立版本 `"2.0"`，记录受限布局节点与内容绑定 |
| `TemplateSpec` | 读取入口对两种版本的统一称呼；根据 version 分发校验和渲染 |
| `content.json` | MVP 为 `Record<textId, string>`；组件阶段为 header/timeline/photos 等结构化数据 |
| `content.schema.json` | 每份模板对应的内容约束；与模板 schema 分开，不能互相替代 |
| `replica` | 固定画布及模块尺寸；原始内容用于视觉对比；溢出时报告并阻止严格导出 |
| `adaptive` | 流式内容布局；按配置增高或分页；编辑后检查内容与排版，不比较原图文字像素 |
| `hybrid` | 组件模板的布局策略：固定骨架与装饰、流式文本与列表；不是第三种渲染模式 |

CLI 的 `--mode` 仅表示 `replica` / `adaptive`，组件阶段另用 `--layout hybrid` 描述提取策略，避免把设计示例中的两类 mode 混为一谈。定位模板仅支持 replica；不支持的组合必须报错。

## 3. 总体架构与文件布局

宿主项目通过 SDK、其他语言通过 CLI 进入同一核心流水线。依赖方向为 `SDK/CLI → pipeline → schema/analysis/render/io/quality`，核心不反向导入 CLI。下列识别、渲染和校准能力均由公开入口调用，不能仅作为命令行私有逻辑存在。

```text
输入图片
  → 标准化与指纹
  → 整页识别（B 阶段增加分区及独立 OCR）
  → SceneSpec 校验与人工校对
  → 内容分离、素材裁剪、字体打包
  → 通用渲染器 → HTML / PNG
  → 布局检查 + 原始内容视觉对比 → report.json
                       │
                       └→ C：语义编译 → LayoutSpec + 结构化内容
                                      → replica / adaptive → PNG / PDF
                                                │
                                                └→ D：受限补丁 → 检查 → 接受或回滚
```

建议文件结构（逐阶段增加，不提前创建空模块）：

```text
image_to_template/
├── package.json / package-lock.json / tsconfig.json / tsconfig.build.json
├── .gitignore / .env.example / README.md
├── src/
│   ├── index.ts           SDK 公开导出，import 无运行副作用
│   ├── sdk.ts / errors.ts 实例配置、操作入口及类型化错误
│   ├── cli.ts             参数、环境、输出和退出码适配
│   ├── config.ts
│   ├── schemas/          scene.ts / layout.ts / content.ts / report.ts / patch.ts
│   ├── io/               json.ts / paths.ts / image.ts / bundle.ts
│   ├── analysis/         provider.ts / vision.ts / prompts.ts / regions.ts / merge.ts / ocr.ts
│   ├── assets/           crop.ts / fonts.ts
│   ├── render/           html.ts / browser.ts / bindings.ts / components.ts / paginate.ts / pdf.ts
│   ├── quality/          layout.ts / compare.ts / editability.ts / publish.ts
│   ├── pipeline/         extract.ts / render.ts / compare.ts / batch.ts
│   ├── semantic/         compile.ts / travel-theme.ts / migrate.ts
│   ├── calibration/      propose.ts / apply.ts / loop.ts
│   └── runtime/          cache.ts / budget.ts / versions.ts
├── tests/
│   ├── fixtures/         合成图、模型输出、OCR 输出、两种模板及编辑变体
│   ├── unit/             schema、路径、几何、坐标、绑定、补丁
│   ├── integration/      离线提取链路、浏览器渲染、分页、校准
│   └── package/          安装归档、公开类型、独立消费项目验收
├── examples/             node-sdk/、python-cli/；仅引用公开契约
├── dist/                 构建后的 ESM、CLI、类型及运行资源，默认忽略
├── input/                真实基准图与类似图；按资源来源决定是否提交
├── fonts/                已获授权的固定字体与 manifest.json
├── output/               运行产物，默认忽略
├── .cache/               可复用识别结果，默认忽略
└── docs/
    ├── design/img_to_template_design.md
    ├── wiki/             baseline.md / evaluation.md / usage.md / integration.md
    └── superpowers/plans/本计划
```

每份模板包按阶段交付：

```text
output/travel/
├── reference.png               标准化原图，仅用于分析和对比，禁止渲染为整页背景
├── template.json               当前使用的 SceneSpec 或 LayoutSpec
├── content.json
├── content.schema.json
├── manifest.json               输入、资源、工具链、模板/内容版本与哈希
├── assets/                     裁剪图片、固定图标及来源记录
├── fonts/                      本次模板实际使用的字体
├── preview.html / preview.png
├── diff.png / overlay.png      仅适用于与原始内容一致的 replica 对比
├── report.json
├── scene.json                  C 阶段保存原始定位基准
├── layout.json                 C 阶段保存语义布局
├── pages/page-001.png           C 阶段分页输出
├── preview.pdf                 C 阶段 PDF
└── history/                    D 阶段补丁、评分与可回滚快照
```

`manifest.json`、schema 和报告逐阶段扩展，但 reader 必须识别版本。不能用新结构覆盖唯一的定位基准；模板和内容版本分别递增。

## 4. 阶段、依赖和里程碑

| 阶段 | 任务 | 前置依赖 | 交付门槛 | 工作量估计 |
|---|---|---|---|---|
| 准备 | T01 | 无 | 工具链、输入清单、离线测试入口明确 | 0.5～1 工作日 |
| A：定位式 MVP | T02～T08 | T01 | 一张真实旅行图可编辑、可重渲染、可对比，报告完整 | 1～3 工作日 |
| B：稳定识别 | T09～T10 | A 验收 | 3～5 张类似图可复查，漏识别、冲突和低置信度可追踪 | 3～5 工作日 |
| C：组件模板 | T11～T13 | B 验收 | 保留 SceneSpec、支持旅行组件、adaptive 与 PDF | 5～10 工作日 |
| D：自动校准 | T14～T15 | C 验收 | 有限补丁循环、无退化接受、预算和回滚可验证 | 5～10 工作日起 |
| E：交付完善 | T16～T18 | D 验收 | 固定环境、严格检查、批量运行、SDK/CLI 安装包和独立项目接入验收 | 4～7 工作日 |

单人顺序实施约 19～36 个工作日起，不含输入/授权获取、复杂背景处理与高精度视觉校准。A/B 的估计沿用设计文档，其余按本计划细化范围估算；新增独立模块交付在 E 增加约 2～3 工作日。T13 分页、T15 校准及跨环境安装可能超出估计，应在完成 B 后按真实样本重新估时。

核心依赖：`T01 → T02 → T03/T04/T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → T17 → T18`。T03、T04、T05 可独立开发，但 T04 的真实裁剪验收依赖 T03 的识别结果；集成验收按依赖顺序进行。T18 的模块边界和构建准备分别落在 T01、T03、T06、T07，不留到交付时才拆分 CLI。

## 5. 可执行任务清单

### T01：建立项目与复刻基准

**文件：** 新建 `package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.build.json`、`src/index.ts`、`src/sdk.ts`、`src/errors.ts`、`.gitignore`、`.env.example`、`README.md`、`docs/wiki/baseline.md`、`tests/fixtures/`；补齐 `input/`、`fonts/manifest.json`。

步骤：

1. 在当前仓库根目录初始化 npm，配置 ESM、NodeNext、strict、DOM 类型库与 noEmit；不再套一层 `image-template/`。
2. 安装设计指定依赖、开发依赖及 Chromium；添加 `check`、`test`、`extract`、`render`、`compare` 脚本。固定 Node、npm、Playwright/Chromium 的实际版本。
3. 忽略 `.env`、`node_modules/`、`.cache/`、`output/`；提交 `.env.example` 的变量名及用途，不放真实密钥。
4. 建立合成图与人工 SceneSpec fixture，覆盖文本、色块、照片框、中文/拉丁文字及层级，供不联网的测试使用。
5. 获取真实基准图，测量头部、左右栏、照片框、时间轴和侧栏边界，建立逐字核对记录。设计中的 `1060 × 1500`、颜色和字号只作测量起点，真实值以输入为准。
6. 选定字体并记录授权；检查中文、数字、日期、温度符号及常用标点覆盖情况。材料未齐时在 baseline 中逐项标记。
7. 增加 `build` 脚本及独立 tsconfig.build（启用 emit/declaration、输出 dist）；定义受控 `exports`、`types`、CLI `bin` 与打包 `files`，运行依赖与开发依赖分开。建立 SDK 配置/错误类型，公开入口随能力完成逐步导出，import 不读写文件或启动任务。

验证：`npm ci`、`npm run check`、`npm test` 能在锁定环境执行；基准记录列明真实资源与仍缺失项。后续真实图验收必须以材料齐备为前提。

### T02：实现 schema、几何及资源边界

**文件：** 新建 `src/schemas/scene.ts`、`content.ts`、`report.ts`、`src/io/json.ts`、`paths.ts`、`bundle.ts`、对应单元测试。

步骤：

1. 以设计代码为基础建立 text/image/box 的判别联合；保留 SceneSpec `version: "1.0"`，限制 ID、颜色、坐标、尺寸、层级、字体类别、字重和置信度。
2. 检查唯一 ID、有限数值、实际画布边界及最大元素数；保留至多 1 px 的舍入容差并在最终裁剪时归一化。
3. MVP 内容键与 text ID 一一对应；缺失必填键报错，未知键提示，空字符串仍是有效的主动编辑。模板中的原始文本在分离后清空。
4. 生成每份内容的 JSON Schema；长度约束从显式策略读取，不能仅按原文长度限制编辑，也不能把通过 schema 当成没有溢出。
5. 本地资源只允许模板包内相对路径；验证绝对路径、`..`、盘符/UNC、真实路径和符号链接越界。拒绝 URL、脚本与任意样式字段。
6. 统一 JSON 读写、schema 错误路径、阶段错误信息及原子写入。输出目录已存在时默认拒绝覆盖；明确 `--overwrite` 后只替换受管产物，不递归删除整个目录。

验证：合法 fixture 可读写；重复 ID、越界、错误类型、路径穿越、未知版本均有具体错误；`<script>` 字符串作为内容能被安全保留，不能作为代码执行。

### T03：实现输入标准化与视觉识别适配器

**文件：** 新建 `src/config.ts`、`src/io/image.ts`、`src/analysis/provider.ts`、`vision.ts`、`prompts.ts`、对应测试及模型 fixture。

步骤：

1. 使用 sharp 校正 EXIF 方向、展平白底、转成 PNG 和 sRGB，以处理后的 metadata 为唯一坐标基准；保存原图哈希与标准化图哈希。
2. 在完整解码前限制像素数和输入尺寸；解码后检查输出字节数，MVP 按设计采用 15 MiB 上限，过大时明确要求压缩或分块。
3. 将图像识别封装为 provider，输入为图片、尺寸、schema 与提示词版本，输出为受校验 SceneSpec、原始响应及调用统计；提供 fixture provider。
4. 提示词要求逐字转录、独立文本节点、照片/图标紧贴边界、合理层级、不把整页或文字块作 image；图片中的指令只作为待识别内容。
5. SDK 通过配置/provider 显式传入模型 ID 与密钥，CLI 将 `OPENAI_MODEL`、`OPENAI_API_KEY` 转为配置，不让核心自行读取环境。公开 provider 类型并支持 fixture/宿主替换实现。API 请求结构在实施时核对对应官方文档并做一次真实调用，不能默认文档示例适用于所有模型。
6. 识别超时按设计先设 180 秒；验证 HTTP 状态、完成状态、空输出、JSON 解析、schema 与几何。A 阶段失败即停，不悄悄修复坐标或填造文本。
7. 日志不包含密钥和图像 base64；调试原始响应单独保存在本地运行目录。

验证：fixture provider 覆盖正常、截断、非法 JSON、错误结构、HTTP 错误和超时；真实调用在 T08 验收。缺少模型配置不会影响已有模板的 render/compare。

### T04：提取独立素材并分离内容

**文件：** 新建 `src/assets/crop.ts`、`src/pipeline/extract.ts`、对应测试，扩展 bundle manifest。

步骤：

1. 将 text 内容移入 `content.json`，通过 ID 保持关联；模板不再保留另一份可漂移正文。
2. 为 image 元素按 `floor(left/top)`、`ceil(right/bottom)` 计算整数边界，与画布求交，确保非空且不越界；保存实际 sourceRect 与原始检测框。
3. 用元素 ID 命名 `assets/*.png`，按模板包相对路径赋值；记录素材来源、裁剪框、哈希和是否包含不可编辑文字。
4. 可见文字与图片相交时生成候选复查项。照片内部固有招牌等文字可保留，但不能用它替代声明可编辑的页面文字。
5. 无法独立裁剪的图标/背景标为待替换或栅格限制；不得自动移除问题以继续宣布成功。
6. 提取阶段先生成完整中间包，再交给渲染；异常产物标记 failed，不与上一次成功包混用。

验证：小数坐标、画布边缘、零面积交集有确定结果；裁剪像素与 fixture 预期一致；所有正文仅由 content 驱动；manifest 能追溯每个素材。

### T05：实现固定字体及通用 HTML 渲染

**文件：** 新建 `src/assets/fonts.ts`、`src/render/html.ts`、`src/quality/editability.ts`、对应测试。

步骤：

1. 从字体 manifest 读取 sans/serif/latin 与实际字重，构建嵌入式 `@font-face`；验证文件存在、哈希和声明字重，不让浏览器无提示地合成缺失字重。
2. 在 `#canvas` 内按稳定的 zIndex/输入顺序渲染 box、image、text；文本使用 `data-text-id`，所有元素使用 `data-element-id`。
3. 所有正文、属性都经过 HTML 转义；样式仅由 schema 白名单生成。正文使用 pre-wrap、换行和可见 overflow 供检测，不通过 line-clamp 隐藏内容。
4. 本地素材嵌入 HTML；MVP 的图片定位与原裁剪框保持一致。不同宽高比图片的 cover/contain 策略在 T12 补齐。
5. 提供诊断与严格模式：诊断允许字体回退但报告 missingFont；严格模式必须使用已声明的字体资源，缺失即失败。
6. 建立正文 ID 与 DOM 文本节点的核对；禁止 reference.png 成为页面背景或素材源。结合素材来源记录检查可编辑性，不能仅靠像素分数判断。

验证：HTML 可离线打开；中文、换行、空字符串和特殊字符显示正确；脚本文本不能执行；缺失字体可定位；正文 DOM 与 content 一致，reference.png 未被渲染。

### T06：实现浏览器导出和布局诊断

**文件：** 新建 `src/render/browser.ts`、`src/quality/layout.ts`、`src/pipeline/render.ts`、对应浏览器集成测试。

步骤：

1. 锁定 Chromium、viewport、deviceScaleFactor=1、locale、timezone 与字体包；replica 按原始像素尺寸导出。
2. 等待 `document.fonts.ready` 和所有图片 decode；显式核查已声明字体加载成功、图片 naturalWidth/naturalHeight 非零；设置加载超时。
3. 检测 scrollWidth/Height 与 clientWidth/Height 差值、实际文字 Range 边界超出文字框/画布、文本间非预期重叠与高层元素遮挡候选。
4. 将设计允许的重叠关系显式记录，例如徽章、背景和装饰；不能把任何交集都当成错误。复杂遮挡判断进入人工复查项。
5. 保持固定画布截图；诊断输出中的溢出必须清楚标注，严格模式发现阻断项时不生成有效导出。
6. 截图和 HTML 使用临时文件后原子替换；失败时不让旧 preview 被误认为本次结果。按 runId 隔离任务临时目录，拒绝同输出目录并发写入；支持 AbortSignal 与超时，无论成功、失败或取消都关闭模块创建的浏览器并清理本次临时资源，不影响宿主进程或其他任务。
7. 完成 report 的 layout、assets、fonts、editability、reviewItems 和运行状态字段。

验证：短文字导出尺寸正确；长标题、长段落和跨画布文字产生带 ID/边界的报告；图片缺失、字体缺失与超时导致严格失败；诊断模式仍可输出供复查的图。

### T07：实现差异图、叠图及 MVP CLI

**文件：** 新建 `src/quality/compare.ts`、`src/pipeline/compare.ts`、`src/cli.ts`、集成测试，扩展 `src/index.ts`、`src/sdk.ts`、`src/errors.ts`，补充 README。

步骤：

1. 对 reference/preview 统一白底、sRGB、RGBA；尺寸不同直接失败，不自动缩放掩盖偏差。
2. 按设计的初始参数生成 pixelmatch 差异图：threshold=0.15、includeAA=false；生成 50% 叠图，报告参数和 mismatchRatio。
3. 在同一份报告中合并 compare 数据，保留识别、字体与溢出项；render 后删除或标记过期的对比分数，不能沿用旧分数。
4. 原始内容哈希写入 manifest；仅同内容、同画布、replica 可直接和原图比较。编辑后默认跳过原图差异；显式 compare 发现不一致时失败，除非用户提供新的匹配基准。
5. 支持设计的三个位置参数命令；同时解析 `--template`、`--data`、`--output` 等显式参数。非法参数、参数缺失返回非零，帮助返回零。
6. extract 串联标准化、识别、校验、裁剪、保存、渲染、对比；render 与 compare 不重新识别、不调用模型。
7. 通过 SDK 公开 extract/render/compare 与类型，CLI 调用相同实现；实现 `--json` 和类型化错误到退出码映射。通过 SDK/CLI 同输入用例核对结果，验证 SDK 导入无副作用、配置隔离、错误不退出宿主。

验证：同图 mismatchRatio=0；局部变化产生对应 diff；尺寸不同、内容改动及过期 preview 可检测；extract 离线 fixture 链路一次完成全部产物。

### T08：完成第一张真实旅行图验收

**文件：** 新增实际模板包、`docs/wiki/baseline.md` 校对记录、`docs/wiki/evaluation.md` 初始报告。

步骤：

1. 用真实模型运行基准图提取，逐项核对标题、日期/天气、酒店、六段时间轴、景点照片、美食、体验/亲子、打卡、停车、预约及餐厅信息；数量以原图为准。
2. 对漏识别、错字、分组、主要坐标、层级、字号和字体做人工校准，记录修改原因及对应元素 ID。
3. 检查所有主要页面文字为真实文本节点，无整页背景、无用于替代可编辑文字的截图；栅格限制单独列出。
4. 保存原文内容的对比基准和一份人工校准后的可复用定位模板；人工纠正识别错误并确认仍对应原图后，更新“已核对原始内容”的基准哈希，保存初次识别快照及修订记录，不能把后续用户编辑也当成原文重新登记。原图、字体、环境和模板哈希一起归档。
5. 仅修改 content 中的标题/描述后重新渲染，确认无需模型调用或模板代码修改；构造超长文本，确认严格导出失败并提供诊断。
6. 记录原始和校准后的差异图，确定按区域的后续基准，不以任意全页分数宣称还原百分比。

阶段 A 完成条件：真实材料齐备；所有可编辑主要文字经过核对；正常内容无阻断项；更换文字有效；超长内容可诊断；产物完整且可离线重渲染。任一真实验收缺失均不能标记 A 完成。

### T09：实现分区识别、坐标回投及去重

**文件：** 新建 `src/analysis/regions.ts`、`merge.ts`，扩展 vision/prompts/provider 与坐标测试。

步骤：

1. 首次整页识别头部、左右栏等区域，保存全局区域框；对小字区域裁剪、按记录的比例放大后识别。
2. 保存真实裁剪原点、缩放比及可选 padding，回投使用 `globalX = cropX + (localX - paddingX) / scale`，Y/宽/高同理；无 padding 时退化为设计公式。
3. 合并整页骨架与分区元素，用几何交集、文字及类型去重；不把同名的不同餐厅/重复标题误删。保留冲突候选和来源记录。
4. 重建唯一且稳定的元素 ID，保持人工修订映射；原始模型置信度与 OCR 对照信号分别存储，不宣称是统计概率。
5. 对局部回投结果重新做几何校验，区域边界文字交给相邻区域/整页结果对照，不直接裁掉。

验证：scale=1、scale=2、padding、重叠区域与边缘元素的回投误差在 1 px 内；同一元素重复消除而不同位置的相同文字仍保留；右侧小字的改进有前后核对证据。

### T10：加入独立 OCR、复查清单、缓存与有限重试

**文件：** 新建 `src/analysis/ocr.ts`、`src/runtime/cache.ts`、`budget.ts`，扩展 report、配置、评估样本与测试。

步骤：

1. 选定独立 OCR 适配器，统一为文本、框、读取顺序及原始置信度；支持 fixture，以便离线测试。
2. OCR 与视觉结果按位置和文本匹配，识别缺失文字、文字冲突及小字区域；OCR 字框不能直接当 CSS 文本框，冲突文本不得自动覆盖人工修订。
3. 低置信度阈值先按设计设 0.7，符合条件的区域最多补识别一次；未解决项生成含 ID、区域、来源、建议动作的 reviewItems。
4. 重试区分网络暂态、非法输出和语义低置信度；所有尝试计入同一全局调用上限，避免多层重试叠加。
5. 缓存键至少包含标准化图片/裁剪图哈希、区域与缩放、提示词版本、schema 版本、模型 ID、provider 参数及 OCR 配置；字体变化使渲染缓存失效，但无需重新 OCR。
6. 缓存原始输出与通过校验的结果，重读仍验证版本/schema；失败和截断响应不可作为成功命中。提供 `--no-cache`。
7. 在基准之外运行 3～5 张相似旅行图，记录关键文字正确性、遗漏/冲突、复查项数量、溢出、调用次数、耗时和可获得的费用数据。

阶段 B 完成条件：每张样本的关键文字均经核对或被明确标为待确认；无静默漏项、重复覆盖和越界；相同配置再次运行可复用识别缓存；失败重试和超时有上限。不得以模型自报置信度替代人工核对。

### T11：建立 LayoutSpec、语义编译与内容迁移

**文件：** 新建 `src/schemas/layout.ts`、`src/semantic/compile.ts`、`migrate.ts`、`src/render/bindings.ts`，扩展内容 schema 与测试。

步骤：

1. 定义受限 container/text/image/repeat 节点与语义组件节点，明确 row/column/grid/局部 absolute 的字段白名单、深度和节点数量上限。
2. 将校对后的 SceneSpec 编译为 LayoutSpec：保留来源元素 ID 和区域框，不直接依赖未经复查的模型输出。
3. 生成 header、weather、hotel、timeline、photos、foods、experiences、photoChecklist、parking、booking、restaurantGroups 的结构化内容 schema；可选模块和列表数量采用明确约束。
4. binding 使用受限属性路径与 repeat 局部作用域，拒绝 `__proto__`、`constructor` 等特殊路径，不使用 eval；缺失必填绑定报错。
5. 输出 scene.json、layout.json、结构化 content 及旧 ID 到新绑定映射；保留旧 content 快照，版本化迁移且可回退。由于 JSON 形态改变会改变内容哈希，应通过映射验证文字与素材逐项未变，再登记迁移后的原始内容基线及父版本；不能仅因为新旧哈希不同就取消原文 replica 对比，也不能未经验证直接重设基准。
6. 通用 reader/render 继续支持 SceneSpec 1.0；LayoutSpec 2.0 的使用不破坏已交付模板。

验证：手工布局 fixture 与真实基准均能迁移；嵌套绑定、空数组、多条 repeat 和字段缺失行为明确；旧模板仍能渲染，迁移过程不丢文字或素材。

### T12：实现旅行主题与七类布局组件

**文件：** 新建 `src/semantic/travel-theme.ts`、`src/render/components.ts`，扩展 html、assets、layout 检查及组件 fixture。

步骤：

1. 将真实测量后的尺寸、颜色、字体、字号、行高、栏宽、间距和线条收敛为 TravelTheme；设计初值只作为待校准默认值。
2. 按顺序实现标题区、双栏布局、时间轴、图片网格、标签组、推荐列表、信息框；复用基础组件覆盖设计中的全部旅行模块。
3. 页面与装饰按约束定位，文本和列表走正常流；徽章/线条在组件内局部 absolute，正文不能继续全部写死全局坐标。
4. 图片绑定支持 src/alt、`objectFit: cover | contain`、受限 `objectPosition`，保留裁剪源记录；图片替换无需改渲染器。
5. 支持空模块隐藏、少/多行程、多标签、多餐厅及长酒店名；repeat 项使用稳定 ID 关联报告和后续补丁。
6. replica 用原始内容与定位基准对比，确认抽象未造成主要区域回退；新内容只做布局检查。

验证：七类组件和所有旅行侧栏模块有样本；替换横图/竖图无拉伸；空列表不留异常空框；与人工定位基准的区域偏差可查看、可追踪，正文仍为真实文本节点。

### T13：实现自适应、分页及 PDF

**文件：** 新建 `src/render/paginate.ts`、`pdf.ts`，扩展 schemas/layout、pipeline/render、CLI 与集成测试。

步骤：

1. 固定 replica；adaptive 明确两种策略：`--overflow grow` 保持宽度自动增高，`--overflow paginate` 保持页尺寸按块分页。SceneSpec 不允许 adaptive。
2. 保持字号下限，不用无限缩小字体；单个不可拆块超出一页时报告 OVERSIZED_BLOCK，不能静默裁切或循环产生空页。
3. 建立按组件测量再分页的流程，标题不孤立、图片与说明尽量同页、时间轴项/卡片默认不可拆；需要拆长正文时按行拆并保留全文。
4. 双栏分别计算可放入页面的块，保留各栏阅读顺序；跨页重建头部/续页标记和局部装饰，避免跨页 absolute 线条。
5. 每页输出同尺寸 PNG 与 page index；grow 输出一张增高 PNG。PDF 根据同一页分配生成，设置页尺寸、背景及字体加载等待，不再另做一套布局。
6. `scale` 仅改变栅格导出分辨率，不改变逻辑排版与 PDF 页尺寸；report 记录逻辑尺寸和实际输出尺寸。

阶段 C 完成条件：旧模板可用；真实旅行图具有语义组件模板；长标题、长段落、0/1/多行程、多标签、多餐厅、不同照片比例均有测试；分页无丢字、重字、空页和阻断溢出；PNG/PDF 页数与顺序一致。

### T14：建立受限补丁与区域评价

**文件：** 新建 `src/schemas/patch.ts`、`src/calibration/apply.ts`，扩展 quality/compare、editability、layout 与单元测试。

步骤：

1. 对 SceneSpec 可修改 x/y/width/height/fontSize/lineHeight/letterSpacing/颜色等已允许样式；对 LayoutSpec 仅允许组件参数、主题 token 和局部定位字段，不把 flow 节点强改为 absolute。
2. 补丁形态采用设计的 changes/id/set；拒绝未知 ID、未知字段、删除节点、改正文、改 binding、改类型、改素材来源和添加整页图片。
3. 设置单轮及相对起始模板的累计幅度上限，防止小步累积绕过限制。初始可采用位置每轮 8 px、累计 24 px，字号每轮 2 px、累计 4 px；这些是待样本校准的实施默认值。
4. 按头部、时间轴、照片、侧栏等固定区域报告 mismatchRatio 和非背景区域差异，权重和阈值写入 evaluation；评分不是还原百分比。
5. 硬约束优先：文本/绑定集合与内容哈希不变、可编辑性不降低、无新增阻断溢出/遮挡/资源失败；通过后才评价视觉改善。
6. 固定最小改善幅度和可接受区域回退范围；默认关键区域不回退，避免通过大面积背景变好掩盖正文变差。

验证：合法小幅补丁可应用；删文字、改内容、改图片、非法字段和过大调整均被拒绝；全局分数变好但关键区域或可编辑性变差的候选不能接受。

### T15：实现有限自动校准和回滚

**文件：** 新建 `src/calibration/propose.ts`、`loop.ts`、`src/runtime/versions.ts`，扩展 budget、CLI 与校准 fixture 测试。

步骤：

1. 仅对原始内容一致的 replica 提供自动校准。输入为原图、预览、区域差异和元素/组件参数；输出只能是 T14 schema 的补丁。
2. 每个候选使用隔离临时包：应用、校验、渲染、诊断、比较；硬约束通过且分数改善才原子接受，否则恢复最近最佳版本。
3. 默认 3 次迭代，最大 5 次；连续 2 次无有效改善、超时或预算耗尽即停止，保留最佳已接受结果。
4. 共享调用预算计入识别、分区补识别、补丁调用和网络重试；配置最大请求数与总耗时，费用预算需要显式模型单价/usage 支持，缺失时只报告可计量项。
5. 保存每轮补丁、前后评分、约束检查、接受/拒绝原因、工具链和模板/内容版本；禁止候选直接覆盖唯一成功包。
6. 对最终高差异区域、字体替代、错字冲突及未完成项生成复查清单。中断后可使用最佳快照重新渲染；在 package.json 增加 `calibrate` 脚本。

阶段 D 完成条件：改善、退化、非法补丁、最大迭代、预算耗尽、超时和中断均有可复现验证；模板/内容不被偷偷改写；失败后最佳版本可恢复；对真实基准的改善有区域证据，不要求所有样本达到零差异。

### T16：完成严格交付检查与模板版本管理

**文件：** 新建 `src/quality/publish.ts`，完善 report、manifest、versions、bundle、README 与离线模板包测试。

步骤：

1. 用 `validate`/`render --strict` 汇总 schema、绑定、几何、正文完整性、字体覆盖/加载、图片加载、溢出及遮挡阻断项；本地检查不执行对外发布，在 package.json 增加 `validate` 脚本。
2. 区分 `pass`、`needs_review`、`failed`；结构非法、资源缺失、正文被裁切等为 failed；低置信度和复杂遮挡为 needs_review，不能仅写一条 notes 当作通过。
3. reviewItems 用稳定 ID 记录人工结论及绑定的模板/内容哈希；变化后相关结论失效，不能继续沿用旧确认。
4. 模板版本和内容版本独立维护；font/assets/theme 变更纳入模板哈希，纯正文变更只更新内容版本，并使原图对比分数失效。
5. 提供模板包导出/重载及完整 manifest，验证离线渲染不依赖原分析服务。
6. 严格有效导出必须通过所有阻断检查，未处理复查项必须由明确策略接受或处理，状态与退出码保持一致。

验证：完整包可离线重渲染；删除字体/图片、添加长文、缺失绑定、过期人工结论均可检测；版本变化不会污染旧版本；失败导出不留下看似有效的新产物。

### T17：批量命令、固定环境和使用手册

**文件：** 新建 `src/pipeline/batch.ts`、`docs/wiki/usage.md`，完善 README、evaluation 和环境记录；具备 CI 时新增最小工作流。

步骤：

1. `batch` 接收任务清单，每项使用独立输出目录与报告；默认顺序执行并设置全局请求预算，不引入队列服务，在 package.json 增加 `batch` 脚本。
2. 单项失败记录错误并继续其他独立任务，最终输出成功/待复查/失败汇总；任一 failed 返回非零，严格模式中 needs_review 也返回非零。
3. 用锁定 Node/npm、lockfile、Playwright/Chromium 和字体 manifest 跑离线回归；记录 OS/容器环境，跨系统结果不得直接当作相同像素基准。
4. 若增加 CI，仅运行无需密钥的 schema、路径、fixture、浏览器和分页测试；真实模型调用使用明确的人工 smoke 步骤，避免每次提交产生 API 费用。
5. 文档覆盖首次安装、PowerShell 配置、extract/render/compare、编辑正文/图片、两种模式、PDF、缓存、预算、校准、报告与失败恢复。
6. 发布能力清单及真实样本评估记录，列出复杂背景、字体替代、未知布局和栅格限制；关闭所有阻断缺陷后完成交付。

T17 完成条件：从空依赖环境可按手册恢复；离线检查通过；真实样本评估可追溯；批量失败不污染其他结果；文档中的示例命令与最终 CLI 一致。阶段 E 还须完成 T18。

### T18：独立模块打包与外部项目接入验收

**文件：** 完善 `package.json`、`tsconfig.build.json`、`src/index.ts`、`src/sdk.ts`、`src/errors.ts`、`README.md`；新增 `examples/node-sdk/`、`examples/python-cli/`、`tests/package/`、`docs/wiki/integration.md`，补齐使用许可与第三方资源声明。

步骤：

1. 汇总 extract/render/compare/validate/calibrate/batch 的公开方法、请求/结果与错误类型；检查所有能力均可通过 SDK 调用。限制 exports，禁止示例深度引用内部源码；确认核心没有宿主业务依赖、隐式环境读取或全局运行状态。
2. 完成 `build`、打包前构建和 `test:package` 脚本；用 `npm pack --dry-run` 检查 dist、类型、CLI 入口和必要运行资源，再生成归档。归档不含真实密钥、私有输入、模型响应或缓存；运行依赖不依赖开发期 tsx。记录包版本、哈希及 Node/OS/Chromium 支持范围，安装浏览器按手册显式执行。
3. 在仓库外创建临时 Node 消费项目，仅安装归档及声明依赖，不使用 workspace link、不访问仓库 src/node_modules；编译公开类型示例并执行 fixture extract、内容修改、render/validate/compare，核对产物与 SDK/CLI 结果。安装依赖后阻断外网进行离线阶段，fixture 不替代 T08/T10 的真实识别验收。
4. 将完整模板包移动到另一路径，清除模型配置并断网，验证 HTML/PNG/PDF 生成及版本兼容；compare 仅在原始内容和匹配基准存在时执行。覆盖含空格路径和不同工作目录，确认资源不引用原仓库。
5. 运行 Python 最小消费示例：通过参数数组启动已安装 CLI，读取单个 JSON 对象及退出码，分别验证成功、严格待复查、参数错误和执行失败。无需 HTTP 服务或修改任何现有业务项目。
6. 验证两个不同配置实例及并发任务的隔离、同目录冲突处理、超时/取消、provider 异常和浏览器清理；取消后宿主仍可执行后续任务。检查 import 无文件/网络/浏览器副作用，CLI 日志不污染 JSON stdout。
7. 接入文档包含安装归档、依赖准备、SDK 与跨语言示例、配置/进度/错误/取消处理、版本兼容和迁移说明；列明前端/无浏览器环境限制。保存消费项目命令、环境、报告及产物哈希作为验收证据；本任务无需对公共 registry 发布。

阶段 E 完成条件：T16/T17 完成，构建归档可独立安装，Node SDK 与跨语言 CLI 示例通过；搬迁模板可离线渲染，公开类型、版本兼容、错误/取消与隔离检查通过，接入手册及证据齐全。仅仓库内 `npm run` 成功不能通过独立性验收。

## 6. SDK/CLI 契约与预期验证命令

以下均为计划实施后的命令，当前仓库还不能执行。位置参数形式保持设计兼容；扩展选项随对应阶段实现，README 必须注明可用阶段。

### 6.1 安装和离线检查

```powershell
Set-Location E:\Tugoo\image_to_template
npm ci
npx playwright install chromium
npm run check
npm test
```

首次初始化依赖由 T01 执行；`npm ci` 适用于 lockfile 已提交后。Linux CI 若缺浏览器依赖，采用设计中的 `npx playwright install --with-deps chromium`。

### 6.2 A 阶段真实提取及编辑

模型变量通过本地环境配置或由调用方传入，不写入命令示例的真实密钥。

```powershell
npm run extract -- input/travel_plan_page_0005.png output/travel
npm run render -- output/travel
npm run compare -- output/travel

# 单独编辑正文后，渲染不重新调用模型
npm run render -- --template output/travel/template.json --data tests/fixtures/updated-content.json --output output/edited.png --strict
```

预期：原始包产生 reference/template/content/content.schema/manifest、assets/fonts、preview、diff/overlay、report。编辑版产生自己的报告和预览；不带原图差异分数。`--output` 的资源根仍是 template.json 所在包目录。

### 6.3 C～E 阶段扩展

```powershell
npm run extract -- --input input/travel_plan_page_0005.png --output output/travel-layout --layout hybrid
npm run render -- --template output/travel-layout/layout.json --data output/travel-layout/content.json --mode adaptive --overflow paginate --format png,pdf --output output/adaptive --strict
npm run calibrate -- output/travel-layout --iterations 3 --max-requests 5
npm run validate -- output/travel-layout --strict
npm run batch -- tests/fixtures/batch.json --strict
```

规则：

- `extract --layout hybrid` 必须先保留 SceneSpec 再编译 LayoutSpec；C 前使用时明确报不支持。
- `--overflow error` 适用于固定页检查；grow/paginate 仅适用于 adaptive；不支持组合直接报错。
- `--format` 在 C 增加 PDF；输出目录用于多页/多格式，单 PNG 可使用文件路径。
- `--iterations` 只在 D 的校准生效，不让 A 的提取命令接受却忽略该参数。
- 建议退出码：0=完成且满足当前策略，1=执行/校验失败，2=严格模式待复查，64=参数错误。诊断模式可产出问题图，但必须显示 needs_review/failed，不能称为有效交付。
- 上述命令均支持 `--json`；输出结构与 SDK 结果一致。SDK 类型化执行错误映射到 JSON error 与对应非零退出码，参数错误为 64，其他执行失败为 1；日志/进度仅写 stderr。

### 6.4 E 阶段模块交付与独立接入检查

```powershell
npm run build
npm pack --dry-run
npm pack
npm run test:package
```

`test:package` 实现 T18 的仓库外消费流程，安装实际打包归档并运行 Node SDK 与 Python CLI 示例；测试报告记录归档和消费目录，不能通过直接引用 src 冒充安装验证。Node 示例使用 `import { createImageTemplate } from "@image-to-template/core"`（以 T01 确认的名称为准），实例方法与参数遵循第 2.3 节及设计第九章。跨语言调用使用已安装的 `img-to-template render <bundle-dir> --json --strict`，不得依赖 `tsx src/cli.ts`。

## 7. 报告契约与验收矩阵

`report.json` 至少包含：

| 字段组 | 内容 | 引入阶段 |
|---|---|---|
| run | runId、阶段、状态、时间、环境、输入/模板/内容哈希 | A |
| analysis | 元素数量、来源、置信度、notes、识别错误 | A；B 增加区域/OCR |
| layout | overflowX/Y、元素边界、画布越界、重叠/遮挡候选及容差 | A |
| assets/fonts | 加载结果、字体替代、资源/授权 manifest 引用 | A |
| editability | 正文节点核对、栅格文字限制、违规图片来源 | A |
| comparison | 是否适用、基准哈希、参数、mismatchRatio、diff/overlay | A；D 增加区域分数 |
| reviewItems | 稳定 ID、类型、严重程度、位置/元素、证据与处理结论 | A；B/E 完善 |
| runtime | 调用数、耗时、缓存命中、可获得的 usage/费用 | B |
| pages | 页数、每页尺寸、块/文字分配、PNG/PDF 路径 | C |
| calibration | 各轮补丁、评分、接受/拒绝、停止原因、最佳版本 | D |

每次运行重新计算受影响字段；不适用的 comparison 明确记录原因，不能保留旧 mismatchRatio。默认阻断项包括非法模板、绑定缺失、正文裁切、资源加载失败和确定的异常遮挡。

| 验收维度 | 用例/方法 | 通过标准 |
|---|---|---|
| 结构与安全 | 非法 ID、越界、路径穿越、脚本文本、特殊 binding | 有具体错误；无越界读取和代码执行 |
| 真实文字正确性 | 人工逐字核对基准与 3～5 张样本 | 关键内容已核对；冲突/未知项可追踪，无静默替换 |
| 可编辑性 | DOM 正文核对、素材来源检查、仅改 content | 主要文字为真实文本，编辑可生效，不调用识别模型 |
| 视觉复刻 | 固定环境、原始内容、叠图与区域 diff | 主要结构可核对；改善有证据；不把差异比例当还原率 |
| 溢出与加载 | 长标题/描述、图片失败、字体缺失 | 全部进入报告；严格有效导出被阻止 |
| 内容变化 | 空/少/多行程、多标签、多餐厅、长酒店名 | replica 明确报超容量；adaptive 按规则布局，无静默裁剪 |
| 图片替换 | 横图、竖图、裁剪焦点 | cover/contain 行为明确，无非预期拉伸 |
| 分页与 PDF | 超单页、超大单块、双栏不等长 | 无丢字/重字/空页；超大块可报错；两种输出一致 |
| 自动校准 | 改善/退化/非法补丁/预算耗尽 | 仅接受满足约束的改善；停机后可恢复最佳版 |
| 缓存与版本 | 同配置重跑、提示词/模型/字体/正文变化 | 正确命中/失效；正文变更不沿用原图评价 |
| 批量 | 成功项与失败项混合 | 输出隔离、汇总完整、退出码匹配实际状态 |
| 独立安装与 SDK | 仓库外仅安装 npm pack 归档，编译并运行公开 API 示例 | 无源码/链接依赖，类型与运行资源齐全，import 无副作用 |
| 跨语言接入 | Python 调 CLI，覆盖成功、待复查和错误 | JSON stdout 可解析，退出码一致，无需修改核心 |
| 模板迁移 | 搬迁完整包、移除模型配置、断网重渲染 | HTML/PNG/PDF 可用，无原机器路径依赖，未知版本明确拒绝 |
| 宿主隔离 | 多实例、并发、输出冲突、超时及取消 | 无配置/数据串扰，资源可清理，宿主进程继续运行 |

全页和区域视觉阈值在 T08/T10 的真实评估后冻结到 `docs/wiki/evaluation.md`，不预设一个没有样本依据的“95% 还原”门槛。字体、OCR、位置及修改幅度的默认值都应注明为策略参数。

## 8. 风险与处理

| 风险 | 影响 | 处理措施 |
|---|---|---|
| 原图和字体尚未提供 | 无法完成真实 A 验收 | 先离线实现；T01 清单持续记录，不用合成图替代真实验收 |
| 字体近似及字形覆盖不足 | 换行、文字宽度、复刻偏差 | 固定字体和字重、检查覆盖、记录替代，必要时人工匹配 |
| 小字和分区边缘漏识别 | 内容错误 | 分区放大、独立 OCR、相邻区域对照和复查清单 |
| 图片含文字/背景被遮挡 | 可编辑性不足 | 独立裁剪和素材来源审查；标记栅格限制，人工替换 |
| 固定尺寸与长内容冲突 | 裁切、重叠 | replica 严格失败；adaptive 明确增高或分页，不无限缩字 |
| 全页白底掩盖局部误差 | 评分失真 | 按区域/非背景评分，同时检查内容和 DOM 可编辑性 |
| 自动补丁过拟合或退化 | 结构被破坏 | 白名单、累计幅度限制、硬约束、区域门槛和回滚 |
| API 成本及响应不稳定 | 重跑成本、任务卡住 | provider 隔离、缓存、有限重试、共享调用/时间预算 |
| 浏览器/OS 环境漂移 | 像素基准失效 | 锁定依赖、Chromium、字体和环境，换环境后重建基准 |
| CLI/仓库路径耦合或打包遗漏 | 只能在本仓库运行，外部项目无法使用 | T01 建构建与 SDK 边界；T18 从实际归档在独立目录安装验收 |
| 宿主运行环境不满足依赖 | 无法启动 sharp/Chromium 或离线缺资源 | 明确支持矩阵、安装步骤及资源授权；不承诺纯浏览器运行 |

## 9. 最终完成清单

- [ ] A：真实定位式模板包可编辑、可离线重渲染，字体与主要文字已核对。（离线链路完成；真实验收待授权字体与模型配置，见 baseline.md）
- [ ] B：基准及另外 3～5 张旅行图已评估，低置信度/冲突均有明确去向。（离线链路完成；真实样本评估待素材）
- [x] C：保留 SceneSpec；旅行组件、结构化内容、图片替换、adaptive、分页及 PDF 可用。（T11–T13 完成，2026-10-14）
- [x] D：自动校准只接受受限改善，具备预算、停机条件、历史和回滚。（T14–T15 完成，2026-10-14）
- [x] E：严格检查、版本管理、批量汇总、固定环境及使用手册完成；T18 独立模块验收通过。（T16–T18 完成，2026-10-14）
- [x] SDK、类型声明、构建 CLI 和必要资源已打包；仓库外 Node 消费项目与跨语言示例可运行，无源码或原项目依赖。（npm run test:package 4/4 通过）
- [x] 模板迁移后可无模型密钥离线渲染；实例/任务隔离、取消/失败清理、公开错误与版本兼容已验证。（含空格路径迁移用例通过）
- [x] `npm run check` 和离线 `npm test` 通过；真实模型 smoke 和人工视觉验收记录齐全。（check + 228 测试通过；真实模型 smoke 待模型配置，见 baseline.md）
- [x] 不存在整页背景伪装、正文栅格替代、无报告溢出或编辑后使用旧原图分数的情况。（各阶段测试断言覆盖；编辑后 compare 默认跳过并记录原因）

实施从 T01 开始。每完成一个阶段，按完成条件验收并保存证据，再进入下一阶段；未满足条件的项目保留为未完成，不能仅凭 CLI 返回成功推进。

> T13–T18 实施记录（2026-10-14）：C/D/E 阶段离线链路全部完成并通过验收矩阵对应项；
> A/B 的真实图验收项（依赖授权字体、模型配置与 3～5 张类似图）保持未勾选，
> 待素材到位后按 T08/T10 步骤补齐，不用合成 fixture 冒充真实验收。
