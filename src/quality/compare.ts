/**
 * 像素差异图与叠图（T07）+ 区域评价（T14）。
 *
 * 实施计划 T07 步骤 1～2：
 * - reference/preview 统一白底、sRGB、RGBA；
 * - 尺寸不同直接失败，不自动缩放掩盖偏差；
 * - 按设计初始参数生成 pixelmatch 差异图（threshold=0.15、includeAA=false）；
 * - 生成 50% 叠图；报告参数与 mismatchRatio。
 *
 * T14 步骤 4：按头部、时间轴、照片、侧栏等固定区域报告 mismatchRatio
 * 和非背景区域差异；评分不是还原百分比。
 *
 * mismatchRatio 只是辅助指标，不是"还原度百分比"（设计文档第八章）。
 */

import sharp from "sharp";
import pixelmatch from "pixelmatch";

import { ImageTemplateError } from "../errors.js";

/** 设计初始参数（策略参数，随 evaluation 记录校准）。 */
export const DEFAULT_COMPARE_PARAMS = {
  threshold: 0.15,
  includeAA: false,
} as const;

export interface RgbaImage {
  data: Buffer;
  width: number;
  height: number;
}

/** 读取图片为统一规格的 RGBA（白底、sRGB、带 alpha）。 */
export async function loadRgba(file: string): Promise<RgbaImage> {
  let pipeline;
  try {
    pipeline = sharp(file);
    await pipeline.metadata();
  } catch (error) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "compare",
      message: `无法读取图片：${file}（${(error as Error).message}）`,
      cause: error,
    });
  }

  try {
    const { data, info } = await pipeline
      .flatten({ background: "#FFFFFF" })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (error) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "compare",
      message: `图片解码失败：${file}（${(error as Error).message}）`,
      cause: error,
    });
  }
}

export interface ImageComparison {
  /** 不匹配像素比例（辅助指标，非还原率）。 */
  mismatchRatio: number;
  /** 不匹配像素数。 */
  mismatchedPixels: number;
  /** 差异图 PNG 字节。 */
  diffPng: Buffer;
  /** 50% 叠图 PNG 字节。 */
  overlayPng: Buffer;
  /** 本次使用的对比参数。 */
  params: { threshold: number; includeAA: boolean };
  width: number;
  height: number;
}

/** 比较两张同尺寸 RGBA 图；尺寸不同直接失败。 */
export async function compareRgbaImages(
  reference: RgbaImage,
  preview: RgbaImage,
  params: { threshold: number; includeAA: boolean } = DEFAULT_COMPARE_PARAMS,
): Promise<ImageComparison> {
  if (
    reference.width !== preview.width ||
    reference.height !== preview.height
  ) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "compare",
      message: `原图和生成图的尺寸不一致：reference ${reference.width}×${reference.height}，preview ${preview.width}×${preview.height}（不自动缩放掩盖偏差）`,
    });
  }

  const { width, height } = reference;

  const diff = Buffer.alloc(width * height * 4);
  const mismatchedPixels = pixelmatch(
    reference.data,
    preview.data,
    diff,
    width,
    height,
    { threshold: params.threshold, includeAA: params.includeAA },
  );

  const diffPng = await sharp(diff, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  // 50% 混合叠图：便于查看文字和边框的双影
  const overlay = Buffer.alloc(width * height * 4);
  for (let i = 0; i < overlay.length; i += 4) {
    overlay[i] = (reference.data[i] + preview.data[i]) >> 1;
    overlay[i + 1] = (reference.data[i + 1] + preview.data[i + 1]) >> 1;
    overlay[i + 2] = (reference.data[i + 2] + preview.data[i + 2]) >> 1;
    overlay[i + 3] = 255;
  }

  const overlayPng = await sharp(overlay, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  return {
    mismatchedPixels,
    mismatchRatio: mismatchedPixels / (width * height),
    diffPng,
    overlayPng,
    params,
    width,
    height,
  };
}

// ---- T14：区域评价 ----

/** 评价区域：固定页面区域定义（按画布坐标）。 */
export interface EvalRegion {
  /** 区域 ID（如 header / timeline / photos / sidebar）。 */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 区域内参考图的非背景像素判定阈值（0～1；低于此值视为背景差异不计分）。 */
  backgroundRatioThreshold?: number;
}

/** 设计默认评价区域（旅行页头部/时间轴/照片/侧栏；策略参数，随 evaluation 校准）。 */
export function defaultEvalRegions(
  canvas: { width: number; height: number },
): EvalRegion[] {
  return [
    { id: "header", x: 0, y: 0, width: canvas.width, height: Math.round(canvas.height * 0.12) },
    { id: "timeline", x: 0, y: Math.round(canvas.height * 0.12), width: Math.round(canvas.width * 0.62), height: Math.round(canvas.height * 0.55) },
    { id: "photos", x: Math.round(canvas.width * 0.62), y: Math.round(canvas.height * 0.12), width: Math.round(canvas.width * 0.38), height: Math.round(canvas.height * 0.5) },
    { id: "sidebar", x: Math.round(canvas.width * 0.62), y: Math.round(canvas.height * 0.62), width: Math.round(canvas.width * 0.38), height: Math.round(canvas.height * 0.38) },
  ];
}

export interface RegionScore {
  id: string;
  /** 区域像素数。 */
  pixels: number;
  /** 区域内不匹配像素数。 */
  mismatchedPixels: number;
  /** 区域 mismatchRatio（辅助指标，非还原率）。 */
  mismatchRatio: number;
  /** 区域内非背景像素比例（参考图；全背景区域差异权重降低）。 */
  nonBackgroundRatio: number;
}

/** 背景判定：与纯白（flatten 后背景）差异低于阈值的像素视为背景。 */
const BACKGROUND_TOLERANCE = 8;

/**
 * 区域评价（T14 步骤 4）：
 * - 按固定区域统计 mismatchRatio 与非背景差异；
 * - 全页白底掩盖局部误差的问题通过 nonBackgroundRatio 缓解：
 *   区域几乎全为背景时其分数权重应降低（由调用方策略决定）；
 * - 不宣称还原百分比。
 */
export function scoreRegions(
  reference: RgbaImage,
  preview: RgbaImage,
  regions: EvalRegion[],
  params: { threshold: number; includeAA: boolean } = DEFAULT_COMPARE_PARAMS,
): RegionScore[] {
  if (
    reference.width !== preview.width ||
    reference.height !== preview.height
  ) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "compare",
      message: `区域评价需要同尺寸图片：reference ${reference.width}×${reference.height}，preview ${preview.width}×${preview.height}`,
    });
  }

  const { width, height } = reference;
  const scores: RegionScore[] = [];

  for (const region of regions) {
    // 区域与画布求交
    const x0 = Math.max(0, Math.floor(region.x));
    const y0 = Math.max(0, Math.floor(region.y));
    const x1 = Math.min(width, Math.ceil(region.x + region.width));
    const y1 = Math.min(height, Math.ceil(region.y + region.height));

    let pixels = 0;
    let mismatched = 0;
    let nonBackground = 0;

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const idx = (y * width + x) * 4;
        pixels += 1;

        const r = reference.data[idx];
        const g = reference.data[idx + 1];
        const b = reference.data[idx + 2];
        const isBackground =
          Math.abs(r - 255) <= BACKGROUND_TOLERANCE &&
          Math.abs(g - 255) <= BACKGROUND_TOLERANCE &&
          Math.abs(b - 255) <= BACKGROUND_TOLERANCE;
        if (!isBackground) {
          nonBackground += 1;
        }

        // pixelmatch 同参判定（单像素；threshold 颜色距离）
        const pr = preview.data[idx];
        const pg = preview.data[idx + 1];
        const pb = preview.data[idx + 2];
        const pa = preview.data[idx + 3];
        const ra = reference.data[idx + 3];
        const maxDiff = Math.max(
          Math.abs(r - pr),
          Math.abs(g - pg),
          Math.abs(b - pb),
          Math.abs(ra - pa),
        );
        if (maxDiff > params.threshold * 255) {
          mismatched += 1;
        }
      }
    }

    scores.push({
      id: region.id,
      pixels,
      mismatchedPixels: mismatched,
      mismatchRatio: pixels === 0 ? 0 : mismatched / pixels,
      nonBackgroundRatio: pixels === 0 ? 0 : nonBackground / pixels,
    });
  }

  return scores;
}
