/**
 * 补丁提案（T15 步骤 1）。
 *
 * 实施计划：
 * - 仅对原始内容一致的 replica 提供自动校准；
 * - 输入为原图、预览、区域差异和元素/组件参数；
 * - 输出只能是 T14 schema 的补丁（changes/id/set）；
 * - 提案来源：provider（模型返回补丁 JSON，经 schema 校验）或
 *   确定性建议器（区域差异 → 偏移类微调建议）。
 */

import {
  parseTemplatePatch,
  PATCH_VERSION,
  type PatchIssue,
  type TemplatePatch,
} from "../schemas/patch.js";
import { ImageTemplateError } from "../errors.js";
import type { RegionScore } from "../quality/compare.js";

/** 校准提案请求（provider 输入）。 */
export interface ProposalRequest {
  /** 标准化原图（PNG 字节；仅分析与对比用途）。 */
  referenceImage: Uint8Array;
  /** 当前预览（PNG 字节）。 */
  previewImage: Uint8Array;
  /** 区域差异分数。 */
  regionScores: RegionScore[];
  /** 可补丁元素/节点参数（id + 当前定位/样式数值）。 */
  elements: Array<{
    id: string;
    fields: Record<string, number>;
  }>;
  /** 画布尺寸。 */
  width: number;
  height: number;
}

/** 提案 provider：宿主可注入模型实现；默认为确定性建议器。 */
export interface ProposalProvider {
  readonly name: string;
  propose(request: ProposalRequest): Promise<{ ok: boolean; patch: unknown }>;
}

/** 确定性建议器：单轮最多调整幅度内的最大偏差元素。 */
export const DETERMINISTIC_PROPOSAL_LIMITS = {
  /** 单元素单字段最大调整（与 DEFAULT_PATCH_LIMITS 对齐）。 */
  maxShiftPx: 8,
  /** 只对非背景比例达标的区域生成建议。 */
  minNonBackgroundRatio: 0.02,
} as const;

/**
 * 默认建议器（离线；不调用模型）：
 * - 找 mismatchRatio 最高且非背景达标的区域；
 * - 由于区域级差异不含元素级方向信息，无法盲目生成有效建议，
 *   因此默认建议器返回"空提案"（ok=true、changes 由调用方策略提供）；
 * - 真实校准应注入模型 provider（返回 T14 补丁 JSON）。
 */
export function createDeterministicProposalProvider(): ProposalProvider {
  return {
    name: "deterministic",
    async propose(request) {
      // 选择需要优先处理的区域（记录在证据；不虚构补丁方向）
      const candidates = request.regionScores
        .filter((s) => s.nonBackgroundRatio >= DETERMINISTIC_PROPOSAL_LIMITS.minNonBackgroundRatio)
        .sort((a, b) => b.mismatchRatio - a.mismatchRatio);

      if (candidates.length === 0) {
        return { ok: false, patch: null };
      }

      // 确定性建议器没有元素级差异方向数据，无法生成有依据的补丁；
      // 返回空提案（调用方可选择停止或换 provider）。
      return { ok: true, patch: { version: PATCH_VERSION, changes: [] } };
    },
  };
}

/** 提案解析结果。 */
export type ProposalResult =
  | { ok: true; patch: TemplatePatch; provider: string }
  | { ok: false; issues: PatchIssue[]; provider: string };

/** 解析 provider 输出为受校验补丁（只能是 T14 schema 形态）。 */
export async function requestProposal(
  provider: ProposalProvider,
  request: ProposalRequest,
): Promise<ProposalResult> {
  let raw: { ok: boolean; patch: unknown };
  try {
    raw = await provider.propose(request);
  } catch (error) {
    throw new ImageTemplateError({
      code: "PROVIDER_ERROR",
      stage: "calibrate",
      message: `补丁提案 provider 调用失败：${(error as Error).message}`,
      cause: error,
    });
  }

  if (!raw.ok || raw.patch === null || raw.patch === undefined) {
    return {
      ok: false,
      provider: provider.name,
      issues: [{ index: -1, code: "SCHEMA", message: "provider 未返回补丁" }],
    };
  }

  const parsed = parseTemplatePatch(raw.patch);
  if (!parsed.ok) {
    return { ok: false, provider: provider.name, issues: parsed.issues };
  }

  // 空 changes 视为无效提案（parseTemplatePatch min(1) 已保证非空）
  return { ok: true, patch: parsed.patch, provider: provider.name };
}
