/**
 * 输入图片标准化（T03 步骤 1～2）。
 *
 * - sharp 校正 EXIF 方向、展平白底、转成 PNG 和 sRGB；
 * - 以处理后的 metadata 为唯一坐标基准；
 * - 完整解码前限制像素数与输入尺寸；解码后限制输出字节数（15 MiB）；
 * - 保存原图哈希与标准化图哈希。
 */

import { createHash } from "node:crypto";

import sharp from "sharp";
import type { Metadata } from "sharp";

import { ImageTemplateError } from "../errors.js";

/** 解码前限制：最大像素数（宽×高）。 */
export const MAX_IMAGE_PIXELS = 30_000_000;

/** 解码前限制：单边最大像素。 */
export const MAX_IMAGE_SIDE = 12_000;

/** 解码后限制：标准化 PNG 最大字节数（设计文档 15 MiB）。 */
export const MAX_NORMALIZED_BYTES = 15 * 1024 * 1024;

export interface StandardizedImage {
  /** 标准化 PNG 字节。 */
  png: Buffer;
  width: number;
  height: number;
  /** 原始输入字节 SHA-256。 */
  inputSha256: string;
  /** 标准化 PNG 字节 SHA-256。 */
  normalizedSha256: string;
  /** 标准化元数据（记录进 manifest）。 */
  format: {
    /** 输入格式（sharp 探测）。 */
    inputFormat: string;
    /** EXIF 方向是否被应用（rotate 无参按 EXIF 旋转）。 */
    orientationApplied: boolean;
  };
}

function inputError(message: string): ImageTemplateError {
  return new ImageTemplateError({
    code: "INVALID_ARGUMENT",
    stage: "extract",
    message,
  });
}

/** 计算字节 SHA-256。 */
export function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 标准化输入图片。
 * @param input 原始图片字节
 * @param options.maxPixels 解码前像素上限（默认 MAX_IMAGE_PIXELS）
 * @param options.maxBytes 标准化输出字节上限（默认 MAX_NORMALIZED_BYTES）
 */
export async function standardizeImage(
  input: Buffer,
  options: {
    maxPixels?: number;
    maxBytes?: number;
  } = {},
): Promise<StandardizedImage> {
  const maxPixels = options.maxPixels ?? MAX_IMAGE_PIXELS;
  const maxBytes = options.maxBytes ?? MAX_NORMALIZED_BYTES;

  if (input.length === 0) {
    throw inputError("输入图片为空");
  }

  // 解码前先读取 metadata 限制尺寸（避免超大图完整解码）。
  let metadata: Metadata;
  try {
    metadata = await sharp(input).metadata();
  } catch (error) {
    throw inputError(
      `无法读取图片元数据：${(error as Error).message}（支持的输入格式见 sharp 文档）`,
    );
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width <= 0 || height <= 0) {
    throw inputError("图片缺少有效尺寸信息");
  }

  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    throw inputError(
      `图片单边尺寸超限：${width}×${height}（上限 ${MAX_IMAGE_SIDE}px），请先压缩或分块`,
    );
  }

  const pixels = width * height;
  if (pixels > maxPixels) {
    throw inputError(
      `图片像素数超限：${pixels}（上限 ${maxPixels}），请先压缩或分块`,
    );
  }

  const inputSha256 = sha256Of(input);

  // rotate() 无参：按 EXIF 方向校正；flatten：透明区展平白底；sRGB。
  let png: Buffer;
  try {
    png = await sharp(input)
      .rotate()
      .flatten({ background: "#FFFFFF" })
      .toColourspace("srgb")
      .png()
      .toBuffer();
  } catch (error) {
    throw inputError(`图片解码失败：${(error as Error).message}`);
  }

  if (png.length > maxBytes) {
    throw inputError(
      `标准化后图片过大：${(png.length / 1024 / 1024).toFixed(1)} MiB（上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB），请先压缩或分块识别`,
    );
  }

  // 以处理后 metadata 为唯一坐标基准。
  const normalizedMetadata = await sharp(png).metadata();
  const normalizedWidth = normalizedMetadata.width ?? 0;
  const normalizedHeight = normalizedMetadata.height ?? 0;

  if (normalizedWidth <= 0 || normalizedHeight <= 0) {
    throw inputError("标准化后图片缺少有效尺寸");
  }

  return {
    png,
    width: normalizedWidth,
    height: normalizedHeight,
    inputSha256,
    normalizedSha256: sha256Of(png),
    format: {
      inputFormat: metadata.format ?? "unknown",
      orientationApplied: (metadata.orientation ?? 1) !== 1,
    },
  };
}
