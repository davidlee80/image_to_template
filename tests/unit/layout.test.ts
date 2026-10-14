/**
 * T06：布局诊断分析单元测试（不启动浏览器，使用构造的诊断数据）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeLayout,
  layoutFindingsToReviewItems,
} from "../../src/quality/layout.js";
import type { BrowserDiagnostics } from "../../src/render/browser.js";

function makeDiagnostics(
  overrides: Partial<BrowserDiagnostics> = {},
): BrowserDiagnostics {
  return {
    canvas: { scrollWidth: 300, scrollHeight: 200, clientWidth: 300, clientHeight: 200 },
    texts: [],
    elements: [],
    images: [],
    fontsLoaded: [],
    domTextMismatches: [],
    ...overrides,
  };
}

test("正常页面无发现", () => {
  const analysis = analyzeLayout({
    diagnostics: makeDiagnostics({
      texts: [
        {
          id: "t1",
          elementBox: { x: 10, y: 10, width: 100, height: 20 },
          textBounds: { x: 10, y: 12, width: 80, height: 16 },
          overflowX: 0,
          overflowY: 0,
        },
      ],
      elements: [
        {
          id: "t1",
          type: "text",
          zIndex: 2,
          box: { x: 10, y: 10, width: 100, height: 20 },
        },
        {
          id: "bg",
          type: "box",
          zIndex: 1,
          box: { x: 0, y: 0, width: 300, height: 200 },
        },
      ],
      images: [
        { elementId: "photo", complete: true, naturalWidth: 50, naturalHeight: 50 },
      ],
      fontsLoaded: [{ family: "Template-sans", weight: "400", loaded: true }],
    }),
    canvas: { width: 300, height: 200 },
  });

  assert.equal(analysis.findings.length, 0);
  // 文字位于背景 box 之上：允许重叠被记录
  assert.equal(analysis.allowedOverlaps.length, 1);
  assert.deepEqual(analysis.allowedOverlaps[0], {
    textId: "t1",
    otherId: "bg",
    otherType: "box",
  });
});

test("画布溢出与文字越出画布分别报告", () => {
  const analysis = analyzeLayout({
    diagnostics: makeDiagnostics({
      canvas: { scrollWidth: 300, scrollHeight: 260, clientWidth: 300, clientHeight: 200 },
      texts: [
        {
          id: "long_text",
          elementBox: { x: 10, y: 185, width: 200, height: 10 },
          textBounds: { x: 10, y: 185, width: 180, height: 60 },
          overflowX: 0,
          overflowY: 50,
        },
      ],
    }),
    canvas: { width: 300, height: 200 },
  });

  assert.ok(analysis.overflowY > 0);
  const canvasOverflow = analysis.findings.find((f) => f.code === "CANVAS_OVERFLOW");
  assert.ok(canvasOverflow);

  const beyond = analysis.findings.find((f) => f.code === "TEXT_BEYOND_CANVAS");
  assert.ok(beyond);
  assert.equal(beyond.severity, "blocker");
  assert.equal(beyond.elementId, "long_text");
  assert.ok(beyond.bounds);

  const elementOverflow = analysis.findings.find(
    (f) => f.code === "TEXT_OVERFLOW_ELEMENT",
  );
  assert.ok(elementOverflow);
  assert.equal(elementOverflow.severity, "warning");
});

test("文字间非预期重叠进入复查候选", () => {
  const analysis = analyzeLayout({
    diagnostics: makeDiagnostics({
      texts: [
        {
          id: "a",
          elementBox: { x: 10, y: 10, width: 100, height: 20 },
          textBounds: { x: 10, y: 10, width: 100, height: 20 },
          overflowX: 0,
          overflowY: 0,
        },
        {
          id: "b",
          elementBox: { x: 50, y: 10, width: 100, height: 20 },
          textBounds: { x: 50, y: 10, width: 100, height: 20 },
          overflowX: 0,
          overflowY: 0,
        },
      ],
    }),
    canvas: { width: 300, height: 200 },
  });

  const overlap = analysis.findings.find((f) => f.code === "TEXT_TEXT_OVERLAP");
  assert.ok(overlap);
  assert.equal(overlap.severity, "warning");
  assert.ok(overlap.message.includes("a"));
  assert.ok(overlap.message.includes("b"));
});

test("图片加载失败与字体失败分类", () => {
  const analysis = analyzeLayout({
    diagnostics: makeDiagnostics({
      images: [
        { elementId: "broken", complete: true, naturalWidth: 0, naturalHeight: 0 },
      ],
      fontsLoaded: [{ family: "Template-sans", weight: "400", loaded: false }],
    }),
    canvas: { width: 300, height: 200 },
  });

  const image = analysis.findings.find((f) => f.code === "IMAGE_LOAD_FAILED");
  assert.ok(image);
  assert.equal(image.severity, "blocker");

  // 诊断模式：字体失败为 warning
  const font = analysis.findings.find((f) => f.code === "FONT_LOAD_FAILED");
  assert.ok(font);
  assert.equal(font.severity, "warning");

  // 严格模式：字体失败为 blocker
  const strict = analyzeLayout({
    diagnostics: makeDiagnostics({
      fontsLoaded: [{ family: "Template-sans", weight: "400", loaded: false }],
    }),
    canvas: { width: 300, height: 200 },
    fontFailureIsBlocker: true,
  });
  const strictFont = strict.findings.find((f) => f.code === "FONT_LOAD_FAILED");
  assert.ok(strictFont);
  assert.equal(strictFont.severity, "blocker");
});

test("高层图片遮挡文字产生复查候选", () => {
  const analysis = analyzeLayout({
    diagnostics: makeDiagnostics({
      texts: [
        {
          id: "t",
          elementBox: { x: 10, y: 10, width: 100, height: 20 },
          textBounds: { x: 10, y: 10, width: 100, height: 20 },
          overflowX: 0,
          overflowY: 0,
        },
      ],
      elements: [
        { id: "t", type: "text", zIndex: 1, box: { x: 10, y: 10, width: 100, height: 20 } },
        { id: "cover", type: "image", zIndex: 9, box: { x: 0, y: 0, width: 300, height: 200 } },
      ],
    }),
    canvas: { width: 300, height: 200 },
  });

  const occluded = analysis.findings.find((f) => f.code === "TEXT_OCCLUDED");
  assert.ok(occluded);
  assert.equal(occluded.severity, "warning");
  assert.ok(occluded.message.includes("cover"));
});

test("低层图片与文字相交不报遮挡（可见文字与图片相交由 extract 阶段复查）", () => {
  const analysis = analyzeLayout({
    diagnostics: makeDiagnostics({
      texts: [
        {
          id: "t",
          elementBox: { x: 10, y: 10, width: 100, height: 20 },
          textBounds: { x: 10, y: 10, width: 100, height: 20 },
          overflowX: 0,
          overflowY: 0,
        },
      ],
      elements: [
        { id: "t", type: "text", zIndex: 5, box: { x: 10, y: 10, width: 100, height: 20 } },
        { id: "photo_below", type: "image", zIndex: 1, box: { x: 0, y: 0, width: 300, height: 200 } },
      ],
    }),
    canvas: { width: 300, height: 200 },
  });

  assert.ok(!analysis.findings.some((f) => f.code === "TEXT_OCCLUDED"));
});

test("warning findings 转为复查项且带 resolution", () => {
  const items = layoutFindingsToReviewItems([
    {
      code: "TEXT_TEXT_OVERLAP",
      severity: "warning",
      elementId: "a",
      message: "重叠",
    },
    {
      code: "TEXT_BEYOND_CANVAS",
      severity: "blocker",
      elementId: "b",
      message: "越界",
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "layout:TEXT_TEXT_OVERLAP:a");
  assert.deepEqual(items[0].resolution, { status: "pending" });
});
