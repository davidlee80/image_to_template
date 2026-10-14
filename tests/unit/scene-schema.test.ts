/**
 * T02：SceneSpec schema 与几何校验测试。
 *
 * 覆盖：合法 fixture 可解析；重复 ID、越界（1 px 容差）、未知版本、
 * 非法类型、非法资源路径、非有限数值均有具体错误路径。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  parseSceneSpec,
  sceneSpecSchema,
  type SceneSpec,
} from "../../src/schemas/scene.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

async function loadSyntheticScene(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(fixtureDir, "scenes", "synthetic-travel.scene.json"),
      "utf8",
    ),
  );
}

/** 构造最小合法 spec 的便捷副本。 */
function baseSpec(): Record<string, unknown> {
  return {
    version: "1.0",
    canvas: { width: 100, height: 100, background: "#FFFFFF" },
    elements: [
      {
        id: "title",
        type: "text",
        x: 0,
        y: 0,
        width: 50,
        height: 20,
        text: "标题",
      },
    ],
  };
}

test("人工 SceneSpec fixture 解析成功且类型收窄正确", async () => {
  const value = await loadSyntheticScene();
  const result = parseSceneSpec(value);

  assert.equal(result.ok, true);
  if (result.ok) {
    const spec: SceneSpec = result.spec;
    assert.equal(spec.version, "1.0");
    assert.equal(spec.canvas.width, 800);
    assert.equal(spec.canvas.height, 600);
    assert.ok(spec.elements.length > 10);

    const texts = spec.elements.filter((e) => e.type === "text");
    const images = spec.elements.filter((e) => e.type === "image");
    const boxes = spec.elements.filter((e) => e.type === "box");
    assert.ok(texts.length > 0);
    assert.ok(images.length > 0);
    assert.ok(boxes.length > 0);

    // 默认值填充
    const title = texts.find((e) => e.id === "destination_title");
    assert.ok(title);
    assert.equal(title.fontFamily, "sans");
    assert.equal(title.fontWeight, "700");
  }
});

test("重复元素 ID 报 DUPLICATE_ID 并带元素索引", () => {
  const value = baseSpec();
  (value.elements as Array<Record<string, unknown>>).push({
    id: "title",
    type: "box",
    x: 0,
    y: 30,
    width: 10,
    height: 10,
  });

  const result = parseSceneSpec(value);
  assert.equal(result.ok, false);
  if (!result.ok) {
    const issue = result.issues.find((i) => i.code === "DUPLICATE_ID");
    assert.ok(issue, "应有 DUPLICATE_ID issue");
    assert.equal(issue.elementId, "title");
    assert.match(issue.path, /^elements\[\d+\]$/);
  }
});

test("越出画布报 OUT_OF_CANVAS，1 px 容差内不报", () => {
  const beyond = baseSpec();
  (beyond.elements as Array<Record<string, unknown>>)[0].width = 101.5;

  const beyondResult = parseSceneSpec(beyond);
  assert.equal(beyondResult.ok, false);
  if (!beyondResult.ok) {
    assert.ok(
      beyondResult.issues.some((i) => i.code === "OUT_OF_CANVAS"),
    );
  }

  const withinTolerance = baseSpec();
  (withinTolerance.elements as Array<Record<string, unknown>>)[0].width = 100.5;
  assert.equal(parseSceneSpec(withinTolerance).ok, true);
});

test("未知版本报 UNSUPPORTED_VERSION", () => {
  const value = baseSpec();
  value.version = "2.0";

  const result = parseSceneSpec(value);
  assert.equal(result.ok, false);
  if (!result.ok) {
    const issue = result.issues.find((i) => i.code === "UNSUPPORTED_VERSION");
    assert.ok(issue);
    assert.equal(issue.path, "version");
  }
});

test("非法字体类别与字重报 SCHEMA 并带路径", () => {
  const value = baseSpec();
  (value.elements as Array<Record<string, unknown>>)[0].fontFamily = "comic-sans";

  const result = parseSceneSpec(value);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some(
        (i) => i.code === "SCHEMA" && i.path.startsWith("elements[0].fontFamily"),
      ),
    );
  }
});

test("NaN 与 Infinity 被拒绝", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const value = baseSpec();
    (value.elements as Array<Record<string, unknown>>)[0].x = bad;
    const result = sceneSpecSchema.safeParse(value);
    assert.equal(result.success, false, `x=${bad} 应被拒绝`);
  }
});

test("image 的越界素材路径报 INVALID_ASSET_PATH", () => {
  for (const badSrc of [
    "../outside.png",
    "assets/../../escape.png",
    "C:/windows/system32/evil.png",
    "\\\\server\\share\\evil.png",
    "https://evil.example.com/x.png",
    "/etc/passwd",
  ]) {
    const value = baseSpec();
    (value.elements as Array<Record<string, unknown>>).push({
      id: "photo",
      type: "image",
      x: 0,
      y: 40,
      width: 10,
      height: 10,
      src: badSrc,
    });

    const result = parseSceneSpec(value);
    assert.equal(result.ok, false, `src=${badSrc} 应被拒绝`);
    if (!result.ok) {
      assert.ok(
        result.issues.some((i) => i.code === "INVALID_ASSET_PATH"),
        `src=${badSrc} 应报 INVALID_ASSET_PATH`,
      );
    }
  }
});

test("空元素数组与超过上限被拒绝", () => {
  const empty = baseSpec();
  empty.elements = [];
  assert.equal(parseSceneSpec(empty).ok, false);

  const tooMany = baseSpec();
  tooMany.elements = Array.from({ length: 1501 }, (_, i) => ({
    id: `e${i}`,
    type: "box",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  }));
  assert.equal(parseSceneSpec(tooMany).ok, false);
});
