/**
 * T09：整页与分区元素合并去重测试。
 *
 * 覆盖（计划验证项）：同一元素重复消除；不同位置的相同文字仍保留；
 * 同位置不同文字形成冲突候选；区域独有元素重建 ID；整页 ID 稳定；
 * 边界元素保留并复查；回投越界元素导致合并失败。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  iouOf,
  isDuplicate,
  mergeRegionElements,
} from "../../src/analysis/merge.js";
import type { SceneElement, SceneSpec } from "../../src/schemas/scene.js";

function textElement(
  id: string,
  box: { x: number; y: number; width: number; height: number },
  text: string,
): SceneElement {
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

function boxElement(
  id: string,
  box: { x: number; y: number; width: number; height: number },
): SceneElement {
  return {
    id,
    type: "box",
    ...box,
    zIndex: 1,
    confidence: 0.9,
    fill: "#FF0000",
    borderColor: "#CCCCCC",
    borderWidth: 0,
    radius: 0,
  };
}

function pageSpecOf(elements: SceneElement[]): SceneSpec {
  return {
    version: "1.0",
    canvas: { width: 800, height: 600, background: "#FFFFFF" },
    elements,
    notes: [],
  };
}

test("iouOf 基本计算", () => {
  // 完全重叠
  assert.equal(iouOf({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }), 1);
  // 不重叠
  assert.equal(iouOf({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 }), 0);
  // 半重叠：交集 50，并集 150
  assert.ok(
    Math.abs(
      iouOf({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }) - 50 / 150,
    ) < 1e-9,
  );
});

test("isDuplicate：同文字同位置为重复；不同文字同位置不是重复", () => {
  const a = textElement("a", { x: 100, y: 100, width: 100, height: 20 }, "标题");

  const same = textElement("b", { x: 100, y: 100, width: 100, height: 20 }, "标题");
  assert.equal(isDuplicate(a, same).duplicate, true);

  const diffText = textElement("c", { x: 100, y: 100, width: 100, height: 20 }, "别的");
  assert.equal(isDuplicate(a, diffText).duplicate, false);

  // 不同位置相同文字：不是重复（同名餐厅不误删）
  const elsewhere = textElement("d", { x: 300, y: 300, width: 100, height: 20 }, "标题");
  assert.equal(isDuplicate(a, elsewhere).duplicate, false);
  assert.ok(isDuplicate(a, elsewhere).iou < 0.7);
});

test("isDuplicate：box 高重叠即重复；类型不同不重复", () => {
  const a = boxElement("a", { x: 0, y: 0, width: 100, height: 50 });
  const same = boxElement("b", { x: 0, y: 0, width: 100, height: 50 });
  assert.equal(isDuplicate(a, same).duplicate, true);

  const text = textElement("t", { x: 0, y: 0, width: 100, height: 50 }, "文字");
  assert.equal(isDuplicate(a, text).duplicate, false);
});

test("合并：同一元素重复消除，区域独有元素保留并重建 ID", () => {
  const page = pageSpecOf([
    textElement("title", { x: 40, y: 20, width: 400, height: 40 }, "页面标题"),
    boxElement("header_bg", { x: 0, y: 0, width: 800, height: 120 }),
  ]);

  const result = mergeRegionElements({
    pageSpec: page,
    regions: [
      {
        region: { id: "header", box: { x: 0, y: 0, width: 800, height: 120 } },
        elements: [
          // 与整页重复（同文字同位置）→ 消除
          textElement("h1", { x: 40, y: 20, width: 400, height: 40 }, "页面标题"),
          // 区域独有元素 → 保留，ID 重建
          textElement("subtitle", { x: 40, y: 70, width: 400, height: 25 }, "副标题"),
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  // 页面 2 + 区域独有 1 = 3；重复的 h1 被消除
  assert.equal(result.spec.elements.length, 3);
  assert.ok(result.spec.elements.some((e) => e.id === "header__subtitle"));

  // 重复记录
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].keptId, "title");
  assert.equal(result.duplicates[0].droppedOriginalId, "h1");

  // ID 映射
  assert.deepEqual(result.idMappings.find((m) => m.from === "subtitle"), {
    from: "subtitle",
    fromRegion: "header",
    to: "header__subtitle",
  });
  assert.deepEqual(result.idMappings.find((m) => m.from === "h1"), {
    from: "h1",
    fromRegion: "header",
    to: "title",
  });

  // 来源记录
  assert.deepEqual(result.sources["title"], { from: "page" });
  assert.deepEqual(result.sources["header__subtitle"], {
    from: "header",
    originalId: "subtitle",
  });
});

test("合并：不同位置的相同文字保留（同名不误删）", () => {
  const page = pageSpecOf([
    textElement("food_a", { x: 560, y: 140, width: 200, height: 20 }, "老边饺子"),
  ]);

  const result = mergeRegionElements({
    pageSpec: page,
    regions: [
      {
        region: { id: "right", box: { x: 560, y: 500, width: 200, height: 80 } },
        elements: [
          // 相同文字、不同位置：另一家同名餐厅 → 保留
          textElement("food_b", { x: 560, y: 520, width: 200, height: 20 }, "老边饺子"),
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.spec.elements.length, 2);
  assert.equal(result.duplicates.length, 0);
});

test("合并：同位置不同文字形成冲突候选（不自动覆盖）", () => {
  const page = pageSpecOf([
    textElement("time_a", { x: 40, y: 200, width: 130, height: 20 }, "10:00–12:00"),
  ]);

  const result = mergeRegionElements({
    pageSpec: page,
    regions: [
      {
        region: { id: "left", box: { x: 40, y: 200, width: 130, height: 20 } },
        elements: [
          textElement("time_b", { x: 40, y: 200, width: 130, height: 20 }, "10:00-12:00"),
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  // 两个元素都保留（冲突不自动覆盖）
  assert.equal(result.spec.elements.length, 2);

  const conflict = result.reviewItems.find((i) => i.type === "merge_conflict");
  assert.ok(conflict, "应有 merge_conflict 复查项");
  assert.ok(conflict.message.includes("time_a"));
  assert.ok(conflict.message.includes("time_b"));
});

test("合并：区域边界文字保留并生成复查项", () => {
  const page = pageSpecOf([]);

  const result = mergeRegionElements({
    pageSpec: page,
    regions: [
      {
        region: { id: "right", box: { x: 560, y: 130, width: 200, height: 200 } },
        elements: [
          // 贴区域左边界
          textElement("edge_text", { x: 562, y: 200, width: 100, height: 20 }, "边界文字"),
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.spec.elements.length, 1);

  const boundary = result.reviewItems.find((i) => i.type === "region_boundary");
  assert.ok(boundary, "应有 region_boundary 复查项");
  assert.equal(boundary.severity, "info");
});

test("合并：整页元素 ID 稳定不变", () => {
  const page = pageSpecOf([
    textElement("stable_id", { x: 40, y: 20, width: 400, height: 40 }, "标题"),
  ]);

  const result = mergeRegionElements({
    pageSpec: page,
    regions: [
      {
        region: { id: "header", box: { x: 0, y: 0, width: 800, height: 120 } },
        elements: [textElement("x", { x: 500, y: 500, width: 50, height: 20 }, "别的")],
      },
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.ok(result.spec.elements.some((e) => e.id === "stable_id"));
});

test("合并：回投越界元素导致失败（几何重新校验）", () => {
  const page = pageSpecOf([]);

  const result = mergeRegionElements({
    pageSpec: page,
    regions: [
      {
        region: { id: "bottom", box: { x: 0, y: 550, width: 800, height: 50 } },
        elements: [
          // 回投后越出画布（y=595 + height=20 > 600 + 1 容差）
          textElement("over", { x: 0, y: 595, width: 100, height: 20 }, "越界"),
        ],
      },
    ],
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.ok(result.issues.some((i) => i.message.includes("越出画布")));
});
