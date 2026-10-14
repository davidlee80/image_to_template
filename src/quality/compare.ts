/**
 * 像素差异图与叠图（T07）。
 *
 * 实施计划 T07 步骤 1～2：
 * - reference/preview 统一白底、sRGB、RGBA；
 * - 尺寸不同直接失败，不自动缩放掩盖偏差；
 * - 按设计初始参数生成 pixelmatch 差异图（threshold=0.15、includeAA=false）；
 * - 生成 50% 叠图；报告参数与 mismatchRatio。
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
