/**
 * 受限补丁 schema（T14 步骤 1～2）。
 *
 * 实施计划：
 * - 补丁形态：changes/id/set；只有"修改"，没有删除/新增操作；
 * - 对 SceneSpec 可修改 x/y/width/height/fontSize/lineHeight/letterSpacing/
 *   颜色等已允许样式；
 * - 对 LayoutSpec 仅允许局部定位字段与样式 token，不把 flow 节点强改 absolute；
 * - 拒绝未知 ID、未知字段、删除节点、改正文、改 binding、改类型、
 *   改素材来源和添加整页图片；
 * - 单轮及相对起始模板的累计幅度上限（策略参数，待样本校准）：
 *   位置每轮 8px、累计 24px；字号每轮 2px、累计 4px。
 */

import { z } from "zod";

/** 补丁版本。 */
export const PATCH_VERSION = "1.0" as const;

/** SceneSpec 可补丁字段白名单（T14 步骤 1）。 */
export const SCENE_PATCHABLE_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "color",
  "fontWeight",
  "align",
  "fill",
  "borderColor",
  "borderWidth",
  "radius",
] as const;

/** LayoutSpec 可补丁字段白名单（局部定位与样式 token；不含正文/binding/src）。 */
export const LAYOUT_PATCHABLE_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
  "backgroundColor",
  "borderColor",
  "borderWidth",
  "borderRadius",
  "padding",
  "gap",
] as const;

/** 字段类别（幅度上限按类别计算）。 */
export type PatchFieldCategory = "position" | "size" | "fontSize" | "style";

/** 字段 → 类别（幅度限制依据）。 */
export const PATCH_FIELD_CATEGORY: Record<string, PatchFieldCategory> = {
  x: "position",
  y: "position",
  width: "size",
  height: "size",
  fontSize: "fontSize",
};

/** 数值型字段（幅度校验只对数值字段；颜色等样式无幅度）。 */
export const NUMERIC_PATCH_FIELDS = new Set<string>([
  "x",
  "y",
  "width",
  "height",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "borderWidth",
  "radius",
  "padding",
  "gap",
]);

/** 幅度上限（初始默认值；策略参数，写入 evaluation 待样本校准）。 */
export interface PatchMagnitudeLimits {
  /** 单轮位置/尺寸变化上限（px）。 */
  perRoundPositionPx: number;
  /** 相对起始模板的累计位置/尺寸变化上限（px）。 */
  cumulativePositionPx: number;
  /** 单轮字号变化上限（px）。 */
  perRoundFontSizePx: number;
  /** 相对起始模板的累计字号变化上限（px）。 */
  cumulativeFontSizePx: number;
}

/** 计划初始默认值（T14 步骤 3：位置每轮 8px、累计 24px；字号每轮 2px、累计 4px）。 */
export const DEFAULT_PATCH_LIMITS: PatchMagnitudeLimits = {
  perRoundPositionPx: 8,
  cumulativePositionPx: 24,
  perRoundFontSizePx: 2,
  cumulativeFontSizePx: 4,
};

/** 单条补丁变更：id + set（仅修改；无删除/新增语义）。 */
export const patchChangeSchema = z.object({
  /** 目标元素/节点 ID（未知 ID 在应用时拒绝）。 */
  id: z.string().min(1).max(128),
  /** 字段 → 新值（字段必须在白名单内）。 */
  set: z
    .record(
      z.string().min(1).max(64),
      z.union([z.number().finite(), z.string().min(1).max(256)]),
    )
    .refine((set) => Object.keys(set).length > 0, {
      message: "set 不能为空",
    }),
});

/** 模板补丁：version + changes 列表。 */
export const templatePatchSchema = z.object({
  version: z.literal(PATCH_VERSION),
  changes: z.array(patchChangeSchema).min(1).max(200),
});

export type PatchChange = z.infer<typeof patchChangeSchema>;
export type TemplatePatch = z.infer<typeof templatePatchSchema>;

/** 补丁解析问题。 */
export interface PatchIssue {
  /** 问题所在 change 的索引（-1 为整体问题）。 */
  index: number;
  id?: string;
  field?: string;
  code:
    | "SCHEMA"
    | "UNKNOWN_ID"
    | "UNKNOWN_FIELD"
    | "FORBIDDEN_FIELD"
    | "NON_NUMERIC"
    | "MAGNITUDE_PER_ROUND"
    | "MAGNITUDE_CUMULATIVE"
    | "FLOW_TO_ABSOLUTE";
  message: string;
}

export interface PatchParseSuccess {
  ok: true;
  patch: TemplatePatch;
}

export interface PatchParseFailure {
  ok: false;
  issues: PatchIssue[];
}

export type PatchParseResult = PatchParseSuccess | PatchParseFailure;

/** 解析补丁（schema 层；ID 与幅度校验在 apply 阶段）。 */
export function parseTemplatePatch(value: unknown): PatchParseResult {
  const result = templatePatchSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        index: -1,
        code: "SCHEMA" as const,
        message: `${issue.path.join(".")}: ${issue.message}`,
      })),
    };
  }
  return { ok: true, patch: result.data };
}

/** 禁止补丁的字段（改正文/binding/类型/素材来源/添加整页图片）。 */
export const FORBIDDEN_PATCH_FIELDS = new Set<string>([
  "text",
  "type",
  "binding",
  "src",
  "alt",
  "fallback",
  "overflow",
  "zIndex",
  "id",
  "children",
  "itemTemplate",
  "component",
  "layout",
  "version",
]);

/**
 * 校验单条 change 的字段合法性（白名单 + 禁止字段）。
 * 返回问题列表；空数组 = 合法。
 */
export function validatePatchFields(
  change: PatchChange,
  whitelist: readonly string[],
): PatchIssue[] {
  const issues: PatchIssue[] = [];
  const allowed = new Set(whitelist);

  for (const field of Object.keys(change.set)) {
    if (FORBIDDEN_PATCH_FIELDS.has(field)) {
      issues.push({
        index: -1,
        id: change.id,
        field,
        code: "FORBIDDEN_FIELD",
        message: `禁止补丁字段 ${field}：不能改正文、改类型、改 binding、改素材来源或结构`,
      });
      continue;
    }
    if (!allowed.has(field)) {
      issues.push({
        index: -1,
        id: change.id,
        field,
        code: "UNKNOWN_FIELD",
        message: `未知字段 ${field}：白名单为 ${whitelist.join(", ")}`,
      });
    }
  }

  return issues;
}
