/**
 * OpenAI Responses API 视觉识别 provider（T03）。
 *
 * 请求结构已对照 2026-10 官方文档（developers.openai.com/api/docs/guides/images-vision
 * 与 structured-outputs）核对：
 * - 端点 POST {baseUrl}/responses；
 * - 图片以 input_image + data URL（base64）传入，detail 可选 low/high/auto；
 * - JSON 模式 text.format = { type: "json_object" }（仅保证合法 JSON，
 *   schema 一致性由本模块 zod 校验保证）；
 * - 完成/拒绝/截断通过 response.status、refusal、incomplete_details 判定。
 *
 * 真实调用验收在 T08；fixture provider 支持离线测试。
 */

import { readFile } from "node:fs/promises";

import {
  parseSceneSpec,
  type SceneIssue,
  type SceneSpec,
} from "../schemas/scene.js";
import {
  parseRegionSpec,
  type RegionSpec,
  type RegionDefinition,
} from "./regions.js";
import {
  REGIONS_PROMPT_VERSION,
  SCENE_USER_INSTRUCTION,
  buildScenePrompt,
} from "./prompts.js";
import type {
  VisionProvider,
  VisionProviderConfig,
  VisionRequest,
  VisionResult,
  VisionCallStats,
} from "./provider.js";

export type { VisionProviderConfig } from "./provider.js";

/** OpenAI HTTP provider 选项。 */
export interface OpenAIVisionOptions {
  model: string;
  apiKey: string;
  /** 默认 https://api.openai.com/v1 */
  baseUrl?: string;
  /** 默认 180_000（设计文档 T03 步骤 6）。 */
  timeoutMs?: number;
  /** 默认 high。 */
  detail?: "low" | "high" | "auto";
  /** 注入测试用 fetch（默认全局 fetch）。 */
  fetchImpl?: typeof fetch;
}

/** 根据配置创建 provider 实例（工厂入口，宿主可替换）。 */
export function createVisionProvider(
  config: VisionProviderConfig,
  fetchImpl?: typeof fetch,
): VisionProvider {
  if (config.kind === "fixture") {
    if (config.fixtureFile === undefined) {
      throw new Error("VisionProviderConfig.kind=fixture 需要 fixtureFile");
    }
    return createFixtureVisionProvider(config.fixtureFile);
  }

  if (config.apiKey === undefined) {
    throw new Error("VisionProviderConfig.kind=openai-http 需要 apiKey");
  }

  return createOpenAIVisionProvider({
    model: config.model,
    apiKey: config.apiKey,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.detail === undefined ? {} : { detail: config.detail }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

/** 组合用户 signal 与超时 signal；任一触发即中止。 */
function combinedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) {
      clearTimeout(timer);
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Responses API 响应中提取全部输出文本。 */
function extractOutputText(response: unknown): {
  text: string;
  refused: boolean;
} {
  const output = (response as { output?: unknown[] }).output;
  if (!Array.isArray(output)) {
    return { text: "", refused: false };
  }

  let text = "";
  let refused = false;

  for (const item of output) {
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      const partType = (part as { type?: string }).type;
      if (partType === "output_text") {
        text += (part as { text?: string }).text ?? "";
      } else if (partType === "refusal") {
        refused = true;
      }
    }
  }

  return { text, refused };
}

function stats(
  provider: string,
  model: string,
  startedAt: number,
  usage?: Record<string, unknown>,
): VisionCallStats {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  const totalTokens = usage?.total_tokens;
  return {
    provider,
    model,
    durationMs: Date.now() - startedAt,
    usage: {
      ...(typeof inputTokens === "number" ? { promptTokens: inputTokens } : {}),
      ...(typeof outputTokens === "number"
        ? { completionTokens: outputTokens }
        : {}),
      ...(typeof totalTokens === "number" ? { totalTokens } : {}),
    },
  };
}

/** OpenAI Responses API provider。 */
export function createOpenAIVisionProvider(
  options: OpenAIVisionOptions,
): VisionProvider {
  const {
    model,
    apiKey,
    baseUrl = "https://api.openai.com/v1",
    timeoutMs = 180_000,
    detail = "high",
    fetchImpl = fetch,
  } = options;

  const providerName = `openai-responses:${model}`;

  return {
    name: providerName,

    async analyze(request: VisionRequest): Promise<VisionResult> {
      const startedAt = Date.now();

      const systemPrompt =
        request.systemPrompt ??
        buildScenePrompt({
          width: request.width,
          height: request.height,
          jsonSchema: request.jsonSchema,
        });

      const base64 = Buffer.from(request.image).toString("base64");

      const body = {
        model,
        input: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "input_text", text: SCENE_USER_INSTRUCTION },
              {
                type: "input_image",
                image_url: `data:image/png;base64,${base64}`,
                detail,
              },
            ],
          },
        ],
        text: { format: { type: "json_object" } },
      };

      const { signal, cleanup } = combinedSignal(request.signal, timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        cleanup();
        const aborted =
          request.signal?.aborted === true ||
          (error as Error).name === "AbortError";
        return {
          ok: false,
          reason: "http_error",
          message: aborted
            ? "请求被中止或超时"
            : `网络请求失败：${(error as Error).message}`,
          retryable: !aborted,
        };
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        cleanup();
        // 5xx 与 429 视为可重试暂态；4xx 参数/鉴权错误不重试。
        const retryable = response.status >= 500 || response.status === 429;
        return {
          ok: false,
          reason: "http_error",
          httpStatus: response.status,
          message: `模型请求失败：HTTP ${response.status}${errorText ? `：${errorText.slice(0, 500)}` : ""}`,
          retryable,
        };
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        cleanup();
        return {
          ok: false,
          reason: "json_parse",
          message: `响应不是合法 JSON：${(error as Error).message}`,
          retryable: false,
        };
      }

      cleanup();
      const callStats = stats(
        providerName,
        model,
        startedAt,
        (parsed as { usage?: Record<string, unknown> }).usage,
      );

      // 完成状态校验
      const status = (parsed as { status?: string }).status;
      if (status === "incomplete") {
        const reason = (
          (parsed as { incomplete_details?: { reason?: string } })
            .incomplete_details ?? {}
        ).reason;
        return {
          ok: false,
          reason: "incomplete",
          message: `模型输出未正常结束：${reason ?? "unknown"}`,
          retryable: false,
          stats: callStats,
        };
      }

      const { text, refused } = extractOutputText(parsed);

      if (refused) {
        return {
          ok: false,
          reason: "refusal",
          message: "模型拒绝了本次请求（refusal）",
          retryable: false,
          stats: callStats,
        };
      }

      if (text.trim() === "") {
        return {
          ok: false,
          reason: "empty_output",
          message: "模型没有返回模板内容",
          retryable: false,
          stats: callStats,
        };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        return {
          ok: false,
          reason: "json_parse",
          message: `模型输出不是合法 JSON：${(error as Error).message}`,
          retryable: false,
          stats: callStats,
        };
      }

      const specResult = parseSceneSpec(raw);
      if (!specResult.ok) {
        return {
          ok: false,
          reason: "schema",
          message: specResult.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("；"),
          issues: specResult.issues,
          retryable: false,
          stats: callStats,
        };
      }

      return {
        ok: true,
        spec: specResult.spec,
        raw,
        stats: callStats,
      };
    },
  };
}

/**
 * Fixture provider：从 JSON 文件读取"模型输出"并走同一校验链路。
 * - 传字符串：单一响应文件（所有提示词版本共用）；
 * - 传记录：按 promptVersion 映射响应文件（分区识别多调用场景）。
 */
export function createFixtureVisionProvider(
  fixture: string | Record<string, string>,
): VisionProvider {
  return {
    name: "fixture",
    async analyze(request: VisionRequest): Promise<VisionResult> {
      const startedAt = Date.now();
      const fixtureFile =
        typeof fixture === "string"
          ? fixture
          : (fixture[request.promptVersion] ??
            fixture["*"] ??
            Object.values(fixture)[0]);

      if (fixtureFile === undefined) {
        return {
          ok: false,
          reason: "empty_output",
          message: `fixture 未提供 ${request.promptVersion} 的响应文件`,
          retryable: false,
        };
      }

      const text = await readFile(fixtureFile, "utf8");
      const raw: unknown = JSON.parse(text);
      const callStats: VisionCallStats = {
        provider: "fixture",
        model: "fixture",
        durationMs: Date.now() - startedAt,
      };

      const specResult =
        request.promptVersion === REGIONS_PROMPT_VERSION
          ? parseRegionSpec(raw)
          : parseSceneSpec(raw);
      if (!specResult.ok) {
        const issues: Array<{ path: string; message: string }> = specResult.issues.map(
          (issue) => ({
            path: Array.isArray(issue.path) ? issue.path.join(".") : issue.path,
            message: issue.message,
          }),
        );
        return {
          ok: false,
          reason: "schema",
          message: issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("；"),
          ...(request.promptVersion === REGIONS_PROMPT_VERSION
            ? {}
            : { issues: specResult.issues as SceneIssue[] }),
          retryable: false,
          stats: callStats,
        };
      }

      const spec = specResult.spec;
      return { ok: true, spec, raw, stats: callStats };
    },
  };
}
