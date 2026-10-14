/**
 * T17：批量任务集成测试（真实 Chromium；不调用模型——render/validate 任务）。
 *
 * 覆盖：
 * - 成功项与失败项混合：输出隔离、汇总完整、失败不污染其他任务；
 * - 任一 failed → 汇总 failed；严格模式下 needs_review 也计入；
 * - 汇总报告落盘（batch-report-*.json）；
 * - 清单结构校验（未知版本、非法 kind、重复 ID 报参数错误）。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runBatch, readBatchManifest } from "../../src/pipeline/batch.js";
import { createImageTemplate } from "../../src/index.js";
import { isImageTemplateError } from "../../src/errors.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

/** 构造最小可渲染 SceneSpec 包。 */
async function makeRenderBundle(dir: string): Promise<string> {
  const bundleDir = path.join(dir, "bundle");
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

/** 构造批量清单。 */
async function writeManifest(
  dir: string,
  tasks: unknown[],
): Promise<string> {
  const file = path.join(dir, "batch.json");
  await writeFile(
    file,
    JSON.stringify({ manifestVersion: "1.0", tasks }),
    "utf8",
  );
  return file;
}

test("成功项与失败项混合：输出隔离、汇总完整、退出状态正确", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-t17-"));
  try {
    const goodBundle = await makeRenderBundle(path.join(dir, "good"));

    const manifest = await writeManifest(dir, [
      { id: "ok-render", kind: "render", input: goodBundle, output: goodBundle },
      { id: "missing-bundle", kind: "render", input: path.join(dir, "no-such"), output: path.join(dir, "no-such") },
      { id: "ok-validate", kind: "validate", input: goodBundle, output: goodBundle },
    ]);

    const instance = createImageTemplate();
    const result = await runBatch({
      manifest,
      outputDir: path.join(dir, "reports"), // 汇总写入临时目录，不污染 fixtures
      executor: {
        extract: async () => {
          throw new Error("本测试不用 extract");
        },
        render: async (task) => instance.render({ template: task.template, ...(task.strict === undefined ? {} : { strict: task.strict }) }),
        validate: async (task) => instance.validate({ bundle: task.bundle, ...(task.strict === undefined ? {} : { strict: task.strict }) }),
      },
    });

    // 任一 failed → 汇总 failed
    assert.equal(result.status, "failed");

    // 逐任务结果：完成 2（ok-render 为 needs_review：无字体 manifest → 字体缺失待复查）、失败 1
    const byId = new Map(result.taskResults.map((r) => [r.id, r]));
    assert.equal(byId.get("ok-render")!.status, "needs_review");
    assert.equal(byId.get("missing-bundle")!.status, "failed");
    assert.ok(byId.get("missing-bundle")!.error);
    assert.equal(byId.get("ok-validate")!.status, "needs_review", "无字体 manifest → 待复查");

    // 失败不污染其他任务：成功任务产物存在
    assert.ok(
      await readFile(path.join(goodBundle, "preview.png")).then(
        () => true,
        () => false,
      ),
    );

    // 汇总报告落盘
    const summary = JSON.parse(await readFile(result.summaryFile, "utf8")) as {
      run: { stage: string };
      summary: { pass: number; needs_review: number; failed: number };
    };
    assert.equal(summary.run.stage, "batch");
    assert.equal(summary.summary.pass, 0);
    assert.equal(summary.summary.needs_review, 2);
    assert.equal(summary.summary.failed, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("严格模式：needs_review 也计入 failed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-t17-strict-"));
  try {
    const bundle = await makeRenderBundle(dir);
    const manifest = await writeManifest(dir, [
      { id: "one", kind: "render", input: bundle, output: bundle },
    ]);

    const instance = createImageTemplate();
    const result = await runBatch({
      manifest,
      strict: true,
      outputDir: path.join(dir, "reports"),
      executor: {
        extract: async () => {
          throw new Error("unused");
        },
        render: async (task) => instance.render({ template: task.template }),
        validate: async (task) => instance.validate({ bundle: task.bundle }),
      },
    });

    // 无字体 manifest → needs_review；strict → 汇总 failed
    assert.equal(result.taskResults[0].status, "needs_review");
    assert.equal(result.status, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("清单结构校验：未知版本 / 非法 kind / 重复 ID", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-t17-manifest-"));
  try {
    // 未知版本
    const badVersion = path.join(dir, "v9.json");
    await writeFile(
      badVersion,
      JSON.stringify({ manifestVersion: "9.9", tasks: [] }),
      "utf8",
    );
    await assert.rejects(
      readBatchManifest(badVersion),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "UNSUPPORTED_VERSION");
        return true;
      },
    );

    // 非法 kind
    const badKind = path.join(dir, "kind.json");
    await writeFile(
      badKind,
      JSON.stringify({
        manifestVersion: "1.0",
        tasks: [{ id: "x", kind: "frobnicate", input: "a", output: "b" }],
      }),
      "utf8",
    );
    await assert.rejects(
      readBatchManifest(badKind),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      },
    );

    // 重复 ID
    const dupId = path.join(dir, "dup.json");
    await writeFile(
      dupId,
      JSON.stringify({
        manifestVersion: "1.0",
        tasks: [
          { id: "same", kind: "render", input: "a", output: "b" },
          { id: "same", kind: "render", input: "c", output: "d" },
        ],
      }),
      "utf8",
    );
    await assert.rejects(
      readBatchManifest(dupId),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.ok((error as Error).message.includes("重复"));
        return true;
      },
    );

    // 非对象
    const notObject = path.join(dir, "array.json");
    await writeFile(notObject, "[]", "utf8");
    await assert.rejects(
      readBatchManifest(notObject),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
