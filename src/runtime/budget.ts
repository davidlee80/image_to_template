/**
 * 共享调用预算与有限重试（T10 步骤 3～4）。
 *
 * 实施计划：
 * - 重试区分网络暂态、非法输出和语义低置信度；
 * - 所有尝试计入同一全局调用上限，避免多层重试叠加；
 * - 低置信度阈值先按设计设 0.7，符合条件的区域最多补识别一次；
 * - 预算耗尽即停止（D 阶段校准共享同一预算）。
 */

import { ImageTemplateError } from "../errors.js";
import type { VisionFailure } from "../analysis/provider.js";

/** 低置信度阈值（设计初始值 0.7；策略参数，T10 真实评估后校准）。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export interface BudgetConfig {
  /** 最大请求数（含重试；跨识别/OCR/校准共享）。 */
  maxRequests: number;
  /** 总耗时预算（毫秒）；可选。 */
  timeoutMs?: number;
}

/** 预算耗尽错误。 */
export class BudgetExhaustedError extends ImageTemplateError {
  constructor(message: string) {
    super({
      code: "PROVIDER_ERROR",
      stage: "extract",
      message,
      retryable: false,
    });
    this.name = "BudgetExhaustedError";
  }
}

/** 全局调用预算：请求数与总时长。 */
export class CallBudget {
  private requests = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly config: BudgetConfig) {}

  /** 记录一次请求；超预算抛 BudgetExhaustedError。 */
  recordRequest(label: string): void {
    this.requests += 1;
    if (this.requests > this.config.maxRequests) {
      throw new BudgetExhaustedError(
        `调用预算耗尽（${label}）：已发起 ${this.requests - 1}/${this.config.maxRequests} 次请求`,
      );
    }
    if (
      this.config.timeoutMs !== undefined &&
      Date.now() - this.startedAt > this.config.timeoutMs
    ) {
      throw new BudgetExhaustedError(
        `时间预算耗尽（${label}）：已耗时 ${Date.now() - this.startedAt}ms / ${this.config.timeoutMs}ms`,
      );
    }
  }

  /** 剩余可用请求数。 */
  get remainingRequests(): number {
    return Math.max(0, this.config.maxRequests - this.requests);
  }

  get usedRequests(): number {
    return this.requests;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get exhausted(): boolean {
    return (
      this.remainingRequests <= 0 ||
      (this.config.timeoutMs !== undefined &&
        this.elapsedMs > this.config.timeoutMs)
    );
  }
}

/** 重试分类。 */
export type RetryCategory =
  | "network_transient"
  | "invalid_output"
  | "low_confidence"
  | "fatal";

/**
 * 失败分类（T10 步骤 4）：
 * - network_transient：HTTP 5xx/429/网络错误（可重试）；
 * - invalid_output：JSON 解析失败/结构非法（有限重试一次）；
 * - low_confidence：语义低置信度（走区域补识别，不在同层重试）；
 * - fatal：拒绝/截断/空输出/参数错误（不重试）。
 */
export function classifyFailure(failure: VisionFailure): RetryCategory {
  switch (failure.reason) {
    case "http_error":
      return failure.retryable ? "network_transient" : "fatal";
    case "json_parse":
    case "schema":
      return "invalid_output";
    case "incomplete":
    case "refusal":
    case "empty_output":
      return "fatal";
  }
}

export interface RetryPolicy {
  /** 网络暂态最大重试次数；默认 1。 */
  maxNetworkRetries?: number;
  /** 非法输出最大重试次数；默认 1。 */
  maxInvalidOutputRetries?: number;
}

export interface RetryAttempt {
  attempt: number;
  /** 本次分类（成功时为 undefined）。 */
  category?: RetryCategory;
  failure?: VisionFailure;
}

/**
 * 带预算与分类的有限重试执行。
 * 所有尝试（含失败）计入同一预算；返回最终结果与尝试记录。
 */
export async function executeWithRetry<T>(
  operation: () => Promise<
    { ok: true; value: T } | { ok: false; failure: VisionFailure }
  >,
  options: {
    budget: CallBudget;
    label: string;
    policy?: RetryPolicy;
    logger?: (message: string) => void;
  },
): Promise<{
  ok: boolean;
  value?: T;
  failure?: VisionFailure;
  attempts: RetryAttempt[];
  totalRequests: number;
}> {
  const {
    budget,
    label,
    policy = {},
    logger,
  } = options;
  const maxNetworkRetries = policy.maxNetworkRetries ?? 1;
  const maxInvalidOutputRetries = policy.maxInvalidOutputRetries ?? 1;

  const attempts: RetryAttempt[] = [];
  let networkRetries = 0;
  let invalidRetries = 0;
  let totalRequests = 0;

  // 语义低置信度不属于执行失败：调用方在拿到结果后按阈值处理
  let attempt = 0;
  // 最多尝试 1 + 各类重试上限 + 1（保险）
  while (attempt <= 1 + maxNetworkRetries + maxInvalidOutputRetries) {
    budget.recordRequest(`${label} 第 ${attempt + 1} 次尝试`);
    totalRequests += 1;

    const result = await operation();
    if (result.ok) {
      attempts.push({ attempt });
      return { ok: true, value: result.value, attempts, totalRequests };
    }

    const category = classifyFailure(result.failure);
    attempts.push({ attempt, category, failure: result.failure });

    const canRetry =
      (category === "network_transient" && networkRetries < maxNetworkRetries) ||
      (category === "invalid_output" && invalidRetries < maxInvalidOutputRetries);

    if (!canRetry) {
      return {
        ok: false,
        failure: result.failure,
        attempts,
        totalRequests,
      };
    }

    if (category === "network_transient") {
      networkRetries += 1;
      logger?.(
        `网络暂态失败，重试（${label}，第 ${networkRetries}/${maxNetworkRetries} 次）`,
      );
    } else if (category === "invalid_output") {
      invalidRetries += 1;
      logger?.(
        `输出非法，重试（${label}，第 ${invalidRetries}/${maxInvalidOutputRetries} 次）`,
      );
    }

    attempt += 1;
  }

  // 理论不可达
  return {
    ok: false,
    failure: {
      ok: false,
      reason: "empty_output",
      message: "重试次数耗尽",
      retryable: false,
    },
    attempts,
    totalRequests,
  };
}
