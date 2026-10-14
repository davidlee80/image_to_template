/**
 * T14：受限补丁单元测试（离线）。
 *
 * 覆盖：
 * - 合法小幅补丁可应用（SceneSpec/LayoutSpec）；
 * - 删文字、改内容、改图片 src、非法字段均被拒绝；
 * - 未知 ID 拒绝；
 * - 单轮幅度超限拒绝；
 * - 小步累积绕过限制被累计上限拦截；
 * - flow 节点不强改 absolute（layout 字段禁止）；
 * - 应用后模板重新走 schema 校验（破坏结构被拒）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PATCH_LIMITS,
  parseTemplatePatch,
  validatePatchFields,
  SCENE_PATCHABLE_FIELDS,
  LAYOUT_PATCHABLE_FIELDS,
} from "../../src/schemas/patch.js";
import {
  applyPatchToScene,
  applyPatchToLayout,
  applyTemplatePatch,
} from "../../src/calibration/apply.js";
import type { SceneSpec } from "../../src/schemas/scene.js";
import type { LayoutSpec } from "../../src/schemas/layout.js";

const scene: SceneSpec = {
  version: "1.0",
  canvas: { width: 1000, height: 1500, background: "#FFFFFF" },
  elements: [
    {
      id: "title",
      type: "text",
      x: 100,
      y: 50,
      width: 400,
      height: 40,
      zIndex: 1,
      confidence: 0.9,
      text: "",
      fontSize: 30,
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
      x: 600,
      y: 100,
      width: 200,
      height: 150,
      zIndex: 1,
      confidence: 0.8,
      src: "assets/photo.png",
    },
  ],
  notes: [],
};

const layout: LayoutSpec = {
  version: "2.0",
  canvas: { width: 1000, height: 1500, background: "#FFFFFF" },
  strategy: { mode: "replica" },
  root: {
    id: "root",
    type: "container",
    layout: "absolute",
    x: 0,
    y: 0,
    width: 1000,
    height: 1500,
    style: {},
    children: [
      {
        id: "title_wrap",
        type: "container",
        layout: "absolute",
        x: 100,
        y: 50,
        width: 400,
        height: 40,
        style: {},
        children: [
          {
            id: "title_text",
            type: "text",
            binding: "texts.title",
            fallback: "",
            style: { fontSize: 30, color: "#193753" },
            overflow: "wrap",
          },
        ],
      },
      {
        id: "flow_section",
        type: "container",
        layout: "column",
        style: { padding: 16 },
        children: [],
      },
    ],
  },
  fonts: ["sans"],
  sourceElements: {},
  notes: [],
};

test("parseTemplatePatch：合法与非法形态", () => {
  const ok = parseTemplatePatch({
    version: "1.0",
    changes: [{ id: "title", set: { x: 108 } }],
  });
  assert.equal(ok.ok, true);

  const badVersion = parseTemplatePatch({
    version: "9.9",
    changes: [{ id: "title", set: { x: 108 } }],
  });
  assert.equal(badVersion.ok, false);

  const emptyChanges = parseTemplatePatch({ version: "1.0", changes: [] });
  assert.equal(emptyChanges.ok, false);

  const emptySet = parseTemplatePatch({
    version: "1.0",
    changes: [{ id: "title", set: {} }],
  });
  assert.equal(emptySet.ok, false);
});

test("SceneSpec：合法小幅补丁应用且原模板不被修改", () => {
  const result = applyPatchToScene(scene, {
    version: "1.0",
    changes: [
      { id: "title", set: { x: 108, y: 54, fontSize: 32, color: "#224466" } },
    ],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    const patched = result.target as SceneSpec;
    const title = patched.elements.find(
      (e): e is SceneSpec["elements"][number] & { fontSize: number } =>
        e.id === "title",
    )!;
    assert.equal(title.x, 108);
    assert.equal(title.fontSize, 32);
    // 原模板未被修改
    assert.equal(scene.elements[0].x, 100);
    assert.equal(
      (scene.elements[0] as { fontSize: number }).fontSize,
      30,
    );
  }
});

test("SceneSpec：删文字/改内容/改图片/改类型/改 zIndex 均被拒绝", () => {
  for (const set of [
    { text: "篡改正文" },
    { type: "box" },
    { src: "assets/evil.png" },
    { zIndex: 99 },
    { id: "new_id" },
    { confidence: 1.5 },
  ]) {
    const result = applyTemplatePatch(scene, {
      version: "1.0",
      changes: [{ id: "title", set }],
    });
    assert.equal(result.ok, false, `set=${JSON.stringify(set)} 应被拒绝`);
    if (!result.ok) {
      assert.ok(
        result.issues.some(
          (i) => i.code === "FORBIDDEN_FIELD" || i.code === "UNKNOWN_FIELD",
        ),
      );
    }
  }
});

test("未知 ID 拒绝", () => {
  const result = applyPatchToScene(scene, {
    version: "1.0",
    changes: [{ id: "nonexistent", set: { x: 5 } }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.code === "UNKNOWN_ID"));
  }
});

test("单轮幅度超限拒绝（位置 > 8px、字号 > 2px）", () => {
  const position = applyPatchToScene(scene, {
    version: "1.0",
    changes: [{ id: "title", set: { x: 100 + DEFAULT_PATCH_LIMITS.perRoundPositionPx + 1 } }],
  });
  assert.equal(position.ok, false);
  if (!position.ok) {
    assert.ok(
      position.issues.some((i) => i.code === "MAGNITUDE_PER_ROUND"),
    );
  }

  const fontSize = applyPatchToScene(scene, {
    version: "1.0",
    changes: [{ id: "title", set: { fontSize: 30 + DEFAULT_PATCH_LIMITS.perRoundFontSizePx + 1 } }],
  });
  assert.equal(fontSize.ok, false);
  if (!fontSize.ok) {
    assert.ok(fontSize.issues.some((i) => i.code === "MAGNITUDE_PER_ROUND"));
  }
});

test("小步累积被累计上限拦截（每轮 8px×4 轮 > 累计 24px）", () => {
  let cumulative: Record<string, Record<string, number>> = {};
  let current = scene;

  let round = 0;
  let lastResult: { ok: boolean } | undefined;
  while (round < 4) {
    const result = applyPatchToScene(
      current,
      { version: "1.0", changes: [{ id: "title", set: { x: (current.elements[0].x ?? 0) + 8 } }] },
      { cumulative },
    );
    lastResult = result;
    if (!result.ok) {
      break;
    }
    cumulative = result.cumulative;
    current = result.target as SceneSpec;
    round += 1;
  }

  // 4 轮 × 8px = 32px > 累计 24px：第 4 轮应被拒绝
  assert.equal(round, 3, `应在第 4 轮被累计上限拦截（实际完成 ${round} 轮）`);
  assert.ok(lastResult && !lastResult.ok);
});

test("LayoutSpec：flow 节点禁止 layout/binding 改动；absolute 节点可调定位", () => {
  // flow 节点禁止改 layout（不强改 absolute）
  const flowPatch = applyPatchToLayout(layout, {
    version: "1.0",
    changes: [{ id: "flow_section", set: { layout: "absolute" as unknown as number } }],
  });
  assert.equal(flowPatch.ok, false);

  // absolute 容器合法小幅定位调整
  const ok = applyPatchToLayout(layout, {
    version: "1.0",
    changes: [{ id: "title_wrap", set: { x: 108 } }],
  });
  assert.equal(ok.ok, true);

  // text 节点样式调整（fontSize ≤ 2px）
  const textStyle = applyPatchToLayout(layout, {
    version: "1.0",
    changes: [{ id: "title_text", set: { fontSize: 31 } }],
  });
  assert.equal(textStyle.ok, true);

  // 禁止改正文绑定
  const binding = applyPatchToLayout(layout, {
    version: "1.0",
    changes: [{ id: "title_text", set: { binding: "texts.evil" as unknown as number } }],
  });
  assert.equal(binding.ok, false);
});

test("白名单内容核对：SceneSpec 不含 src/binding；LayoutSpec 不含 src/text", () => {
  assert.ok(!SCENE_PATCHABLE_FIELDS.includes("src" as never));
  assert.ok(!SCENE_PATCHABLE_FIELDS.includes("text" as never));
  assert.ok(!LAYOUT_PATCHABLE_FIELDS.includes("src" as never));
  assert.ok(!LAYOUT_PATCHABLE_FIELDS.includes("text" as never));
  assert.ok(!LAYOUT_PATCHABLE_FIELDS.includes("binding" as never));
});

test("补丁后模板破坏结构被 schema 校验拒绝", () => {
  // width=0 是数值字段：幅度检查先行拒绝（400px 超单轮上限），同样保护结构
  const widthResult = applyPatchToScene(scene, {
    version: "1.0",
    changes: [{ id: "title", set: { width: 0 } }],
  });
  assert.equal(widthResult.ok, false);

  // 非法颜色（无幅度概念）直达 schema 复检：破坏结构被拒
  const result = applyPatchToScene(scene, {
    version: "1.0",
    changes: [{ id: "title", set: { color: "not-a-color" } }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.code === "SCHEMA"));
  }
});

test("validatePatchFields：单条 change 字段校验", () => {
  const issues = validatePatchFields(
    { id: "x", set: { text: "a", unknownField: 1 } },
    SCENE_PATCHABLE_FIELDS,
  );
  assert.equal(issues.length, 2);
  assert.ok(issues.some((i) => i.code === "FORBIDDEN_FIELD"));
  assert.ok(issues.some((i) => i.code === "UNKNOWN_FIELD"));
});
