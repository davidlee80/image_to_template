/**
 * T11：LayoutSpec schema、语义编译与绑定解析测试。
 *
 * 覆盖：受限节点/样式/binding 路径校验（拒绝 __proto__ 等）、深度与数量上限、
 * SceneSpec→LayoutSpec 编译（来源 ID 保留、绑定映射）、repeat 局部作用域、
 * 缺失必填绑定报错、读写绑定路径。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  bindingPathSchema,
  parseLayoutSpec,
  readBindingPath,
  writeBindingPath,
  MAX_LAYOUT_DEPTH,
} from "../../src/schemas/layout.js";
import {
  compileSceneToLayout,
} from "../../src/semantic/compile.js";
import {
  resolveBindings,
  requiredBindingsOf,
} from "../../src/render/bindings.js";
import { parseSceneSpec, type SceneSpec } from "../../src/schemas/scene.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

test("binding 路径：合法路径通过；特殊路径拒绝", () => {
  for (const valid of [
    "header.title",
    "timeline.[0].title",
    "texts.destination_title",
    "a.b.c",
  ]) {
    assert.equal(bindingPathSchema.safeParse(valid).success, true, valid);
  }

  for (const invalid of [
    "header.__proto__",
    "constructor.name",
    "a.prototype.b",
    ".leading",
    "trailing.",
    "非法字符.path",
    "a..b",
  ]) {
    assert.equal(
      bindingPathSchema.safeParse(invalid).success,
      false,
      invalid,
    );
  }
});

test("readBindingPath / writeBindingPath 受限解析", () => {
  const content = {
    header: { title: "标题" },
    timeline: [
      { title: "第一站", tags: ["木栈道"] },
      { title: "第二站", tags: [] },
    ],
  };

  assert.deepEqual(readBindingPath(content, "header.title"), {
    found: true,
    value: "标题",
  });
  assert.deepEqual(readBindingPath(content, "timeline.[0].title"), {
    found: true,
    value: "第一站",
  });
  assert.deepEqual(readBindingPath(content, "timeline.[2].title"), {
    found: false,
    value: undefined,
  });
  assert.deepEqual(readBindingPath(content, "header.missing"), {
    found: false,
    value: undefined,
  });

  // __proto__ 读取返回 not found（不触达原型链）
  assert.equal(readBindingPath(content, "__proto__.polluted").found, false);

  const target: Record<string, unknown> = { timeline: [] };
  writeBindingPath(target, "header.title", "新标题");
  assert.deepEqual(target.header, { title: "新标题" });

  writeBindingPath(target, "timeline.[0]", "第一项");
  assert.deepEqual((target.timeline as unknown[])[0], "第一项");
});

function makeLayoutSpec(overrides: Record<string, unknown> = {}) {
  return {
    version: "2.0",
    canvas: { width: 800, height: 600, background: "#FFFFFF" },
    strategy: { mode: "replica" },
    root: {
      id: "root",
      type: "container",
      layout: "absolute",
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      style: {},
      children: [
        {
          id: "title",
          type: "text",
          binding: "header.title",
          fallback: "默认",
          style: { fontSize: 24 },
          overflow: "wrap",
        },
      ],
    },
    fonts: ["sans"],
    sourceElements: { title: ["destination_title"] },
    notes: [],
    ...overrides,
  };
}

test("parseLayoutSpec：合法通过；未知版本/重复 ID/深度超限拒绝", () => {
  assert.equal(parseLayoutSpec(makeLayoutSpec()).ok, true);

  const badVersion = makeLayoutSpec({ version: "3.0" });
  const versionResult = parseLayoutSpec(badVersion);
  assert.equal(versionResult.ok, false);
  if (!versionResult.ok) {
    assert.ok(versionResult.issues.some((i) => i.code === "UNSUPPORTED_VERSION"));
  }

  // 重复 ID
  const dup = makeLayoutSpec();
  (dup.root as { children: unknown[] }).children.push({
    id: "title",
    type: "text",
    binding: "header.other",
    style: {},
    overflow: "wrap",
  });
  const dupResult = parseLayoutSpec(dup);
  assert.equal(dupResult.ok, false);
  if (!dupResult.ok) {
    assert.ok(dupResult.issues.some((i) => i.code === "DUPLICATE_ID"));
  }

  // 深度超限：嵌套 MAX_LAYOUT_DEPTH+1 层
  let node: Record<string, unknown> = {
    id: "leaf",
    type: "text",
    binding: "a.b",
    style: {},
    overflow: "wrap",
  };
  for (let i = 0; i < MAX_LAYOUT_DEPTH + 1; i += 1) {
    node = {
      id: `level_${i}`,
      type: "container",
      layout: "column",
      style: {},
      children: [node],
    };
  }
  const deep = makeLayoutSpec({ root: node });
  const deepResult = parseLayoutSpec(deep);
  assert.equal(deepResult.ok, false);
  if (!deepResult.ok) {
    assert.ok(deepResult.issues.some((i) => i.code === "DEPTH_LIMIT"));
  }
});

test("grid 缺 columns / absolute 缺字段被拒绝", () => {
  const gridNoColumns = makeLayoutSpec({
    root: {
      id: "root",
      type: "container",
      layout: "grid",
      style: {},
      children: [],
    },
  });
  const gridResult = parseLayoutSpec(gridNoColumns);
  assert.equal(gridResult.ok, false);

  const absoluteNoX = makeLayoutSpec({
    root: {
      id: "root",
      type: "container",
      layout: "absolute",
      y: 0,
      width: 100,
      height: 100,
      style: {},
      children: [],
    },
  });
  assert.equal(parseLayoutSpec(absoluteNoX).ok, false);
});

test("编译：SceneSpec → LayoutSpec + 结构化内容 + ID 映射", async () => {
  const sceneValue = JSON.parse(
    await readFile(
      path.join(fixtureDir, "scenes", "synthetic-travel.scene.json"),
      "utf8",
    ),
  );
  const sceneResult = parseSceneSpec(sceneValue);
  assert.equal(sceneResult.ok, true);
  if (!sceneResult.ok) throw new Error("unreachable");
  const scene: SceneSpec = sceneResult.spec;

  // MVP 内容（提取后形态）
  const content: Record<string, string> = {};
  for (const element of scene.elements) {
    if (element.type === "text") {
      content[element.id] = element.text;
    }
  }

  const compiled = compileSceneToLayout({ scene, content });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error("unreachable");

  // LayoutSpec 合法且来源保留
  assert.equal(compiled.layout.version, "2.0");
  assert.equal(compiled.layout.strategy.mode, "replica");
  assert.equal(compiled.layout.canvas.width, 800);

  const titleNode = compiled.layout.root.children.find(
    (child) => child.id === "pos_destination_title",
  );
  assert.ok(titleNode, "text 应被 absolute 容器包裹保持原坐标");

  // sourceElements：节点 → 来源元素 ID
  assert.deepEqual(compiled.layout.sourceElements["destination_title"], [
    "destination_title",
  ]);

  // 结构化内容：正文与素材分组
  assert.equal(compiled.content.texts["destination_title"], "本溪水洞 · 天桥沟");
  assert.equal(compiled.content.assets["photo_trail"].src, "");

  // ID 映射
  const titleMapping = compiled.idMappings.find(
    (m) => m.fromId === "destination_title",
  );
  assert.deepEqual(titleMapping, {
    fromId: "destination_title",
    toBinding: "texts.destination_title",
  });

  // 内容 JSON Schema 生成
  assert.ok(
    (compiled.contentJsonSchema as { properties?: Record<string, unknown> })
      .properties?.texts,
  );

  // 编译产物可重新解析（往返一致）
  const reparsed = parseLayoutSpec(compiled.layout);
  assert.equal(reparsed.ok, true);
});

test("绑定解析：正常解析、repeat 局部作用域、缺失必填报错", () => {
  const spec = parseLayoutSpec(
    makeLayoutSpec({
      root: {
        id: "root",
        type: "container",
        layout: "column",
        style: {},
        children: [
          {
            id: "title",
            type: "text",
            binding: "header.title",
            style: {},
            overflow: "wrap",
          },
          {
            id: "stops",
            type: "repeat",
            binding: "timeline",
            gap: 10,
            itemTemplate: {
              id: "stop_title",
              type: "text",
              binding: "item.title",
              style: {},
              overflow: "wrap",
            },
          },
        ],
      },
    }),
  );
  assert.equal(spec.ok, true);
  if (!spec.ok) throw new Error("unreachable");

  const content = {
    header: { title: "页面标题" },
    timeline: [
      { title: "第一站" },
      { title: "第二站" },
      { title: "第三站" },
    ],
  };

  const resolved = resolveBindings(spec.spec, content);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.bindings.values["title"], "页面标题");

  // repeat 展开：项内绑定带索引前缀
  assert.equal(resolved.bindings.repeats["stops"].length, 3);
  assert.equal(resolved.bindings.values["stops[0].stop_title"], "第一站");
  assert.equal(resolved.bindings.values["stops[2].stop_title"], "第三站");

  // requiredBindingsOf 列出 item. 展开路径
  const required = requiredBindingsOf(spec.spec);
  assert.ok(required.some((r) => r.path === "header.title" && !r.inRepeat));
  assert.ok(required.some((r) => r.path === "item.title" && r.inRepeat));

  // 缺失必填绑定报错（带节点与路径）
  const missing = resolveBindings(spec.spec, { header: {} });
  assert.equal(missing.ok, false);
  assert.ok(
    missing.issues.some(
      (i) => i.path === "header.title" && i.nodeId === "title",
    ),
  );
  assert.ok(
    missing.issues.some((i) => i.path === "timeline" && i.nodeId === "stops"),
  );

  // allowMissing 诊断模式
  const diagnostic = resolveBindings(spec.spec, {}, { allowMissing: true });
  assert.equal(diagnostic.ok, true);
});

test("绑定解析：repeat 绑定非数组报错；值类型错误报错", () => {
  const spec = parseLayoutSpec(
    makeLayoutSpec({
      root: {
        id: "root",
        type: "container",
        layout: "column",
        style: {},
        children: [
          {
            id: "stops",
            type: "repeat",
            binding: "timeline",
            gap: 0,
            itemTemplate: {
              id: "stop_title",
              type: "text",
              binding: "item.title",
              style: {},
              overflow: "wrap",
            },
          },
          {
            id: "count",
            type: "text",
            binding: "header.day",
            style: {},
            overflow: "wrap",
          },
        ],
      },
    }),
  );
  assert.equal(spec.ok, true);
  if (!spec.ok) throw new Error("unreachable");

  // repeat 非数组
  const notArray = resolveBindings(spec.spec, {
    timeline: "不是数组",
    header: { day: 5 },
  });
  assert.equal(notArray.ok, false);
  assert.ok(
    notArray.issues.some((i) => i.path === "timeline" && i.message.includes("数组")),
  );

  // 绑定值非字符串
  const wrongType = resolveBindings(spec.spec, {
    timeline: [],
    header: { day: 5 },
  });
  assert.equal(wrongType.ok, false);
  assert.ok(
    wrongType.issues.some((i) => i.path === "header.day" && i.message.includes("字符串")),
  );
});

test("空 repeat（0 项）不报错", () => {
  const spec = parseLayoutSpec(
    makeLayoutSpec({
      root: {
        id: "root",
        type: "container",
        layout: "column",
        style: {},
        children: [
          {
            id: "stops",
            type: "repeat",
            binding: "timeline",
            gap: 0,
            itemTemplate: {
              id: "stop_title",
              type: "text",
              binding: "item.title",
              style: {},
              overflow: "wrap",
            },
          },
        ],
      },
    }),
  );
  assert.equal(spec.ok, true);
  if (!spec.ok) throw new Error("unreachable");

  const resolved = resolveBindings(spec.spec, { timeline: [] });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.bindings.repeats["stops"], []);
});
