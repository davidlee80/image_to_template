/**
 * 通用 HTML 渲染器（T05）。
 *
 * 实施计划 T05 步骤 2～4：
 * - 在 #canvas 内按稳定的 zIndex/输入顺序渲染 box、image、text；
 *   文本 data-text-id，所有元素 data-element-id；
 * - 所有正文、属性经 HTML 转义；样式仅由 schema 白名单字段生成；
 *   正文 pre-wrap、换行和可见 overflow（不 line-clamp 隐藏内容）；
 * - 本地素材以 data URL 嵌入 HTML（离线打开不依赖外部资源）；
 *   MVP 图片定位与原裁剪框一致（object-fit: fill）。
 *
 * 渲染器是通用的：同一入口处理不同图片生成的模板（设计文档第二部分）。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { ImageTemplateError } from "../errors.js";
import type { SceneSpec } from "../schemas/scene.js";
import type { SceneContent } from "../schemas/content.js";
import { resolveAssetPathReal } from "../io/paths.js";

export interface BuildHtmlInput {
  spec: SceneSpec;
  content: SceneContent;
  /** 模板包根目录（素材与字体相对此解析）。 */
  bundleDir: string;
  /** 嵌入式 @font-face CSS（T05 fonts 模块产出）。 */
  fontFaceCss: string;
}

export interface BuildHtmlResult {
  html: string;
  /** 实际嵌入的图片素材记录（elementId → 包内相对路径）。 */
  embeddedImages: Array<{ elementId: string; src: string }>;
}

/** HTML 转义：正文与属性统一使用。 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** 系统回退字体栈（诊断模式字体缺失时使用；严格模式在加载检查时失败）。 */
const fallbackStack: Record<string, string> = {
  sans: '"Template-sans", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  serif: '"Template-serif", "Noto Serif CJK SC", "SimSun", serif',
  latin: '"Template-latin", Georgia, "Times New Roman", serif',
};

function positionStyle(element: {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}): string {
  return [
    "position:absolute",
    `left:${element.x}px`,
    `top:${element.y}px`,
    `width:${element.width}px`,
    `height:${element.height}px`,
    `z-index:${element.zIndex}`,
    "box-sizing:border-box",
  ].join(";");
}

async function readAssetAsPngDataUrl(
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

  // 对本地素材统一转成 PNG（支持后续替换成 JPG 等文件）
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

/**
 * 构建 HTML。渲染顺序：先按 zIndex 稳定排序（相同 zIndex 保持输入顺序）。
 */
export async function buildHtml(
  input: BuildHtmlInput,
): Promise<BuildHtmlResult> {
  const { spec, content, bundleDir, fontFaceCss } = input;

  const ordered = spec.elements
    .map((element, index) => ({ element, index }))
    .sort((a, b) => a.element.zIndex - b.element.zIndex || a.index - b.index);

  const nodes: string[] = [];
  const embeddedImages: BuildHtmlResult["embeddedImages"] = [];

  for (const { element } of ordered) {
    const position = positionStyle(element);

    if (element.type === "text") {
      const text = content[element.id] ?? "";
      const family = fallbackStack[element.fontFamily];

      const style = [
        position,
        `font-family:${family}`,
        `font-size:${element.fontSize}px`,
        `font-weight:${element.fontWeight}`,
        `line-height:${element.lineHeight}`,
        `letter-spacing:${element.letterSpacing}px`,
        `color:${element.color}`,
        `text-align:${element.align}`,
        "white-space:pre-wrap",
        "overflow-wrap:anywhere",
        "overflow:visible",
      ].join(";");

      nodes.push(
        `<div data-text-id="${escapeHtml(element.id)}" ` +
          `data-element-id="${escapeHtml(element.id)}" ` +
          `data-expected-text="${escapeHtml(text)}" ` +
          `style="${escapeHtml(style)}">${escapeHtml(text)}</div>`,
      );
      continue;
    }

    if (element.type === "box") {
      const style = [
        position,
        `background:${element.fill}`,
        `border:${element.borderWidth}px solid ${element.borderColor}`,
        `border-radius:${element.radius}px`,
      ].join(";");

      nodes.push(
        `<div data-element-id="${escapeHtml(element.id)}" ` +
          `style="${escapeHtml(style)}"></div>`,
      );
      continue;
    }

    // image：素材以 data URL 嵌入；定位与原裁剪框一致
    if (element.src === "") {
      throw new ImageTemplateError({
        code: "INVALID_ARGUMENT",
        stage: "render",
        message: `图片元素 ${element.id} 缺少 src（提取阶段应填充 assets/ 相对路径）`,
      });
    }

    const dataUrl = await readAssetAsPngDataUrl(bundleDir, element.src);
    embeddedImages.push({ elementId: element.id, src: element.src });

    const style = [
      position,
      "object-fit:fill",
      "display:block",
    ].join(";");

    nodes.push(
      `<img alt="" data-element-id="${escapeHtml(element.id)}" ` +
        `style="${escapeHtml(style)}" src="${dataUrl}">`,
    );
  }

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
${fontFaceCss}
html, body {
  margin: 0;
  padding: 0;
}
body {
  width: ${spec.canvas.width}px;
  height: ${spec.canvas.height}px;
}
#canvas {
  position: relative;
  width: ${spec.canvas.width}px;
  height: ${spec.canvas.height}px;
  background: ${spec.canvas.background};
}
</style>
</head>
<body>
<div id="canvas">${nodes.join("\n")}</div>
</body>
</html>`;

  return { html, embeddedImages };
}

/** 输出文件相对 bundle 根的约定路径。 */
export function previewHtmlPath(bundleDir: string): string {
  return path.join(bundleDir, "preview.html");
}
