/**
 * LayoutSpec → HTML 渲染器（T12）。
 *
 * 同一渲染入口处理两种模板版本：
 * - SceneSpec 1.0 → render/html.ts（定位式）；
 * - LayoutSpec 2.0 → 本模块（组件 + 流式布局 + 绑定）。
 *
 * 组件节点走注册表；text/image/repeat/container 走通用节点；
 * 样式仅由 schema 白名单与主题 token 生成；正文全转义。
 */

import path from "node:path";
import { readFile } from "node:fs/promises";

import sharp from "sharp";

import { ImageTemplateError } from "../errors.js";
import { escapeHtml } from "./html.js";
import { resolveAssetPathReal } from "../io/paths.js";
import {
  resolveBindings,
  type ResolvedBindings,
} from "./bindings.js";
import {
  componentRegistry,
  type ComponentContext,
} from "./components.js";
import {
  defaultTravelTheme,
  applyThemeOverrides,
  type TravelTheme,
  type DeepPartial,
} from "../semantic/travel-theme.js";
import type {
  LayoutNode,
  LayoutSpec,
  StyleFields,
} from "../schemas/layout.js";
import { readBindingPath } from "../schemas/layout.js";
import type { TravelContent } from "../schemas/travel.js";
import { parseTravelContent } from "../schemas/travel.js";

export interface BuildLayoutHtmlInput {
  spec: LayoutSpec;
  /** 结构化内容（迁移后形态或宿主提供）。 */
  content: unknown;
  /** 模板包根目录（素材解析根）。 */
  bundleDir: string;
  /** 嵌入式 @font-face CSS。 */
  fontFaceCss: string;
  /** 主题覆盖（校准值）。 */
  themeOverrides?: DeepPartial<TravelTheme>;
  /** 渲染模式：replica 固定画布 / adaptive 高度自适应（T13 分页）。 */
  mode?: "replica" | "adaptive";
}

export interface BuildLayoutHtmlResult {
  html: string;
  /** 绑定解析结果（诊断用）。 */
  bindings: ResolvedBindings;
  /** 使用的主题（含覆盖）。 */
  theme: TravelTheme;
}

/** 白名单样式 → CSS 声明。 */
function styleToCss(style: StyleFields): string {
  const entries = Object.entries(style) as Array<
    [string, string | number]
  >;
  return entries
    .map(([field, value]) => {
      const css = typeof value === "number" ? `${field === "lineHeight" ? String(value) : `${value}px`}` : value;
      return `${field}:${css}`;
    })
    .join(";");
}

/** 素材 → data URL（同 SceneSpec 渲染策略：统一 PNG 嵌入）。 */
async function assetToDataUrl(
  bundleDir: string,
  src: string,
): Promise<string> {
  const file = await resolveAssetPathReal(bundleDir, src, "render");
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "render",
      message: `素材读取失败：${src}（${(error as Error).message}）`,
      cause: error,
    });
  }
  try {
    const png = await sharp(bytes).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (error) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "render",
      message: `素材不是有效图片：${src}（${(error as Error).message}）`,
      cause: error,
    });
  }
}

const layoutStyle: Record<string, string> = {
  row: "display:flex;flex-direction:row",
  column: "display:flex;flex-direction:column",
};

/**
 * 渲染 LayoutSpec 为 HTML。
 * 缺失必填绑定直接失败（严格语义；诊断由调用方 allowMissing 预检后降级）。
 */
export async function buildLayoutHtml(
  input: BuildLayoutHtmlInput,
): Promise<BuildLayoutHtmlResult> {
  const { spec, content, bundleDir, fontFaceCss } = input;
  const mode = input.mode ?? spec.strategy.mode;

  // 绑定解析（缺失必填即失败）
  const bindingResult = resolveBindings(spec, content);
  if (!bindingResult.ok) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "render",
      message: `绑定解析失败：${bindingResult.issues
        .map((issue) => issue.message)
        .join("；")}`,
    });
  }

  // 内容按旅行 schema 解析（组件需要结构化字段；宽松：仅组件实际访问）
  const travel = parseTravelContent(content);
  if (!travel.ok && input.content !== undefined) {
    // 结构化内容不完整时组件按可选模块降级（不阻断渲染）；
    // 严重结构错误由 validate 阶段报告。
    void travel;
  }
  const travelContent = travel.ok
    ? travel.content
    : (normalizeToTravelContent(content) as TravelContent);

  const theme = applyThemeOverrides(
    defaultTravelTheme,
    input.themeOverrides ?? {},
  );

  // 素材缓存（同素材不重复读）
  const assetCache = new Map<string, string>();
  const resolveImageSrc = async (src: string): Promise<string> => {
    if (assetCache.has(src)) {
      return assetCache.get(src)!;
    }
    const dataUrl = await assetToDataUrl(bundleDir, src);
    assetCache.set(src, dataUrl);
    return dataUrl;
  };

  /** 渲染节点为 HTML。 */
  const renderNode = async (
    node: LayoutNode,
    scopedIdPrefix: string,
  ): Promise<string> => {
    const nodeId = scopedIdPrefix + node.id;

    if (node.type === "text") {
      const value = bindingResult.bindings.values[nodeId];
      const css = [
        layoutStyle.column,
        styleToCss(node.style),
        "white-space:pre-wrap",
        "overflow-wrap:anywhere",
        "overflow:visible",
      ]
        .filter((s) => s !== "")
        .join(";");
      return `<div data-text-id="${escapeHtml(node.id)}" data-element-id="${escapeHtml(node.id)}" data-expected-text="${escapeHtml(String(value ?? node.fallback))}" style="${escapeHtml(css)}">${escapeHtml(String(value ?? node.fallback))}</div>`;
    }

    if (node.type === "image") {
      const boundSrc =
        node.binding !== undefined
          ? (bindingResult.bindings.values[nodeId] as string | undefined)
          : undefined;
      const src = boundSrc ?? node.src;
      if (src === "") {
        throw new ImageTemplateError({
          code: "INVALID_ARGUMENT",
          stage: "render",
          message: `图片节点 ${node.id} 缺少 src 与可用绑定`,
        });
      }
      const dataUrl = await resolveImageSrc(src);
      return `<img alt="${escapeHtml(node.alt)}" data-element-id="${escapeHtml(node.id)}" src="${dataUrl}" style="${escapeHtml(styleToCss(node.style))};max-width:100%;display:block">`;
    }

    if (node.type === "repeat") {
      const items = bindingResult.bindings.repeats[nodeId] ?? [];
      const parts: string[] = [];
      for (const { index } of items) {
        const inner = await renderNode(
          node.itemTemplate,
          `${nodeId}[${index}].`,
        );
        parts.push(inner);
      }
      const gapCss =
        node.gap > 0 ? `gap:${node.gap}px` : "";
      return `<div data-element-id="${escapeHtml(node.id)}" style="${escapeHtml(`${layoutStyle.column}${gapCss !== "" ? `;${gapCss}` : ""}`)}">${parts.join("\n")}</div>`;
    }

    if (node.type === "component") {
      const renderer = componentRegistry[node.component];
      if (renderer === undefined) {
        throw new ImageTemplateError({
          code: "UNSUPPORTED",
          stage: "render",
          message: `未知组件：${node.component}（已注册：${Object.keys(componentRegistry).join(", ")}）`,
        });
      }

      // 组件绑定子树（可选）：组件读取绑定域
      let componentContent = travelContent;
      if (node.binding !== undefined) {
        const subtree = readSubtree(content, node.binding);
        if (subtree.found) {
          componentContent = normalizeToTravelContent(subtree.value);
        }
      }

      // 同步 resolveImageSrc：先收集组件输出中的 src 引用不可行；
      // 组件输出使用占位符，渲染后统一替换。
      const placeholders: Array<{ marker: string; src: string }> = [];
      const ctx: ComponentContext = {
        theme,
        resolveImageSrc: (src) => {
          const marker = `__ITT_IMG_${placeholders.length}__`;
          placeholders.push({ marker, src });
          return marker;
        },
        idPrefix: node.id,
      };

      let html = renderer(componentContent, node.props, ctx);
      // 空组件输出（空模块隐藏）
      if (html.trim() === "") {
        return "";
      }

      // 替换占位符为 data URL
      for (const { marker, src } of placeholders) {
        const dataUrl = await resolveImageSrc(src);
        html = html.split(marker).join(dataUrl);
      }

      return `<div data-component="${escapeHtml(node.component)}" data-element-id="${escapeHtml(node.id)}">${html}</div>`;
    }

    // container
    const childrenHtml: string[] = [];
    for (const child of node.children) {
      childrenHtml.push(await renderNode(child, scopedIdPrefix));
    }

    const isRoot = scopedIdPrefix === "" && node.id === spec.root.id;
    let css: string;
    if (node.layout === "absolute") {
      css = [
        "position:absolute",
        `left:${node.x ?? 0}px`,
        `top:${node.y ?? 0}px`,
        node.width !== undefined ? `width:${node.width}px` : "",
        node.height !== undefined ? `height:${node.height}px` : "",
        styleToCss(node.style),
      ]
        .filter((s) => s !== "")
        .join(";");
    } else if (node.layout === "grid") {
      css = `display:grid;grid-template-columns:repeat(${node.columns ?? 2},1fr)${Object.keys(node.style).length > 0 ? `;${styleToCss(node.style)}` : ""}`;
    } else {
      css = `${layoutStyle[node.layout]}${Object.keys(node.style).length > 0 ? `;${styleToCss(node.style)}` : ""}`;
    }

    if (isRoot) {
      // 根节点：canvas 定位上下文
      const canvasCss =
        mode === "replica"
          ? `width:${spec.canvas.width}px;height:${spec.canvas.height}px`
          : `width:${spec.canvas.width}px;min-height:${spec.canvas.height}px`;
      return `<div id="canvas" style="position:relative;${canvasCss};background:${spec.canvas.background}"><div data-element-id="${escapeHtml(node.id)}" style="${escapeHtml(css)}">${childrenHtml.join("\n")}</div></div>`;
    }

    return `<div data-element-id="${escapeHtml(node.id)}" style="${escapeHtml(css)}">${childrenHtml.join("\n")}</div>`;
  };

  const body = await renderNode(spec.root, "");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
${fontFaceCss}
html, body { margin: 0; padding: 0; }
body { width: ${spec.canvas.width}px; }
</style>
</head>
<body>
${body}
</body>
</html>`;

  return { html, bindings: bindingResult.bindings, theme };
}

/** 读取绑定子树（复用受限解析）。 */
function readSubtree(
  content: unknown,
  binding: string,
): { found: boolean; value: unknown } {
  return readBindingPath(content, binding);
}

/** 任意结构 → TravelContent（宽松归一：组件按可选模块降级）。 */
function normalizeToTravelContent(value: unknown): TravelContent {
  if (typeof value !== "object" || value === null) {
    return emptyTravelContent();
  }
  const record = value as Record<string, unknown>;
  const parsed = parseTravelContent({ ...emptyTravelContent(), ...record });
  if (parsed.ok) {
    return parsed.content;
  }
  return { ...emptyTravelContent(), ...(record as Partial<TravelContent>) };
}

function emptyTravelContent(): TravelContent {
  return {
    schemaVersion: "1.0",
    header: { day: 1, date: "", weekday: "", title: "", subtitle: "" },
    timeline: [],
    photos: [],
    foods: [],
    experiences: [],
    photoChecklist: [],
    restaurantGroups: [],
  };
}

/** LayoutSpec 渲染入口的预检（诊断模式用：缺失绑定的节点清单）。 */
export function precheckBindings(
  spec: LayoutSpec,
  content: unknown,
): Array<{ nodeId: string; path: string; message: string }> {
  const result = resolveBindings(spec, content, { allowMissing: true });
  return result.issues;
}
