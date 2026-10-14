/**
 * SDK 类型化错误。
 *
 * 约定（实施计划 2.3 / 设计文档第九章）：
 * - 可诊断的质量失败通过操作结果的 `status: "failed"` 报告，不抛异常；
 * - 无法形成诊断的执行错误（参数、I/O、provider、超时、取消等）抛出
 *   本错误类型，至少携带 code / stage / message / runId（如已分配）/ retryable；
 * - SDK 内部不得抛出裸 Error 之外的类型给调用方。
 */

/** 抛出错误时所处的操作阶段。 */
export type SdkStage =
  | "config"
  | "extract"
  | "render"
  | "compare"
  | "validate"
  | "calibrate"
  | "batch"
  | "cli";

/** 公开错误码；CLI 按同一集合映射退出码。 */
export type SdkErrorCode =
  | "NOT_IMPLEMENTED"
  | "INVALID_CONFIG"
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED"
  | "UNSUPPORTED_VERSION"
  | "IO_ERROR"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "ABORTED"
  | "CONFLICT";

export interface ImageTemplateErrorInit {
  code: SdkErrorCode;
  stage: SdkStage;
  message: string;
  /** 已分配的运行 ID；未分配时省略。 */
  runId?: string;
  /** 网络暂态、可重试的 provider 故障等设为 true；默认 false。 */
  retryable?: boolean;
  /** 原始错误（如 Node.js 系统错误）。 */
  cause?: unknown;
}

/** SDK 对外抛出的唯一错误类型。 */
export class ImageTemplateError extends Error {
  readonly code: SdkErrorCode;
  readonly stage: SdkStage;
  readonly runId?: string;
  readonly retryable: boolean;

  constructor(init: ImageTemplateErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "ImageTemplateError";
    this.code = init.code;
    this.stage = init.stage;
    this.runId = init.runId;
    this.retryable = init.retryable ?? false;
  }

  /** CLI `--json` 与日志使用的结构化形式。 */
  toJSON(): {
    name: string;
    code: SdkErrorCode;
    stage: SdkStage;
    message: string;
    runId?: string;
    retryable: boolean;
  } {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      message: this.message,
      ...(this.runId === undefined ? {} : { runId: this.runId }),
      retryable: this.retryable,
    };
  }
}

/** 判断未知错误是否为本 SDK 的类型化错误。 */
export function isImageTemplateError(
  error: unknown,
): error is ImageTemplateError {
  return error instanceof ImageTemplateError;
}
