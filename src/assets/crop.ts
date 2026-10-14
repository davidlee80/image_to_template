/**
 * 独立素材裁剪（T04）。
 *
 * 实施计划 T04 步骤 2：
 * - 为 image 元素按 floor(left/top)、ceil(right/bottom) 计算整数边界；
 * - 与画布求交，确保非空且不越界；
 * - 保存实际 sourceRect（裁剪框）与原始检测框（元素声明的浮点框）。
 *
 * 小数坐标、画布边缘、零面积交集必须有确定结果（不静默扩大或偏移）。
 */

import sharp from "sharp";

import { ImageTemplateError } from "../errors.js";

export interface CropInput {
  /** 元素声明的检测框（浮点）。 */
  element: { id: string; x: number; y: number; width: number; height: number };
  /** 画布尺寸。 */
  canvas: { width: number; height: number };
}

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CropPlan {
  /** 实际裁剪框（整数像素，已与画布求交）。 */
  sourceRect: CropRect;
  /** 原始检测框（元素声明值，写入 manifest 供追溯）。 */
  detectionRect: CropRect;
  /** 检测框是否被画布裁剪（记录进 manifest）。 */
  clippedByCanvas: boolean;
}

function cropError(message: string): ImageTemplateError {
  return new ImageTemplateError({
    code: "INVALID_ARGUMENT",
    stage: "extract",
    message,
  });
}

/** 计算整数裁剪计划：floor 起点、ceil 终点、画布求交。 */
export function planCrop(input: CropInput): CropPlan {
  const { x, y, width, height, id } = input.element;
  const { width: canvasWidth, height: canvasHeight } = input.canvas;

  // 检测框（浮点原值，四舍五入到整数仅用于记录）
  const detectionRect: CropRect = {
    left: Math.floor(x),
    top: Math.floor(y),
    width: Math.ceil(x + width) - Math.floor(x),
    height: Math.ceil(y + height) - Math.floor(y),
  };

  // 整数边界
  let left = Math.floor(x);
  let top = Math.floor(y);
  let right = Math.ceil(x + width);
  let bottom = Math.ceil(y + height);

  // 与画布求交
  const clippedLeft = left < 0;
  const clippedTop = top < 0;
  const clippedRight = right > canvasWidth;
  const clippedBottom = bottom > canvasHeight;

  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(canvasWidth, right);
  bottom = Math.min(canvasHeight, bottom);

  const cropWidth = right - left;
  const cropHeight = bottom - top;

  if (cropWidth <= 0 || cropHeight <= 0) {
    throw cropError(
      `素材 ${id} 与画布的交集为空（检测框 x=${x}, y=${y}, w=${width}, h=${height}；画布 ${canvasWidth}×${canvasHeight}）：无法生成有效裁剪`,
    );
  }

  return {
    sourceRect: { left, top, width: cropWidth, height: cropHeight },
    detectionRect,
    clippedByCanvas: clippedLeft || clippedTop || clippedRight || clippedBottom,
  };
}

export interface CroppedAsset {
  /** PNG 字节。 */
  png: Buffer;
  plan: CropPlan;
  /** 素材 SHA-256。 */
  sha256: string;
}

/** 执行裁剪：从标准化图裁出素材 PNG。 */
export async function cropAsset(
  normalizedPng: Buffer,
  input: CropInput,
): Promise<CroppedAsset> {
  const plan = planCrop(input);

  let png: Buffer;
  try {
    png = await sharp(normalizedPng)
      .extract({
        left: plan.sourceRect.left,
        top: plan.sourceRect.top,
        width: plan.sourceRect.width,
        height: plan.sourceRect.height,
      })
      .png()
      .toBuffer();
  } catch (error) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "extract",
      message: `素材裁剪失败（${input.element.id}）：${(error as Error).message}`,
      cause: error,
    });
  }

  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(png).digest("hex");

  return { png, plan, sha256 };
}

/**
 * 可见文字与图片相交检测（T04 步骤 4）：
 * 生成候选复查项——照片内部固有招牌等文字可保留，
 * 但不能用它替代声明可编辑的页面文字。
 */
export interface IntersectionCandidate {
  textId: string;
  imageId: string;
  /** 交集占文字元素面积的比例。 */
  textOverlapRatio: number;
}

export function findTextImageIntersections(
  elements: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
): IntersectionCandidate[] {
  const texts = elements.filter((e) => e.type === "text");
  const images = elements.filter((e) => e.type === "image");
  const candidates: IntersectionCandidate[] = [];

  for (const text of texts) {
    for (const image of images) {
      const intersectLeft = Math.max(text.x, image.x);
      const intersectTop = Math.max(text.y, image.y);
      const intersectRight = Math.min(text.x + text.width, image.x + image.width);
      const intersectBottom = Math.min(
        text.y + text.height,
        image.y + image.height,
      );

      const intersectWidth = intersectRight - intersectLeft;
      const intersectHeight = intersectBottom - intersectTop;

      if (intersectWidth > 0 && intersectHeight > 0) {
        const textArea = text.width * text.height;
        const ratio = (intersectWidth * intersectHeight) / (textArea || 1);
        candidates.push({
          textId: text.id,
          imageId: image.id,
          textOverlapRatio: ratio,
        });
      }
    }
  }

  return candidates;
}
