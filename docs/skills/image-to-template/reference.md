# reference — SceneSpec 字段核对表与常见错误处理

供执行 image-to-template skill 时查阅：第 2 步构造 spec 的字段标准、
第 3/5 步遇到错误时的处理对照。

## SceneSpec 字段核对表

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 固定 `"1.0"` |
| `canvas.width` / `canvas.height` | 是 | 图片真实像素尺寸（来自 prompt 命令锚定） |
| `canvas.background` | 是 | 页面底色 `#RRGGBB` |
| `elements[].id` | 是 | 全局唯一；`A-Za-z0-9_-`（如 `title`、`photo_1`、`header_bg`） |
| `elements[].type` | 是 | `text` / `image` / `box` |
| `elements[].x,y,width,height` | 是 | 像素坐标（左上原点）；元素必须在画布内 |
| text 的 `text` | 建议 | 逐字转录的正文；程序自动分离到 content.json |
| text 的 `fontSize` | 否 | 默认 14 |
| text 的 `fontFamily` | 否 | `sans` / `serif` / `latin`，默认 `sans` |
| text 的 `fontWeight` | 否 | `"400"` / `"700"`，默认 `"400"` |
| text 的 `color` | 否 | `#RRGGBB`，默认 `#333333` |
| text 的 `lineHeight` / `letterSpacing` / `align` | 否 | 默认 1.4 / 0 / left |
| image 的 `src` | 留空 | `""`；程序按坐标从原图裁剪并回填 `assets/<id>.png` |
| box 的 `fill` | 否 | `#RRGGBB` 或 `transparent`，默认 transparent |
| box 的 `borderColor/borderWidth/radius` | 否 | 默认 `#CCCCCC` / 0 / 0 |
| `elements[].zIndex` | 否 | 底色 0~1、照片 1~2、文字 2+；默认 1 |
| `elements[].confidence` | 否 | 0~1 自评；默认 0.5 |
| `notes` | 否 | 不确定项的说明数组 |

元素划分原则：
- 一段连续多行文字可合为一个 text；独立标题/标签/时间/编号各一个 text；
- 照片坐标贴紧素材可见边缘；
- **禁止**整页或含大段文字的区域做成 image；**禁止**同一文字既在 text 又被裁进图片。

## 常见错误与处理

校验错误消息带 `[CODE] elements[n]` 路径，按 CODE 对照处理（只改点名的元素）：

| 错误码 | 含义 | 修复 |
|---|---|---|
| `OUT_OF_CANVAS` | 元素越出画布（含 1px 容差说明） | 收缩 width/height 或挪回 x/y，使 x+width ≤ 画布宽、y+height ≤ 画布高 |
| `DUPLICATE_ID` | 重复元素 ID | 给后出现的元素换唯一 ID（如 `title_2`），或删除误加的副本 |
| `SCHEMA` | 字段类型/枚举/缺字段（消息带字段路径） | 按消息修正：颜色必须 `#RRGGBB`、fontFamily 只能三选一、数值必须有限数 |
| `INVALID_ASSET_PATH` | image src 非包内相对路径 | src 应留空 `""`（程序自动裁剪回填），不要写绝对路径/URL/`..` |
| 画布尺寸不一致 | spec canvas ≠ 图片实测尺寸 | 把 canvas 改成错误消息里的"图片实际尺寸"；若提示词尺寸不符则重跑第 1 步 |

其他情况：

- **JSON 解析失败**：多为输出被截断——检查 spec 文件首 `{` 末 `}` 完整；
  从模型多段输出拼接时确认无遗漏。
- **extract 失败但 validate-spec 通过**：多为运行环境问题（Chromium 未安装），
  运行 `npx playwright install chromium`；不要改 spec。
- **diff 全页飘红**：先核对 canvas 与图片是否同一版本（传错图最常见）；
  再按区域逐块修正，避免整体重写 spec。

## 环境要点

- 命令统一在仓库根目录执行；Windows PowerShell 语句分隔用 `;`（不支持 `&&`）。
- `.agent/` 为工作目录（git 已忽略）。
- Node ≥ 20；Playwright Chromium 首次使用需安装。
