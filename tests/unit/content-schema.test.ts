/**
 * T02：内容校验与内容 schema 生成测试。
 *
 * 覆盖：内容键与 text ID 一一对应（缺失报错/未知提示/空串有效）、
 * 长度策略（unbounded 默认、absolute、relative）、部分编辑合并、
 * `<script>` 字符串作为内容被安全保留（数据不执行）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContentJsonSchema,
  buildContentZodSchema,
  maxLengthForTextElement,
  mergeSceneContent,
  parseSceneContent,
} from "../../src/schemas/content.js";
import { parseSceneSpec, type SceneSpec } from "../../src/schemas/scene.js";

const sceneValue = {
  version: "1.0",
  canvas: { width: 200, height: 200, background: "#FFFFFF" },
  elements: [
    { id: "title", type: "text", x: 0, y: 0, width: 100, height: 20, text: "标题" },
    { id: "desc", type: "text", x: 0, y: 30, width: 100, height: 40, text: "一段较长的描述文字" },
    { id: "photo", type: "image", x: 0, y: 80, width: 50, height: 50, src: "assets/photo.png" },
  ],
};

function loadSpec(): SceneSpec {
  const result = parseSceneSpec(sceneValue);
  assert.equal(result.ok, true, "测试 fixture 应为合法 SceneSpec");
  if (result.ok) {
    return result.spec;
  }
  throw new Error("unreachable");
}

test("内容键与 text ID 一一对应：合法内容通过", () => {
  const result = parseSceneContent(loadSpec(), {
    title: "新标题",
    desc: "新描述",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
});

test("缺失必填键报 MISSING_CONTENT_KEY", () => {
  const result = parseSceneContent(loadSpec(), { title: "只有标题" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.code === "MISSING_CONTENT_KEY" && i.elementId === "desc"));
  }
});

test("空字符串是有效的主动编辑", () => {
  const result = parseSceneContent(loadSpec(), { title: "", desc: "保留" });
  assert.equal(result.ok, true);
});

test("未知键产生提示但不阻断", () => {
  const result = parseSceneContent(loadSpec(), {
    title: "t",
    desc: "d",
    ghost_key: "没有对应元素",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "UNKNOWN_CONTENT_KEY");
  }
});

test("非字符串内容值报 SCHEMA", () => {
  const result = parseSceneContent(loadSpec(), { title: 123, desc: "d" });
  assert.equal(result.ok, false);
});

test("<script> 字符串作为内容被安全保留为数据", () => {
  const malicious = '<script>alert("xss")</script>';
  const result = parseSceneContent(loadSpec(), { title: malicious, desc: "正常" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.content.title, malicious);
  }
});

test("默认策略 unbounded 不限制长度（溢出交给布局检查）", () => {
  const spec = loadSpec();
  const descElement = spec.elements.find((e) => e.id === "desc");
  assert.ok(descElement && descElement.type === "text");
  assert.equal(maxLengthForTextElement(descElement, { strategy: "unbounded" }), undefined);

  // 超长内容通过 schema（不能把通过 schema 当成没有溢出）
  const zodSchema = buildContentZodSchema(spec);
  const longText = "很长的文字".repeat(100);
  assert.equal(zodSchema.safeParse({ title: longText, desc: longText }).success, true);
});

test("absolute 策略统一限制长度", () => {
  const spec = loadSpec();
  const policy = { strategy: "absolute" as const, absoluteMaxLength: 10 };
  const zodSchema = buildContentZodSchema(spec, policy);
  assert.equal(zodSchema.safeParse({ title: "短", desc: "短" }).success, true);
  assert.equal(
    zodSchema.safeParse({ title: "超过十个字符的标题内容", desc: "短" }).success,
    false,
  );
});

test("relative 策略按原文长度计算上限且不小于原文", () => {
  const spec = loadSpec();
  const descElement = spec.elements.find((e) => e.id === "desc");
  assert.ok(descElement && descElement.type === "text");

  const policy = { strategy: "relative" as const, relativeFactor: 2, extraAllowance: 5 };
  const max = maxLengthForTextElement(descElement, policy);
  assert.equal(max, descElement.text.length * 2 + 5);

  // 策略非法时抛出明确错误
  assert.throws(() => maxLengthForTextElement(descElement, { strategy: "absolute" }));
  assert.throws(() => maxLengthForTextElement(descElement, { strategy: "relative" }));
});

test("content.schema.json 生成包含全部 text 键且与模板 schema 分离", () => {
  const spec = loadSpec();
  const { jsonSchema, policy } = buildContentJsonSchema(spec, {
    strategy: "absolute",
    absoluteMaxLength: 500,
  });

  assert.equal(policy.strategy, "absolute");
  const props = (jsonSchema as { properties?: Record<string, unknown> }).properties;
  assert.ok(props);
  assert.ok("title" in props);
  assert.ok("desc" in props);
  assert.equal("photo" in props, false, "image 元素不应出现在内容 schema");
  // 缺失必填键在 required 中声明
  const required = (jsonSchema as { required?: string[] }).required;
  assert.ok(required?.includes("title"));
});

test("mergeSceneContent 支持部分编辑并保留未知键提示", () => {
  const spec = loadSpec();
  const result = mergeSceneContent(spec, { title: "原标题", desc: "原描述" }, {
    title: "改过的标题",
    unknown_new_key: "新键",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.content.title, "改过的标题");
    assert.equal(result.content.desc, "原描述");
    assert.equal(result.warnings.length, 1);
  }
});
