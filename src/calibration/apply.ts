/**
 * 补丁应用（T14 步骤 1～3）。
 *
 * 实施计划：
 * - 拒绝未知 ID、未知字段、删除节点、改正文、改 binding、改类型、
 *   改素材来源和添加整页图片（FORBIDDEN_PATCH_FIELDS）；
 * - 单轮及相对起始模板的累计幅度上限（防止小步累积绕过限制）；
 * - LayoutSpec 的 flow 节点（row/column/grid）不允许补丁为 absolute；
 * - 应用返回新模板（浅拷贝变更；原模板不被修改）。
 */

import {
  DEFAULT_PATCH_LIMITS,
  FORBIDDEN_PATCH_FIELDS,
  NUMERIC_PATCH_FIELDS,
  PATCH_FIELD_CATEGORY,
  SCENE_PATCHABLE_FIELDS,
  LAYOUT_PATCHABLE_FIELDS,
  parseTemplatePatch,
  validatePatchFields,
  type PatchIssue,
  type PatchMagnitudeLimits,
  type TemplatePatch,
} from "../schemas/patch.js";
import type { SceneSpec, SceneElement } from "../schemas/scene.js";
import type { LayoutSpec, LayoutNode, StyleFields } from "../schemas/layout.js";
import { parseSceneSpec } from "../schemas/scene.js";
import { parseLayoutSpec } from "../schemas/layout.js";

/** 应用目标：SceneSpec 或 LayoutSpec。 */
export type PatchTarget = SceneSpec | LayoutSpec;

/** 相对起始模板的累计变化记录（元素 ID → 字段 → 起始值）。 */
export type CumulativeChanges = Record<string, Record<string, number>>;

export interface ApplyPatchOptions {
  /** 幅度上限（默认 DEFAULT_PATCH_LIMITS）。 */
  limits?: PatchMagnitudeLimits;
  /** 相对起始模板的累计变化（跨轮校验；首轮传 {}）。 */
  cumulative?: CumulativeChanges;
}

export interface ApplyPatchSuccess {
  ok: true;
  /** 应用后的新模板（原模板不被修改）。 */
  target: PatchTarget;
  /** 本轮各元素字段实际变化量（数值字段）。 */
  roundDeltas: Record<string, Record<string, number>>;
  /** 更新后的累计变化（供下一轮传入）。 */
  cumulative: CumulativeChanges;
  /** 应用的 change 数。 */
  applied: number;
}

export interface ApplyPatchFailure {
  ok: false;
  issues: PatchIssue[];
}

export type ApplyPatchResult = ApplyPatchSuccess | ApplyPatchFailure;

/** 数值读取（元素字段当前值；非数值字段返回 undefined）。 */
function numericValueOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 校验并计算单条 change 的幅度问题。 */
function checkMagnitude(
  change: { id: string; set: Record<string, number | string> },
  currentById: Map<string, Record<string, unknown>>,
  cumulative: CumulativeChanges,
  limits: PatchMagnitudeLimits,
): PatchIssue[] {
  const issues: PatchIssue[] = [];
  const element = currentById.get(change.id);

  for (const [field, next] of Object.entries(change.set)) {
    if (!NUMERIC_PATCH_FIELDS.has(field)) {
      continue; // 颜色等样式无幅度概念
    }
    if (typeof next !== "number") {
      if (field === "fontWeight") {
        continue; // fontWeight 允许字符串/数字
      }
      issues.push({
        index: -1,
        id: change.id,
        field,
        code: "NON_NUMERIC",
        message: `字段 ${field} 需要数值（收到 ${typeof next}）`,
      });
      continue;
    }

    const current = numericValueOf(element?.[field]);
    if (current === undefined) {
      continue; // 目标字段当前非数值（如未设置）；仅设置不视为幅度
    }

    const category = PATCH_FIELD_CATEGORY[field] ?? "style";
    const roundDelta = Math.abs(next - current);

    if (
      (category === "position" || category === "size") &&
      roundDelta > limits.perRoundPositionPx
    ) {
      issues.push({
        index: -1,
        id: change.id,
        field,
        code: "MAGNITUDE_PER_ROUND",
        message: `字段 ${field} 单轮变化 ${roundDelta}px 超过上限 ${limits.perRoundPositionPx}px`,
      });
    }
    if (category === "fontSize" && roundDelta > limits.perRoundFontSizePx) {
      issues.push({
        index: -1,
        id: change.id,
        field,
        code: "MAGNITUDE_PER_ROUND",
        message: `字段 ${field} 单轮变化 ${roundDelta}px 超过上限 ${limits.perRoundFontSizePx}px`,
      });
    }

    // 累计幅度（相对起始模板；防止小步累积绕过限制）
    const startValue = cumulative[change.id]?.[field];
    if (startValue !== undefined) {
      const cumulativeDelta = Math.abs(next - startValue);
      if (
        (category === "position" || category === "size") &&
        cumulativeDelta > limits.cumulativePositionPx
      ) {
        issues.push({
          index: -1,
          id: change.id,
          field,
          code: "MAGNITUDE_CUMULATIVE",
          message: `字段 ${field} 相对起始模板累计变化 ${cumulativeDelta}px 超过上限 ${limits.cumulativePositionPx}px`,
        });
      }
      if (
        category === "fontSize" &&
        cumulativeDelta > limits.cumulativeFontSizePx
      ) {
        issues.push({
          index: -1,
          id: change.id,
          field,
          code: "MAGNITUDE_CUMULATIVE",
          message: `字段 ${field} 相对起始模板累计变化 ${cumulativeDelta}px 超过上限 ${limits.cumulativeFontSizePx}px`,
        });
      }
    }
  }

  return issues;
}

/** 记录起始值（首次补丁某元素字段时登记到 cumulative）。 */
function recordStartValues(
  change: { id: string; set: Record<string, number | string> },
  currentById: Map<string, Record<string, unknown>>,
  cumulative: CumulativeChanges,
): void {
  const element = currentById.get(change.id);
  if (element === undefined) {
    return;
  }
  const existing = cumulative[change.id] ?? {};
  for (const field of Object.keys(change.set)) {
    if (NUMERIC_PATCH_FIELDS.has(field) && existing[field] === undefined) {
      const current = numericValueOf(element[field]);
      if (current !== undefined) {
        existing[field] = current;
      }
    }
  }
  cumulative[change.id] = existing;
}

/** 对 SceneSpec 应用补丁。 */
export function applyPatchToScene(
  scene: SceneSpec,
  patch: TemplatePatch,
  options: ApplyPatchOptions = {},
): ApplyPatchResult {
  const limits = options.limits ?? DEFAULT_PATCH_LIMITS;
  const cumulative: CumulativeChanges = { ...(options.cumulative ?? {}) };
  const issues: PatchIssue[] = [];

  const currentById = new Map<string, Record<string, unknown>>();
  for (const element of scene.elements) {
    currentById.set(element.id, element as unknown as Record<string, unknown>);
  }

  // ---- 校验（全部 change 先验证，任一非法则整体拒绝，不产生半应用状态）----
  for (const [index, change] of patch.changes.entries()) {
    if (!currentById.has(change.id)) {
      issues.push({
        index,
        id: change.id,
        code: "UNKNOWN_ID",
        message: `未知元素 ID：${change.id}（SceneSpec 中不存在）`,
      });
      continue;
    }
    const fieldIssues = validatePatchFields(change, SCENE_PATCHABLE_FIELDS);
    issues.push(
      ...fieldIssues.map((issue) => ({ ...issue, index })),
    );
    issues.push(
      ...checkMagnitude(change, currentById, cumulative, limits).map((issue) => ({
        ...issue,
        index,
      })),
    );
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // ---- 应用（浅拷贝元素；原模板不被修改）----
  const roundDeltas: Record<string, Record<string, number>> = {};
  const elements: SceneElement[] = scene.elements.map((element) => {
    const change = patch.changes.find((c) => c.id === element.id);
    if (change === undefined) {
      return element;
    }

    recordStartValues(change, currentById, cumulative);

    const updated = { ...element } as Record<string, unknown>;
    const deltas: Record<string, number> = {};
    for (const [field, value] of Object.entries(change.set)) {
      const before = numericValueOf(updated[field]);
      updated[field] = value;
      const after = numericValueOf(value);
      if (before !== undefined && after !== undefined) {
        deltas[field] = after - before;
      }
    }
    roundDeltas[element.id] = deltas;
    return updated as unknown as SceneElement;
  });

  const patched: SceneSpec = { ...scene, elements };

  // ---- 结果重新走 schema 校验（补丁不能破坏结构）----
  const reparsed = parseSceneSpec(patched);
  if (!reparsed.ok) {
    return {
      ok: false,
      issues: reparsed.issues.map((issue) => ({
        index: -1,
        code: "SCHEMA" as const,
        message: `补丁后模板校验失败：${issue.path}: ${issue.message}`,
      })),
    };
  }

  return {
    ok: true,
    target: reparsed.spec,
    roundDeltas,
    cumulative,
    applied: patch.changes.length,
  };
}

/** 对 LayoutSpec 应用补丁（节点白名单更窄；flow 节点不可改 absolute）。 */
export function applyPatchToLayout(
  layout: LayoutSpec,
  patch: TemplatePatch,
  options: ApplyPatchOptions = {},
): ApplyPatchResult {
  const limits = options.limits ?? DEFAULT_PATCH_LIMITS;
  const cumulative: CumulativeChanges = { ...(options.cumulative ?? {}) };
  const issues: PatchIssue[] = [];

  // 收集全部节点（含 repeat 模板内部）
  const nodesById = new Map<string, LayoutNode>();
  const collect = (node: LayoutNode): void => {
    nodesById.set(node.id, node);
    if (node.type === "container") {
      for (const child of node.children) {
        collect(child);
      }
    } else if (node.type === "repeat") {
      collect(node.itemTemplate);
    }
  };
  collect(layout.root);

  const currentById = new Map<string, Record<string, unknown>>();
  for (const [id, node] of nodesById) {
    const flat: Record<string, unknown> = { ...node } as Record<string, unknown>;
    if (node.type !== "container" && node.type !== "text" && node.type !== "image") {
      currentById.set(id, flat);
      continue;
    }
    // 样式字段拍平（style.fontSize → fontSize）供幅度读取
    for (const [k, v] of Object.entries((node as { style?: StyleFields }).style ?? {})) {
      if (!(k in flat)) {
        flat[k] = v;
      }
    }
    currentById.set(id, flat);
  }

  for (const [index, change] of patch.changes.entries()) {
    const node = nodesById.get(change.id);
    if (node === undefined) {
      issues.push({
        index,
        id: change.id,
        code: "UNKNOWN_ID",
        message: `未知节点 ID：${change.id}（LayoutSpec 中不存在）`,
      });
      continue;
    }

    // flow 节点不允许强改 absolute（layout 字段本身在禁止清单）
    const fieldIssues = validatePatchFields(change, LAYOUT_PATCHABLE_FIELDS);
    issues.push(...fieldIssues.map((issue) => ({ ...issue, index })));
    issues.push(
      ...checkMagnitude(change, currentById, cumulative, limits).map((issue) => ({
        ...issue,
        index,
      })),
    );
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // ---- 应用（重建节点树；原模板不被修改）----
  const roundDeltas: Record<string, Record<string, number>> = {};

  const applyToNode = (node: LayoutNode): LayoutNode => {
    const change = patch.changes.find((c) => c.id === node.id);
    if (change === undefined) {
      // 递归子节点
      if (node.type === "container") {
        return { ...node, children: node.children.map(applyToNode) };
      }
      if (node.type === "repeat") {
        return { ...node, itemTemplate: applyToNode(node.itemTemplate) };
      }
      return node;
    }

    recordStartValues(change, currentById, cumulative);

    // 定位字段（x/y/width/height）仅 absolute 容器有；样式字段写入 style
    const style: StyleFields = { ...((node as { style?: StyleFields }).style ?? {}) };
    const position: Record<string, number> = {};
    const deltas: Record<string, number> = {};

    for (const [field, value] of Object.entries(change.set)) {
      const isPosition = field === "x" || field === "y" || field === "width" || field === "height";
      const styleRecord = style as Record<string, unknown>;
      const before = numericValueOf(
        isPosition
          ? (node as unknown as Record<string, unknown>)[field]
          : styleRecord[field],
      );
      const after = numericValueOf(value);

      if (isPosition) {
        // 只在节点本身是 absolute 容器时应用定位字段
        if (node.type === "container" && node.layout === "absolute") {
          (position as Record<string, unknown>)[field] = value;
        } else {
          // flow 节点收到定位字段：已在白名单内但无定位语义，忽略到 style
          // 不应发生（白名单允许 x/y 但 flow 节点无此字段）——按无效处理
          continue;
        }
      } else {
        (style as Record<string, unknown>)[field] = value;
      }

      if (before !== undefined && after !== undefined) {
        deltas[field] = after - before;
      }
    }
    roundDeltas[node.id] = deltas;

    const updated = {
      ...node,
      ...(position as object),
      ...((node.type === "container" || node.type === "text" || node.type === "image"
        ? { style }
        : {}) as object),
    } as LayoutNode;

    // 递归子节点
    if (updated.type === "container") {
      return { ...updated, children: updated.children.map(applyToNode) };
    }
    if (updated.type === "repeat") {
      return { ...updated, itemTemplate: applyToNode(updated.itemTemplate) };
    }
    return updated;
  };

  const patched: LayoutSpec = { ...layout, root: applyToNode(layout.root) as LayoutSpec["root"] };

  const reparsed = parseLayoutSpec(patched);
  if (!reparsed.ok) {
    return {
      ok: false,
      issues: reparsed.issues.map((issue) => ({
        index: -1,
        code: "SCHEMA" as const,
        field: issue.nodeId,
        message: `补丁后布局校验失败：${issue.path}: ${issue.message}`,
      })),
    };
  }

  return {
    ok: true,
    target: reparsed.spec,
    roundDeltas,
    cumulative,
    applied: patch.changes.length,
  };
}

/** 按模板版本分发应用补丁。 */
export function applyTemplatePatch(
  target: PatchTarget,
  patchValue: unknown,
  options: ApplyPatchOptions = {},
): ApplyPatchResult {
  const parsed = parseTemplatePatch(patchValue);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues };
  }

  const version = (target as { version: string }).version;
  if (version === "1.0") {
    return applyPatchToScene(target as SceneSpec, parsed.patch, options);
  }
  if (version === "2.0") {
    return applyPatchToLayout(target as LayoutSpec, parsed.patch, options);
  }
  return {
    ok: false,
    issues: [
      {
        index: -1,
        code: "SCHEMA",
        message: `未知模板版本：${version}`,
      },
    ],
  };
}

export { FORBIDDEN_PATCH_FIELDS };
