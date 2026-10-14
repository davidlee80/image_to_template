/**
 * Node SDK 最小消费示例（T18 步骤 3）。
 *
 * 仅使用公开契约：`import { createImageTemplate } from "@image-to-template/core"`。
 * 不引用仓库内部源码、不访问仓库路径；对模板包执行 render / validate。
 *
 * 运行（需先安装归档：见 docs/wiki/integration.md）：
 *   node example.mjs <模板包目录>
 */

import { createImageTemplate } from "@image-to-template/core";

const bundleDir = process.argv[2];
if (bundleDir === undefined) {
  console.error("用法：node example.mjs <模板包目录>");
  process.exitCode = 64;
} else {
  const instance = createImageTemplate({
    // 结构化日志走回调（SDK 不直接打印）
    logger: (message, detail) => console.error(`[log] ${message}`, detail ?? ""),
  });

  // 1. 渲染（不调用模型）
  const rendered = await instance.render({ template: bundleDir });
  console.log(JSON.stringify({ op: "render", status: rendered.status, artifacts: rendered.artifacts.length }));

  // 2. 交付检查（诊断模式；阻断项列出）
  const validated = await instance.validate({ bundle: bundleDir });
  console.log(
    JSON.stringify({
      op: "validate",
      status: validated.status,
      blockers: validated.report.validate?.blockers?.length ?? 0,
    }),
  );

  // 3. 对比（内容与基准一致时给出 mismatchRatio）
  const compared = await instance.compare({ bundle: bundleDir }).catch(
    (error) => ({ status: "error", message: String(error) }),
  );
  console.log(JSON.stringify({ op: "compare", status: compared.status }));
}
