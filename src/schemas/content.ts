/**
 * MVP 内容（content.json）校验与内容 JSON Schema 生成。
 *
 * 实施计划 T02：
 * - MVP 内容为 Record<textId, string>；内容键与 text 元素 ID 一一对应；
 * - 缺失必填键报错，未知键提示（warning，不阻断），空字符串是有效的主动编辑；
 * - 长度约束从显式策略读取：不能仅按原文长度限制编辑，
 *   也不能把通过 schema 校验当成没有溢出（溢出由布局检查负责，T06）。
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  textElementsOf,
  type SceneSpec,
  type TextElement,
} from "./scene.js";

/** 内容校验问题：与 SceneIssue 同构。 */
export interface ContentIssue {
  code: "SCHEMA" | "MISSING_CONTENT_KEY" | "UNKNOWN_CONTENT_KEY";
  path: string;
  message: string;
  elementId?: string;
}

export interface ContentParseSuccess {
  ok: true;
  content: Record<string, string>;
  /** 未知键等提示，不阻断。 */
  warnings: ContentIssue[];
}

export interface ContentParseFailure {
  ok: false;
  issues: ContentIssue[];
  warnings: ContentIssue[];
}

export type ContentParseResult = ContentParseSuccess | ContentParseFailure;

/** 内容形态：MVP 为 Record<textId, string>。 */
export type SceneContent = Record<string, string>;

const contentValueSchema = z.record(z.string(), z.string());

/**
 * 校验内容与 SceneSpec 的一致性。
 * 空字符串是有效的主动编辑（清空文本），不视为缺失。
 */
export function parseSceneContent(
  spec: SceneSpec,
  value: unknown,
): ContentParseResult {
  const warnings: ContentIssue[] = [];

  const schemaResult = contentValueSchema.safeParse(value);
  if (!schemaResult.success) {
    return {
      ok: false,
      warnings,
      issues: schemaResult.error.issues.map((issue) => ({
        code: "SCHEMA" as const,
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: `content 必须是 Record<textId, string>：${issue.message}`,
      })),
    };
  }

  const content = schemaResult.data;
  const textIds = new Set(textElementsOf(spec).map((element) => element.id));
  const issues: ContentIssue[] = [];

  for (const id of textIds) {
    if (!(id in content)) {
      issues.push({
        code: "MISSING_CONTENT_KEY",
        path: id,
        elementId: id,
        message: `缺少必填内容键：${id}（对应 text 元素；空字符串也是有效值）`,
      });
    }
  }

  for (const key of Object.keys(content)) {
    if (!textIds.has(key)) {
      warnings.push({
        code: "UNKNOWN_CONTENT_KEY",
        path: key,
        message: `内容键 ${key} 没有对应的 text 元素（可能来自已删除或重命名的元素）`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, warnings };
  }

  return { ok: true, content, warnings };
}

/** 内容长度约束的显式策略。 */
export interface ContentLengthPolicy {
  /**
   * - "unbounded"：不限制长度（默认；溢出交由布局检查报告）；
   * - "absolute"：所有键统一 maxLength；
   * - "relative"：maxLength = 原文长度 × relativeFactor + extraAllowance。
   */
  strategy: "unbounded" | "absolute" | "relative";
  /** strategy = "absolute" 时必填。 */
  absoluteMaxLength?: number;
  /** strategy = "relative" 时必填，≥ 1。 */
  relativeFactor?: number;
  /** strategy = "relative" 时额外字符数，默认 0。 */
  extraAllowance?: number;
}

export const defaultContentLengthPolicy: ContentLengthPolicy = {
  strategy: "unbounded",
};

/** 计算单个 text 元素在给定策略下的 maxLength；undefined 表示不限制。 */
export function maxLengthForTextElement(
  element: TextElement,
  policy: ContentLengthPolicy,
): number | undefined {
  switch (policy.strategy) {
    case "unbounded":
      return undefined;
    case "absolute": {
      const max = policy.absoluteMaxLength;
      if (max === undefined || !Number.isInteger(max) || max < 0) {
        throw new TypeError(
          "ContentLengthPolicy.strategy=absolute 需要 absoluteMaxLength（非负整数）",
        );
      }
      return max;
    }
    case "relative": {
      const factor = policy.relativeFactor;
      if (factor === undefined || factor < 1) {
        throw new TypeError(
          "ContentLengthPolicy.strategy=relative 需要 relativeFactor（≥ 1）",
        );
      }
      const allowance = policy.extraAllowance ?? 0;
      return Math.ceil(element.text.length * factor + allowance);
    }
  }
}

/** 构建与 SceneSpec 对应的 zod 内容 schema（缺失必填键报错、未知键放行并提示）。 */
export function buildContentZodSchema(
  spec: SceneSpec,
  policy: ContentLengthPolicy = defaultContentLengthPolicy,
): z.ZodType<SceneContent> {
  const shape: Record<string, z.ZodString> = {};

  for (const element of textElementsOf(spec)) {
    const maxLength = maxLengthForTextElement(element, policy);
    shape[element.id] =
      maxLength === undefined
        ? z.string()
        : z.string().max(maxLength, `内容长度超过策略上限 ${maxLength}`);
  }

  return z.object(shape).passthrough();
}

export interface ContentJsonSchemaResult {
  /** JSON Schema 对象（zod-to-json-schema 产物）。 */
  jsonSchema: Record<string, unknown>;
  /** 生成时使用的策略（随 manifest 记录，保证可追溯）。 */
  policy: ContentLengthPolicy;
}

/** 生成 content.schema.json 内容（与模板 schema 分开，不能互相替代）。 */
export function buildContentJsonSchema(
  spec: SceneSpec,
  policy: ContentLengthPolicy = defaultContentLengthPolicy,
): ContentJsonSchemaResult {
  const zodSchema = buildContentZodSchema(spec, policy);
  const jsonSchema = zodToJsonSchema(zodSchema, {
    $refStrategy: "none",
  }) as Record<string, unknown>;

  return { jsonSchema, policy };
}

/** 将部分编辑覆盖到基准内容上；未知键同样产生提示。 */
export function mergeSceneContent(
  spec: SceneSpec,
  base: SceneContent,
  override: Record<string, unknown>,
): ContentParseResult {
  const merged: SceneContent = { ...base };
  const warnings: ContentIssue[] = [];
  const textIds = new Set(textElementsOf(spec).map((element) => element.id));

  const overrideResult = contentValueSchema.safeParse(override);
  if (!overrideResult.success) {
    return {
      ok: false,
      warnings,
      issues: overrideResult.error.issues.map((issue) => ({
        code: "SCHEMA" as const,
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: `覆盖内容必须是 Record<textId, string>：${issue.message}`,
      })),
    };
  }

  for (const [key, value] of Object.entries(overrideResult.data)) {
    merged[key] = value;
    if (!textIds.has(key)) {
      warnings.push({
        code: "UNKNOWN_CONTENT_KEY",
        path: key,
        message: `覆盖内容键 ${key} 没有对应的 text 元素`,
      });
    }
  }

  // 合并结果仍需满足"必填键齐全"约束。
  return parseSceneContent(spec, merged);
}
