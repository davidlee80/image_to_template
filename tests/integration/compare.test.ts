/**
 * T07：对比流水线集成测试。
 *
 * 覆盖：同内容对比（applicable + diff/overlay + 报告合并）；编辑后默认跳过
 * （不保留旧 mismatchRatio）；force 发现不一致失败；新基准可对比；preview 缺失报错。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { runCompare } from "../../src/pipeline/compare.js";
import { runRender } from "../../src/pipeline/render.js";
import { isImageTemplateError } from "../../src/errors.js";

async function makeCompareBundle(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-cmp-"));
  await mkdir(path.join(dir, "assets"), { recursive: true });

  // reference.png：100×80 白底红块
  await writeFile(
    path.join(dir, "reference.png"),
    await sharp({
      create: { width: 100, height: 80, channels: 3, background: "#FFFFFF" },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 30, height: 20, channels: 3, background: "#FF0000" },
          })
            .png()
            .toBuffer(),
          left: 5,
          top: 5,
        },
      ])
      .png()
      .toBuffer(),
  );

  const template = {
    version: "1.0",
    canvas: { width: 100, height: 80, background: "#FFFFFF" },
    elements: [
      {
        id: "bg",
        type: "box",
        x: 5,
        y: 5,
        width: 30,
        height: 20,
        zIndex: 1,
        confidence: 0.9,
        fill: "#FF0000",
        borderColor: "#CCCCCC",
        borderWidth: 0,
        radius: 0,
      },
    ],
    notes: [],
  };
  await writeFile(
    path.join(dir, "template.json"),
    JSON.stringify(template),
    "utf8",
  );
  await writeFile(path.join(dir, "content.json"), "{}", "utf8");

  // manifest 登记原始内容哈希（canonicalContentHash({}) 的值由渲染后写入？此处手工模拟）
  const { canonicalContentHash } = await import("../../src/io/json.js");
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      manifestVersion: "1.0",
      originalContentSha256: canonicalContentHash({}),
    }),
    "utf8",
  );

  return dir;
}

test("同内容对比：applicable、diff/overlay 产物、报告合并", async () => {
  const bundle = await makeCompareBundle();
  try {
    // 先渲染生成 preview
    await runRender({ bundleDir: bundle });

    const result = await runCompare({ bundleDir: bundle });

    assert.equal(result.status, "pass");
    assert.equal(result.applicable, true);
    assert.ok(result.mismatchRatio !== undefined && result.mismatchRatio >= 0);

    // diff 与 overlay 存在
    assert.ok(
      await (await import("node:fs/promises")).stat(
        path.join(bundle, "diff.png"),
      ).then(() => true),
    );
    assert.ok(
      await (await import("node:fs/promises")).stat(
        path.join(bundle, "overlay.png"),
      ).then(() => true),
    );

    // 报告合并：comparison 段存在且带参数
    const report = result.report as {
      comparison: {
        applicable: boolean;
        params: { threshold: number; includeAA: boolean };
        mismatchRatio: number;
        reference: string;
      };
      run: { stage: string; status: string };
    };
    assert.equal(report.comparison.applicable, true);
    assert.equal(report.comparison.params.threshold, 0.15);
    assert.equal(report.comparison.params.includeAA, false);
    assert.equal(report.run.stage, "compare");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("渲染接近原图时 mismatchRatio 较低（红块 box 重建）", async () => {
  const bundle = await makeCompareBundle();
  try {
    await runRender({ bundleDir: bundle });
    const result = await runCompare({ bundleDir: bundle });
    // box 精确重建红块：主要差异来自文字渲染边缘，应很小
    assert.ok(
      (result.mismatchRatio ?? 1) < 0.02,
      `红块重建差异应很小：${result.mismatchRatio}`,
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("编辑后默认跳过原图差异且不保留旧 mismatchRatio", async () => {
  const bundle = await makeCompareBundle();
  try {
    await runRender({ bundleDir: bundle });
    await runCompare({ bundleDir: bundle });

    // 编辑内容（template 无 text，加一个 text 元素模拟编辑）
    const template = {
      version: "1.0",
      canvas: { width: 100, height: 80, background: "#FFFFFF" },
      elements: [
        {
          id: "bg",
          type: "box",
          x: 5,
          y: 5,
          width: 30,
          height: 20,
          zIndex: 1,
          confidence: 0.9,
          fill: "#FF0000",
          borderColor: "#CCCCCC",
          borderWidth: 0,
          radius: 0,
        },
        {
          id: "caption",
          type: "text",
          x: 40,
          y: 40,
          width: 50,
          height: 20,
          zIndex: 2,
          confidence: 0.9,
          text: "",
          fontSize: 12,
          fontFamily: "sans",
          fontWeight: "400",
          lineHeight: 1.4,
          letterSpacing: 0,
          color: "#333333",
          align: "left",
        },
      ],
      notes: [],
    };
    await writeFile(
      path.join(bundle, "template.json"),
      JSON.stringify(template),
      "utf8",
    );
    await writeFile(
      path.join(bundle, "content.json"),
      JSON.stringify({ caption: "编辑后的文字" }),
      "utf8",
    );

    // 重新渲染（内容已变；render 报告不含旧 comparison）
    await runRender({ bundleDir: bundle });

    const result = await runCompare({ bundleDir: bundle });
    assert.equal(result.applicable, false);
    assert.equal(result.skippedReason, "content_changed");
    assert.equal(result.mismatchRatio, undefined);

    const report = result.report as {
      comparison: { applicable: boolean; reason: string; mismatchRatio?: number };
    };
    assert.equal(report.comparison.applicable, false);
    assert.equal(report.comparison.mismatchRatio, undefined);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("force + 内容不一致 → failed", async () => {
  const bundle = await makeCompareBundle();
  try {
    await runRender({ bundleDir: bundle });

    const template = {
      version: "1.0",
      canvas: { width: 100, height: 80, background: "#FFFFFF" },
      elements: [
        {
          id: "caption",
          type: "text",
          x: 40,
          y: 40,
          width: 50,
          height: 20,
          zIndex: 2,
          confidence: 0.9,
          text: "",
          fontSize: 12,
          fontFamily: "sans",
          fontWeight: "400",
          lineHeight: 1.4,
          letterSpacing: 0,
          color: "#333333",
          align: "left",
        },
      ],
      notes: [],
    };
    await writeFile(
      path.join(bundle, "template.json"),
      JSON.stringify(template),
      "utf8",
    );
    await writeFile(
      path.join(bundle, "content.json"),
      JSON.stringify({ caption: "编辑后的文字" }),
      "utf8",
    );
    await runRender({ bundleDir: bundle });

    const result = await runCompare({ bundleDir: bundle, force: true });
    assert.equal(result.status, "failed");
    assert.equal(result.applicable, false);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("提供新基准后可对比", async () => {
  const bundle = await makeCompareBundle();
  try {
    await runRender({ bundleDir: bundle });

    // 编辑内容并渲染
    const template = {
      version: "1.0",
      canvas: { width: 100, height: 80, background: "#FFFFFF" },
      elements: [
        {
          id: "caption",
          type: "text",
          x: 40,
          y: 40,
          width: 50,
          height: 20,
          zIndex: 2,
          confidence: 0.9,
          text: "",
          fontSize: 12,
          fontFamily: "sans",
          fontWeight: "400",
          lineHeight: 1.4,
          letterSpacing: 0,
          color: "#333333",
          align: "left",
        },
      ],
      notes: [],
    };
    await writeFile(
      path.join(bundle, "template.json"),
      JSON.stringify(template),
      "utf8",
    );
    await writeFile(
      path.join(bundle, "content.json"),
      JSON.stringify({ caption: "新内容" }),
      "utf8",
    );
    await runRender({ bundleDir: bundle });

    // 新基准：拷贝 preview 作为匹配基准
    const { copyFile } = await import("node:fs/promises");
    const newReference = path.join(bundle, "new-baseline.png");
    await copyFile(path.join(bundle, "preview.png"), newReference);

    const result = await runCompare({
      bundleDir: bundle,
      reference: newReference,
    });

    assert.equal(result.applicable, true);
    assert.equal(result.status, "pass");
    // 与自身比较 → 0
    assert.equal(result.mismatchRatio, 0);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("preview 缺失时明确报错", async () => {
  const bundle = await makeCompareBundle();
  try {
    await assert.rejects(
      runCompare({ bundleDir: bundle }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "IO_ERROR");
        assert.ok((error as Error).message.includes("preview.png"));
        return true;
      },
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});
