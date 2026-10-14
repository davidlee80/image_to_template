/**
 * SceneSpec（定位式模板，version "1.0"）schema 与几何校验。
 *
 * 实施计划 T02：
 * - text / image / box 判别联合；限制 ID、颜色、坐标、尺寸、层级、字体类别、字重和置信度；
 * - 唯一 ID、有限数值、画布边界（保留至多 1 px 舍入容差）、最大元素数；
 * - image 的 src 只允许模板包内相对路径（越界在解析阶段报具体 issue）。
 *
 * 结构合法不代表识别准确；视觉对比与人工校验另行执行（设计文档第四章）。
 */

import { z } from "zod";

/** #RRGGBB 颜色。 */
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "颜色必须是 #RRGGBB 格式");

export type Color = z.infer<typeof colorSchema>;

/** 元素 ID：字母、数字、下划线、连字符。 */
export const elementIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "元素 ID 只允许字母、数字、下划线和连字符",
  );

/** 画布坐标：非负有限数。 */
const coordinateSchema = z.number().finite().nonnegative();

/** 元素尺寸：正有限数。 */
const sizeSchema = z.number().finite().positive();

const baseElementFields = {
  id: elementIdSchema,
  x: coordinateSchema,
  y: coordinateSchema,
  width: sizeSchema,
  height: sizeSchema,
  zIndex: z.number().int().min(0).max(1000).default(1),
  /** 识别置信度：模型自报或合并信号，不是统计概率。 */
  confidence: z.number().min(0).max(1).default(0.5),
};

export const textElementSchema = z.object({
  ...baseElementFields,
  type: z.literal("text"),
  /** 提取阶段（T04）会把正文移入 content.json 并将此字段清空；空串是合法状态。 */
  text: z.string().default(""),
  fontSize: sizeSchema.max(500).default(14),
  fontFamily: z.enum(["sans", "serif", "latin"]).default("sans"),
  fontWeight: z.enum(["400", "700"]).default("400"),
  lineHeight: z.number().min(0.8).max(3).default(1.4),
  letterSpacing: z.number().min(-10).max(30).default(0),
  color: colorSchema.default("#333333"),
  align: z.enum(["left", "center", "right"]).default("left"),
});

export const imageElementSchema = z.object({
  ...baseElementFields,
  type: z.literal("image"),
  /** 模板包内相对路径，如 assets/photo-01.png；由提取阶段填充。 */
  src: z.string().default(""),
});

export const boxElementSchema = z.object({
  ...baseElementFields,
  type: z.literal("box"),
  fill: z.union([colorSchema, z.literal("transparent")]).default("transparent"),
  borderColor: colorSchema.default("#CCCCCC"),
  borderWidth: z.number().min(0).max(50).default(0),
  radius: z.number().min(0).max(1000).default(0),
});

export const sceneElementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  imageElementSchema,
  boxElementSchema,
]);

/** SceneSpec：对应设计 MVP 的 version "1.0" 定位模板。 */
export const sceneSpecSchema = z.object({
  version: z.literal("1.0"),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    background: colorSchema,
  }),
  elements: z.array(sceneElementSchema).min(1).max(1500),
  notes: z.array(z.string()).default([]),
});

export type TextElement = z.infer<typeof textElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export type BoxElement = z.infer<typeof boxElementSchema>;
export type SceneElement = z.infer<typeof sceneElementSchema>;
export type SceneSpec = z.infer<typeof sceneSpecSchema>;
export type SceneCanvas = SceneSpec["canvas"];

/** SceneSpec 读取入口对两种版本的统一称呼（LayoutSpec "2.0" 在 T11 引入）。 */
export type TemplateSpec = SceneSpec;

/** 校验问题：schema 错误与几何错误共用一种结构，带具体路径。 */
export interface SceneIssue {
  code:
    | "SCHEMA"
    | "DUPLICATE_ID"
    | "OUT_OF_CANVAS"
    | "INVALID_ASSET_PATH"
    | "UNSUPPORTED_VERSION";
  /** 如 "elements[3].id"、"elements[3]"、"canvas"。 */
  path: string;
  message: string;
  /** 关联元素 ID（几何/资源问题有值）。 */
  elementId?: string;
}

export interface SceneParseSuccess {
  ok: true;
  spec: SceneSpec;
}

export interface SceneParseFailure {
  ok: false;
  issues: SceneIssue[];
}

export type SceneParseResult = SceneParseSuccess | SceneParseFailure;

const ONE_PIXEL_TOLERANCE = 1;

function zodIssuesToSceneIssues(
  issues: z.ZodIssue[],
): SceneIssue[] {
  return issues.map((issue) => {
    const path = formatIssuePath(issue.path);
    const isVersion =
      issue.path.length === 1 && issue.path[0] === "version";
    return {
      code: isVersion ? "UNSUPPORTED_VERSION" : "SCHEMA",
      path,
      message: issue.message,
    };
  });
}

/** 将 zod issue 路径格式化为可读形式：数组索引用 [n]。 */
function formatIssuePath(
  path: Array<string | number>,
): string {
  if (path.length === 0) {
    return "(root)";
  }
  return path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : index === 0
          ? segment
          : `.${segment}`,
    )
    .join("");
}

/**
 * 判断资源相对路径是否为模板包内安全相对路径。
 * 拒绝：空、URL/协议、绝对路径（POSIX 与 Windows 盘符/UNC）、`..` 段、反斜杠分隔符。
 * 返回 null 表示安全；否则返回具体原因。
 */
export function unsafeRelativePathReason(relative: string): string | null {
  if (relative === "") {
    return "资源路径为空";
  }

  const normalized = relative.replace(/\\/g, "/");

  if (normalized.includes("\0")) {
    return "资源路径包含空字节";
  }

  // URL 或协议前缀（http:、https:、data:、file: …），包括 Windows 盘符 E:/x
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)) {
    return "资源路径不允许 URL、协议或盘符前缀";
  }

  // POSIX 绝对路径或 UNC（//server/share、\\server\share）
  if (normalized.startsWith("/") || normalized.startsWith("//")) {
    return "资源路径不允许绝对路径或 UNC 路径";
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      return "资源路径不允许 .. 上级目录";
    }
  }

  return null;
}

function validateSceneGeometry(spec: SceneSpec): SceneIssue[] {
  const issues: SceneIssue[] = [];
  const seen = new Set<string>();
  const { width, height } = spec.canvas;

  spec.elements.forEach((element, index) => {
    const base = { path: `elements[${index}]`, elementId: element.id };

    if (seen.has(element.id)) {
      issues.push({
        ...base,
        code: "DUPLICATE_ID",
        message: `重复元素 ID：${element.id}`,
      });
    }
    seen.add(element.id);

    if (element.x + element.width > width + ONE_PIXEL_TOLERANCE) {
      issues.push({
        ...base,
        code: "OUT_OF_CANVAS",
        message: `元素 ${element.id} 右边界越出画布：x=${element.x} + width=${element.width} > ${width}（容差 ${ONE_PIXEL_TOLERANCE} px）`,
      });
    }

    if (element.y + element.height > height + ONE_PIXEL_TOLERANCE) {
      issues.push({
        ...base,
        code: "OUT_OF_CANVAS",
        message: `元素 ${element.id} 下边界越出画布：y=${element.y} + height=${element.height} > ${height}（容差 ${ONE_PIXEL_TOLERANCE} px）`,
      });
    }

    if (element.type === "image") {
      const reason = unsafeRelativePathReason(element.src);
      if (element.src !== "" && reason !== null) {
        issues.push({
          ...base,
          code: "INVALID_ASSET_PATH",
          message: `素材路径非法（${element.id}）：${reason}`,
        });
      }
    }
  });

  return issues;
}

/**
 * 解析并校验 SceneSpec：schema 校验 + 几何/唯一性/资源路径检查。
 * 不抛异常；调用方决定转为类型化错误或写入报告。
 */
export function parseSceneSpec(value: unknown): SceneParseResult {
  const schemaResult = sceneSpecSchema.safeParse(value);
  if (!schemaResult.success) {
    return { ok: false, issues: zodIssuesToSceneIssues(schemaResult.error.issues) };
  }

  const geometryIssues = validateSceneGeometry(schemaResult.data);
  if (geometryIssues.length > 0) {
    return { ok: false, issues: geometryIssues };
  }

  return { ok: true, spec: schemaResult.data };
}

/** 将 issue 列表格式化为单条错误消息（保留路径信息）。 */
export function formatSceneIssues(issues: SceneIssue[]): string {
  return issues
    .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
    .join("；");
}

/** 运行时类型守卫：区分 SceneSpec 与 RegionSpec（provider 返回联合类型时使用）。 */
export function isSceneSpec(value: object): value is SceneSpec {
  return "elements" in value && "canvas" in value;
}

/** 便捷构造：text 元素集合（内容键一一对应的依据）。 */
export function textElementsOf(spec: SceneSpec): TextElement[] {
  return spec.elements.filter(
    (element): element is TextElement => element.type === "text",
  );
}

/** 便捷构造：image 元素集合。 */
export function imageElementsOf(spec: SceneSpec): ImageElement[] {
  return spec.elements.filter(
    (element): element is ImageElement => element.type === "image",
  );
}
