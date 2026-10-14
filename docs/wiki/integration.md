# 独立模块接入手册（integration）

面向把 `@image-to-template/core` 集成到其他项目的开发者。
验收证据见 `tests/package/package.test.ts`（`npm run test:package`）。

## 1. 交付物与支持范围

| 项 | 值 |
|---|---|
| 包名 | `@image-to-template/core`（私有归档交付；公共 registry 发布不是验收前提） |
| CLI 命令 | `img-to-template` |
| 归档 | `image-to-template-core-0.1.0.tgz`（`npm pack` 产出；含 dist、类型声明、bin、README） |
| 运行时 | Node.js ≥ 20（验收环境 v24.13.0，Windows 21H2） |
| 浏览器 | Playwright Chromium（安装归档后需执行一次 `npx playwright install chromium`） |
| 模块形态 | ESM only（`"type": "module"`；`exports` 仅暴露 `.`，禁止深路径引用） |

归档不含：真实密钥、`.env`、`input/` 私有图片、模型响应、缓存、测试与文档。

## 2. 安装归档（Node 项目）

```powershell
# 1. 构建并生成归档（在模块仓库内）
npm run build
npm pack                      # 产出 image-to-template-core-0.1.0.tgz

# 2. 在消费项目安装（仅归档；不用 workspace link）
npm install --no-audit --no-fund <归档绝对路径>

# 3. 安装浏览器（每环境一次）
npx playwright install chromium
```

安装后 `node_modules/.bin/img-to-template(.cmd)` 可用；
`import { createImageTemplate } from "@image-to-template/core"` 无文件/网络/浏览器副作用。

## 3. Node SDK 示例

完整示例：`examples/node-sdk/example.mjs`。最小用法：

```js
import { createImageTemplate } from "@image-to-template/core";

const instance = createImageTemplate({
  logger: (message, detail) => console.error(`[log] ${message}`, detail ?? ""),
});

const rendered = await instance.render({ template: "path/to/bundle" });
const validated = await instance.validate({ bundle: "path/to/bundle" });
const compared = await instance.compare({ bundle: "path/to/bundle" });
```

- 实例方法：`extract / render / compare / validate / calibrate / batch`；
  请求/结果类型从同一入口导出。
- `extract` 需在配置中显式传入 `vision`（模型 ID 与密钥）；SDK 不读取环境变量、
  不加载 `.env`。`render / compare / validate` 不需要模型。
- 配置在创建实例时解析并拷贝：两个实例的 logger/预算/provider 互不串扰。
- 操作支持 `AbortSignal` 与 `timeoutMs`；类型化错误 `ImageTemplateError`
  含 code/stage/message/runId/retryable，不会 `process.exit`。

## 4. 跨语言 CLI 示例（Python）

完整示例：`examples/python-cli/example.py`。约定：

- 通过参数数组启动 `img-to-template`，`--json` 时 **stdout 恰好一个 JSON 对象**
  （结果或 `{error}`）；日志/进度仅 stderr。
- 退出码：0=完成（非严格 needs_review 视为完成）、1=执行/校验失败、
  2=严格待复查、64=参数错误。

```python
import json, subprocess

def run_cli(args):
    proc = subprocess.run(["img-to-template", *args, "--json"],
                          capture_output=True, text=True, encoding="utf-8")
    return proc.returncode, json.loads(proc.stdout or "null")
```

## 5. 模板包迁移（离线渲染）

完整模板包（template/content/manifest/assets/fonts）可整体复制到任意路径
（含空格路径）后直接渲染；资源以包目录为根，不引用原机器路径、不需要模型密钥：

```powershell
npm run render -- "D:\my projects\travel bundle"
npm run render -- "D:\my projects\travel bundle" --mode adaptive --format png,pdf
```

- 未知模板/报告版本明确拒绝（UNSUPPORTED_VERSION）。
- compare 仅在原始内容与匹配基准存在时执行；内容编辑后需提供 `--reference`。

## 6. 版本兼容与错误处理

- 模板（SceneSpec 1.0 / LayoutSpec 2.0）、内容、manifest、报告版本独立；
  reader 按版本分发，未知版本拒绝。
- 破坏性变更有迁移说明；`migrateBundle` / `rollbackMigration`（SDK 导出）
  支持 1.0 → 2.0 迁移与回退。
- 并发与隔离：同输出目录并发写入拒绝（CONFLICT）；任务目录按 runId 隔离；
  失败/取消清理临时资源并关闭模块创建的浏览器，不终止宿主进程。

## 7. 环境限制

- 前端/无浏览器环境不可用（渲染依赖 Playwright Chromium；不承诺浏览器直接运行 SDK）。
- 像素对比结果依赖环境（Chromium/字体/OS）；跨系统结果不作为相同像素基准
  （见 evaluation.md 环境事实）。
- Windows：`npm pack` 生成的 `.bin` shim 为 `.cmd`；跨语言调用用完整路径 + shell。
