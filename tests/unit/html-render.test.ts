/**
 * T05：通用 HTML 渲染器与可编辑性静态检查测试。
 *
 * 覆盖：转义（脚本文本不执行）、空字符串、zIndex/输入顺序、
 * 图片 data URL 嵌入、素材路径校验、reference.png 禁用、整页图片检测。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { buildHtml, escapeHtml } from "../../src/render/html.js";
import {
  checkEditabilityStatic,
  domMismatchesToIssues,
} from "../../src/quality/editability.js";
import { isImageTemplateError } from "../../src/errors.js";
import type { SceneSpec } from "../../src/schemas/scene.js";
import type { SceneContent } from "../../src/schemas/content.js";

/** 构造最小 SceneSpec（不经过 zod 默认值填充，字段手工齐全）。 */
function miniSpec(
  elements: Array<Record<string, unknown>>,
): SceneSpec {
  return {
    version: "1.0",
    canvas: { width: 200, height: 200, background: "#FFFFFF" },
    elements: elements.map((element) => ({
      zIndex: 1,
      confidence: 0.9,
      ...element,
    })) as unknown as SceneSpec["elements"],
    notes: [],
  };
}

/** 构造含一张真实 PNG 素材的临时模板包。 */
async function makeBundleWithAsset(): Promise<{
  dir: string;
  spec: SceneSpec;
  content: SceneContent;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-html-"));
  await mkdir(path.join(dir, "assets"), { recursive: true });

  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(dir, "assets", "photo.png"), png);

  const spec = miniSpec([
    {
      id: "bg",
      type: "box",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      fill: "#F5F1EA",
      borderColor: "#CCCCCC",
      borderWidth: 0,
      radius: 0,
    },
    {
      id: "title",
      type: "text",
      x: 10,
      y: 10,
      width: 180,
      height: 30,
      text: "",
      fontSize: 20,
      fontFamily: "sans",
      fontWeight: "700",
      lineHeight: 1.4,
      letterSpacing: 0,
      color: "#193753",
      align: "left",
    },
    {
      id: "photo",
      type: "image",
      x: 10,
      y: 50,
      width: 40,
      height: 40,
      src: "assets/photo.png",
    },
  ]);

  return { dir, spec, content: { title: "标题文字" } };
}

test("escapeHtml 转义全部特殊字符", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script>&'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;",
  );
});

test("构建 HTML：结构、属性、转义与嵌入素材", async () => {
  const { dir, spec, content } = await makeBundleWithAsset();
  try {
    const { html, embeddedImages } = await buildHtml({
      spec,
      content,
      bundleDir: dir,
      fontFaceCss: "@font-face { font-family: \"Template-sans\"; }",
    });

    // 画布与基础结构
    assert.ok(html.includes('<div id="canvas">'));
    assert.ok(html.includes("width: 200px"));
    assert.ok(html.includes("height: 200px"));
    assert.ok(html.includes("background: #FFFFFF"));

    // 文本节点带全部核对属性
    assert.ok(html.includes('data-text-id="title"'));
    assert.ok(html.includes('data-element-id="title"'));
    assert.ok(html.includes('data-expected-text="标题文字"'));

    // 正文以转义形式出现
    assert.ok(html.includes("标题文字"));

    // box 与图片元素带 data-element-id
    assert.ok(html.includes('data-element-id="bg"'));
    assert.ok(html.includes('data-element-id="photo"'));

    // 图片以 data URL 嵌入（离线可打开）
    assert.ok(html.includes('src="data:image/png;base64,'));
    assert.deepEqual(embeddedImages, [
      { elementId: "photo", src: "assets/photo.png" },
    ]);

    // 字体 CSS 已嵌入
    assert.ok(html.includes("@font-face"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("脚本文本作为数据被转义，不会出现在可执行位置", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-html-"));
  try {
    const malicious = '<script>alert("xss")</script>';
    const spec = miniSpec([
      {
        id: "t",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        text: "",
        fontSize: 12,
        fontFamily: "sans",
        fontWeight: "400",
        lineHeight: 1.4,
        letterSpacing: 0,
        color: "#333333",
        align: "left",
      },
    ]);

    const { html } = await buildHtml({
      spec,
      content: { t: malicious },
      bundleDir: dir,
      fontFaceCss: "",
    });

    // 原样脚本不存在；只有转义形式
    assert.ok(!html.includes(`>${malicious}<`));
    assert.ok(html.includes("&lt;script&gt;"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("空字符串文本渲染为空节点", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-html-"));
  try {
    const spec = miniSpec([
      {
        id: "empty",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        text: "",
        fontSize: 12,
        fontFamily: "sans",
        fontWeight: "400",
        lineHeight: 1.4,
        letterSpacing: 0,
        color: "#333333",
        align: "left",
      },
    ]);

    const { html } = await buildHtml({
      spec,
      content: { empty: "" },
      bundleDir: dir,
      fontFaceCss: "",
    });

    assert.ok(
      html.includes('data-expected-text=""'),
      "空字符串应保留为空的期望值属性",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("相同 zIndex 保持输入顺序，高 zIndex 后渲染（覆盖在上层）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-html-"));
  try {
    const textElement = {
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      text: "",
      fontSize: 12,
      fontFamily: "sans",
      fontWeight: "400",
      lineHeight: 1.4,
      letterSpacing: 0,
      color: "#333333",
      align: "left",
    };
    const boxLow = { id: "box_low", type: "box", x: 0, y: 0, width: 10, height: 10, zIndex: 1, fill: "#FF0000", borderColor: "#CCCCCC", borderWidth: 0, radius: 0 };
    const boxHigh = { id: "box_high", type: "box", x: 0, y: 0, width: 10, height: 10, zIndex: 5, fill: "#00FF00", borderColor: "#CCCCCC", borderWidth: 0, radius: 0 };

    const spec = miniSpec([textElement, boxLow, boxHigh]);
    const { html } = await buildHtml({
      spec,
      content: { t: "x" },
      bundleDir: dir,
      fontFaceCss: "",
    });

    const tIndex = html.indexOf('data-element-id="t"');
    const lowIndex = html.indexOf('data-element-id="box_low"');
    const highIndex = html.indexOf('data-element-id="box_high"');

    assert.ok(tIndex < lowIndex, "相同 zIndex 按输入顺序");
    assert.ok(lowIndex < highIndex, "高 zIndex 后渲染");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("image 缺少 src 或素材路径越界时报错", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-html-"));
  try {
    const noSrcSpec = miniSpec([
      { id: "photo", type: "image", x: 0, y: 0, width: 10, height: 10, src: "" },
    ]);
    await assert.rejects(
      buildHtml({
        spec: noSrcSpec,
        content: {},
        bundleDir: dir,
        fontFaceCss: "",
      }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.ok((error as Error).message.includes("缺少 src"));
        return true;
      },
    );

    const escapeSpec = miniSpec([
      {
        id: "photo",
        type: "image",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        src: "../outside.png",
      },
    ]);
    await assert.rejects(
      buildHtml({
        spec: escapeSpec,
        content: {},
        bundleDir: dir,
        fontFaceCss: "",
      }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("静态可编辑性检查：reference.png 素材源与整页图片", () => {
  const spec = miniSpec([
    {
      id: "cheat",
      type: "image",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      src: "reference.png",
    },
    {
      id: "ok_photo",
      type: "image",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      src: "assets/photo.png",
    },
    {
      id: "orphan_text",
      type: "text",
      x: 0,
      y: 0,
      width: 50,
      height: 20,
      text: "",
      fontSize: 12,
      fontFamily: "sans",
      fontWeight: "400",
      lineHeight: 1.4,
      letterSpacing: 0,
      color: "#333333",
      align: "left",
    },
  ]);

  const issues = checkEditabilityStatic(spec, {});

  assert.ok(issues.some((i) => i.code === "REFERENCE_AS_SOURCE" && i.elementId === "cheat"));
  assert.ok(issues.some((i) => i.code === "WHOLE_PAGE_IMAGE" && i.elementId === "cheat"));
  assert.ok(issues.some((i) => i.code === "TEXT_ID_NOT_IN_CONTENT" && i.elementId === "orphan_text"));
  // 正常素材不产生问题
  assert.ok(!issues.some((i) => i.elementId === "ok_photo"));
});

test("DOM mismatch 转换为 issue", () => {
  const issues = domMismatchesToIssues([
    { id: "t1", code: "DOM_TEXT_MISMATCH", message: "DOM 文本与 content 不一致", expected: "a", actual: "b" },
    { id: "t2", code: "DOM_TEXT_MISSING", message: "缺少声明" },
  ]);

  assert.equal(issues.length, 2);
  assert.equal(issues[0].code, "DOM_TEXT_MISMATCH");
  assert.ok(issues[0].message.includes("期望"));
  assert.equal(issues[1].code, "DOM_TEXT_MISSING");
});
