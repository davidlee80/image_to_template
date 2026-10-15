/**
 * SDK 实例与操作入口（骨架）。
 *
 * 实施计划 2.3：公开 `createImageTemplate(config)` 及实例方法
 * extract / render / compare / validate / calibrate / batch；
 * 未实现的能力必须明确拒绝（抛 NOT_IMPLEMENTED），不得静默忽略。
 *
 * 配置显式注入，SDK 不隐式加载 .env、不改变 cwd、不修改全局环境；
 * 配置路径在创建实例时解析，操作路径在调用开始时解析。
 */

import path from "node:path";

import { ImageTemplateError, type SdkStage } from "./errors.js";
import type {
  VisionProvider,
  VisionProviderFactory,
} from "./analysis/provider.js";
import {
  createVisionProvider,
  type VisionProviderConfig,
} from "./analysis/vision.js";
import { runExtraction } from "./pipeline/extract.js";
import {
  readContentOverride,
  runRender,
  type OverflowStrategy,
} from "./pipeline/render.js";
import { runCompare } from "./pipeline/compare.js";
import { migrateBundle } from "./semantic/migrate.js";
import type { OcrProvider } from "./analysis/ocr.js";
import { ResponseCache } from "./runtime/cache.js";
import { CallBudget } from "./runtime/budget.js";
import {
  runCalibrationLoop,
  type ProposalProvider,
} from "./calibration/loop.js";
import { runValidate } from "./quality/publish.js";
import { runBatch } from "./pipeline/batch.js";

/** 结构化日志回调：仅由宿主决定输出位置，SDK 不直接打印。 */
export type Logger = (
  message: string,
  detail?: Record<string, unknown>,
) => void;

/** 显式目录配置；均为可选，由调用方在创建实例时解析为绝对路径。 */
export interface DirectoriesConfig {
  /** 默认输出根目录；单次操作可用参数覆盖。 */
  output?: string;
  /** 识别缓存目录（B 阶段启用）。 */
  cache?: string;
  /** 临时任务目录；按 runId 隔离，操作结束后清理。 */
  temp?: string;
}

export interface ImageTemplateConfig {
  /** 结构化日志回调。 */
  logger?: Logger;
  /** 输出 / 缓存 / 临时目录。 */
  directories?: DirectoriesConfig;
  /** 视觉识别 provider 配置；未配置时 extract 明确报错，render/compare 不受影响。 */
  vision?: VisionProviderConfig;
  /** 宿主替换实现的 provider 工厂；设置后覆盖 vision 的内置实现。 */
  visionProviderFactory?: VisionProviderFactory;
  /** B 阶段：启用分区识别（区域划分 → 区域补识别 → 合并去重）。 */
  regionsMode?: boolean;
  /** B 阶段：独立 OCR provider（可选；支持 fixture 或宿主实现）。 */
  ocr?: OcrProvider;
  /** B 阶段：共享调用预算（识别/区域/OCR 全部计入）。 */
  budget?: { maxRequests: number; timeoutMs?: number };
  /** B 阶段：禁用识别缓存（--no-cache）。 */
  noCache?: boolean;
  /** D 阶段：补丁提案 provider（默认确定性建议器；真实校准注入模型实现）。 */
  proposalProvider?: ProposalProvider;
}

/** 所有操作的公共选项。 */
export interface OperationOptions {
  /** 中止信号；触发时清理本次临时资源并抛 ABORTED。 */
  signal?: AbortSignal;
  /** 操作超时（毫秒）；到期抛 TIMEOUT。 */
  timeoutMs?: number;
}

export interface ExtractOptions extends OperationOptions {
  /** 输入图片路径。 */
  input: string;
  /** 模板包输出目录。 */
  output: string;
  /**
   * 人工提供的 SceneSpec 文件（对话式 LLM 生成）：最高优先级；
   * 提供时不调用模型（无需 vision 配置）。
   */
  spec?: string;
  /** 显式覆盖已存在的输出目录（只替换受管产物）。 */
  overwrite?: boolean;
  /**
   * T13 提取策略：hybrid = 先保留 SceneSpec 再编译 LayoutSpec（自动迁移）；
   * 省略时仅产出 SceneSpec 1.0（A/B 阶段行为）。
   */
  layout?: "hybrid";
}

export interface RenderOptions extends OperationOptions {
  /** 模板包目录或 template.json 文件路径。 */
  template: string;
  /** 输出目录或单个 PNG 文件路径。 */
  output?: string;
  /** 覆盖内容数据（content.json 或 JSON 对象路径）。 */
  data?: string;
  /** 严格模式：发现阻断项时不产出有效导出。 */
  strict?: boolean;
  /** 渲染模式（T13）：replica 固定 / adaptive 流式；仅 LayoutSpec 2.0 支持 adaptive。 */
  mode?: "replica" | "adaptive";
  /** 溢出策略（T13）：grow / paginate；仅 adaptive。 */
  overflow?: OverflowStrategy;
  /** 输出格式（T13）：png / pdf，可多选。 */
  format?: Array<"png" | "pdf">;
  /** 栅格缩放（T13）：仅改变 PNG 分辨率。 */
  scale?: number;
}

export interface CompareOptions extends OperationOptions {
  /** 模板包目录。 */
  bundle: string;
  /** 新的匹配基准图（内容已编辑时使用）。 */
  reference?: string;
  /** 内容已改变时强制对比（不一致将报告 failed）。 */
  force?: boolean;
}

export interface ValidateOptions extends OperationOptions {
  /** 模板包目录。 */
  bundle: string;
  /** 严格策略。 */
  strict?: boolean;
}

export interface CalibrateOptions extends OperationOptions {
  /** 模板包目录。 */
  bundle: string;
  /** 最大迭代次数。 */
  iterations?: number;
  /** 共享调用预算：最大请求数。 */
  maxRequests?: number;
}

export interface BatchOptions extends OperationOptions {
  /** 批量任务清单（JSON 文件路径）。 */
  manifest: string;
  /** 严格策略：needs_review 也视为失败。 */
  strict?: boolean;
}

/** 操作结果：统一包含 runId、状态、产物清单与报告。 */
export interface OperationResult {
  runId: string;
  status: "pass" | "needs_review" | "failed";
  /** 本次操作产出的文件相对/绝对路径清单。 */
  artifacts: string[];
  /** 与 report.json 同构的报告对象。 */
  report: Record<string, unknown>;
}

export interface BatchResult extends OperationResult {
  /** 各任务的独立结果。 */
  tasks: OperationResult[];
}

/** 模块实例：配置隔离，操作共享同一核心流水线。 */
export interface ImageTemplate {
  extract(options: ExtractOptions): Promise<OperationResult>;
  render(options: RenderOptions): Promise<OperationResult>;
  compare(options: CompareOptions): Promise<OperationResult>;
  validate(options: ValidateOptions): Promise<OperationResult>;
  calibrate(options: CalibrateOptions): Promise<OperationResult>;
  batch(options: BatchOptions): Promise<BatchResult>;
}

function assertConfig(config: ImageTemplateConfig): void {
  const { logger, directories, vision, visionProviderFactory } = config;

  if (logger !== undefined && typeof logger !== "function") {
    throw new ImageTemplateError({
      code: "INVALID_CONFIG",
      stage: "config",
      message: "logger 必须是函数",
    });
  }

  if (visionProviderFactory !== undefined && typeof visionProviderFactory !== "function") {
    throw new ImageTemplateError({
      code: "INVALID_CONFIG",
      stage: "config",
      message: "visionProviderFactory 必须是函数",
    });
  }

  if (vision !== undefined) {
    if (typeof vision !== "object" || vision === null) {
      throw new ImageTemplateError({
        code: "INVALID_CONFIG",
        stage: "config",
        message: "vision 必须是对象",
      });
    }
    if (typeof vision.model !== "string" || vision.model === "") {
      throw new ImageTemplateError({
        code: "INVALID_CONFIG",
        stage: "config",
        message: "vision.model 必须是非空字符串",
      });
    }
    if (
      vision.kind === "fixture" &&
      (typeof vision.fixtureFile !== "string" &&
        (typeof vision.fixtureFile !== "object" ||
          vision.fixtureFile === null))
    ) {
      throw new ImageTemplateError({
        code: "INVALID_CONFIG",
        stage: "config",
        message: "vision.kind=fixture 需要 fixtureFile（字符串或按提示词版本映射的对象）",
      });
    }
    if (vision.kind === "openai-http" && typeof vision.apiKey !== "string") {
      throw new ImageTemplateError({
        code: "INVALID_CONFIG",
        stage: "config",
        message: "vision.kind=openai-http 需要 apiKey",
      });
    }
  }

  if (directories !== undefined) {
    if (typeof directories !== "object" || directories === null) {
      throw new ImageTemplateError({
        code: "INVALID_CONFIG",
        stage: "config",
        message: "directories 必须是对象",
      });
    }

    for (const key of ["output", "cache", "temp"] as const) {
      const value = directories[key];
      if (value !== undefined && typeof value !== "string") {
        throw new ImageTemplateError({
          code: "INVALID_CONFIG",
          stage: "config",
          message: `directories.${key} 必须是字符串路径`,
        });
      }
    }
  }
}

/**
 * 创建配置隔离的模块实例。import 本函数所在模块无任何运行副作用。
 */
export function createImageTemplate(
  config: ImageTemplateConfig = {},
): ImageTemplate {
  assertConfig(config);

  // 拷贝配置，避免宿主后续修改影响实例（计划 2.3：实例隔离）。
  const instanceConfig: ImageTemplateConfig = {
    ...(config.logger === undefined ? {} : { logger: config.logger }),
    ...(config.directories === undefined
      ? {}
      : { directories: { ...config.directories } }),
    ...(config.vision === undefined ? {} : { vision: { ...config.vision } }),
    ...(config.visionProviderFactory === undefined
      ? {}
      : { visionProviderFactory: config.visionProviderFactory }),
    ...(config.regionsMode === undefined ? {} : { regionsMode: config.regionsMode }),
    ...(config.ocr === undefined ? {} : { ocr: config.ocr }),
    ...(config.budget === undefined ? {} : { budget: { ...config.budget } }),
    ...(config.noCache === undefined ? {} : { noCache: config.noCache }),
    ...(config.proposalProvider === undefined
      ? {}
      : { proposalProvider: config.proposalProvider }),
  };

  // Provider 创建为惰性：实例创建无 I/O；工厂替换优先于内置实现。
  let cachedProvider: VisionProvider | undefined;
  const resolveProvider = (): VisionProvider => {
    if (cachedProvider === undefined) {
      cachedProvider =
        instanceConfig.visionProviderFactory !== undefined
          ? instanceConfig.visionProviderFactory(
              instanceConfig.vision as VisionProviderConfig,
            )
          : createVisionProvider(instanceConfig.vision as VisionProviderConfig);
    }
    return cachedProvider;
  };

  /** spec 路径：未配置 vision 时返回 undefined（管线跳过识别）。 */
  const resolveProviderSafe = (): VisionProvider | undefined => {
    if (
      instanceConfig.vision === undefined &&
      instanceConfig.visionProviderFactory === undefined
    ) {
      return undefined;
    }
    return resolveProvider();
  };

  void resolveProvider;

  const api: ImageTemplate = {
    extract: async (options: ExtractOptions) => {
      // --spec 路径：无需视觉配置（零模型调用）
      if (
        options.spec === undefined &&
        instanceConfig.vision === undefined &&
        instanceConfig.visionProviderFactory === undefined
      ) {
        throw new ImageTemplateError({
          code: "INVALID_CONFIG",
          stage: "extract",
          message: "缺少视觉识别配置：提供 spec（人工对话生成，零模型调用），或 createImageTemplate 需要 vision（或 visionProviderFactory）",
        });
      }

      const result = await runExtraction({
        inputPath: options.input,
        outputDir: options.output,
        // spec 路径下 provider 可省略（管线内部跳过识别）
        provider:
          options.spec !== undefined
            ? resolveProviderSafe()
            : resolveProvider(),
        ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
        ...(options.spec === undefined ? {} : { specFile: options.spec }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        logger: instanceConfig.logger,
        // B 阶段：分区识别 + OCR + 缓存 + 预算
        ...(instanceConfig.regionsMode === true ||
        instanceConfig.ocr !== undefined ||
        (instanceConfig.directories?.cache !== undefined &&
          instanceConfig.noCache !== true)
          ? {
              regions: {
                enabled: instanceConfig.regionsMode === true,
                ...(instanceConfig.ocr === undefined ? {} : { ocr: instanceConfig.ocr }),
                ...(instanceConfig.directories?.cache !== undefined &&
                instanceConfig.noCache !== true
                  ? { cache: new ResponseCache(instanceConfig.directories.cache) }
                  : {}),
                ...(instanceConfig.budget === undefined
                  ? {}
                  : {
                      budget: new CallBudget({
                        maxRequests: instanceConfig.budget.maxRequests,
                        ...(instanceConfig.budget.timeoutMs === undefined
                          ? {}
                          : { timeoutMs: instanceConfig.budget.timeoutMs }),
                      }),
                    }),
              },
            }
          : {}),
      });

      // T13：--layout hybrid = 先保留 SceneSpec 再编译 LayoutSpec（自动迁移）
      if (options.layout === "hybrid") {
        const migration = await migrateBundle(result.bundleDir);
        if (!migration.ok) {
          throw new ImageTemplateError({
            code: "INVALID_ARGUMENT",
            stage: "extract",
            message: `hybrid 提取的语义编译失败：${migration.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("；")}`,
            runId: result.runId,
          });
        }
      }

      // extract 串联：识别/裁剪/保存 → 渲染 → 对比（同一 runId）
      const renderResult = await runRender({
        bundleDir: result.bundleDir,
        runId: result.runId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        logger: instanceConfig.logger,
      });

      // hybrid（LayoutSpec）不串联原图对比：adaptive 布局不与原图逐像素比较；
      // SceneSpec 1.0 保持 A/B 阶段行为（render 后自动对比）。
      const isHybrid = options.layout === "hybrid";

      const operationResult: OperationResult = isHybrid
        ? {
            runId: result.runId,
            status: renderResult.status,
            artifacts: [
              ...result.artifacts.map((relative) =>
                path.join(result.bundleDir, relative),
              ),
              ...renderResult.artifacts,
            ],
            report: renderResult.report,
          }
        : await (async () => {
            const compareResult = await runCompare({
              bundleDir: result.bundleDir,
              runId: result.runId,
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
              logger: instanceConfig.logger,
            });

            const statuses = [renderResult.status, compareResult.status];
            const status: OperationResult["status"] = statuses.includes(
              "failed",
            )
              ? "failed"
              : statuses.includes("needs_review")
                ? "needs_review"
                : "pass";

            return {
              runId: result.runId,
              status,
              artifacts: [
                ...result.artifacts.map((relative) =>
                  path.join(result.bundleDir, relative),
                ),
                ...renderResult.artifacts,
                ...compareResult.artifacts,
              ],
              report: compareResult.report,
            };
          })();
      return operationResult;
    },
    render: async (options: RenderOptions) => {
      const contentOverride =
        options.data === undefined
          ? undefined
          : await readContentOverride(options.data);

      // --output 指向单 PNG 时输出到该路径；资源根仍是模板包目录
      const result = await runRender({
        bundleDir: options.template,
        ...(contentOverride === undefined ? {} : { contentOverride }),
        ...(options.output === undefined ? {} : { outputPng: options.output }),
        ...(options.strict === undefined ? {} : { strict: options.strict }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.overflow === undefined ? {} : { overflow: options.overflow }),
        ...(options.format === undefined ? {} : { format: options.format }),
        ...(options.scale === undefined ? {} : { scale: options.scale }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        logger: instanceConfig.logger,
      });

      const operationResult: OperationResult = {
        runId: result.runId,
        status: result.status,
        artifacts: result.artifacts,
        report: result.report,
      };
      return operationResult;
    },
    compare: async (options: CompareOptions) => {
      const result = await runCompare({
        bundleDir: options.bundle,
        ...(options.reference === undefined ? {} : { reference: options.reference }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        logger: instanceConfig.logger,
      });

      const operationResult: OperationResult = {
        runId: result.runId,
        status: result.status,
        artifacts: result.artifacts,
        report: result.report,
      };
      return operationResult;
    },
    validate: async (options: ValidateOptions) => {
      const result = await runValidate({
        bundleDir: options.bundle,
        ...(options.strict === undefined ? {} : { strict: options.strict }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        logger: instanceConfig.logger,
      });

      const operationResult: OperationResult = {
        runId: result.runId,
        status: result.status,
        artifacts: result.artifacts,
        report: {
          validate: {
            strict: options.strict === true,
            blockers: result.blockers,
            resolutions: result.resolutions,
            versions: result.versions,
          },
          reviewItems: result.reviewItems,
        },
      };
      return operationResult;
    },
    calibrate: async (options: CalibrateOptions) => {
      const result = await runCalibrationLoop({
        bundleDir: options.bundle,
        ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
        ...(options.maxRequests === undefined
          ? {}
          : { maxRequests: options.maxRequests }),
        ...(instanceConfig.proposalProvider === undefined
          ? {}
          : { proposalProvider: instanceConfig.proposalProvider }),
        ...(instanceConfig.budget === undefined
          ? {}
          : { timeoutMs: instanceConfig.budget.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        logger: instanceConfig.logger,
      });

      const operationResult: OperationResult = {
        runId: result.runId,
        status: result.status,
        artifacts: result.artifacts,
        report: {
          calibration: {
            stopReason: result.stopReason,
            bestSnapshotIndex: result.bestSnapshotIndex,
            bestMismatchRatio: result.bestMismatchRatio,
            rounds: result.rounds.map((r) => ({
              round: r.round,
              accepted: r.accepted,
              improvement: r.improvement,
              reason: r.reason,
            })),
          },
        },
      };
      return operationResult;
    },
    batch: async (options: BatchOptions) => {
      const result = await runBatch({
        manifest: options.manifest,
        ...(options.strict === undefined ? {} : { strict: options.strict }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        logger: instanceConfig.logger,
        executor: {
          extract: async (task) =>
            api.extract({
              input: task.input,
              output: task.output,
              ...(task.overwrite === undefined ? {} : { overwrite: task.overwrite }),
              ...(task.layout === undefined ? {} : { layout: task.layout }),
            }),
          render: async (task) =>
            api.render({
              template: task.template,
              ...(task.strict === undefined ? {} : { strict: task.strict }),
              ...(task.mode === undefined ? {} : { mode: task.mode }),
              ...(task.overflow === undefined ? {} : { overflow: task.overflow }),
              ...(task.format === undefined ? {} : { format: task.format }),
            }),
          validate: async (task) =>
            api.validate({
              bundle: task.bundle,
              ...(task.strict === undefined ? {} : { strict: task.strict }),
            }),
        },
      });

      const operationResult: BatchResult = {
        runId: result.runId,
        status: result.status,
        artifacts: result.artifacts,
        report: {
          batch: {
            summaryFile: result.summaryFile,
            summary: {
              pass: result.taskResults.filter((r) => r.status === "pass").length,
              needs_review: result.taskResults.filter((r) => r.status === "needs_review").length,
              failed: result.taskResults.filter((r) => r.status === "failed").length,
            },
            tasks: result.taskResults,
          },
        },
        tasks: result.taskResults.map((task) => ({
          runId: result.runId,
          status: task.status,
          artifacts: task.artifacts,
          report: { batchTask: task },
        })),
      };
      return operationResult;
    },
  };

  return api;
}
