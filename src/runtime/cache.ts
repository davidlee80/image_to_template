/**
 * 识别缓存（T10 步骤 5～6）。
 *
 * 实施计划：
 * - 缓存键至少包含标准化图片/裁剪图哈希、区域与缩放、提示词版本、
 *   schema 版本、模型 ID、provider 参数及 OCR 配置；
 *   字体变化使渲染缓存失效，但无需重新 OCR（渲染缓存由键中的 kind 区分）；
 * - 缓存原始输出与通过校验的结果；失败和截断响应不可作为成功命中；
 * - 重读仍验证版本/schema（get 返回条目，调用方负责校验；
 *   ok=false 的条目只作诊断记录，不命中）。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { ImageTemplateError } from "../errors.js";

/** 缓存条目类型。 */
export type CacheKind = "vision" | "regions" | "region-scene" | "ocr" | "render";

/** 缓存键输入（各字段全部参与键计算）。 */
export interface CacheKeyInput {
  kind: CacheKind;
  /** 标准化图片或裁剪图的 SHA-256。 */
  imageSha256: string;
  /** 区域 ID（整页识别为 undefined）。 */
  region?: string;
  /** 区域缩放倍数。 */
  scale?: number;
  /** 提示词版本。 */
  promptVersion: string;
  /** schema 版本（如 scene "1.0"）。 */
  schemaVersion: string;
  /** 模型 ID 或 OCR provider 名。 */
  model: string;
  /** provider 参数（超时、detail 等）。 */
  providerParams?: Record<string, unknown>;
  /** OCR 配置（provider 参数差异使缓存失效）。 */
  ocrConfig?: Record<string, unknown>;
}

/** 稳定序列化：键排序。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** 计算缓存键（SHA-256）。 */
export function cacheKeyOf(input: CacheKeyInput): string {
  return createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

/** 缓存条目。 */
export interface CacheEntry {
  key: string;
  kind: CacheKind;
  createdAt: string;
  /** 调用是否成功且通过校验（false 只作诊断记录，不命中）。 */
  ok: boolean;
  /** 模型/provider 原始输出。 */
  raw: unknown;
  /** 通过校验的结果（ok=true 时存在）。 */
  validated?: unknown;
}

export interface CacheHit {
  entry: CacheEntry;
  /** 命中的条目是否为本次之前写入。 */
  hit: true;
}

/** 文件系统响应缓存（.cache/<key>.json）。 */
export class ResponseCache {
  constructor(private readonly dir: string) {}

  private fileOf(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  /** 读取条目；仅 ok=true 视为命中。 */
  async get(key: string): Promise<CacheHit | null> {
    let text: string;
    try {
      text = await readFile(this.fileOf(key), "utf8");
    } catch {
      return null;
    }

    let entry: CacheEntry;
    try {
      entry = JSON.parse(text) as CacheEntry;
    } catch {
      // 损坏条目：删除并视为未命中
      await rm(this.fileOf(key), { force: true }).catch(() => undefined);
      return null;
    }

    if (entry.key !== key || entry.ok !== true) {
      return null;
    }

    return { entry, hit: true };
  }

  /** 写入条目（含失败记录：ok=false 不参与命中）。 */
  async put(entry: CacheEntry): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });

      // 临时文件 + rename 原子写入
      const file = this.fileOf(entry.key);
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
      const { rename } = await import("node:fs/promises");
      await rename(tmp, file);
    } catch (error) {
      throw new ImageTemplateError({
        code: "IO_ERROR",
        stage: "extract",
        message: `缓存写入失败（${entry.kind}）：${(error as Error).message}`,
        cause: error,
      });
    }
  }
}
