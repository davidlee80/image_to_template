/**
 * 整页骨架与分区元素合并、去重与冲突检测（T09 步骤 3～5）。
 *
 * 实施计划：
 * - 用几何交集、文字及类型去重；不把同名的不同餐厅/重复标题误删
 *   （相同文字在不同位置不视为重复）；
 * - 保留冲突候选和来源记录；
 * - 重建唯一且稳定的元素 ID，保持映射（人工修订不受影响）；
 * - 区域边界文字交给相邻区域/整页结果对照，不直接裁掉；
 * - 合并结果重新做几何校验（调用 parseSceneSpec）。
 */

import {
  parseSceneSpec,
  type SceneElement,
  type SceneSpec,
} from "../schemas/scene.js";
import type { RegionDefinition } from "./regions.js";
import { isNearRegionBoundary } from "./regions.js";
import type { ReviewItem } from "../schemas/report.js";

/** 元素来源记录。 */
export interface ElementSource {
  /** 整页识别或区域 ID。 */
  from: "page" | string;
  /** 区域识别时的原始元素 ID。 */
  originalId?: string;
}

/** 几何重叠判定阈值（IoU；策略参数）。 */
export const DEDUP_IOU_THRESHOLD = 0.7;

/** 合并输入。 */
export interface MergeInput {
  /** 整页识别结果（骨架；正文尚在 text 字段）。 */
  pageSpec: SceneSpec;
  /** 区域识别结果：区域定义 + 回投后的全局元素（未并入画布校验）。 */
  regions: Array<{
    region: RegionDefinition;
    /** 回投到全局坐标后的元素（坐标为全局；ID 为区域识别原始 ID）。 */
    elements: SceneElement[];
  }>;
}

/** 合并输出。 */
export interface MergeResult {
  ok: true;
  spec: SceneSpec;
  /** 元素 ID → 来源。 */
  sources: Record<string, ElementSource>;
  /** 被去重丢弃的元素记录。 */
  duplicates: Array<{
    keptId: string;
    droppedFrom: string;
    droppedOriginalId: string;
    iou: number;
  }>;
  /** 复查项：冲突候选与区域边界文字。 */
  reviewItems: ReviewItem[];
  /** ID 重建映射（区域原始 ID → 合并后 ID）。 */
  idMappings: Array<{ from: string; fromRegion: string; to: string }>;
}

export interface MergeFailure {
  ok: false;
  issues: Array<{ path: string; message: string }>;
}

function boxOf(element: SceneElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return { x: element.x, y: element.y, width: element.width, height: element.height };
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

/** IoU（交集 / 并集）。 */
export function iouOf(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const intersection = intersectionArea(a, b);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/**
 * 两个元素是否为重复：同类型 + 高几何重叠 +（文本元素）文字一致。
 * 相同文字不同位置不会误删（IoU 不满足）；不同文字高重叠是冲突而非重复。
 */
export function isDuplicate(
  a: SceneElement,
  b: SceneElement,
  threshold = DEDUP_IOU_THRESHOLD,
): { duplicate: boolean; iou: number; textMatch: boolean } {
  const iou = iouOf(boxOf(a), boxOf(b));
  if (a.type !== b.type || iou < threshold) {
    return { duplicate: false, iou, textMatch: false };
  }

  if (a.type === "text" && b.type === "text") {
    const textMatch = a.text === b.text;
    return { duplicate: textMatch, iou, textMatch };
  }

  // box/image：同类型 + 高重叠即视为重复
  return { duplicate: true, iou, textMatch: true };
}

/** 构造区域元素的合并 ID（符合 elementIdSchema：字母数字下划线连字符）。 */
function mergedRegionId(regionId: string, originalId: string): string {
  const sanitizedRegion = regionId.replace(/[^A-Za-z0-9_-]/g, "-");
  const sanitizedOriginal = originalId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${sanitizedRegion}__${sanitizedOriginal}`;
}

/**
 * 合并整页骨架与分区元素。
 * - 整页元素 ID 保持不变（稳定 ID，人工修订映射不受影响）；
 * - 区域元素与整页元素重复时丢弃区域版本并记录；
 * - 区域独有元素以 <region>__<originalId> 为 ID 加入；
 * - 同文字不同位置、不同文字同位置分别形成冲突候选（不自动合并/覆盖）。
 */
export function mergeRegionElements(input: MergeInput): MergeResult | MergeFailure {
  const { pageSpec, regions } = input;

  const sources: Record<string, ElementSource> = {};
  const duplicates: MergeResult["duplicates"] = [];
  const reviewItems: ReviewItem[] = [];
  const idMappings: MergeResult["idMappings"] = [];

  // 整页元素为骨架（ID 稳定）
  const merged: SceneElement[] = [...pageSpec.elements];
  for (const element of pageSpec.elements) {
    sources[element.id] = { from: "page" };
  }

  // 冲突检测辅助：同位置不同文字（整页 vs 区域、区域 vs 区域）
  const conflicts: Array<{
    idA: string;
    idB: string;
    fromA: string;
    fromB: string;
    iou: number;
  }> = [];

  for (const { region, elements } of regions) {
    for (const regionElement of elements) {
      const globalBox = boxOf(regionElement);

      // 区域边界文字：交给相邻区域/整页对照，不直接裁掉
      const boundary = isNearRegionBoundary(globalBox, region);
      if (boundary.near) {
        reviewItems.push({
          id: `region-boundary:${region.id}:${regionElement.id}`,
          type: "region_boundary",
          severity: "info",
          elementId: regionElement.id,
          message: `元素 ${regionElement.id} 贴近区域 ${region.id} 的边界（${boundary.edges.join("/")}）：已保留，请与相邻区域或整页识别结果对照确认`,
          evidence: { regionId: region.id, edges: boundary.edges },
          resolution: { status: "pending" },
        });
      }

      // 与已合并元素比对
      let duplicateOf: SceneElement | undefined;
      let duplicateIou = 0;

      for (const existing of merged) {
        const result = isDuplicate(existing, regionElement);
        if (result.duplicate) {
          duplicateOf = existing;
          duplicateIou = result.iou;
          break;
        }

        // 冲突候选：高几何重叠但文字不同（文本元素）
        if (
          existing.type === "text" &&
          regionElement.type === "text" &&
          result.iou >= DEDUP_IOU_THRESHOLD &&
          existing.text !== regionElement.text
        ) {
          conflicts.push({
            idA: existing.id,
            idB: regionElement.id,
            fromA: sources[existing.id]?.from ?? "page",
            fromB: region.id,
            iou: result.iou,
          });
        }
      }

      if (duplicateOf !== undefined) {
        // 重复：丢弃区域版本，保留整页/先到版本（记录来源）
        duplicates.push({
          keptId: duplicateOf.id,
          droppedFrom: region.id,
          droppedOriginalId: regionElement.id,
          iou: duplicateIou,
        });
        idMappings.push({
          from: regionElement.id,
          fromRegion: region.id,
          to: duplicateOf.id,
        });
        continue;
      }

      // 区域独有元素：重建唯一 ID
      let newId = mergedRegionId(region.id, regionElement.id);
      const usedIds = new Set(merged.map((e) => e.id));
      if (usedIds.has(newId)) {
        let suffix = 2;
        while (usedIds.has(`${newId}-${suffix}`)) {
          suffix += 1;
        }
        newId = `${newId}-${suffix}`;
      }

      merged.push({ ...regionElement, id: newId });
      sources[newId] = { from: region.id, originalId: regionElement.id };
      idMappings.push({ from: regionElement.id, fromRegion: region.id, to: newId });
    }
  }

  // 冲突候选 → 复查项（不自动覆盖）
  for (const conflict of conflicts) {
    reviewItems.push({
      id: `merge-conflict:${conflict.idA}:${conflict.idB}`,
      type: "merge_conflict",
      severity: "warning",
      elementId: conflict.idA,
      message: `元素 ${conflict.idA}（${conflict.fromA}）与 ${conflict.idB}（${conflict.fromB}）位置高度重叠（IoU ${conflict.iou.toFixed(2)}）但文字不同：请人工确认正确内容`,
      evidence: { ...conflict },
      resolution: { status: "pending" },
    });
  }

  // 合并结果重新做几何校验（区域回投可能越界）
  const candidateSpec: SceneSpec = {
    ...pageSpec,
    elements: merged,
  };
  const validated = parseSceneSpec(candidateSpec);
  if (!validated.ok) {
    return {
      ok: false,
      issues: validated.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    };
  }

  return {
    ok: true,
    spec: validated.spec,
    sources,
    duplicates,
    reviewItems,
    idMappings,
  };
}
