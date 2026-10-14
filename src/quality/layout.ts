/**
 * 布局诊断分析（T06）。
 *
 * 实施计划 T06 步骤 3～4：
 * - 检测 scrollWidth/Height 与 clientWidth/Height 差值、实际文字 Range 边界
 *   超出文字框/画布、文本间非预期重叠与高层元素遮挡候选；
 * - 设计允许的重叠关系显式记录（文字与其背景 box）；复杂遮挡进入人工复查。
 *
 * findings 分类：
 * - blocker：严格模式阻断导出（文字越出画布、资源加载失败等）；
 * - warning：进入报告与复查清单（元素内溢出、重叠/遮挡候选）。
 */

import type { BrowserDiagnostics } from "../render/browser.js";

export interface LayoutFinding {
  code:
    | "CANVAS_OVERFLOW"
    | "TEXT_OVERFLOW_ELEMENT"
    | "TEXT_BEYOND_CANVAS"
    | "TEXT_TEXT_OVERLAP"
    | "TEXT_OCCLUDED"
    | "IMAGE_LOAD_FAILED"
    | "FONT_LOAD_FAILED";
  severity: "blocker" | "warning";
  elementId?: string;
  /** 相关边界（文字实际边界或元素盒）。 */
  bounds?: { x: number; y: number; width: number; height: number };
  message: string;
  evidence?: Record<string, unknown>;
}

export interface AllowedOverlap {
  textId: string;
  otherId: string;
  /** other 的元素类型（box=背景/装饰；image=照片说明等由 extract 阶段复查）。 */
  otherType: string;
}

export interface LayoutAnalysis {
  findings: LayoutFinding[];
  /** 画布级溢出（scroll - client）。 */
  overflowX: number;
  overflowY: number;
  /** 设计允许的重叠记录（文字与背景 box）。 */
  allowedOverlaps: AllowedOverlap[];
}

/** 溢出容差（px）：小于此值视为舍入噪声（设计允许至多 1px 容差）。 */
export const OVERFLOW_TOLERANCE_PX = 1;

/** 遮挡候选：文字实际边界被更高层不透明元素覆盖比例阈值。 */
export const OCCLUSION_RATIO = 0.5;

function intersectArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export interface LayoutAnalysisInput {
  diagnostics: BrowserDiagnostics;
  canvas: { width: number; height: number };
  /** 字体加载失败是否按 blocker 处理（严格模式）；诊断模式为 warning。 */
  fontFailureIsBlocker?: boolean;
}

/** 分析浏览器诊断数据，产出布局发现与允许重叠记录。 */
export function analyzeLayout(input: LayoutAnalysisInput): LayoutAnalysis {
  const { diagnostics, canvas } = input;
  const findings: LayoutFinding[] = [];
  const allowedOverlaps: AllowedOverlap[] = [];

  // ---- 画布级溢出 ----
  const overflowX = diagnostics.canvas.scrollWidth - diagnostics.canvas.clientWidth;
  const overflowY = diagnostics.canvas.scrollHeight - diagnostics.canvas.clientHeight;

  if (overflowX > OVERFLOW_TOLERANCE_PX || overflowY > OVERFLOW_TOLERANCE_PX) {
    findings.push({
      code: "CANVAS_OVERFLOW",
      severity: "warning",
      message: `画布内容溢出：scroll ${diagnostics.canvas.scrollWidth}×${diagnostics.canvas.scrollHeight} > client ${diagnostics.canvas.clientWidth}×${diagnostics.canvas.clientHeight}`,
      evidence: { overflowX, overflowY },
    });
  }

  // ---- 图片加载核查 ----
  for (const image of diagnostics.images) {
    if (image.naturalWidth === 0 || image.naturalHeight === 0) {
      findings.push({
        code: "IMAGE_LOAD_FAILED",
        severity: "blocker",
        elementId: image.elementId,
        message: `图片加载失败：${image.elementId}（naturalWidth=${image.naturalWidth}）`,
      });
    }
  }

  // ---- 字体加载核查 ----
  for (const font of diagnostics.fontsLoaded) {
    if (!font.loaded) {
      findings.push({
        code: "FONT_LOAD_FAILED",
        severity: input.fontFailureIsBlocker === true ? "blocker" : "warning",
        message: `字体加载失败：${font.family} ${font.weight}`,
      });
    }
  }

  // ---- 文字边界 ----
  for (const text of diagnostics.texts) {
    if (text.overflowX > OVERFLOW_TOLERANCE_PX || text.overflowY > OVERFLOW_TOLERANCE_PX) {
      findings.push({
        code: "TEXT_OVERFLOW_ELEMENT",
        severity: "warning",
        elementId: text.id,
        bounds: text.textBounds ?? undefined,
        message: `文字超出其声明框：${text.id}（overflowX=${text.overflowX}px, overflowY=${text.overflowY}px）`,
        evidence: { overflowX: text.overflowX, overflowY: text.overflowY },
      });
    }

    if (text.textBounds !== null) {
      const beyondRight = text.textBounds.x + text.textBounds.width - canvas.width;
      const beyondBottom = text.textBounds.y + text.textBounds.height - canvas.height;
      const beyondLeft = -text.textBounds.x;
      const beyondTop = -text.textBounds.y;

      if (
        beyondRight > OVERFLOW_TOLERANCE_PX ||
        beyondBottom > OVERFLOW_TOLERANCE_PX ||
        beyondLeft > OVERFLOW_TOLERANCE_PX ||
        beyondTop > OVERFLOW_TOLERANCE_PX
      ) {
        findings.push({
          code: "TEXT_BEYOND_CANVAS",
          severity: "blocker",
          elementId: text.id,
          bounds: text.textBounds,
          message: `文字实际边界越出画布：${text.id}（文字边界 ${Math.round(text.textBounds.x)},${Math.round(text.textBounds.y)} ${Math.round(text.textBounds.width)}×${Math.round(text.textBounds.height)}；画布 ${canvas.width}×${canvas.height}）`,
          evidence: { beyondRight, beyondBottom, beyondLeft, beyondTop },
        });
      }
    }
  }

  // ---- 文字间非预期重叠（实际文字边界相交） ----
  const textsWithBounds = diagnostics.texts.filter((t) => t.textBounds !== null);
  for (let i = 0; i < textsWithBounds.length; i += 1) {
    for (let j = i + 1; j < textsWithBounds.length; j += 1) {
      const a = textsWithBounds[i];
      const b = textsWithBounds[j];
      const area = intersectArea(a.textBounds!, b.textBounds!);
      if (area > 0) {
        findings.push({
          code: "TEXT_TEXT_OVERLAP",
          severity: "warning",
          elementId: a.id,
          bounds: a.textBounds ?? undefined,
          message: `文字 ${a.id} 与 ${b.id} 的实际边界重叠（交集 ${Math.round(area)} px²）`,
          evidence: { otherId: b.id, area },
        });
      }
    }
  }

  // ---- 遮挡候选与允许重叠记录 ----
  for (const text of diagnostics.texts) {
    if (text.textBounds === null) {
      continue;
    }

    for (const element of diagnostics.elements) {
      if (element.id === text.id || element.type === "text") {
        continue;
      }

      const overlap = intersectArea(text.textBounds, element.box);
      const textArea = text.textBounds.width * text.textBounds.height;

      if (overlap <= 0) {
        continue;
      }

      if (element.type === "box") {
        // 文字位于背景/装饰 box 之上：设计允许，显式记录。
        allowedOverlaps.push({
          textId: text.id,
          otherId: element.id,
          otherType: "box",
        });
        continue;
      }

      // image 遮挡文字：更高层的图片覆盖文字 ≥ 阈值 → 复查候选
      if (
        element.type === "image" &&
        element.zIndex > (diagnostics.elements.find((e) => e.id === text.id)?.zIndex ?? 0) &&
        overlap / (textArea || 1) >= OCCLUSION_RATIO
      ) {
        findings.push({
          code: "TEXT_OCCLUDED",
          severity: "warning",
          elementId: text.id,
          bounds: text.textBounds,
          message: `文字 ${text.id} 被更高层图片 ${element.id} 遮挡 ${(100 * overlap / (textArea || 1)).toFixed(0)}%：复杂遮挡需人工复查`,
          evidence: { occluderId: element.id, ratio: overlap / (textArea || 1) },
        });
      }
    }
  }

  return { findings, overflowX: Math.max(0, overflowX), overflowY: Math.max(0, overflowY), allowedOverlaps };
}

/** findings → 复查项（warning 级）。 */
export function layoutFindingsToReviewItems(
  findings: LayoutFinding[],
): Array<{
  id: string;
  type: string;
  severity: "info" | "warning" | "blocker";
  elementId?: string;
  message: string;
  evidence?: Record<string, unknown>;
  resolution: { status: "pending" | "accepted" | "dismissed" };
}> {
  return findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => ({
      id: `layout:${finding.code}:${finding.elementId ?? "canvas"}`,
      type: `layout_${finding.code.toLowerCase()}`,
      severity: "warning" as const,
      ...(finding.elementId === undefined ? {} : { elementId: finding.elementId }),
      message: finding.message,
      ...(finding.evidence === undefined ? {} : { evidence: finding.evidence }),
      resolution: { status: "pending" as const },
    }));
}
