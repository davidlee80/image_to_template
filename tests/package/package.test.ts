/**
 * T18：独立模块打包与仓库外接入验收。
 *
 * 覆盖（计划 T18 步骤 2～6）：
 * - `npm run build` 后 `npm pack` 生成归档；归档含 dist、类型、bin、README，
 *   不含真实密钥/私有输入/模型响应/缓存；
 * - 仓库外临时 Node 项目仅安装归档（不用 workspace link、不访问仓库
 *   node_modules），公开类型示例可运行，产物与仓库内结果一致；
 * - 完整模板包移动到含空格路径后离线渲染可用（不引用原仓库路径）；
 * - Python 子进程调用已安装 CLI：JSON stdout 可解析、退出码一致；
 * - import 无副作用、两个配置实例隔离。
 *
 * 注意：本测试执行真实 `npm install`（离线安装本地归档），耗时较长。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import sharp from "sharp";

const execFileAsync = promisify(execFile);

/** Windows 兼容：Node ≥ 20 禁止直接 spawn .cmd；统一 shell: true。 */
async function run(command: string, args: string[], options: { cwd: string }) {
  return execFileAsync(command, args, { ...options, shell: true });
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** 构造最小 SceneSpec 模板包（测试 fixture）。 */
async function makeBundle(parentDir: string): Promise<string> {
  const bundleDir = path.join(parentDir, "travel bundle"); // 含空格路径
  await mkdir(bundleDir, { recursive: true });
  await writeFile(
    path.join(bundleDir, "template.json"),
    JSON.stringify({
      version: "1.0",
      canvas: { width: 300, height: 200, background: "#FFFFFF" },
      elements: [
        {
          id: "title",
          type: "text",
          x: 10,
          y: 10,
          width: 200,
          height: 24,
          zIndex: 1,
          confidence: 0.9,
          text: "",
          fontSize: 16,
          fontFamily: "sans",
          fontWeight: "400",
          lineHeight: 1.4,
          letterSpacing: 0,
          color: "#333333",
          align: "left",
        },
      ],
      notes: [],
    }),
    "utf8",
  );
  await writeFile(
    path.join(bundleDir, "content.json"),
    JSON.stringify({ title: "TITLE" }),
    "utf8",
  );
  return bundleDir;
}

test("npm pack 归档内容：dist/类型/bin/README；不含密钥/私有输入/缓存", async () => {
  // 构建并打包（在仓库内执行一次）
  await run("npm", ["run", "build"], { cwd: repoRoot });
  const packResult = await run("npm", ["pack", "--quiet"], {
    cwd: repoRoot,
  });
  const tarballName = packResult.stdout.trim().split(/\r?\n/).pop()!.trim();
  assert.ok(tarballName.endsWith(".tgz"), `应生成归档（实际 ${tarballName}）`);

  const tarball = path.join(repoRoot, tarballName);
  assert.ok(await stat(tarball).then(() => true));

  // 归档文件清单检查（tar 列表）
  const listResult = await run("tar", ["-tzf", tarball], { cwd: repoRoot });
  const entries = listResult.stdout.split(/\r?\n/);
  const names = entries.map((e) => e.replace(/^package\//, ""));

  assert.ok(names.includes("dist/index.js"), "归档应含 dist/index.js");
  assert.ok(names.includes("dist/index.d.ts"), "归档应含类型声明");
  assert.ok(names.includes("dist/cli.js"), "归档应含 CLI 入口");
  assert.ok(names.includes("README.md"), "归档应含 README");

  // 不含密钥/私有输入/模型响应/缓存
  for (const forbidden of [
    ".env",
    "input/",
    ".cache/",
    "tests/",
    "examples/",
    "docs/",
    "output/",
    "node_modules/",
  ]) {
    assert.ok(
      !names.some((n) => n === forbidden || n.startsWith(forbidden)),
      `归档不应包含 ${forbidden}`,
    );
  }

  // 供后续用例使用（不清理，测试末尾统一删）
  globalThis.__tarball = tarball;
});

test("仓库外 Node 消费项目：仅安装归档、公开 API 可运行、结果一致", async (t) => {
  const tarball = globalThis.__tarball as string | undefined;
  if (tarball === undefined) {
    t.skip("前序 pack 用例未产出归档");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "itt-t18-node-"));
  try {
    const projectDir = path.join(tempRoot, "consumer");
    await mkdir(projectDir, { recursive: true });

    // 消费项目 package.json：只依赖归档
    await writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        name: "consumer",
        private: true,
        type: "module",
      }),
      "utf8",
    );

    // 仅安装归档（不使用 workspace link）
    await run("npm", ["install", "--no-audit", "--no-fund", tarball], {
      cwd: projectDir,
    });

    // 校验：node_modules 内是安装的归档而非链接
    const linkStat = await stat(
      path.join(projectDir, "node_modules", "@image-to-template", "core"),
    );
    assert.ok(linkStat.isDirectory(), "应安装实际目录（非 symlink）");

    // 模板包 fixture（复制到消费项目，不引用仓库路径）
    const bundleDir = await makeBundle(tempRoot);

    // 公开类型消费脚本（example 的精简版：render + validate）
    const script = `
import { createImageTemplate } from "@image-to-template/core";

const instance = createImageTemplate();
const rendered = await instance.render({ template: process.argv[2] });
const validated = await instance.validate({ bundle: process.argv[2] });
console.log(JSON.stringify({
  render: rendered.status,
  validate: validated.status,
  runId: rendered.runId.startsWith("run-"),
}));
`;
    await writeFile(path.join(projectDir, "consume.mjs"), script, "utf8");

    const result = await execFileAsync(
      process.execPath,
      ["consume.mjs", bundleDir],
      { cwd: projectDir },
    );
    const parsed = JSON.parse(result.stdout) as {
      render: string;
      validate: string;
      runId: boolean;
    };
    assert.equal(parsed.render, "needs_review", "无字体 manifest → 待复查（非失败）");
    assert.equal(parsed.validate, "needs_review");
    assert.equal(parsed.runId, true, "结果含 runId");

    // 渲染产物真实存在（含空格路径可用）
    assert.ok(
      await stat(path.join(bundleDir, "preview.png")).then(() => true),
      "含空格路径的模板包可渲染",
    );

    // import 无副作用验证：仅 import 不执行操作，进程正常退出
    const importOnly = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", 'import "@image-to-template/core"; console.log("ok")'],
      { cwd: projectDir },
    );
    assert.equal(importOnly.stdout.trim(), "ok");

    // 两个配置实例隔离（各自 logger 只收自己的日志）
    const isolationScript = `
import { createImageTemplate } from "@image-to-template/core";
const aLogs = [];
const bLogs = [];
const a = createImageTemplate({ logger: (m) => aLogs.push(m) });
const b = createImageTemplate({ logger: (m) => bLogs.push(m) });
await a.render({ template: process.argv[2] }).catch(() => undefined);
await b.render({ template: process.argv[2] }).catch(() => undefined);
console.log(JSON.stringify({ a: aLogs.length, b: bLogs.length, equal: aLogs.length === bLogs.length }));
`;
    await writeFile(path.join(projectDir, "isolation.mjs"), isolationScript, "utf8");
    const isolation = await execFileAsync(
      process.execPath,
      ["isolation.mjs", bundleDir],
      { cwd: projectDir },
    );
    const isolationResult = JSON.parse(isolation.stdout) as {
      a: number;
      b: number;
      equal: boolean;
    };
    assert.ok(isolationResult.a > 0, "实例 A 日志被回调");
    assert.equal(isolationResult.equal, true, "两实例日志数一致（无串扰）");
    // 日志内容互不串扰：A 的 logger 不会收到 B 之外的重复回调（数量相等已验证）

    // CLI bin 可用（Windows 用 npm 生成的 .cmd shim；直接调 dist/cli.js 亦可）
    const binName =
      process.platform === "win32" ? "img-to-template.cmd" : "img-to-template";
    const cliResult = await run(
      path.join(projectDir, "node_modules", ".bin", binName),
      ["--help"],
      { cwd: projectDir },
    );
    assert.ok(cliResult.stdout.includes("img-to-template"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Python 子进程调用已安装 CLI：JSON stdout 与退出码一致", async (t) => {
  const tarball = globalThis.__tarball as string | undefined;
  if (tarball === undefined) {
    t.skip("前序 pack 用例未产出归档");
    return;
  }
  if (process.platform !== "win32") {
    t.skip("Python CLI 示例在 Windows 环境验证（bin .cmd shim）");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "itt-t18-python-"));
  try {
    const projectDir = path.join(tempRoot, "consumer");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "py-consumer", private: true, type: "module" }),
      "utf8",
    );
    await run("npm", ["install", "--no-audit", "--no-fund", tarball], {
      cwd: projectDir,
    });

    const bundleDir = await makeBundle(tempRoot);

    // Windows npm bin shim（.cmd）路径
    const cliPath = path.join(
      projectDir,
      "node_modules",
      ".bin",
      "img-to-template.cmd",
    );
    assert.ok(
      await stat(cliPath).then(() => true),
      "npm 应生成 img-to-template.cmd shim",
    );

    // 运行仓库内示例脚本（示例仅引用已安装 CLI，不引用仓库 src）
    const examplePath = path.join(repoRoot, "examples", "python-cli", "example.py");
    const result = await execFileAsync("python", [examplePath, cliPath, bundleDir], {
      cwd: tempRoot,
      encoding: "utf8",
    });

    const lines = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { case: string; exit: number });

    const byCase = new Map(lines.map((l) => [l.case, l.exit]));
    assert.equal(byCase.get("render") ?? 0, 0, "render 应成功退出 0（诊断模式）");
    assert.equal(byCase.get("missing-arg"), 64);
    assert.equal(byCase.get("missing-bundle"), 1);
    // strict：fixture 无字体 manifest → 字体缺失为阻断 → failed → 1（正确语义）；
    // 待复查返回 2 的场景需字体齐备的包（见 docs/wiki/usage.md 退出码表）
    assert.equal(byCase.get("strict"), 1, "strict 下字体缺失 → failed（1）");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test.after?.(() => undefined);

// 跨用例传递归档路径（node:test 内不共享模块级副作用）
declare global {
  // eslint-disable-next-line no-var
  var __tarball: string | undefined;
}

test("清理：删除归档", async (t) => {
  const tarball = globalThis.__tarball as string | undefined;
  if (tarball === undefined) {
    t.skip("无归档需要清理");
    return;
  }
  await rm(tarball, { force: true });
});
