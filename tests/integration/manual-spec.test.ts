/**
 * 人工对话式提取（manual spec）测试：prompt 生成、围栏剥离、--spec 提取链路。
 *
 * 覆盖：
 * - stripJsonFence：```json 围栏 / 无围栏带前后说明 / BOM；
 * - buildManualSpecPrompt：画布尺寸锚定 + schema 嵌入；
 * - extract --spec：零模型调用（无 vision 配置）、正文分离（text→content.json）、
 *   image src 留空自动裁剪、manifest 记录 manual-spec；
 * - 非法 spec：具体校验错误（可回贴给对话模型）、画布尺寸不一致报错；
 * - CLI prompt 命令输出。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import sharp from "sharp";

import { stripJsonFence } from "../../src/analysis/manual-spec.js";
import { createImageTemplate } from "../../src/index.js";
import { isImageTemplateError } from "../../src/errors.js";
import { cliMain } from "../../src/cli.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);
const syntheticImage = path.join(fixtureDir, "images", "synthetic-travel.png");

test("stripJsonFence：围栏/前后说明/BOM 剥离", () => {
  const fenced = '```json\n{"version": "1.0"}\n```';
  assert.equal(stripJsonFence(fenced), '{"version": "1.0"}');

  const plainFence = '```\n{"a": 1}\n```';
  assert.equal(stripJsonFence(plainFence), '{"a": 1}');

  const withChatter =
    '好的，以下是模板：\n```json\n{"b": 2}\n```\n希望有帮助！';
  assert.equal(stripJsonFence(withChatter), '{"b": 2}');

  const noFence = '前缀说明 {"c": 3} 后缀说明';
  assert.equal(stripJsonFence(noFence), '{"c": 3}');

  const bom = '﻿{"d": 4}';
  // BOM 由 extractManualSpec 处理；stripJsonFence 本身不剥 BOM 但 JSON.parse 前已去
  assert.ok(stripJsonFence(bom).includes('{"d": 4}'));
});

test("buildManualSpecPrompt：画布尺寸锚定与 schema 嵌入", async () => {
  const { buildManualSpecPrompt } = await import(
    "../../src/analysis/manual-spec.js"
  );
  const result = await buildManualSpecPrompt({ imagePath: syntheticImage });

  // 合成图尺寸 800×600
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.ok(result.prompt.includes("800 × 600"), "提示词应锚定真实尺寸");
  assert.ok(result.prompt.includes("version"), "提示词应嵌入 schema");
  assert.ok(result.prompt.includes("img-to-template extract"), "含使用说明");
});

test("extract --spec：零模型调用、正文分离、src 留空自动裁剪", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-manual-"));
  const bundleDir = path.join(dir, "bundle");
  try {
    // 构造人工 spec（模拟对话模型输出：带围栏 + 前后寒暄）
    const spec = {
      version: "1.0",
      canvas: { width: 800, height: 600, background: "#FFFFFF" },
      elements: [
        {
          id: "title",
          type: "text",
          x: 40,
          y: 22,
          width: 420,
          height: 42,
          zIndex: 2,
          confidence: 0.95,
          text: "本溪水洞 · 天桥沟",
          fontSize: 30,
          fontFamily: "sans",
          fontWeight: "700",
          lineHeight: 1.4,
          letterSpacing: 0,
          color: "#FFFFFF",
          align: "left",
        },
        {
          id: "photo_trail",
          type: "image",
          x: 560,
          y: 148,
          width: 200,
          height: 130,
          zIndex: 1,
          confidence: 0.9,
          src: "",
        },
      ],
      notes: [],
    };
    const specFile = path.join(dir, "my-spec.json");
    await writeFile(
      specFile,
      `好的，以下是分析结果：\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n如需调整请告诉我。`,
      "utf8",
    );

    // 零模型配置的实例（无 vision）
    const instance = createImageTemplate();
    const result = await instance.extract({
      input: syntheticImage,
      output: bundleDir,
      spec: specFile,
    });

    assert.notEqual(result.status, "failed");

    // 正文分离：模板 text 清空、正文在 content.json
    const template = JSON.parse(
      await readFile(path.join(bundleDir, "template.json"), "utf8"),
    ) as { elements: Array<{ id: string; type: string; text?: string; src?: string }> };
    const title = template.elements.find((e) => e.id === "title")!;
    assert.equal(title.text, "", "模板正文应已清空");

    const content = JSON.parse(
      await readFile(path.join(bundleDir, "content.json"), "utf8"),
    ) as Record<string, string>;
    assert.equal(content.title, "本溪水洞 · 天桥沟");

    // image src 自动裁剪回填
    const photo = template.elements.find((e) => e.id === "photo_trail")!;
    assert.equal(photo.src, "assets/photo_trail.png", "src 应自动裁剪回填");
    assert.ok(await stat(path.join(bundleDir, "assets", "photo_trail.png")).then(() => true));

    // manifest 记录 manual-spec 来源
    const manifest = JSON.parse(
      await readFile(path.join(bundleDir, "manifest.json"), "utf8"),
    ) as { vision: { provider: string }; runtime: { visionRequests: number } };
    assert.equal(manifest.vision.provider, "manual-spec");
    assert.equal(manifest.runtime.visionRequests, 0, "零模型调用");

    // 渲染产物存在（extract 串联渲染）
    assert.ok(await stat(path.join(bundleDir, "preview.png")).then(() => true));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("非法 spec：具体校验错误消息（可回贴给对话模型）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-manual-bad-"));
  const bundleDir = path.join(dir, "bundle");
  try {
    const specFile = path.join(dir, "bad-spec.json");
    await writeFile(
      specFile,
      JSON.stringify({
        version: "1.0",
        canvas: { width: 800, height: 600, background: "#FFFFFF" },
        elements: [
          {
            id: "overflow_text",
            type: "text",
            x: 100,
            y: 590,
            width: 200,
            height: 60,
            zIndex: 1,
            confidence: 0.9,
            text: "越界",
          },
          { id: "overflow_text", type: "box", x: 0, y: 0, width: 10, height: 10, zIndex: 1, confidence: 0.9 },
        ],
        notes: [],
      }),
      "utf8",
    );

    const instance = createImageTemplate();
    await assert.rejects(
      instance.extract({ input: syntheticImage, output: bundleDir, spec: specFile }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.ok(error.message.includes("OUT_OF_CANVAS"), "应报越界");
        assert.ok(error.message.includes("DUPLICATE_ID"), "应报重复 ID");
        assert.ok(error.message.includes("粘贴回对话窗口"), "错误消息应提示回贴修复");
        return true;
      },
    );

    // 失败不产出包
    const exists = await stat(bundleDir).then(() => true, () => false);
    assert.equal(exists, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spec 画布尺寸与图片不一致：明确报错", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-manual-canvas-"));
  const bundleDir = path.join(dir, "bundle");
  try {
    const specFile = path.join(dir, "wrong-canvas.json");
    await writeFile(
      specFile,
      JSON.stringify({
        version: "1.0",
        canvas: { width: 1060, height: 1500, background: "#FFFFFF" },
        elements: [
          { id: "t", type: "text", x: 10, y: 10, width: 100, height: 20, zIndex: 1, confidence: 0.9, text: "标题" },
        ],
        notes: [],
      }),
      "utf8",
    );

    const instance = createImageTemplate();
    await assert.rejects(
      instance.extract({ input: syntheticImage, output: bundleDir, spec: specFile }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.ok(error.message.includes("1060"));
        assert.ok(error.message.includes("800"));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI：prompt 命令输出完整提示词", async () => {
  // 捕获 stdout
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") {
      captured += chunk;
    }
    return true;
  }) as typeof process.stdout.write;

  try {
    const code = await cliMain(["prompt", syntheticImage]);
    assert.equal(code, 0);
    assert.ok(captured.includes("你是页面版式分析器"), "含核心提示词");
    assert.ok(captured.includes("800 × 600"), "含画布尺寸锚定");
    assert.ok(captured.includes("img-to-template extract"), "含使用说明");
  } finally {
    process.stdout.write = originalWrite;
  }
});
