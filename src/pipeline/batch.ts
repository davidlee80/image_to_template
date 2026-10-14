/**
 * 批量任务流水线（T17 步骤 1～2）。
 *
 * 实施计划：
 * - batch 接收任务清单（JSON 文件），每项使用独立输出目录与报告；
 * - 默认顺序执行并设置全局请求预算，不引入队列服务；
 * - 单项失败记录错误并继续其他独立任务；
 * - 最终输出成功/待复查/失败汇总；任一 failed 返回非零，
 *   严格模式中 needs_review 也返回非零（由 CLI exitCodeOf 映射）。
 */

import path from "node:path";

import type { Logger } from "../sdk.js";
import { ImageTemplateError } from "../errors.js";
import { readJsonFile, writeJsonFileAtomic } from "../io/json.js";
import { reportSchemaVersion } from "../schemas/report.js";
import { newRunId } from "./extract.js";

/** 批量任务类型（与单任务 CLI 参数一致）。 */
export type BatchTaskKind = "extract" | "render" | "validate";

/** 批量清单中的单个任务。 */
export interface BatchTask {
  /** 任务类型。 */
  kind: BatchTaskKind;
  /** 任务 ID（稳定；用于结果关联）。 */
  id: string;
  /** extract：输入图片；render/validate：模板包目录。 */
  input: string;
  /** 输出目录（每任务独立）。 */
  output: string;
  /** extract：允许覆盖。 */
  overwrite?: boolean;
  /** render/validate：严格模式。 */
  strict?: boolean;
  /** render：渲染模式。 */
  mode?: "replica" | "adaptive";
  /** render：溢出策略。 */
  overflow?: "error" | "grow" | "paginate";
  /** render：输出格式。 */
  format?: Array<"png" | "pdf">;
  /** extract：hybrid 提取。 */
  layout?: "hybrid";
}

/** 批量清单文件结构。 */
export interface BatchManifest {
  /** 清单版本。 */
  manifestVersion: "1.0";
  /** 全局请求预算（extract 识别调用共享；默认 20）。 */
  maxRequests?: number;
  tasks: BatchTask[];
}

export interface BatchTaskResult {
  /** 任务 ID（清单中的 id）。 */
  id: string;
  kind: BatchTaskKind;
  status: "pass" | "needs_review" | "failed";
  /** 任务错误（failed 时）。 */
  error?: {
    code: string;
    stage: string;
    message: string;
  };
  /** 任务产物路径。 */
  artifacts: string[];
  /** 任务运行 ID。 */
  runId?: string;
}

export interface BatchRunResult {
  runId: string;
  status: "pass" | "needs_review" | "failed";
  /** 汇总报告文件路径。 */
  summaryFile: string;
  taskResults: BatchTaskResult[];
  artifacts: string[];
}

/** 读取批量清单文件（结构校验）。 */
export async function readBatchManifest(
  file: string,
): Promise<BatchManifest> {
  const value = await readJsonFile(file, "batch");

  if (typeof value !== "object" || value === null || !Array.isArray((value as { tasks?: unknown }).tasks)) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "batch",
      message: `批量清单必须是含 tasks 数组的 JSON 对象：${file}`,
    });
  }

  const raw = value as Record<string, unknown>;
  if (raw.manifestVersion !== "1.0") {
    throw new ImageTemplateError({
      code: "UNSUPPORTED_VERSION",
      stage: "batch",
      message: `未知批量清单版本：${String(raw.manifestVersion)}（当前支持 1.0）`,
    });
  }

  const tasks = raw.tasks as BatchTask[];
  for (const [index, task] of tasks.entries()) {
    if (!["extract", "render", "validate"].includes(task.kind)) {
      throw new ImageTemplateError({
        code: "INVALID_ARGUMENT",
        stage: "batch",
        message: `tasks[${index}].kind 必须是 extract|render|validate（收到 ${String(task.kind)}）`,
      });
    }
    if (typeof task.id !== "string" || task.id === "") {
      throw new ImageTemplateError({
        code: "INVALID_ARGUMENT",
        stage: "batch",
        message: `tasks[${index}].id 必须是非空字符串`,
      });
    }
    if (typeof task.input !== "string" || typeof task.output !== "string") {
      throw new ImageTemplateError({
        code: "INVALID_ARGUMENT",
        stage: "batch",
        message: `tasks[${index}] 缺少 input/output 路径`,
      });
    }
  }

  // ID 唯一性
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new ImageTemplateError({
        code: "INVALID_ARGUMENT",
        stage: "batch",
        message: `批量任务 ID 重复：${task.id}`,
      });
    }
    ids.add(task.id);
  }

  return value as BatchManifest;
}

export interface BatchRunOptions {
  /** 清单文件路径。 */
  manifest: string;
  /** 严格策略：needs_review 也视为失败（退出码层面由 CLI 处理；此处影响汇总状态）。 */
  strict?: boolean;
  signal?: AbortSignal;
  logger?: Logger;
  /** 任务执行器（由 SDK 层注入：复用同一实例的 extract/render/validate）。 */
  executor: {
    extract: (options: {
      input: string;
      output: string;
      overwrite?: boolean;
      layout?: "hybrid";
      maxRequests?: number;
    }) => Promise<{ runId: string; status: string; artifacts: string[] }>;
    render: (options: {
      template: string;
      strict?: boolean;
      mode?: "replica" | "adaptive";
      overflow?: "error" | "grow" | "paginate";
      format?: Array<"png" | "pdf">;
    }) => Promise<{ runId: string; status: string; artifacts: string[] }>;
    validate: (options: {
      bundle: string;
      strict?: boolean;
    }) => Promise<{ runId: string; status: string; artifacts: string[] }>;
  };
  /** 汇总报告输出目录（默认清单文件所在目录）。 */
  outputDir?: string;
}

/**
 * 执行批量任务（顺序执行；单项失败继续后续任务）。
 * 全局请求预算由调用方（SDK）按任务拆分注入 executor。
 */
export async function runBatch(
  options: BatchRunOptions,
): Promise<BatchRunResult> {
  const runId = newRunId();
  const manifest = await readBatchManifest(options.manifest);
  const outputDir = path.resolve(
    options.outputDir ?? path.dirname(path.resolve(options.manifest)),
  );

  options.logger?.("批量任务开始", {
    tasks: manifest.tasks.length,
    maxRequests: manifest.maxRequests ?? 20,
  });

  const taskResults: BatchTaskResult[] = [];

  // 全局预算拆分：每任务均分（不引入队列；顺序执行天然隔离）
  const perTaskBudget =
    manifest.maxRequests !== undefined && manifest.tasks.length > 0
      ? Math.max(1, Math.floor(manifest.maxRequests / manifest.tasks.length))
      : undefined;

  for (const [index, task] of manifest.tasks.entries()) {
    if (options.signal?.aborted) {
      throw new ImageTemplateError({
        code: "ABORTED",
        stage: "batch",
        message: "批量任务已取消",
        runId,
      });
    }

    options.logger?.(`任务 ${index + 1}/${manifest.tasks.length}`, {
      id: task.id,
      kind: task.kind,
    });

    try {
      let result: { runId: string; status: string; artifacts: string[] };
      if (task.kind === "extract") {
        result = await options.executor.extract({
          input: task.input,
          output: task.output,
          ...(task.overwrite === undefined ? {} : { overwrite: task.overwrite }),
          ...(task.layout === undefined ? {} : { layout: task.layout }),
          ...(perTaskBudget === undefined ? {} : { maxRequests: perTaskBudget }),
        });
      } else if (task.kind === "render") {
        result = await options.executor.render({
          template: task.input,
          ...(task.strict === undefined ? {} : { strict: task.strict }),
          ...(task.mode === undefined ? {} : { mode: task.mode }),
          ...(task.overflow === undefined ? {} : { overflow: task.overflow }),
          ...(task.format === undefined ? {} : { format: task.format }),
        });
      } else {
        result = await options.executor.validate({
          bundle: task.input,
          ...(task.strict === undefined ? {} : { strict: task.strict }),
        });
      }

      taskResults.push({
        id: task.id,
        kind: task.kind,
        status:
          result.status === "pass" || result.status === "needs_review"
            ? result.status
            : "failed",
        artifacts: result.artifacts,
        runId: result.runId,
      });
    } catch (error) {
      // 单项失败记录错误并继续其他独立任务
      const structured =
        error instanceof ImageTemplateError
          ? {
              code: error.code,
              stage: error.stage,
              message: error.message,
              ...(error.runId === undefined ? {} : { runId: error.runId }),
            }
          : {
              code: "IO_ERROR",
              stage: "batch",
              message: (error as Error).message ?? String(error),
            };

      options.logger?.(`任务 ${task.id} 失败，继续后续任务`, {
        code: structured.code,
      });

      taskResults.push({
        id: task.id,
        kind: task.kind,
        status: "failed",
        error: structured,
        artifacts: [],
      });
    }
  }

  // ---- 汇总状态：任一 failed → failed；严格模式下 needs_review 也计入 ----
  const hasFailed = taskResults.some((r) => r.status === "failed");
  const hasReview = taskResults.some((r) => r.status === "needs_review");
  const status: BatchRunResult["status"] = hasFailed
    ? "failed"
    : hasReview
      ? options.strict === true
        ? "failed"
        : "needs_review"
      : "pass";

  // ---- 汇总报告落盘 ----
  const summary = {
    schemaVersion: reportSchemaVersion,
    run: {
      runId,
      stage: "batch" as const,
      status,
      startedAt: new Date().toISOString(),
      manifest: path.resolve(options.manifest),
      taskCount: manifest.tasks.length,
    },
    summary: {
      pass: taskResults.filter((r) => r.status === "pass").length,
      needs_review: taskResults.filter((r) => r.status === "needs_review").length,
      failed: taskResults.filter((r) => r.status === "failed").length,
    },
    tasks: taskResults,
  };

  const summaryFile = path.join(outputDir, `batch-report-${runId}.json`);
  await writeJsonFileAtomic(summaryFile, summary, "batch");

  options.logger?.("批量任务完成", { status, ...summary.summary });

  return {
    runId,
    status,
    summaryFile,
    taskResults,
    artifacts: [summaryFile],
  };
}
