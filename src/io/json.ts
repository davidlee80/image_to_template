/**
 * 统一 JSON 读写（UTF-8、原子写入）与 schema 错误路径格式化。
 *
 * 实施计划 T02 步骤 6：统一 JSON 读写、schema 错误路径、阶段错误信息及原子写入。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ImageTemplateError, type SdkStage } from "../errors.js";

function ioError(stage: SdkStage, message: string, cause?: unknown): ImageTemplateError {
  return new ImageTemplateError({
    code: "IO_ERROR",
    stage,
    message,
    retryable: false,
    cause,
  });
}

/** 读取并解析 JSON 文件；文件不存在或内容非法时抛类型化 IO 错误（带路径）。 */
export async function readJsonFile(
  file: string,
  stage: SdkStage,
): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw ioError(
      stage,
      code === "ENOENT"
        ? `文件不存在：${file}`
        : `读取文件失败：${file}（${code ?? "未知错误"}）`,
      error,
    );
  }

  // 去 BOM（历史编辑器可能写入 BOM；内容判定不以控制台显示为准）
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  try {
    return JSON.parse(stripped);
  } catch (error) {
    throw ioError(stage, `JSON 解析失败：${file}（${(error as Error).message}）`, error);
  }
}

/** 读文本文件（UTF-8，去 BOM）。 */
export async function readTextFile(
  file: string,
  stage: SdkStage,
): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw ioError(
      stage,
      code === "ENOENT"
        ? `文件不存在：${file}`
        : `读取文件失败：${file}（${code ?? "未知错误"}）`,
      error,
    );
  }
}

/**
 * 原子写入 JSON 文件：先写临时文件再 rename；UTF-8 无 BOM、末尾换行。
 * 失败时清理临时文件，不留半成品。
 */
export async function writeJsonFileAtomic(
  file: string,
  value: unknown,
  stage: SdkStage,
): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeTextFileAtomic(file, json, stage);
}

/**
 * 原子写入文本文件：临时文件 + rename。
 * 截图等二进制产物同样使用"临时文件后原子替换"策略（T06）。
 */
export async function writeTextFileAtomic(
  file: string,
  text: string,
  stage: SdkStage,
): Promise<void> {
  const directory = path.dirname(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw ioError(stage, `写入文件失败：${file}（${(error as Error).message}）`, error);
  }
}

/** 格式化 schema/几何 issue 列表为单条可读消息（保留路径）。 */
export function formatIssues(
  issues: Array<{ path: string; message: string }>,
): string {
  return issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("；");
}

/**
 * 内容规范化哈希：键排序后序列化再 SHA-256。
 * 同一内容不论键序如何哈希一致；仅纯正文变更改变哈希（模板变更不影响）。
 */
export function canonicalContentHash(
  content: Record<string, string>,
): string {
  const keys = Object.keys(content).sort();
  const canonical = keys
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(content[key])}`)
    .join(",");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
