/**
 * T06：渲染流水线集成测试（真实 Chromium；不调用模型）。
 *
 * 覆盖：正常导出尺寸正确；长文字产生带 ID/边界的报告；诊断模式输出复查图；
 * 严格模式阻断（文字越出画布、字体缺失）且不产出有效导出、移除旧 preview；
 * 同目录并发写入拒绝；缺失素材失败。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { runRender } from "../../src/pipeline/render.js";
import { isImageTemplateError } from "../../src/errors.js";

const LONG_TEXT =
  "这是一段非常长的文字内容，用于验证文字越出画布时能产生带元素 ID 与边界的诊断报告，内容还会继续变长以产生多行溢出。";

/** 构造完整测试模板包（含素材与字体 manifest）。 */
async function makeTestBundle(
  options: {
    /** 包含图片元素及素材文件（默认 true）。 */
    withAsset?: boolean;
    /** 包含图片元素但素材文件不存在（验证资源加载失败）。 */
    missingAsset?: boolean;
    withFontsManifest?: boolean;
    longText?: string;
  } = {},
): Promise<string> {
  const {
    withAsset = true,
    missingAsset = false,
    withFontsManifest = true,
    longText = LONG_TEXT,
  } = options;

  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-render-"));

  if (withAsset && !missingAsset) {
    await mkdir(path.join(dir, "assets"), { recursive: true });
    const png = await sharp({
      create: { width: 40, height: 40, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, "assets", "photo.png"), png);
  }

  if (withFontsManifest) {
    await mkdir(path.join(dir, "fonts"), { recursive: true });
    // 声明槽位但不提供文件 → 字体缺失
    await writeFile(
      path.join(dir, "fonts", "manifest.json"),
      JSON.stringify({
        version: "1.0",
        fontSlots: [
          {
            slot: "sans",
            familyAlias: "Template-sans",
            weights: ["400"],
            files: {},
          },
        ],
      }),
      "utf8",
    );
  }

  const template = {
    version: "1.0",
    canvas: { width: 300, height: 200, background: "#FFFFFF" },
    elements: [
      {
        id: "bg",
        type: "box",
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        zIndex: 1,
        confidence: 0.9,
        fill: "#F5F1EA",
        borderColor: "#CCCCCC",
        borderWidth: 0,
        radius: 0,
      },
      {
        id: "short_text",
        type: "text",
        x: 10,
        y: 10,
        width: 200,
        height: 20,
        zIndex: 2,
        confidence: 0.9,
        text: "",
        fontSize: 14,
        fontFamily: "sans",
        fontWeight: "400",
        lineHeight: 1.4,
        letterSpacing: 0,
        color: "#333333",
        align: "left",
      },
      {
        id: "long_text",
        type: "text",
        x: 10,
        y: 170,
        width: 200,
        height: 25,
        zIndex: 2,
        confidence: 0.9,
        text: "",
        fontSize: 14,
        fontFamily: "sans",
        fontWeight: "400",
        lineHeight: 1.4,
        letterSpacing: 0,
        color: "#333333",
        align: "left",
      },
      ...(withAsset || missingAsset
        ? [
            {
              id: "photo",
              type: "image",
              x: 240,
              y: 140,
              width: 40,
              height: 40,
              zIndex: 1,
              confidence: 0.8,
              src: "assets/photo.png",
            },
          ]
        : []),
    ],
    notes: [],
  };

  await writeFile(
    path.join(dir, "template.json"),
    JSON.stringify(template),
    "utf8",
  );
  await writeFile(
    path.join(dir, "content.json"),
    JSON.stringify({ short_text: "短文本", long_text: longText }),
    "utf8",
  );

  return dir;
}

test("诊断模式：导出正确尺寸，长文字产生带 ID/边界的报告", async () => {
  const bundle = await makeTestBundle();
  try {
    const result = await runRender({ bundleDir: bundle });

    // 字体缺失 → needs_review（诊断模式允许回退）
    assert.equal(result.status, "needs_review");

    // 导出尺寸正确
    const preview = path.join(bundle, "preview.png");
    const meta = await sharp(preview).metadata();
    assert.equal(meta.width, 300);
    assert.equal(meta.height, 200);

    // 报告存在且包含布局发现
    const report = result.report as {
      layout: {
        findings: Array<{ code: string; elementId?: string; bounds?: unknown }>;
        allowedOverlaps: Array<{ textId: string; otherId: string }>;
      };
      reviewItems: Array<{ id: string; type: string }>;
      fonts: { missing: Array<{ slot: string }> };
    };

    const beyond = report.layout.findings.find(
      (f) => f.code === "TEXT_BEYOND_CANVAS" && f.elementId === "long_text",
    );
    assert.ok(beyond, "长文字应产生 TEXT_BEYOND_CANVAS");
    assert.ok(beyond.bounds, "发现应带边界");

    // 文字与背景 box 的允许重叠被记录
    assert.ok(
      report.layout.allowedOverlaps.some(
        (o) => o.textId === "short_text" && o.otherId === "bg",
      ),
    );

    // 字体缺失进入复查项
    assert.ok(
      report.reviewItems.some((i) => i.type === "font_missing"),
    );

    // 报告文件已写入
    assert.ok(await stat(path.join(bundle, "report.json")).then(() => true));
    assert.ok(await stat(path.join(bundle, "preview.html")).then(() => true));
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("严格模式：阻断项导致失败且不产出有效导出", async () => {
  const bundle = await makeTestBundle();
  try {
    const result = await runRender({ bundleDir: bundle, strict: true });
    assert.equal(result.status, "failed");

    // 不产出有效导出（preview 被移除）
    const previewExists = await stat(path.join(bundle, "preview.png")).then(
      () => true,
      () => false,
    );
    assert.equal(previewExists, false);

    // 报告仍写入（含失败状态与原因）
    const report = result.report as {
      run: { status: string };
      layout: { findings: Array<{ code: string; severity: string }> };
    };
    assert.equal(report.run.status, "failed");
    assert.ok(
      report.layout.findings.some((f) => f.code === "TEXT_BEYOND_CANVAS"),
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("严格模式失败时移除旧 preview（不让旧产物冒充本次结果）", async () => {
  const bundle = await makeTestBundle({ longText: "正常短文本" });
  try {
    // 先渲染一个无越界版本（诊断模式，产出 preview）
    const ok = await runRender({ bundleDir: bundle });
    assert.notEqual(ok.status, "failed");
    assert.ok(
      await stat(path.join(bundle, "preview.png")).then(() => true),
      "首次渲染应产出 preview",
    );

    // 替换为长文本再严格渲染 → 失败且旧 preview 被移除
    await writeFile(
      path.join(bundle, "content.json"),
      JSON.stringify({ short_text: "短文本", long_text: LONG_TEXT }),
      "utf8",
    );
    const failed = await runRender({ bundleDir: bundle, strict: true });
    assert.equal(failed.status, "failed");

    const previewExists = await stat(path.join(bundle, "preview.png")).then(
      () => true,
      () => false,
    );
    assert.equal(previewExists, false, "旧 preview 应被移除");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("无字体 manifest：诊断回退且报告 missingFont，严格失败", async () => {
  const bundle = await makeTestBundle({
    withFontsManifest: false,
    longText: "正常文本",
  });
  try {
    const diagnostic = await runRender({ bundleDir: bundle });
    assert.equal(diagnostic.status, "needs_review");
    const report = diagnostic.report as {
      reviewItems: Array<{ type: string }>;
    };
    assert.ok(report.reviewItems.some((i) => i.type === "font_missing"));

    // 严格模式：字体缺失即失败（计划 T05 步骤 5）
    const strict = await runRender({ bundleDir: bundle, strict: true });
    assert.equal(strict.status, "failed");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("真实字体文件：严格模式可通过（无可用系统字体时跳过）", async (t) => {
  const systemFont = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "Fonts",
    "simhei.ttf",
  );
  const hasSystemFont = await stat(systemFont).then(
    () => true,
    () => false,
  );
  if (!hasSystemFont) {
    t.skip("当前环境无 SimHei 字体，跳过真实字体严格模式用例");
    return;
  }

  const bundle = await makeTestBundle({ longText: "正常文本" });
  try {
    // 填入真实字体（仅测试用；正式字体按 fonts/manifest.json 授权记录）
    const { copyFile } = await import("node:fs/promises");
    await copyFile(systemFont, path.join(bundle, "fonts", "sans-400.ttf"));
    await writeFile(
      path.join(bundle, "fonts", "manifest.json"),
      JSON.stringify({
        version: "1.0",
        fontSlots: [
          {
            slot: "sans",
            familyAlias: "Template-sans",
            weights: ["400"],
            files: {
              "400": { file: "sans-400.ttf", format: "truetype" },
            },
          },
        ],
      }),
      "utf8",
    );

    const result = await runRender({ bundleDir: bundle, strict: true });
    assert.equal(
      result.status,
      "pass",
      `严格模式应通过：${JSON.stringify(
        (result.report as { layout?: { findings?: unknown[] } }).layout
          ?.findings ?? [],
      )}`,
    );

    const meta = await sharp(path.join(bundle, "preview.png")).metadata();
    assert.equal(meta.width, 300);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("素材缺失时渲染失败（资源加载失败为阻断）", async () => {
  const bundle = await makeTestBundle({ missingAsset: true });
  try {
    await assert.rejects(
      runRender({ bundleDir: bundle }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "IO_ERROR");
        return true;
      },
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("同输出目录并发写入被拒绝", async () => {
  const bundle = await makeTestBundle({ longText: "正常" });
  try {
    const first = runRender({ bundleDir: bundle });
    const second = runRender({ bundleDir: bundle }).catch(
      (error: unknown) => error,
    );

    const [firstResult, secondError] = await Promise.all([first, second]);

    assert.notEqual(
      (firstResult as { status: string }).status,
      "failed",
    );
    assert.ok(isImageTemplateError(secondError));
    assert.equal((secondError as { code: string }).code, "CONFLICT");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("内容覆盖（--data）生效且不修改包内 content.json", async () => {
  const bundle = await makeTestBundle({ longText: "正常文本" });
  try {
    const result = await runRender({
      bundleDir: bundle,
      contentOverride: { short_text: "改过的文字" },
    });

    assert.equal(result.content.short_text, "改过的文字");
    assert.equal(result.content.long_text, "正常文本");

    // 包内 content.json 未被修改
    const onDisk = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        path.join(bundle, "content.json"),
        "utf8",
      ),
    );
    assert.equal(onDisk.short_text, "短文本");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});
