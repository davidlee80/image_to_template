/**
 * 语义编译（T11 步骤 2、5）：SceneSpec → LayoutSpec + 结构化内容 + ID 映射。
 *
 * 实施计划：
 * - 将校对后的 SceneSpec 编译为 LayoutSpec：保留来源元素 ID 和区域框，
 *   不直接依赖未经复查的模型输出（输入应为人工校对后的模板）；
 * - 输出旧 ID 到新绑定映射；
 * - 编译为保真形态：replica 模式、节点局部 absolute 定位（布局参数
 *   由 T12 组件化逐步抽象，本阶段保证语义结构与来源可追溯）。
 */

import type { SceneSpec, SceneElement } from "../schemas/scene.js";
import {
  parseLayoutSpec,
  type LayoutSpec,
  type ContainerNodeShape,
  type LayoutNode,
} from "../schemas/layout.js";

/** 结构化内容（编译产物）：正文与素材按绑定域分组。 */
export interface CompiledStructuredContent {
  schemaVersion: "1.0";
  /** 正文：textId → string（迁移自 MVP content.json）。 */
  texts: Record<string, string>;
  /** 素材：elementId → { src, alt }（图片替换无需改渲染器）。 */
  assets: Record<string, { src: string; alt: string }>;
}

/** 旧内容键 → 新绑定路径映射（人工修订迁移依据）。 */
export interface IdMappingEntry {
  /** 旧 text 元素 ID。 */
  fromId: string;
  /** 新绑定路径（如 texts.title）。 */
  toBinding: string;
}

export interface CompileResult {
  ok: true;
  layout: LayoutSpec;
  content: CompiledStructuredContent;
  idMappings: IdMappingEntry[];
  /** 内容 JSON Schema（结构化内容的约束）。 */
  contentJsonSchema: Record<string, unknown>;
}

export interface CompileFailure {
  ok: false;
  issues: Array<{ path: string; message: string }>;
}

export type SemanticCompileResult = CompileResult | CompileFailure;

function elementToNode(
  element: SceneElement,
): LayoutNode {
  if (element.type === "text") {
    return {
      id: element.id,
      type: "text",
      binding: `texts.${element.id}`,
      fallback: element.text,
      style: {
        fontSize: element.fontSize,
        lineHeight: element.lineHeight,
        letterSpacing: element.letterSpacing,
        color: element.color,
        textAlign: element.align,
        ...(element.fontWeight === "700" ? { fontWeight: 700 } : {}),
      },
      overflow: "wrap",
    };
  }

  if (element.type === "image") {
    return {
      id: element.id,
      type: "image",
      binding: `assets.${element.id}.src`,
      src: element.src,
      alt: "",
      style: {},
    };
  }

  // box → absolute 容器（背景/装饰）
  return {
    id: element.id,
    type: "container",
    layout: "absolute",
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    style: {
      ...(element.fill !== "transparent" ? { backgroundColor: element.fill } : {}),
      ...(element.borderWidth > 0
        ? { borderWidth: element.borderWidth, borderColor: element.borderColor }
        : {}),
      ...(element.radius > 0 ? { borderRadius: element.radius } : {}),
    },
    children: [],
  };
}

function wrapAbsolute(
  node: LayoutNode,
  element: SceneElement,
): ContainerNodeShape {
  // text/image 保留在原坐标：包一层 absolute 容器（replica 保真）
  return {
    id: `pos_${element.id}`,
    type: "container",
    layout: "absolute",
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    style: {},
    children: [node],
  };
}

/**
 * 编译 SceneSpec（人工校对后）为 LayoutSpec + 结构化内容。
 * 输入 content 为 MVP Record<textId, string>（正文已在 content.json）。
 */
export function compileSceneToLayout(input: {
  scene: SceneSpec;
  /** MVP 内容（textId → 正文）。 */
  content: Record<string, string>;
}): SemanticCompileResult {
  const { scene, content } = input;

  const children: LayoutNode[] = [];
  const idMappings: IdMappingEntry[] = [];
  const texts: Record<string, string> = {};
  const assets: Record<string, { src: string; alt: string }> = {};
  const sourceElements: Record<string, string[]> = {};

  // 按 zIndex/输入顺序稳定处理
  const ordered = scene.elements
    .map((element, index) => ({ element, index }))
    .sort((a, b) => a.element.zIndex - b.element.zIndex || a.index - b.index);

  for (const { element } of ordered) {
    const node = elementToNode(element);
    sourceElements[node.id] = [element.id];

    if (element.type === "text") {
      texts[element.id] = content[element.id] ?? element.text;
      idMappings.push({
        fromId: element.id,
        toBinding: `texts.${element.id}`,
      });
      children.push(wrapAbsolute(node, element));
      continue;
    }

    if (element.type === "image") {
      assets[element.id] = { src: element.src, alt: "" };
      idMappings.push({
        fromId: element.id,
        toBinding: `assets.${element.id}.src`,
      });
      children.push(wrapAbsolute(node, element));
      continue;
    }

    children.push(node);
  }

  const layoutCandidate = {
    version: "2.0" as const,
    canvas: { ...scene.canvas },
    strategy: { mode: "replica" as const },
    root: {
      id: "root",
      type: "container" as const,
      layout: "absolute" as const,
      x: 0,
      y: 0,
      width: scene.canvas.width,
      height: scene.canvas.height,
      style: {},
      children,
    },
    fonts: ["sans" as const],
    sourceElements,
    notes: [
      "由 SceneSpec 1.0 编译：replica 保真形态，节点保留来源元素 ID（sourceElements）；组件化抽象在 T12 逐步进行。",
    ],
  };

  const parsed = parseLayoutSpec(layoutCandidate);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    };
  }

  const structuredContent: CompiledStructuredContent = {
    schemaVersion: "1.0",
    texts,
    assets,
  };

  return {
    ok: true,
    layout: parsed.spec,
    content: structuredContent,
    idMappings,
    contentJsonSchema: buildCompiledContentJsonSchema(structuredContent),
  };
}

/** 生成编译产物的内容 JSON Schema（texts/assets 键集合）。 */
export function buildCompiledContentJsonSchema(
  content: CompiledStructuredContent,
): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      schemaVersion: { const: "1.0" },
      texts: {
        type: "object",
        properties: Object.fromEntries(
          Object.keys(content.texts).map((key) => [key, { type: "string" }]),
        ),
        required: Object.keys(content.texts),
        additionalProperties: { type: "string" },
      },
      assets: {
        type: "object",
        properties: Object.fromEntries(
          Object.keys(content.assets).map((key) => [
            key,
            {
              type: "object",
              properties: {
                src: { type: "string" },
                alt: { type: "string" },
              },
              required: ["src"],
            },
          ]),
        ),
        required: Object.keys(content.assets),
        additionalProperties: false,
      },
    },
    required: ["schemaVersion", "texts", "assets"],
  };
}
