/**
 * 模板包（bundle）读取与输出目录管理。
 *
 * 实施计划 T02 步骤 6：
 * - 输出目录已存在时默认拒绝覆盖（CONFLICT）；
 * - 明确 --overwrite 后只替换受管产物，不递归删除整个目录。
 *
 * 模板包结构（A 阶段）：reference.png、template.json、content.json、
 * content.schema.json、manifest.json、assets/、fonts/、preview.html/png、
 * diff.png、overlay.png、report.json（manifest 哈希与版本记录在 T04/T07 扩展）。
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ImageTemplateError, type SdkStage } from "../errors.js";
import {
  formatSceneIssues,
  parseSceneSpec,
  type SceneSpec,
} from "../schemas/scene.js";
import {
  formatIssues,
  readJsonFile,
} from "./json.js";
import {
  parseSceneContent,
  type ContentIssue,
  type SceneContent,
} from "../schemas/content.js";

/** 模板包内由本模块管理的产物文件（--overwrite 只替换这些）。 */
export const managedBundleFiles = [
  "reference.png",
  "template.json",
  "content.json",
  "content.schema.json",
  "manifest.json",
  "preview.html",
  "preview.png",
  "diff.png",
  "overlay.png",
  "report.json",
] as const;

/** 模板包内由本模块管理的产物目录。 */
export const managedBundleDirs = ["assets", "fonts"] as const;

export interface PrepareOutputOptions {
  /** 明确允许覆盖：只替换受管产物，保留目录内其他文件。 */
  overwrite?: boolean;
}

/**
 * 准备模板包输出目录。
 * - 不存在：创建；
 * - 存在且未显式 overwrite：抛 CONFLICT；
 * - 存在且 overwrite：移除受管产物（文件与目录），保留其余内容。
 */
export async function prepareBundleOutputDir(
  dir: string,
  options: PrepareOutputOptions,
  stage: SdkStage,
): Promise<void> {
  let exists: boolean;
  try {
    await stat(dir);
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    await mkdir(dir, { recursive: true });
    return;
  }

  if (options.overwrite !== true) {
    throw new ImageTemplateError({
      code: "CONFLICT",
      stage,
      message: `输出目录已存在：${dir}（如确认覆盖受管产物，请显式指定 overwrite/--overwrite；不会删除目录内其他文件）`,
    });
  }

  // 只替换受管产物；目录内其他文件保持原样。
  const entries = new Set(await readdir(dir));
  for (const file of managedBundleFiles) {
    if (entries.has(file)) {
      await rm(path.join(dir, file), { force: true });
    }
  }
  for (const subDir of managedBundleDirs) {
    if (entries.has(subDir)) {
      await rm(path.join(dir, subDir), { recursive: true, force: true });
    }
  }
}

/** 读取并校验后的 SceneSpec 模板包。 */
export interface SceneBundle {
  /** 模板包根目录。 */
  dir: string;
  spec: SceneSpec;
  content: SceneContent;
  /** 内容校验的提示（未知键等），不阻断。 */
  contentWarnings: ContentIssue[];
}

/**
 * 读取模板包核心文件（template.json + content.json）并校验。
 * 结构非法、键缺失抛 INVALID_ARGUMENT（带具体路径信息）。
 */
export async function readSceneBundle(
  dir: string,
  stage: SdkStage,
): Promise<SceneBundle> {
  const templateFile = path.join(dir, "template.json");
  const templateValue = await readJsonFile(templateFile, stage);

  const specResult = parseSceneSpec(templateValue);
  if (!specResult.ok) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage,
      message: `模板校验失败（${templateFile}）：${formatSceneIssues(specResult.issues)}`,
    });
  }

  const contentFile = path.join(dir, "content.json");
  const contentValue = await readJsonFile(contentFile, stage);

  const contentResult = parseSceneContent(specResult.spec, contentValue);
  if (!contentResult.ok) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage,
      message: `内容校验失败（${contentFile}）：${formatIssues(contentResult.issues)}`,
    });
  }

  return {
    dir: path.resolve(dir),
    spec: specResult.spec,
    content: contentResult.content,
    contentWarnings: contentResult.warnings,
  };
}
