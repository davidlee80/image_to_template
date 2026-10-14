/**
 * report.json schema（A 阶段骨架，随阶段扩展）。
 *
 * 实施计划第 7 节：reader 必须识别版本；每次运行重新计算受影响字段；
 * 不适用的 comparison 明确记录原因，不能保留旧 mismatchRatio。
 * 字段组按阶段引入（layout/assets/fonts/editability 在 T05/T06，
 * comparison 在 T07，区域分数在 T14，pages 在 T13，calibration 在 T15）。
 */

import { z } from "zod";

export const reportSchemaVersion = "1.0" as const;

/** 复查项：稳定 ID、类型、严重程度、位置/元素、证据与处理结论。 */
export const reviewItemSchema = z.object({
  /** 稳定 ID：同一问题重复运行保持一致（基于元素与问题类型构造）。 */
  id: z.string().min(1),
  /** 如 low_confidence / overflow / asset_review / font_missing。 */
  type: z.string().min(1),
  severity: z.enum(["info", "warning", "blocker"]),
  elementId: z.string().optional(),
  region: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  message: z.string(),
  /** 证据：来源、坐标、对照值等。 */
  evidence: z.record(z.string(), z.unknown()).optional(),
  /** 人工结论：pending 待处理；结论与模板/内容哈希绑定（T16）。 */
  resolution: z
    .object({
      status: z.enum(["pending", "accepted", "dismissed"]),
      note: z.string().optional(),
      resolvedAt: z.string().optional(),
    })
    .default({ status: "pending" }),
});

export type ReviewItem = z.infer<typeof reviewItemSchema>;

/** 运行状态：runId、阶段、状态、时间与输入哈希（环境/工具链字段 T06 扩展）。 */
export const reportRunSchema = z.object({
  runId: z.string().min(1),
  stage: z.enum(["extract", "render", "compare", "validate", "calibrate", "batch"]),
  status: z.enum(["pass", "needs_review", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** 输入/模板/内容哈希（A 阶段：原始内容哈希；T07 写入 manifest）。 */
  inputHash: z.string().optional(),
  templateHash: z.string().optional(),
  contentHash: z.string().optional(),
});

export type ReportRun = z.infer<typeof reportRunSchema>;

/**
 * report 骨架 schema：只约束已知字段的结构；
 * 阶段扩展字段允许存在（passthrough），由各阶段自己的 schema 细化。
 */
export const reportSchema = z
  .object({
    schemaVersion: z.literal(reportSchemaVersion),
    run: reportRunSchema,
    reviewItems: z.array(reviewItemSchema).default([]),
  })
  .passthrough();

export type Report = z.infer<typeof reportSchema>;

export interface ReportParseSuccess {
  ok: true;
  report: Report;
}

export interface ReportParseFailure {
  ok: false;
  issues: Array<{ path: string; message: string }>;
}

export type ReportParseResult = ReportParseSuccess | ReportParseFailure;

/** 读取 report：未知 schemaVersion 必须明确报错（计划 2.3）。 */
export function parseReport(value: unknown): ReportParseResult {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion !== reportSchemaVersion
  ) {
    return {
      ok: false,
      issues: [
        {
          path: "schemaVersion",
          message: `未知报告版本：${String(value.schemaVersion)}（当前支持 ${reportSchemaVersion}）`,
        },
      ],
    };
  }

  const result = reportSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: issue.message,
      })),
    };
  }

  return { ok: true, report: result.data };
}
