/**
 * 分区识别：区域定义、裁剪计划与坐标回投（T09）。
 *
 * 实施计划 T09 步骤 1～2：
 * - 首次整页识别头部、左右栏等区域，保存全局区域框；
 * - 对小字区域裁剪、按记录的比例放大后识别；
 * - 保存真实裁剪原点、缩放比及可选 padding；
 *   回投公式：globalX = cropX + (localX - paddingX) / scale，
 *   Y/宽/高同理；无 padding 时退化为设计公式 globalX = region.x + localX / scale。
 *
 * 回投误差要求在 1 px 内（由单元测试验证边界条件）。
 */

import sharp from "sharp";
import { z } from "zod";

import { ImageTemplateError } from "../errors.js";

/** 识别区域定义（全局坐标）。 */
export interface RegionDefinition {
  /** 区域 ID（如 header / left-column / right-column）。 */
  id: string;
  /** 全局区域框。 */
  box: { x: number; y: number; width: number; height: number };
  /** 放大倍数：小字区域 > 1（默认 1）。 */
  scale?: number;
  /** 可选 padding：裁剪时向外扩展的像素（默认 0）。 */
  padding?: number;
}

/** 区域识别结果 schema 对应类型（provider 返回）。 */
export interface RegionSpec {
  version: "1.0";
  regions: RegionDefinition[];
}

/** 区域识别响应的 zod schema（区域划分 provider 输出）。 */
export const regionSpecSchema = z.object({
  version: z.literal("1.0"),
  regions: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9-]*$/, "区域 ID 使用小写字母数字与连字符"),
        box: z.object({
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          width: z.number().finite().positive(),
          height: z.number().finite().positive(),
        }),
        scale: z.number().min(1).max(4).default(1),
        padding: z.number().min(0).max(64).default(0),
      }),
    )
    .min(1)
    .max(20),
});

/** 解析区域识别响应；返回问题列表（不抛异常）。 */
export function parseRegionSpec(
  value: unknown,
): { ok: true; spec: RegionSpec } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const result = regionSpecSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  return { ok: true, spec: result.data };
}

/** 实际执行的裁剪计划（与画布求交后）。 */
export interface RegionCropPlan {
  regionId: string;
  /** 裁剪原点（全局坐标；含 padding 扩展，已与画布求交）。 */
  originX: number;
  originY: number;
  /** 实际裁剪尺寸（全局像素）。 */
  cropWidth: number;
  cropHeight: number;
  /** 实际应用的 padding（求交后可能小于请求值）。 */
  paddingX: number;
  paddingY: number;
  /** 放大倍数（实际像素/逻辑像素）。 */
  scale: number;
  /** 放大后送识别的图像尺寸。 */
  scaledWidth: number;
  scaledHeight: number;
  /** 请求的框是否被画布裁剪。 */
  clippedByCanvas: boolean;
}

/**
 * 计算区域裁剪计划：请求框 ± padding 与画布求交。
 * 注意：padding 在求交之前应用（区域边界文字尽量包含在裁剪内）。
 */
export function planRegionCrop(
  region: RegionDefinition,
  canvas: { width: number; height: number },
): RegionCropPlan {
  const scale = region.scale ?? 1;
  const padding = region.padding ?? 0;

  if (scale < 1) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "extract",
      message: `区域 ${region.id} 的 scale 必须 ≥ 1（当前 ${scale}）`,
    });
  }
  if (padding < 0) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "extract",
      message: `区域 ${region.id} 的 padding 不能为负（当前 ${padding}）`,
    });
  }

  const requestedLeft = region.box.x - padding;
  const requestedTop = region.box.y - padding;
  const requestedRight = region.box.x + region.box.width + padding;
  const requestedBottom = region.box.y + region.box.height + padding;

  const left = Math.max(0, Math.floor(requestedLeft));
  const top = Math.max(0, Math.floor(requestedTop));
  const right = Math.min(canvas.width, Math.ceil(requestedRight));
  const bottom = Math.min(canvas.height, Math.ceil(requestedBottom));

  const cropWidth = right - left;
  const cropHeight = bottom - top;

  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "extract",
      message: `区域 ${region.id} 与画布的交集为空（框 ${region.box.x},${region.box.y} ${region.box.width}×${region.box.height}；画布 ${canvas.width}×${canvas.height}）`,
    });
  }

  // 实际应用的 padding（求交后）
  const paddingX = region.box.x - left;
  const paddingY = region.box.y - top;

  return {
    regionId: region.id,
    originX: left,
    originY: top,
    cropWidth,
    cropHeight,
    paddingX,
    paddingY,
    scale,
    scaledWidth: Math.round(cropWidth * scale),
    scaledHeight: Math.round(cropHeight * scale),
    clippedByCanvas:
      requestedLeft < 0 ||
      requestedTop < 0 ||
      requestedRight > canvas.width ||
      requestedBottom > canvas.height,
  };
}

/** 本地（放大后）坐标框。 */
export interface LocalBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 局部坐标回投到全局：
 *   globalX = originX + (localX - paddingX) / scale
 * 宽高只除以 scale（padding 不影响尺寸）。
 */
export function projectLocalToGlobal(
  local: LocalBox,
  plan: RegionCropPlan,
): { x: number; y: number; width: number; height: number } {
  return {
    x: plan.originX + (local.x - plan.paddingX) / plan.scale,
    y: plan.originY + (local.y - plan.paddingY) / plan.scale,
    width: local.width / plan.scale,
    height: local.height / plan.scale,
  };
}

/**
 * 裁剪并放大区域图像，返回送识别的 PNG 与裁剪计划。
 * 放大使用 lanczos3（保持文字边缘锐利度；策略参数）。
 */
export async function cropRegionImage(
  normalizedPng: Buffer,
  region: RegionDefinition,
  canvas: { width: number; height: number },
): Promise<{ png: Buffer; plan: RegionCropPlan }> {
  const plan = planRegionCrop(region, canvas);

  let png: Buffer;
  try {
    const pipeline = sharp(normalizedPng).extract({
      left: plan.originX,
      top: plan.originY,
      width: plan.cropWidth,
      height: plan.cropHeight,
    });

    png =
      plan.scale === 1
        ? await pipeline.png().toBuffer()
        : await pipeline
            .resize(plan.scaledWidth, plan.scaledHeight, {
              kernel: "lanczos3",
            })
            .png()
            .toBuffer();
  } catch (error) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "extract",
      message: `区域裁剪失败（${region.id}）：${(error as Error).message}`,
      cause: error,
    });
  }

  return { png, plan };
}

/** 判断全局框是否贴近区域边界（边界文字需相邻区域/整页对照，不直接裁掉）。 */
export function isNearRegionBoundary(
  globalBox: LocalBox,
  region: RegionDefinition,
  tolerance = 4,
): { near: boolean; edges: Array<"left" | "right" | "top" | "bottom"> } {
  const edges: Array<"left" | "right" | "top" | "bottom"> = [];

  if (Math.abs(globalBox.x - region.box.x) <= tolerance) {
    edges.push("left");
  }
  if (Math.abs(globalBox.x + globalBox.width - (region.box.x + region.box.width)) <= tolerance) {
    edges.push("right");
  }
  if (Math.abs(globalBox.y - region.box.y) <= tolerance) {
    edges.push("top");
  }
  if (Math.abs(globalBox.y + globalBox.height - (region.box.y + region.box.height)) <= tolerance) {
    edges.push("bottom");
  }

  return { near: edges.length > 0, edges };
}
