/**
 * 独立 OCR 适配器与 OCR/视觉对照（T10）。
 *
 * 实施计划 T10 步骤 1～2：
 * - 选定独立 OCR 适配器，统一为文本、框、读取顺序及原始置信度；支持 fixture；
 * - OCR 与视觉结果按位置和文本匹配，识别缺失文字、文字冲突及小字区域；
 * - OCR 字框不能直接当 CSS 文本框；冲突文本不得自动覆盖人工修订。
 *
 * 真实 OCR 实现按 provider 注入（宿主可替换）；本轮提供 fixture 实现。
 */

import { readFile } from "node:fs/promises";

import { ImageTemplateError } from "../errors.js";
import type { TextElement } from "../schemas/scene.js";
import type { ReviewItem } from "../schemas/report.js";

/** OCR 识别出的文本行。 */
export interface OcrLine {
  text: string;
  box: { x: number; y: number; width: number; height: number };
  /** 读取顺序（provider 声明）。 */
  readingOrder: number;
  /** provider 原始置信度（不作统计概率解读）。 */
  confidence: number;
}

export interface OcrResult {
  provider: string;
  lines: OcrLine[];
  durationMs: number;
}

export interface OcrRequest {
  image: Uint8Array;
  width: number;
  height: number;
  signal?: AbortSignal;
}

export type OcrProvider = {
  readonly name: string;
  recognize(request: OcrRequest): Promise<OcrResult>;
};

/** Fixture OCR provider：从 JSON 文件读取预置 OCR 结果。 */
export function createFixtureOcrProvider(
  fixtureFile: string,
): OcrProvider {
  return {
    name: "fixture-ocr",
    async recognize(): Promise<OcrResult> {
      const startedAt = Date.now();
      const value = JSON.parse(await readFile(fixtureFile, "utf8")) as {
        lines?: OcrLine[];
      };
      if (!Array.isArray(value.lines)) {
        throw new ImageTemplateError({
          code: "INVALID_ARGUMENT",
          stage: "extract",
          message: `OCR fixture 格式非法（需要 lines 数组）：${fixtureFile}`,
        });
      }
      return {
        provider: "fixture-ocr",
        lines: value.lines,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

/** 文本归一化：去首尾空白、全半角空格差异（CJK 比较不依赖空格）。 */
export function normalizeOcrText(text: string): string {
  return text.replace(/\s+/g, "").trim();
}

/** 两段文本是否视为一致（归一化后相等）。 */
export function ocrTextMatches(a: string, b: string): boolean {
  return normalizeOcrText(a) === normalizeOcrText(b) && normalizeOcrText(a) !== "";
}

function intersectionArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

/** OCR 行与视觉文本元素的几何重叠比（交集 / OCR 行面积）。 */
export function overlapRatio(
  ocrBox: { x: number; y: number; width: number; height: number },
  element: { x: number; y: number; width: number; height: number },
): number {
  const area = ocrBox.width * ocrBox.height;
  if (area <= 0) {
    return 0;
  }
  return intersectionArea(ocrBox, element) / area;
}

/** 小字判定高度阈值（px；策略参数，按设计初始值，T10 真实评估后校准）。 */
export const SMALL_TEXT_HEIGHT_PX = 14;

/** OCR/视觉对照结果。 */
export interface OcrCrossCheck {
  /** 匹配成功（位置重叠且文字一致）。 */
  matched: Array<{ ocrIndex: number; elementId: string }>;
  /** OCR 有、视觉无：漏识别候选。 */
  missingInVision: Array<{ ocrIndex: number; line: OcrLine }>;
  /** 位置重叠但文字不同：冲突候选（不自动覆盖）。 */
  conflicts: Array<{ ocrIndex: number; elementId: string; ocrText: string; visionText: string }>;
  /** 小字区域候选（行高低于阈值）。 */
  smallTextLines: Array<{ ocrIndex: number; line: OcrLine }>;
}

/**
 * OCR 行与视觉 text 元素对照。
 * @param elements 视觉识别的 text 元素（含正文，即提取前形态）
 */
export function crossCheckOcrWithVision(
  ocrLines: OcrLine[],
  elements: TextElement[],
  options: {
    /** 位置匹配阈值（交集占 OCR 行面积比例）。 */
    overlapThreshold?: number;
    smallTextHeightPx?: number;
  } = {},
): OcrCrossCheck {
  const overlapThreshold = options.overlapThreshold ?? 0.6;
  const smallHeight = options.smallTextHeightPx ?? SMALL_TEXT_HEIGHT_PX;

  const result: OcrCrossCheck = {
    matched: [],
    missingInVision: [],
    conflicts: [],
    smallTextLines: [],
  };

  ocrLines.forEach((line, ocrIndex) => {
    // 小字候选
    if (line.box.height <= smallHeight) {
      result.smallTextLines.push({ ocrIndex, line });
    }

    // 找最佳位置匹配
    let bestElement: TextElement | undefined;
    let bestRatio = 0;

    for (const element of elements) {
      const ratio = overlapRatio(line.box, element);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestElement = element;
      }
    }

    if (bestElement === undefined || bestRatio < overlapThreshold) {
      result.missingInVision.push({ ocrIndex, line });
      return;
    }

    if (ocrTextMatches(line.text, bestElement.text)) {
      result.matched.push({ ocrIndex, elementId: bestElement.id });
    } else {
      result.conflicts.push({
        ocrIndex,
        elementId: bestElement.id,
        ocrText: line.text,
        visionText: bestElement.text,
      });
    }
  });

  return result;
}

/** 对照结果 → 复查项（缺失/冲突/小字；冲突文本不得自动覆盖人工修订）。 */
export function crossCheckToReviewItems(
  crossCheck: OcrCrossCheck,
  ocrLines: OcrLine[],
): ReviewItem[] {
  const items: ReviewItem[] = [];

  for (const missing of crossCheck.missingInVision) {
    items.push({
      id: `ocr-missing:${missing.ocrIndex}`,
      type: "ocr_missing_text",
      severity: "warning",
      message: `OCR 发现视觉识别遗漏的文字：${JSON.stringify(missing.line.text)}（位置 ${Math.round(missing.line.box.x)},${Math.round(missing.line.box.y)} ${Math.round(missing.line.box.width)}×${Math.round(missing.line.box.height)}，OCR 置信度 ${missing.line.confidence}）`,
      evidence: {
        ocrText: missing.line.text,
        box: missing.line.box,
        ocrConfidence: missing.line.confidence,
        note: "OCR 字框不能直接当 CSS 文本框；请人工确认后补入模板",
      },
      resolution: { status: "pending" },
    });
  }

  for (const conflict of crossCheck.conflicts) {
    items.push({
      id: `ocr-conflict:${conflict.elementId}`,
      type: "ocr_text_conflict",
      severity: "warning",
      elementId: conflict.elementId,
      message: `OCR 与视觉识别文字不一致（${conflict.elementId}）：OCR=${JSON.stringify(conflict.ocrText)}，视觉=${JSON.stringify(conflict.visionText)}：不自动覆盖，请人工确认正确内容`,
      evidence: {
        ocrText: conflict.ocrText,
        visionText: conflict.visionText,
        note: "冲突文本不得自动覆盖人工修订",
      },
      resolution: { status: "pending" },
    });
  }

  for (const small of crossCheck.smallTextLines) {
    items.push({
      id: `ocr-small:${small.ocrIndex}`,
      type: "ocr_small_text",
      severity: "info",
      message: `小字号文字（行高 ${Math.round(small.line.box.height)}px ≤ ${SMALL_TEXT_HEIGHT_PX}px）：${JSON.stringify(small.line.text)}——候选分区补识别区域`,
      evidence: {
        text: small.line.text,
        box: small.line.box,
        ocrConfidence: small.line.confidence,
      },
      resolution: { status: "pending" },
    });
  }

  void ocrLines;
  return items;
}
