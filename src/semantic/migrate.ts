/**
 * 内容迁移（T11 步骤 5～6）：模板包从 SceneSpec 1.0 迁移到 LayoutSpec 2.0。
 *
 * 实施计划：
 * - 输出 scene.json（原始定位基准）、layout.json（语义布局）、结构化 content
 *   及旧 ID 到新绑定映射；
 * - 保留旧 content 快照，版本化迁移且可回退；
 * - JSON 形态改变会改变内容哈希：必须通过映射验证文字与素材逐项未变，
 *   再登记迁移后的原始内容基线及父版本；不能仅因为新旧哈希不同就取消
 *   原文 replica 对比，也不能未经验证直接重设基准；
 * - 通用 reader/render 继续支持 SceneSpec 1.0（不破坏已交付模板）。
 */

import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ImageTemplateError } from "../errors.js";
import { readJsonFile, writeJsonFileAtomic, canonicalContentHash } from "../io/json.js";
import { readSceneBundle } from "../io/bundle.js";
import {
  compileSceneToLayout,
  type CompiledStructuredContent,
  type IdMappingEntry,
} from "./compile.js";
import { parseLayoutSpec, type LayoutSpec } from "../schemas/layout.js";

export interface MigrationResult {
  ok: true;
  /** 迁移记录。 */
  migration: {
    /** 迁移时间。 */
    migratedAt: string;
    /** 迁移前模板版本（SceneSpec 包的 templateVersion）。 */
    parentTemplateVersion: number;
    /** 迁移前内容版本。 */
    parentContentVersion: number;
    /** 迁移前原始内容哈希（MVP 形态）。 */
    parentContentHash: string;
    /** 迁移后原始内容哈希（结构化形态，同一正文）。 */
    migratedContentHash: string;
    /** 逐项验证结论。 */
    verification: {
      /** 验证通过（全部文字与素材逐项一致）。 */
      passed: boolean;
      /** 核对项数。 */
      textCount: number;
      assetCount: number;
      /** 不一致项（验证失败时存在）。 */
      mismatches: Array<{ id: string; kind: "text" | "asset"; detail: string }>;
    };
  };
  /** 产物清单（相对包目录）。 */
  artifacts: string[];
}

export interface MigrationFailure {
  ok: false;
  issues: Array<{ path: string; message: string }>;
}

export type MigrationOutcome = MigrationResult | MigrationFailure;

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/**
 * 迁移模板包（就地）。步骤：
 * 1. 读取 SceneSpec 1.0 模板包（template.json + content.json）；
 * 2. 编译为 LayoutSpec + 结构化内容；
 * 3. 逐项验证文字与素材未变（映射核对）；
 * 4. 验证通过后：保存 scene.json 基准、layout.json、结构化 content、
 *    旧内容快照与迁移记录；验证失败则不修改任何文件。
 */
export async function migrateBundle(
  bundleDir: string,
): Promise<MigrationOutcome> {
  const dir = path.resolve(bundleDir);
  const startedAt = new Date().toISOString();

  // 已迁移检查：layout.json 存在则拒绝重复迁移
  if (await fileExists(path.join(dir, "layout.json"))) {
    return {
      ok: false,
      issues: [
        {
          path: "layout.json",
          message: "模板包已迁移到 LayoutSpec 2.0：不重复迁移（回退请先 rollbackMigration）",
        },
      ],
    };
  }

  const bundle = await readSceneBundle(dir, "render");

  // manifest 版本
  let parentTemplateVersion = 1;
  let parentContentVersion = 1;
  let parentContentHash = "";
  const manifestFile = path.join(dir, "manifest.json");
  if (await fileExists(manifestFile)) {
    const manifest = (await readJsonFile(manifestFile, "render")) as {
      templateVersion?: number;
      contentVersion?: number;
      originalContentSha256?: string;
    };
    parentTemplateVersion = manifest.templateVersion ?? 1;
    parentContentVersion = manifest.contentVersion ?? 1;
    parentContentHash = manifest.originalContentSha256 ?? "";
  }

  // 编译
  const compiled = compileSceneToLayout({
    scene: bundle.spec,
    content: bundle.content,
  });
  if (!compiled.ok) {
    return {
      ok: false,
      issues: compiled.issues,
    };
  }

  // ---- 逐项验证：文字与素材未变 ----
  const mismatches: MigrationResult["migration"]["verification"]["mismatches"] =
    [];

  for (const mapping of compiled.idMappings) {
    if (mapping.toBinding.startsWith("texts.")) {
      const expected = bundle.content[mapping.fromId] ?? "";
      const actual = compiled.content.texts[mapping.fromId];
      if (actual !== expected) {
        mismatches.push({
          id: mapping.fromId,
          kind: "text",
          detail: `正文不一致：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
        });
      }
    }
  }

  for (const element of bundle.spec.elements) {
    if (element.type !== "image") {
      continue;
    }
    const migrated = compiled.content.assets[element.id];
    if (migrated === undefined) {
      mismatches.push({
        id: element.id,
        kind: "asset",
        detail: "素材在迁移后内容中缺失",
      });
    } else if (migrated.src !== element.src) {
      mismatches.push({
        id: element.id,
        kind: "asset",
        detail: `素材 src 不一致：期望 ${element.src}，实际 ${migrated.src}`,
      });
    }
  }

  const textCount = Object.keys(compiled.content.texts).length;
  const assetCount = Object.keys(compiled.content.assets).length;

  if (mismatches.length > 0) {
    // 验证失败：不修改任何文件
    return {
      ok: false,
      issues: mismatches.map((m) => ({
        path: m.kind === "text" ? `texts.${m.id}` : `assets.${m.id}`,
        message: `迁移验证失败：${m.detail}`,
      })),
    };
  }

  // ---- 验证通过：写产物 ----
  const migratedContentHash = canonicalContentHash(
    compiled.content.texts as Record<string, string>,
  );

  // scene.json：原始定位基准（template.json 副本语义）
  await writeJsonFileAtomic(
    path.join(dir, "scene.json"),
    bundle.spec,
    "render",
  );

  // layout.json：语义布局
  await writeJsonFileAtomic(
    path.join(dir, "layout.json"),
    compiled.layout,
    "render",
  );

  // 旧内容快照（content.json → content.legacy.json）
  await writeJsonFileAtomic(
    path.join(dir, "content.legacy.json"),
    bundle.content,
    "render",
  );

  // 结构化 content.json（新形态）
  await writeJsonFileAtomic(
    path.join(dir, "content.json"),
    compiled.content,
    "render",
  );

  // content.schema.json（结构化约束）
  await writeJsonFileAtomic(
    path.join(dir, "content.schema.json"),
    compiled.contentJsonSchema,
    "render",
  );

  // id-mappings.json：旧 ID → 新绑定
  await writeJsonFileAtomic(
    path.join(dir, "id-mappings.json"),
    compiled.idMappings,
    "render",
  );

  // migration.json：迁移记录（含验证证据与父版本）
  const migration: MigrationResult["migration"] = {
    migratedAt: startedAt,
    parentTemplateVersion,
    parentContentVersion,
    parentContentHash,
    migratedContentHash,
    verification: {
      passed: true,
      textCount,
      assetCount,
      mismatches: [],
    },
  };
  await writeJsonFileAtomic(
    path.join(dir, "migration.json"),
    migration,
    "render",
  );

  // manifest 更新：模板版本 +1（结构变化）；登记迁移基线
  if (await fileExists(manifestFile)) {
    const manifest = (await readJsonFile(manifestFile, "render")) as Record<
      string,
      unknown
    >;
    const updated = {
      ...manifest,
      templateVersion: parentTemplateVersion + 1,
      /** 迁移后原始内容基线（同正文的结构化形态哈希）。 */
      originalContentSha256: migratedContentHash,
      /** 父版本基线保留（replica 对比基准链）。 */
      parentOriginalContentSha256:
        parentContentHash === "" ? undefined : parentContentHash,
      migration: {
        from: { templateVersion: parentTemplateVersion, contentVersion: parentContentVersion },
        verifiedTexts: textCount,
        verifiedAssets: assetCount,
        migratedAt: startedAt,
      },
    };
    await writeJsonFileAtomic(manifestFile, updated, "render");
  }

  return {
    ok: true,
    migration,
    artifacts: [
      "scene.json",
      "layout.json",
      "content.legacy.json",
      "content.json",
      "content.schema.json",
      "id-mappings.json",
      "migration.json",
      "manifest.json",
    ],
  };
}

/**
 * 回退迁移：恢复 content.legacy.json 为 content.json、移除 LayoutSpec 产物、
 * 还原 manifest 版本。迁移记录保留在 migration.rollback.json 供审计。
 */
export async function rollbackMigration(
  bundleDir: string,
): Promise<{ ok: true } | MigrationFailure> {
  const dir = path.resolve(bundleDir);

  if (!(await fileExists(path.join(dir, "migration.json")))) {
    return {
      ok: false,
      issues: [{ path: "migration.json", message: "模板包没有迁移记录，无法回退" }],
    };
  }

  const migration = (await readJsonFile(
    path.join(dir, "migration.json"),
    "render",
  )) as MigrationResult["migration"];

  // 恢复旧内容
  const legacyFile = path.join(dir, "content.legacy.json");
  if (!(await fileExists(legacyFile))) {
    return {
      ok: false,
      issues: [
        { path: "content.legacy.json", message: "旧内容快照缺失，无法回退" },
      ],
    };
  }
  const legacyContent = await readJsonFile(legacyFile, "render");
  await writeJsonFileAtomic(
    path.join(dir, "content.json"),
    legacyContent,
    "render",
  );

  // 移除迁移产物（保留 migration 记录为 rollback 审计）
  for (const file of [
    "layout.json",
    "content.schema.json",
    "id-mappings.json",
    "scene.json",
    "content.legacy.json",
  ]) {
    await rm(path.join(dir, file), { force: true });
  }

  // migration.json → migration.rollback.json
  await rename(path.join(dir, "migration.json"), path.join(dir, "migration.rollback.json"));

  // manifest 还原版本与基线
  const manifestFile = path.join(dir, "manifest.json");
  if (await fileExists(manifestFile)) {
    const manifest = (await readJsonFile(manifestFile, "render")) as Record<
      string,
      unknown
    >;
    const updated: Record<string, unknown> = {
      ...manifest,
      templateVersion: migration.parentTemplateVersion,
      originalContentSha256:
        migration.parentContentHash || manifest.originalContentSha256,
    };
    delete updated.parentOriginalContentSha256;
    delete updated.migration;
    await writeJsonFileAtomic(manifestFile, updated, "render");
  }

  return { ok: true };
}

/** 读取迁移后的 LayoutSpec（供渲染入口按版本分发）。 */
export async function readLayoutSpec(
  bundleDir: string,
): Promise<LayoutSpec> {
  const file = path.join(bundleDir, "layout.json");
  const value = await readJsonFile(file, "render");
  const result = parseLayoutSpec(value);
  if (!result.ok) {
    throw new ImageTemplateError({
      code: "UNSUPPORTED_VERSION",
      stage: "render",
      message: `layout.json 校验失败：${result.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("；")}`,
    });
  }
  return result.spec;
}

/** 读取结构化内容（迁移后形态）。 */
export async function readStructuredContent(
  bundleDir: string,
): Promise<CompiledStructuredContent> {
  return (await readJsonFile(
    path.join(bundleDir, "content.json"),
    "render",
  )) as CompiledStructuredContent;
}

export type { IdMappingEntry };
