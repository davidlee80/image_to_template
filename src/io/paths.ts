/**
 * 模板包资源路径边界。
 *
 * 实施计划 T02 步骤 5：本地资源只允许模板包内相对路径；
 * 验证绝对路径、`..`、盘符/UNC、真实路径和符号链接越界；
 * 拒绝 URL。模板资源始终以包目录为根（计划 2.3）。
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

import { ImageTemplateError, type SdkStage } from "../errors.js";
import { unsafeRelativePathReason } from "../schemas/scene.js";

export class UnsafeAssetPathError extends ImageTemplateError {
  constructor(stage: SdkStage, relative: string, reason: string) {
    super({
      code: "INVALID_ARGUMENT",
      stage,
      message: `资源路径越界：${relative}（${reason}）`,
    });
    this.name = "UnsafeAssetPathError";
  }
}

/**
 * 校验并解析模板包内相对资源路径为绝对路径。
 * 只做词法检查（无 I/O）：拒绝空、URL/协议、盘符、UNC、绝对路径与 `..` 段。
 */
export function resolveAssetPath(
  bundleRoot: string,
  relative: string,
  stage: SdkStage,
): string {
  const reason = unsafeRelativePathReason(relative);
  if (reason !== null) {
    throw new UnsafeAssetPathError(stage, relative, reason);
  }

  const root = path.resolve(bundleRoot);
  const target = path.resolve(root, relative);

  const rel = path.relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new UnsafeAssetPathError(
      stage,
      relative,
      "解析后越出模板包根目录",
    );
  }

  return target;
}

/**
 * 在词法检查之上再做真实路径（realpath）检查：
 * 拒绝符号链接指向模板包之外的资源。
 * 资源文件必须已存在（realpath 会失败并抛 IO_ERROR）。
 */
export async function resolveAssetPathReal(
  bundleRoot: string,
  relative: string,
  stage: SdkStage,
): Promise<string> {
  const target = resolveAssetPath(bundleRoot, relative, stage);

  let rootReal: string;
  let targetReal: string;
  try {
    [rootReal, targetReal] = await Promise.all([
      realpath(path.resolve(bundleRoot)),
      realpath(target),
    ]);
  } catch (error) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage,
      message: `资源不存在或无法解析真实路径：${relative}（${(error as Error).message}）`,
      cause: error,
    });
  }

  const rel = path.relative(rootReal, targetReal);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new UnsafeAssetPathError(
      stage,
      relative,
      "真实路径（含符号链接）越出模板包根目录",
    );
  }

  return targetReal;
}
