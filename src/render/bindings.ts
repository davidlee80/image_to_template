/**
 * LayoutSpec 绑定解析（T11 步骤 4）。
 *
 * 实施计划：
 * - binding 使用受限属性路径与 repeat 局部作用域；
 * - 拒绝 `__proto__`、`constructor` 等特殊路径（schema 层已拒）；
 * - 缺失必填绑定报错（带节点 ID 与路径）；
 * - 不使用 eval。
 */

import {
  readBindingPath,
  walkLayoutNodes,
  type LayoutNode,
  type LayoutSpec,
} from "../schemas/layout.js";

/** 解析后的节点绑定值。 */
export interface ResolvedBindings {
  /** text/image 节点 ID → 解析值。 */
  values: Record<string, unknown>;
  /** repeat 节点 ID → 展开项列表（每项含项内绑定值）。 */
  repeats: Record<
    string,
    Array<{
      /** 项索引。 */
      index: number;
      /** 项数据（供 item.* 绑定）。 */
      item: unknown;
    }>
  >;
}

export interface BindingIssue {
  nodeId: string;
  path: string;
  message: string;
}

export interface BindingResult {
  ok: boolean;
  bindings: ResolvedBindings;
  /** 缺失必填绑定（ok=false 时非空）。 */
  issues: BindingIssue[];
}

/** repeat 项模板中允许的绑定前缀。 */
export const REPEAT_ITEM_PREFIX = "item.";

/**
 * 解析全部绑定。
 * @param spec LayoutSpec
 * @param content 结构化内容
 * @param options.allowMissing 允许缺失（诊断模式；缺省 false 报错）
 */
export function resolveBindings(
  spec: LayoutSpec,
  content: unknown,
  options: { allowMissing?: boolean } = {},
): BindingResult {
  const values: ResolvedBindings["values"] = {};
  const repeats: ResolvedBindings["repeats"] = {};
  const issues: BindingIssue[] = [];

  const resolveNode = (node: LayoutNode, scope: unknown, scopedIdPrefix: string) => {
    if (node.type === "text") {
      const { found, value } = readBindingPath(scope, node.binding);
      if (!found) {
        issues.push({
          nodeId: scopedIdPrefix + node.id,
          path: node.binding,
          message: `缺失必填绑定：${node.binding}（节点 ${scopedIdPrefix + node.id}）`,
        });
        return;
      }
      if (typeof value !== "string") {
        issues.push({
          nodeId: scopedIdPrefix + node.id,
          path: node.binding,
          message: `绑定值必须是字符串：${node.binding}（实际 ${typeof value}）`,
        });
        return;
      }
      values[scopedIdPrefix + node.id] = value;
      return;
    }

    if (node.type === "image" && node.binding !== undefined) {
      const { found, value } = readBindingPath(scope, node.binding);
      if (!found) {
        issues.push({
          nodeId: scopedIdPrefix + node.id,
          path: node.binding,
          message: `缺失必填绑定：${node.binding}（节点 ${scopedIdPrefix + node.id}）`,
        });
        return;
      }
      if (typeof value !== "string") {
        issues.push({
          nodeId: scopedIdPrefix + node.id,
          path: node.binding,
          message: `图片绑定值必须是字符串：${node.binding}`,
        });
        return;
      }
      values[scopedIdPrefix + node.id] = value;
      return;
    }

    if (node.type === "repeat") {
      const { found, value } = readBindingPath(scope, node.binding);
      if (!found || !Array.isArray(value)) {
        issues.push({
          nodeId: scopedIdPrefix + node.id,
          path: node.binding,
          message: `repeat 绑定必须是数组：${node.binding}（${found ? "非数组" : "缺失"}）`,
        });
        return;
      }

      const items = value.map((item, index) => ({ index, item }));
      repeats[scopedIdPrefix + node.id] = items;

      // 项模板绑定以 item. 前缀在局部作用域解析
      for (const { index, item } of items) {
        resolveNode(
          node.itemTemplate,
          { item },
          `${scopedIdPrefix}${node.id}[${index}].`,
        );
      }
    }

    if (node.type === "container") {
      for (const child of node.children) {
        resolveNode(child, scope, scopedIdPrefix);
      }
    }
  };

  resolveNode(spec.root, content, "");

  const ok = options.allowMissing === true || issues.length === 0;
  return { ok, bindings: { values, repeats }, issues };
}

/** 列出 spec 的全部必填绑定路径（repeat 以 item. 展开）。 */
export function requiredBindingsOf(spec: LayoutSpec): Array<{
  nodeId: string;
  path: string;
  inRepeat: boolean;
}> {
  const required: Array<{ nodeId: string; path: string; inRepeat: boolean }> = [];

  const visit = (node: LayoutNode, prefix: string, inRepeat: boolean) => {
    if (node.type === "text") {
      required.push({ nodeId: prefix + node.id, path: node.binding, inRepeat });
    } else if (node.type === "image" && node.binding !== undefined) {
      required.push({ nodeId: prefix + node.id, path: node.binding, inRepeat });
    } else if (node.type === "repeat") {
      visit(node.itemTemplate, `${prefix}${node.id}[*].`, true);
    } else if (node.type === "container") {
      for (const child of node.children) {
        visit(child, prefix, inRepeat);
      }
    }
  };

  visit(spec.root, "", false);
  return required;
}

/** 遍历导出（重用 schema 的 walkLayoutNodes）。 */
export { walkLayoutNodes };
