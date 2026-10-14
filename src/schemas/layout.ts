/**
 * LayoutSpec（语义模板，version "2.0"）schema（T11）。
 *
 * 实施计划 T11 步骤 1：
 * - 受限 container/text/image/repeat 节点与语义组件节点；
 * - row/column/grid/局部 absolute 的字段白名单；
 * - 深度与节点数量上限；
 * - binding 使用受限属性路径；拒绝 `__proto__`、`constructor` 等特殊路径；
 * - 模式仅 replica/adaptive（2.4 统一名词：hybrid 是提取策略不是渲染模式）。
 *
 * 通用 reader/render 继续支持 SceneSpec 1.0；LayoutSpec 2.0 不破坏已交付模板。
 */

import { z } from "zod";

import { colorSchema, elementIdSchema } from "./scene.js";

/** 布局模式：replica 固定画布 / adaptive 流式内容（计划 2.4）。 */
export const layoutModeSchema = z.enum(["replica", "adaptive"]);

/** 受限样式值：颜色 / 像素数 / 百分比字符串 / 对齐枚举 / 有限数字。 */
const styleValueSchema = z.union([
  colorSchema,
  z.number().finite(),
  z
    .string()
    .regex(
      /^-?\d+(\.\d+)?(px|%)$/,
      "样式字符串只允许 px/% 数值（如 12px、50%）",
    ),
  z.enum(["left", "center", "right"]),
  z.literal("bold"),
]);

/** 受限样式字段白名单。 */
export const styleFieldNames = [
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
  "paddingX",
  "paddingY",
  "gap",
  "width",
  "height",
  "minHeight",
  "align",
  "justify",
  "textAlign",
] as const;

export const styleFieldsSchema = z.record(
  z.enum(styleFieldNames),
  styleValueSchema,
);

/** 受限 binding 属性路径：点分层级，拒绝特殊路径。 */
export const bindingPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((path) => !path.startsWith(".") && !path.endsWith("."), {
    message: "binding 路径不能以 . 开头或结尾",
  })
  .refine(
    (path) =>
      path.split(".").every(
        (segment) =>
          /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ||
          /^\[\d+\]$/.test(segment),
      ),
    { message: "binding 路径段必须是合法标识符或 [n] 数组索引" },
  )
  .refine(
    (path) =>
      !path
        .split(".")
        .some(
          (segment) =>
            segment === "__proto__" ||
            segment === "constructor" ||
            segment === "prototype",
        ),
    { message: "binding 路径不允许 __proto__/constructor/prototype" },
  );

const baseNodeFields = {
  id: elementIdSchema,
};

/** text 节点：绑定内容路径 + fallback + 受限样式与溢出策略。 */
export const textNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal("text"),
  binding: bindingPathSchema,
  /** 绑定缺失时的显示文本（校验缺失必填绑定时报错的依据）。 */
  fallback: z.string().default(""),
  style: styleFieldsSchema.default({}),
  overflow: z.enum(["wrap", "error"]).default("wrap"),
});

/** image 节点：绑定或固定 src + 受限样式（T12 扩展 objectFit/objectPosition）。 */
export const imageNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal("image"),
  /** 绑定路径（如 photos.[0].src）；可选（固定装饰图可只给 src）。 */
  binding: bindingPathSchema.optional(),
  /** 包内相对路径（固定图）；与 binding 二选一。 */
  src: z.string().default(""),
  alt: z.string().default(""),
  style: styleFieldsSchema.default({}),
});

/** repeat 节点：列表绑定 + 项模板 + 局部作用域绑定。 */
export interface RepeatNodeShape {
  id: string;
  type: "repeat";
  binding: string;
  itemTemplate: LayoutNode;
  gap: number;
}

/** 分页块元数据（T13 步骤 2～4；仅 adaptive 分页读取，replica 忽略）。 */
export interface PaginationMeta {
  /** 块类型（决定拆分规则；对应 paginate.ts PageBlock.kind）。 */
  kind:
    | "page-header"
    | "section-title"
    | "card"
    | "timeline-item"
    | "photo"
    | "text"
    | "info-box";
  /** 栏序（双栏布局的栏号；单栏为 0）。 */
  column?: number;
  /** 阅读顺序（栏内顺序；省略时按文档顺序）。 */
  order?: number;
  /** 不可拆（卡片/时间轴项/图片+说明默认 true；标题除外）。 */
  atomic?: boolean;
  /** 与下一块同页（标题不孤立）。 */
  keepWithNext?: boolean;
}

/** container 节点形状（供 lazy 引用）。 */
export interface ContainerNodeShape {
  id: string;
  type: "container";
  layout: "row" | "column" | "grid" | "absolute";
  columns?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  style: Record<string, string | number>;
  /** 分页块元数据（T13；仅 adaptive-paginate 使用）。 */
  pagination?: PaginationMeta;
  children: LayoutNode[];
}

/** LayoutNode 联合（向前声明）。 */
export type LayoutNode =
  | ContainerNodeShape
  | z.infer<typeof textNodeSchema>
  | z.infer<typeof imageNodeSchema>
  | RepeatNodeShape
  | z.infer<typeof componentNodeSchema>;

/** repeat 节点 schema（lazy 引用 layoutNodeSchema）。 */
export const repeatNodeSchema: z.ZodType<
  RepeatNodeShape,
  z.ZodTypeDef,
  unknown
> = z.lazy(() =>
  z.object({
    ...baseNodeFields,
    type: z.literal("repeat"),
    /** 列表路径（如 timeline）。 */
    binding: bindingPathSchema,
    /** 项模板：内部 binding 以 "item." 前缀引用当前项。 */
    itemTemplate: layoutNodeSchema,
    /** 项间距（px）。 */
    gap: z.number().finite().min(0).max(200).default(0),
  }),
);

/** container 节点 schema：row/column/grid/局部 absolute（字段白名单）。 */
export const containerNodeSchema: z.ZodType<
  ContainerNodeShape,
  z.ZodTypeDef,
  unknown
> = z.lazy(() =>
  z
    .object({
      ...baseNodeFields,
      type: z.literal("container"),
      layout: z.enum(["row", "column", "grid", "absolute"]),
      /** grid 列数。 */
      columns: z.number().int().min(1).max(12).optional(),
      /** 局部 absolute 定位（仅装饰与骨架；正文不写死全局坐标）。 */
      x: z.number().finite().nonnegative().optional(),
      y: z.number().finite().nonnegative().optional(),
      width: z.number().finite().positive().optional(),
      height: z.number().finite().positive().optional(),
      style: styleFieldsSchema.default({}),
      /** 分页块元数据（T13；仅 adaptive-paginate 使用）。 */
      pagination: paginationMetaSchema.optional(),
      children: z.array(layoutNodeSchema).default([]),
    })
    .superRefine((node, ctx) => {
      if (node.layout === "grid" && node.columns === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["columns"],
          message: "grid 布局必须声明 columns",
        });
      }
      if (node.layout === "absolute") {
        for (const field of ["x", "y", "width", "height"] as const) {
          if (node[field] === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [field],
              message: `absolute 布局必须声明 ${field}`,
            });
          }
        }
      }
    }),
);

/** 分页块元数据 schema（T13）。 */
export const paginationMetaSchema = z.object({
  kind: z.enum([
    "page-header",
    "section-title",
    "card",
    "timeline-item",
    "photo",
    "text",
    "info-box",
  ]),
  column: z.number().int().min(0).max(4).optional(),
  order: z.number().int().min(0).optional(),
  atomic: z.boolean().optional(),
  keepWithNext: z.boolean().optional(),
});

/** 语义组件节点（T12 实现具体组件；此处为组件引用声明）。 */
export const componentNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal("component"),
  /** 注册表中的组件名（如 header、timeline、photo-grid）。 */
  component: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, "组件名使用小写字母数字与连字符"),
  /** 组件参数（受限：由组件 schema 校验）。 */
  props: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
  /** 绑定（可选；组件决定语义字段）。 */
  binding: bindingPathSchema.optional(),
});

/** LayoutNode 判别联合 schema（普通 union + 手动判别）。 */
export const layoutNodeSchema: z.ZodType<LayoutNode, z.ZodTypeDef, unknown> =
  z.lazy(() =>
  z.union([
    containerNodeSchema,
    textNodeSchema,
    imageNodeSchema,
    repeatNodeSchema,
    componentNodeSchema,
  ]),
);

/** 布局策略：replica（固定骨架）或 adaptive（流式），见计划 2.4 hybrid 说明。 */
export const layoutStrategySchema = z.object({
  mode: layoutModeSchema,
  /** adaptive 溢出策略（T13）：grow 增高 / paginate 分页；replica 不适用。 */
  overflow: z.enum(["error", "grow", "paginate"]).optional(),
});

/** LayoutSpec：version "2.0" 语义模板。 */
export const layoutSpecSchema = z.object({
  version: z.literal("2.0"),
  /** 画布（replica 的固定尺寸；adaptive 的初始页尺寸）。 */
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    background: colorSchema,
  }),
  strategy: layoutStrategySchema,
  /** 根节点（单容器）。 */
  root: containerNodeSchema,
  /** 使用的字体槽位声明。 */
  fonts: z.array(z.enum(["sans", "serif", "latin"])).default(["sans"]),
  /** 来源追踪：节点 ID → SceneSpec 元素 ID（编译保留，T11 步骤 2）。 */
  sourceElements: z.record(z.string(), z.array(z.string())).default({}),
  notes: z.array(z.string()).default([]),
});

export type LayoutSpec = z.infer<typeof layoutSpecSchema>;
export type TextNode = z.infer<typeof textNodeSchema>;
export type ImageNode = z.infer<typeof imageNodeSchema>;
export type ComponentNode = z.infer<typeof componentNodeSchema>;
export type StyleFields = Partial<
  Record<(typeof styleFieldNames)[number], string | number>
>;
export type LayoutMode = z.infer<typeof layoutModeSchema>;
export type LayoutStrategy = z.infer<typeof layoutStrategySchema>;

/** LayoutSpec 解析问题。 */
export interface LayoutIssue {
  code:
    | "SCHEMA"
    | "UNSUPPORTED_VERSION"
    | "DUPLICATE_ID"
    | "NODE_LIMIT"
    | "DEPTH_LIMIT";
  path: string;
  message: string;
  nodeId?: string;
}

export interface LayoutParseSuccess {
  ok: true;
  spec: LayoutSpec;
}

export interface LayoutParseFailure {
  ok: false;
  issues: LayoutIssue[];
}

export type LayoutParseResult = LayoutParseSuccess | LayoutParseFailure;

/** 深度上限（计划 T11 步骤 1）。 */
export const MAX_LAYOUT_DEPTH = 12;

/** 节点数上限。 */
export const MAX_LAYOUT_NODES = 500;

/** 遍历节点（含根与 repeat 模板内部）。 */
export function walkLayoutNodes(
  node: LayoutNode,
  visit: (node: LayoutNode, depth: number) => void,
  depth = 1,
): void {
  visit(node, depth);
  if (node.type === "container") {
    for (const child of node.children) {
      walkLayoutNodes(child, visit, depth + 1);
    }
  } else if (node.type === "repeat") {
    walkLayoutNodes(node.itemTemplate, visit, depth + 1);
  }
}

/** 解析并校验 LayoutSpec：schema + 唯一 ID + 深度/数量上限。 */
export function parseLayoutSpec(value: unknown): LayoutParseResult {
  const result = layoutSpecSchema.safeParse(value);
  if (!result.success) {
    const issues: LayoutIssue[] = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      const isVersion = issue.path.length === 1 && issue.path[0] === "version";
      return {
        code: isVersion
          ? ("UNSUPPORTED_VERSION" as const)
          : ("SCHEMA" as const),
        path: path === "" ? "(root)" : path,
        message: issue.message,
      };
    });
    return { ok: false, issues };
  }

  const spec = result.data as LayoutSpec;
  const issues: LayoutIssue[] = [];

  // 唯一 ID / 深度 / 数量
  const seen = new Set<string>();
  let count = 0;

  walkLayoutNodes(spec.root, (node, depth) => {
    count += 1;

    if (seen.has(node.id)) {
      issues.push({
        code: "DUPLICATE_ID",
        path: node.id,
        nodeId: node.id,
        message: `重复节点 ID：${node.id}`,
      });
    }
    seen.add(node.id);

    if (depth > MAX_LAYOUT_DEPTH) {
      issues.push({
        code: "DEPTH_LIMIT",
        path: node.id,
        nodeId: node.id,
        message: `节点嵌套深度 ${depth} 超过上限 ${MAX_LAYOUT_DEPTH}`,
      });
    }
  });

  if (count > MAX_LAYOUT_NODES) {
    issues.push({
      code: "NODE_LIMIT",
      path: "(root)",
      message: `节点数量 ${count} 超过上限 ${MAX_LAYOUT_NODES}`,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, spec };
}

/** 绑定路径读取（受限解析；不使用 eval）。 */
export function readBindingPath(
  content: unknown,
  path: string,
): { found: boolean; value: unknown } {
  const segments = path.split(".");
  let current: unknown = content;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return { found: false, value: undefined };
    }
    const arrayMatch = /^\[(\d+)\]$/.exec(segment);
    if (arrayMatch !== null) {
      const index = Number(arrayMatch[1]);
      if (!Array.isArray(current) || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (
      typeof current !== "object" ||
      !(segment in (current as Record<string, unknown>))
    ) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return { found: true, value: current };
}

/** 绑定路径写入（受限解析；不使用 eval）。 */
export function writeBindingPath(
  content: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = content;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const next = current[segment];
    if (typeof next !== "object" || next === null) {
      const nextIsIndex = /^\[(\d+)\]$/.test(segments[i + 1] ?? "");
      current[segment] = nextIsIndex ? [] : {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  const last = segments[segments.length - 1];
  const arrayMatch = /^\[(\d+)\]$/.exec(last);
  if (arrayMatch !== null && Array.isArray(current)) {
    current[Number(arrayMatch[1])] = value;
  } else {
    current[last] = value;
  }
}
