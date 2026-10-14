/**
 * 可编辑性检查（T05）。
 *
 * 实施计划 T05 步骤 6：
 * - 正文 ID 与 DOM 文本节点的核对（浏览器侧脚本，T06 执行）；
 * - 禁止 reference.png 成为页面背景或素材源；
 * - 结合素材来源记录检查可编辑性，不能仅靠像素分数判断。
 *
 * 静态检查在渲染前执行；DOM 核对脚本在浏览器加载后执行。
 */

import type { SceneSpec } from "../schemas/scene.js";
import type { SceneContent } from "../schemas/content.js";

export interface EditabilityIssue {
  code:
    | "REFERENCE_AS_SOURCE"
    | "WHOLE_PAGE_IMAGE"
    | "TEXT_ID_NOT_IN_CONTENT"
    | "DOM_TEXT_MISMATCH"
    | "DOM_TEXT_MISSING";
  elementId?: string;
  message: string;
}

/** 画布面积占比阈值：image 覆盖超过此比例视为可疑整页背景。 */
export const WHOLE_PAGE_IMAGE_RATIO = 0.98;

/** 渲染前静态检查：素材来源与结构。 */
export function checkEditabilityStatic(
  spec: SceneSpec,
  content: SceneContent,
): EditabilityIssue[] {
  const issues: EditabilityIssue[] = [];
  const canvasArea = spec.canvas.width * spec.canvas.height;

  for (const element of spec.elements) {
    if (element.type === "image") {
      // reference.png 禁止作为素材源（只能用于分析对比）
      if (element.src === "reference.png" || element.src.endsWith("/reference.png")) {
        issues.push({
          code: "REFERENCE_AS_SOURCE",
          elementId: element.id,
          message: `图片元素 ${element.id} 直接引用 reference.png：禁止把原图作为页面素材源（只能用于分析对比）`,
        });
      }

      // 整页图片：可能用原图背景伪装还原
      const area = element.width * element.height;
      if (area / canvasArea >= WHOLE_PAGE_IMAGE_RATIO) {
        issues.push({
          code: "WHOLE_PAGE_IMAGE",
          elementId: element.id,
          message: `图片元素 ${element.id} 覆盖 ${(100 * area / canvasArea).toFixed(1)}% 画布：疑似整页背景伪装，需人工确认该图不是原图本身`,
        });
      }
    }

    if (element.type === "text" && !(element.id in content)) {
      issues.push({
        code: "TEXT_ID_NOT_IN_CONTENT",
        elementId: element.id,
        message: `文本元素 ${element.id} 在 content.json 中没有对应键`,
      });
    }
  }

  return issues;
}

/**
 * 浏览器侧 DOM 核对脚本源码（T06 中通过 page.evaluate 执行）。
 * 返回正文 DOM 与 content 的不一致清单。
 */
export const DOM_TEXT_CHECK_SCRIPT = `
(() => {
  const mismatches = [];
  const nodes = document.querySelectorAll("[data-text-id]");
  for (const node of nodes) {
    const id = node.getAttribute("data-text-id");
    const declared = node.getAttribute("data-expected-text");
    const actual = node.textContent ?? "";
    if (declared === null) {
      mismatches.push({ id, code: "DOM_TEXT_MISSING", message: "缺少 data-expected-text 声明" });
      continue;
    }
    if (actual !== declared) {
      mismatches.push({
        id,
        code: "DOM_TEXT_MISMATCH",
        message: "DOM 文本与 content 不一致",
        expected: declared,
        actual,
      });
    }
  }
  return mismatches;
})()
`;

export interface DomTextMismatch {
  id: string;
  code: string;
  message: string;
  expected?: string;
  actual?: string;
}

/** 校验浏览器返回的 mismatch 列表并转为 issue。 */
export function domMismatchesToIssues(
  mismatches: DomTextMismatch[],
): EditabilityIssue[] {
  return mismatches.map((mismatch) => ({
    code: mismatch.code === "DOM_TEXT_MISSING" ? "DOM_TEXT_MISSING" : "DOM_TEXT_MISMATCH",
    elementId: mismatch.id,
    message: `${mismatch.message}${mismatch.expected !== undefined ? `（期望 ${JSON.stringify(mismatch.expected)}，实际 ${JSON.stringify(mismatch.actual)}）` : ""}`,
  }));
}
