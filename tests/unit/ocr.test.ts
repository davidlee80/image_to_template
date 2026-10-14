/**
 * T10：OCR 对照单元测试。
 *
 * 覆盖：fixture provider、文本归一化匹配、按位置和文本的对照
 * （匹配/缺失/冲突/小字）、复查项生成。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFixtureOcrProvider,
  crossCheckOcrWithVision,
  crossCheckToReviewItems,
  normalizeOcrText,
  ocrTextMatches,
  overlapRatio,
} from "../../src/analysis/ocr.js";
import type { TextElement } from "../../src/schemas/scene.js";

function textElement(
  id: string,
  box: { x: number; y: number; width: number; height: number },
  text: string,
): TextElement {
  return {
    id,
    type: "text",
    ...box,
    zIndex: 1,
    confidence: 0.9,
    text,
    fontSize: 14,
    fontFamily: "sans",
    fontWeight: "400",
    lineHeight: 1.4,
    letterSpacing: 0,
    color: "#333333",
    align: "left",
  };
}

test("文本归一化：空白不影响匹配", () => {
  assert.equal(normalizeOcrText("  本溪 水洞 "), "本溪水洞");
  assert.equal(ocrTextMatches("本溪 水洞", "本溪水洞"), true);
  assert.equal(ocrTextMatches("标题", "副标题"), false);
  assert.equal(ocrTextMatches("  ", ""), false);
});

test("overlapRatio 计算", () => {
  const element = { x: 100, y: 100, width: 100, height: 20 };
  assert.equal(
    overlapRatio({ x: 100, y: 100, width: 100, height: 20 }, element),
    1,
  );
  assert.equal(
    overlapRatio({ x: 200, y: 100, width: 100, height: 20 }, element),
    0,
  );
});

test("对照：匹配 / 缺失 / 冲突 / 小字", () => {
  const elements = [
    textElement("title", { x: 40, y: 22, width: 420, height: 42 }, "本溪水洞 · 天桥沟"),
    textElement("time", { x: 300, y: 212, width: 130, height: 22 }, "10:00–12:00"),
  ];

  const crossCheck = crossCheckOcrWithVision(
    [
      {
        text: "本溪水洞·天桥沟",
        box: { x: 40, y: 22, width: 420, height: 42 },
        readingOrder: 1,
        confidence: 0.97,
      },
      {
        text: "漏识别店铺",
        box: { x: 600, y: 480, width: 150, height: 18 },
        readingOrder: 2,
        confidence: 0.8,
      },
      {
        text: "10:00-12:00",
        box: { x: 300, y: 212, width: 130, height: 22 },
        readingOrder: 3,
        confidence: 0.9,
      },
      {
        text: "小字",
        box: { x: 600, y: 505, width: 100, height: 12 },
        readingOrder: 4,
        confidence: 0.7,
      },
    ],
    elements,
  );

  // 匹配（归一化后一致）
  assert.equal(crossCheck.matched.length, 1);
  assert.equal(crossCheck.matched[0].elementId, "title");

  // 缺失：无位置匹配（漏识别店铺 + 小字两行均无匹配元素）
  assert.equal(crossCheck.missingInVision.length, 2);
  assert.equal(crossCheck.missingInVision[0].line.text, "漏识别店铺");

  // 冲突：位置匹配但文字不同（en dash vs hyphen）
  assert.equal(crossCheck.conflicts.length, 1);
  assert.equal(crossCheck.conflicts[0].elementId, "time");
  assert.equal(crossCheck.conflicts[0].visionText, "10:00–12:00");

  // 小字（行高 12 ≤ 14）
  assert.equal(crossCheck.smallTextLines.length, 1);
});

test("复查项：缺失/冲突/小字类型正确且不自动覆盖", () => {
  const items = crossCheckToReviewItems(
    {
      matched: [],
      missingInVision: [
        {
          ocrIndex: 0,
          line: {
            text: "漏识别",
            box: { x: 1, y: 2, width: 3, height: 4 },
            readingOrder: 1,
            confidence: 0.8,
          },
        },
      ],
      conflicts: [
        {
          ocrIndex: 1,
          elementId: "t",
          ocrText: "A",
          visionText: "B",
        },
      ],
      smallTextLines: [
        {
          ocrIndex: 2,
          line: {
            text: "小",
            box: { x: 0, y: 0, width: 10, height: 10 },
            readingOrder: 2,
            confidence: 0.6,
          },
        },
      ],
    },
    [],
  );

  assert.equal(items.length, 3);
  assert.equal(items[0].type, "ocr_missing_text");
  // "不能直接当 CSS 文本框"提示记录在 evidence.note
  assert.equal(
    (items[0].evidence as { note?: string }).note?.includes(
      "不能直接当 CSS 文本框",
    ),
    true,
  );
  assert.equal(items[1].type, "ocr_text_conflict");
  assert.ok(items[1].message.includes("不自动覆盖"));
  assert.equal(items[2].type, "ocr_small_text");
  assert.equal(items[2].severity, "info");
});

test("fixture OCR provider 读取预置结果", async () => {
  const provider = createFixtureOcrProvider(
    "tests/fixtures/model-responses/ocr-synthetic.response.json",
  );
  const result = await provider.recognize({
    image: new Uint8Array(),
    width: 800,
    height: 600,
  });

  assert.equal(result.provider, "fixture-ocr");
  assert.equal(result.lines.length, 5);
  assert.equal(result.lines[0].text, "本溪水洞 · 天桥沟");
});
