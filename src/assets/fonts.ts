/**
 * 固定字体管理与嵌入式 @font-face（T05）。
 *
 * 实施计划 T05 步骤 1：
 * - 从字体 manifest 读取 sans/serif/latin 与实际字重，构建嵌入式 @font-face；
 * - 验证文件存在、哈希和声明字重；
 * - 诊断模式允许字体回退但报告 missingFont；严格模式缺失即失败（由调用方决策）。
 * - 不让浏览器无提示地合成缺失字重：未提供的 (slot, weight) 不声明 @font-face，
 *   并显式报告，浏览器按回退栈渲染，行为可诊断。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { ImageTemplateError } from "../errors.js";
import { sha256Of } from "../io/image.js";

/** 单个字体槽位。 */
export interface FontSlot {
  slot: string;
  familyAlias: string;
  weights: string[];
  /** 字重 → 字体文件描述。 */
  files: Record<string, FontFileRef | string>;
  status?: string;
  notes?: string;
}

/** 字体文件引用：包内相对路径 + 可选哈希与格式。 */
export interface FontFileRef {
  file: string;
  sha256?: string;
  /** 字体格式提示（CSS format()）；默认 woff2。 */
  format?: string;
  /** 来源与授权记录（manifest 内声明）。 */
  source?: string;
  license?: string;
}

export interface FontsManifest {
  version: string;
  fontSlots: FontSlot[];
  missingItems?: string[];
}

export interface FontRequirement {
  /** SceneSpec 的 fontFamily 类别：sans / serif / latin。 */
  slot: string;
  weight: string;
}

export interface LoadedFontFace {
  slot: string;
  familyAlias: string;
  weight: string;
  file: string;
  sha256: string;
  /** 字体文件字节（已读取，供 base64 嵌入）。 */
  bytes: Buffer;
}

export interface MissingFont {
  slot: string;
  weight: string;
  reason:
    | "no_manifest"
    | "no_slot"
    | "no_file"
    | "file_missing"
    | "hash_mismatch";
  message: string;
}

export interface FontFaceCssResult {
  /** 嵌入式 @font-face CSS（仅含实际存在的字体）。 */
  css: string;
  loaded: LoadedFontFace[];
  missing: MissingFont[];
}

/** 解析文件引用（兼容 string 与对象两种写法）。 */
function fileRefOf(value: FontFileRef | string): FontFileRef {
  return typeof value === "string" ? { file: value } : value;
}

/** 读取模板包 fonts/manifest.json。 */
export async function readFontsManifest(
  bundleDir: string,
  stage: "extract" | "render" = "render",
): Promise<FontsManifest> {
  const manifestFile = path.join(bundleDir, "fonts", "manifest.json");
  try {
    const value = JSON.parse(await readFile(manifestFile, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray(value.fontSlots)
    ) {
      throw new TypeError("fontSlots 必须是数组");
    }
    return value as FontsManifest;
  } catch (error) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage,
      message: `无法读取字体 manifest：${manifestFile}（${(error as Error).message}）`,
      cause: error,
    });
  }
}

/**
 * 构建模板所需字体的嵌入式 @font-face CSS。
 * 只为 required 中实际存在的 (slot, weight) 生成声明；缺失项进入 missing。
 * manifest 不存在时全部记为 no_manifest（诊断回退；严格模式由调用方失败）。
 */
export async function buildFontFaces(
  bundleDir: string,
  required: FontRequirement[],
): Promise<FontFaceCssResult> {
  let manifest: FontsManifest;
  try {
    manifest = await readFontsManifest(bundleDir);
  } catch (error) {
    if (
      error instanceof ImageTemplateError &&
      (error.message.includes("不存在") || error.message.includes("ENOENT"))
    ) {
      return {
        css: "",
        loaded: [],
        missing: required.map((r) => ({
          slot: r.slot,
          weight: r.weight,
          reason: "no_manifest" as const,
          message: `模板包缺少 fonts/manifest.json（槽位 ${r.slot}，字重 ${r.weight}）：诊断模式回退系统字体，严格模式将失败`,
        })),
      };
    }
    throw error;
  }

  const slots = new Map(manifest.fontSlots.map((slot) => [slot.slot, slot]));

  const loaded: LoadedFontFace[] = [];
  const missing: MissingFont[] = [];
  const seen = new Set<string>();

  for (const { slot: slotName, weight } of required) {
    const key = `${slotName}:${weight}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const slot = slots.get(slotName);
    if (slot === undefined) {
      missing.push({
        slot: slotName,
        weight,
        reason: "no_slot",
        message: `字体槽位 ${slotName} 不在 manifest 中`,
      });
      continue;
    }

    const rawRef = slot.files[weight];
    if (rawRef === undefined) {
      missing.push({
        slot: slotName,
        weight,
        reason: "no_file",
        message: `字体槽位 ${slotName} 未提供 ${weight} 字重文件（manifest 声明的字重：${slot.weights.join(", ")}）`,
      });
      continue;
    }

    const ref = fileRefOf(rawRef);
    const fontDir = path.join(bundleDir, "fonts");
    const fontFile = path.join(fontDir, ref.file);

    let bytes: Buffer;
    try {
      bytes = await readFile(fontFile);
    } catch {
      missing.push({
        slot: slotName,
        weight,
        reason: "file_missing",
        message: `字体文件不存在：fonts/${ref.file}（槽位 ${slotName}，字重 ${weight}）`,
      });
      continue;
    }

    const actualHash = sha256Of(bytes);
    if (ref.sha256 !== undefined && ref.sha256 !== actualHash) {
      missing.push({
        slot: slotName,
        weight,
        reason: "hash_mismatch",
        message: `字体文件哈希不匹配：fonts/${ref.file}（期望 ${ref.sha256}，实际 ${actualHash}）`,
      });
      continue;
    }

    loaded.push({
      slot: slotName,
      familyAlias: slot.familyAlias,
      weight,
      file: `fonts/${ref.file}`,
      sha256: actualHash,
      bytes,
    });
  }

  const css = loaded
    .map((font) => {
      const ref = fileRefOf(
        (slots.get(font.slot)?.files ?? {})[font.weight] ?? font.file,
      );
      const format = ref.format ?? "woff2";
      return `
@font-face {
  font-family: "${font.familyAlias}";
  src: url(data:font/${format};base64,${font.bytes.toString("base64")})
       format("${format}");
  font-weight: ${font.weight};
  font-style: normal;
  font-display: block;
}`;
    })
    .join("\n");

  return { css, loaded, missing };
}

/** 模板实际需要的字体需求（按 text 元素的 fontFamily/weight 收集去重）。 */
export function fontRequirementsOf(
  elements: Array<{ type: string; fontFamily?: string; fontWeight?: string }>,
): FontRequirement[] {
  const requirements: FontRequirement[] = [];
  const seen = new Set<string>();

  for (const element of elements) {
    if (element.type !== "text") {
      continue;
    }
    const slot = element.fontFamily ?? "sans";
    const weight = element.fontWeight ?? "400";
    const key = `${slot}:${weight}`;
    if (!seen.has(key)) {
      seen.add(key);
      requirements.push({ slot, weight });
    }
  }

  return requirements;
}
