/**
 * CLI 层环境变量 → SDK 显式配置的转换（T03 步骤 5）。
 *
 * 实施计划 2.3：SDK 不隐式加载 .env、不读取环境；
 * 环境变量只在 CLI 层转换为显式配置。
 */

import type { VisionProviderConfig } from "./analysis/vision.js";

/** 从环境变量构造视觉 provider 配置；缺少任一必需变量返回 undefined。 */
export function visionConfigFromEnv(env: {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}): VisionProviderConfig | undefined {
  const { OPENAI_API_KEY: apiKey, OPENAI_MODEL: model } = env;
  if (!apiKey || !model) {
    return undefined;
  }
  return { kind: "openai-http", model, apiKey };
}
