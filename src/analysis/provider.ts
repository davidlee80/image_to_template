/**
 * 视觉识别 provider 接口（T03）。
 *
 * 实施计划 T03 步骤 3：将图像识别封装为 provider，输入为图片、尺寸、
 * schema 与提示词版本，输出为受校验 SceneSpec、原始响应及调用统计；
 * 提供 fixture provider；公开类型支持宿主替换实现。
 *
 * A 阶段失败即停：不悄悄修复坐标或填造文本（T03 步骤 6）。
 */

import { ImageTemplateError } from "../errors.js";
import type { RegionSpec } from "./regions.js";
import type { SceneIssue, SceneSpec } from "../schemas/scene.js";

/** 识别请求。 */
export interface VisionRequest {
  /** 标准化后的 PNG 图像字节。 */
  image: Uint8Array;
  /** 图像尺寸（与字节一致，作为坐标基准写入提示词）。 */
  width: number;
  height: number;
  /** 目标结构的 JSON Schema（嵌入提示词）。 */
  jsonSchema: Record<string, unknown>;
  /** 提示词版本（与缓存键关联）。 */
  promptVersion: string;
  /**
   * 自定义系统提示词（T09 分区识别）；省略时使用内置整页场景提示词。
   * 提示词内容必须与 promptVersion 对应。
   */
  systemPrompt?: string;
  /** 中止信号。 */
  signal?: AbortSignal;
}

/** 单次调用统计。 */
export interface VisionCallStats {
  /** 模型 ID。 */
  model: string;
  /** provider 名称。 */
  provider: string;
  /** 请求耗时（毫秒）。 */
  durationMs: number;
  /** usage（如 API 返回；fixture 为空）。 */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/** 识别成功结果：受校验输出 + 原始响应 + 统计。
 * spec 类型由 promptVersion 决定：场景提示词 → SceneSpec；
 * 区域划分提示词（REGIONS_PROMPT_VERSION）→ RegionSpec。 */
export interface VisionSuccess {
  ok: true;
  spec: SceneSpec | RegionSpec;
  /** 模型原始输出（已解析为对象；调试用途单独落盘，不进日志）。 */
  raw: unknown;
  stats: VisionCallStats;
}

/** 识别失败结果。 */
export interface VisionFailure {
  ok: false;
  /** 失败类别：HTTP / 完成状态 / 空输出 / JSON 解析 / schema 或几何。 */
  reason:
    | "http_error"
    | "incomplete"
    | "refusal"
    | "empty_output"
    | "json_parse"
    | "schema";
  message: string;
  /** schema/几何失败时的具体 issue 列表。 */
  issues?: SceneIssue[];
  /** HTTP 状态码（http_error）。 */
  httpStatus?: number;
  /** 是否网络暂态可重试（B 阶段重试策略使用；A 阶段失败即停）。 */
  retryable: boolean;
  stats?: VisionCallStats;
}

export type VisionResult = VisionSuccess | VisionFailure;

/** 视觉识别 provider 配置（SDK 公开配置形态）。 */
export interface VisionProviderConfig {
  /** provider 类型：openai-http（默认 HTTP 实现）或 fixture。 */
  kind: "openai-http" | "fixture";
  /** 模型 ID（如账号可用的视觉模型）。 */
  model: string;
  /** API 密钥；fixture provider 不需要。 */
  apiKey?: string;
  /** API 基地址；默认 https://api.openai.com/v1。 */
  baseUrl?: string;
  /** 请求超时（毫秒）；默认 180_000（设计文档 T03 步骤 6）。 */
  timeoutMs?: number;
  /** 图片细节级别；默认 high（设计文档）。 */
  detail?: "low" | "high" | "auto";
  /** fixture 模式的模型响应文件（kind=fixture 时必填）；
   * 字符串=单一响应；记录=按提示词版本映射（分区识别多调用）。 */
  fixtureFile?: string | Record<string, string>;
}

/** 视觉识别 provider。 */
export interface VisionProvider {
  readonly name: string;
  analyze(request: VisionRequest): Promise<VisionResult>;
}

/** provider 工厂：宿主可注入替换实现。 */
export type VisionProviderFactory = (
  config: VisionProviderConfig,
) => VisionProvider;

/** 将 VisionFailure 转为类型化错误（CLI/流水线边界使用）。 */
export function visionFailureToError(
  failure: VisionFailure,
  runId?: string,
): ImageTemplateError {
  const code =
    failure.reason === "http_error"
      ? "PROVIDER_ERROR"
      : failure.reason === "schema"
        ? "INVALID_ARGUMENT"
        : "PROVIDER_ERROR";

  return new ImageTemplateError({
    code,
    stage: "extract",
    message: `识别失败（${failure.reason}）：${failure.message}`,
    ...(runId === undefined ? {} : { runId }),
    retryable: failure.retryable,
  });
}
