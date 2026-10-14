/**
 * 严格交付检查与模板版本管理（T16）。
 *
 * 实施计划：
 * - 用 validate 汇总 schema、绑定、几何、正文完整性、字体覆盖/加载、
 *   图片加载、溢出及遮挡阻断项；本地检查不执行对外发布；
 * - 区分 pass / needs_review / failed：结构非法、资源缺失、正文被裁切等
 *   为 failed；低置信度和复杂遮挡为 needs_review；
 * - reviewItems 用稳定 ID 记录人工结论及绑定的模板/内容哈希；
 *   变化后相关结论失效，不能继续沿用旧确认；
 * - 模板版本和内容版本独立维护；font/assets/theme 变更纳入模板哈希，
 *   纯正文变更只更新内容版本；
 * - 提供模板包导出/重载及完整 manifest，验证离线渲染不依赖原分析服务。
 */

import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import type { Logger } from "../sdk.js";
import { ImageTemplateError } from "../errors.js";
import { readJsonFile, writeJsonFileAtomic, canonicalContentHash } from "../io/json.js";
import { readSceneBundle } from "../io/bundle.js";
import { reportSchemaVersion, type ReviewItem } from "../schemas/report.js";
import { newRunId } from "../pipeline/extract.js";
import { runRender } from "../pipeline/render.js";
import {
  readBundleVersions,
  hashBundleFile,
} from "../runtime/versions.js";

/** validate 选项。 */
export interface ValidateOptions {
  bundleDir: string;
  /** 严格策略：阻断项与未决复查项都计入 failed。 */
  strict?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
  runId?: string;
}

/** validate 结果报告（report.json 合并写入 validate 段）。 */
export interface ValidateReport {
  runId: string;
  status: "pass" | "needs_review" | "failed";
  /** 阻断项（结构/资源/正文裁切/字体/图片/溢出）。 */
  blockers: Array<{
    source: string;
    code: string;
    message: string;
    elementId?: string;
  }>;
  /** 待复查项（低置信度、复杂遮挡等；strict 下计入 failed）。 */
  reviewItems: ReviewItem[];
  /** 复查结论有效性核对（哈希绑定）。 */
  resolutions: {
    /** 有效（哈希匹配）的已处理结论数。 */
    valid: number;
    /** 失效（模板/内容已变化）的结论数；失效即回退为 pending。 */
    stale: number;
  };
  /** 版本与哈希登记。 */
  versions: {
    templateVersion: number;
    contentVersion: number;
    /** 模板哈希（template.json + fonts + assets 结构）。 */
    templateSha256: string;
    /** 内容规范化哈希。 */
    contentSha256: string;
  };
  artifacts: string[];
}

/** 复查结论登记文件（history/resolutions.json）。 */
interface ResolutionRecord {
  /** 复查项稳定 ID。 */
  itemId: string;
  status: "accepted" | "dismissed";
  note?: string;
  resolvedAt: string;
  /** 结论绑定的模板哈希。 */
  templateSha256: string;
  /** 结论绑定的内容哈希。 */
  contentSha256: string;
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** 计算模板哈希：template.json + assets 清单 + fonts manifest（结构变更纳入）。 */
async function computeTemplateHash(
  bundleDir: string,
): Promise<string> {
  const parts: Buffer[] = [];

  const templateFile = path.join(bundleDir, "template.json");
  if (await fileExists(templateFile)) {
    parts.push(await readFile(templateFile));
  }

  // assets：文件名 + 哈希（内容变更纳入模板哈希）
  const assetsDir = path.join(bundleDir, "assets");
  if (await fileExists(assetsDir)) {
    const { readdir } = await import("node:fs/promises");
    for (const name of (await readdir(assetsDir)).sort()) {
      const bytes = await readFile(path.join(assetsDir, name));
      const digest = createHash("sha256").update(bytes).digest("hex");
      parts.push(Buffer.from(`${name}:${digest}`));
    }
  }

  // fonts manifest
  const fontsManifest = path.join(bundleDir, "fonts", "manifest.json");
  if (await fileExists(fontsManifest)) {
    parts.push(await readFile(fontsManifest));
  }

  const canonical = Buffer.concat(parts);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * 执行严格交付检查：
 * 1. 结构（template/content schema 走 readSceneBundle / parseLayoutSpec）；
 * 2. 渲染 --strict（阻断溢出/遮挡/资源失败/字体缺失/DOM 正文核对）；
 * 3. 复查结论哈希绑定核对（失效结论回退 pending）；
 * 4. 版本与哈希登记（validate 段写入 report）。
 */
export async function runValidate(
  options: ValidateOptions,
): Promise<ValidateReport> {
  const runId = options.runId ?? newRunId();
  const bundleDir = path.resolve(options.bundleDir);
  const strict = options.strict === true;

  options.logger?.("交付检查", { dir: bundleDir, strict });

  const blockers: ValidateReport["blockers"] = [];

  // ---- 结构校验（SceneSpec：readSceneBundle；LayoutSpec：render 内分发）----
  let content: Record<string, string> | undefined;
  try {
    const bundle = await readSceneBundle(bundleDir, "validate");
    content = bundle.content;
  } catch (error) {
    if (isStructureError(error)) {
      // 结构非法 → failed（LayoutSpec 包走 render 分发校验；此处只登记 SceneSpec 结构失败）
      blockers.push({
        source: "schema",
        code: "INVALID_TEMPLATE",
        message: (error as Error).message,
      });
    } else {
      throw error;
    }
  }

  // ---- 渲染检查（诊断模式渲染：阻断项从 findings 提取，不因字体缺失误判 failed；
  //      字体缺失进入复查项，strict 策略下由下方分类规则计入 failed）----
  let renderReviewItems: ReviewItem[] = [];
  let renderOk = true;
  try {
    const render = await runRender({
      bundleDir,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      logger: options.logger,
      runId,
    });
    renderReviewItems = render.reviewItems;

    // 阻断级 findings（文字越出画布、图片加载失败、DOM 正文不一致等）
    const renderBlockers = render.findings.filter((f) => f.severity === "blocker");
    if (renderBlockers.length > 0) {
      renderOk = false;
      for (const finding of renderBlockers) {
        blockers.push({
          source: "render",
          code: finding.code,
          message: finding.message,
          ...(finding.elementId === undefined
            ? {}
            : { elementId: finding.elementId }),
        });
      }
    }
  } catch (error) {
    // 渲染执行失败（素材缺失、LayoutSpec 校验失败等）→ failed
    renderOk = false;
    blockers.push({
      source: "render",
      code: isImageTemplateErrorCode(error, "IO_ERROR") ? "RESOURCE_MISSING" : "RENDER_ERROR",
      message: (error as Error).message,
    });
  }

  // ---- 版本与哈希 ----
  const versions = await readBundleVersions(bundleDir, "validate");
  const templateSha256 = await computeTemplateHash(bundleDir);
  const contentSha256 =
    content !== undefined
      ? canonicalContentHash(content)
      : await hashBundleFile(bundleDir, "content.json").catch(() => "");

  // ---- 复查结论哈希绑定核对 ----
  const resolutionsFile = path.join(bundleDir, "history", "resolutions.json");
  let resolutionRecords: ResolutionRecord[] = [];
  if (await fileExists(resolutionsFile)) {
    resolutionRecords = (await readJsonFile(resolutionsFile, "validate")) as ResolutionRecord[];
  }

  let validResolutions = 0;
  let staleResolutions = 0;
  const staleIds = new Set<string>();
  for (const record of resolutionRecords) {
    if (
      record.templateSha256 === templateSha256 &&
      record.contentSha256 === contentSha256
    ) {
      validResolutions += 1;
    } else {
      staleResolutions += 1;
      staleIds.add(record.itemId);
    }
  }

  // 渲染复查项 + 失效结论回退 pending 的标记
  const reviewItems: ReviewItem[] = [
    ...renderReviewItems,
    ...[...staleIds].map((itemId) => ({
      id: `resolution-stale:${itemId}`,
      type: "resolution_stale",
      severity: strict ? ("blocker" as const) : ("warning" as const),
      message: `复查结论 ${itemId} 已失效（模板或内容哈希已变化）：不能继续沿用旧确认，需重新处理`,
      resolution: { status: "pending" as const },
    })),
  ];

  // ---- 分类（T16 步骤 2）----
  let status: ValidateReport["status"];
  if (blockers.length > 0 || !renderOk) {
    status = "failed";
  } else if (
    reviewItems.some((i) => i.severity === "blocker") ||
    (strict && reviewItems.length > 0)
  ) {
    status = strict ? "failed" : "needs_review";
  } else if (reviewItems.length > 0) {
    status = "needs_review";
  } else {
    status = "pass";
  }

  // ---- report 合并写入（validate 段）----
  const reportFile = path.join(bundleDir, "report.json");
  const existingReport = (await fileExists(reportFile)
    ? ((await readJsonFile(reportFile, "validate")) as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const finishedAt = new Date().toISOString();
  const mergedReport = {
    ...existingReport,
    schemaVersion: reportSchemaVersion,
    run: {
      ...((existingReport.run as Record<string, unknown>) ?? {}),
      runId,
      stage: "validate" as const,
      status,
      startedAt: finishedAt,
      finishedAt,
      templateHash: templateSha256,
      contentHash: contentSha256,
    },
    validate: {
      strict,
      blockers,
      resolutions: { valid: validResolutions, stale: staleResolutions },
      versions: {
        ...versions,
        templateSha256,
        contentSha256,
      },
    },
    reviewItems,
  };
  await writeJsonFileAtomic(reportFile, mergedReport, "validate");

  options.logger?.("交付检查完成", { status, blockers: blockers.length });

  return {
    runId,
    status,
    blockers,
    reviewItems,
    resolutions: { valid: validResolutions, stale: staleResolutions },
    versions: {
      ...versions,
      templateSha256,
      contentSha256,
    },
    artifacts: [reportFile],
  };
}

/** 结构错误判定（schema 类 INVALID_ARGUMENT）。 */
function isStructureError(error: unknown): boolean {
  return (
    error instanceof ImageTemplateError && error.code === "INVALID_ARGUMENT"
  );
}

function isImageTemplateErrorCode(error: unknown, code: string): boolean {
  return error instanceof ImageTemplateError && error.code === code;
}

/** 登记复查结论（哈希绑定；模板/内容变化后失效）。 */
export async function recordResolution(
  bundleDir: string,
  resolution: {
    itemId: string;
    status: "accepted" | "dismissed";
    note?: string;
  },
): Promise<void> {
  const dir = path.resolve(bundleDir);
  const resolutionsFile = path.join(dir, "history", "resolutions.json");

  const templateSha256 = await computeTemplateHash(dir);
  let contentSha256 = "";
  try {
    const bundle = await readSceneBundle(dir, "validate");
    contentSha256 = canonicalContentHash(bundle.content);
  } catch {
    contentSha256 = await hashBundleFile(dir, "content.json").catch(() => "");
  }

  let records: ResolutionRecord[] = [];
  if (await fileExists(resolutionsFile)) {
    records = (await readJsonFile(resolutionsFile, "validate")) as ResolutionRecord[];
  }

  // 同 ID 旧结论替换（保留最新）
  records = records.filter((r) => r.itemId !== resolution.itemId);
  records.push({
    itemId: resolution.itemId,
    status: resolution.status,
    ...(resolution.note === undefined ? {} : { note: resolution.note }),
    resolvedAt: new Date().toISOString(),
    templateSha256,
    contentSha256,
  });

  await mkdir(path.dirname(resolutionsFile), { recursive: true });
  await writeJsonFileAtomic(resolutionsFile, records, "validate");
}

/**
 * 导出完整模板包（供迁移/重载验证）：复制受管文件到目标目录。
 * 不含模型响应调试文件与缓存；manifest 保持完整。
 */
export async function exportBundle(
  bundleDir: string,
  targetDir: string,
): Promise<{ files: string[] }> {
  const source = path.resolve(bundleDir);
  const target = path.resolve(targetDir);

  if (await fileExists(target)) {
    throw new ImageTemplateError({
      code: "CONFLICT",
      stage: "validate",
      message: `导出目标目录已存在：${target}（不覆盖已有内容）`,
    });
  }

  await mkdir(target, { recursive: true });

  const managedFiles = [
    "reference.png",
    "template.json",
    "content.json",
    "content.schema.json",
    "manifest.json",
    "layout.json",
    "scene.json",
    "id-mappings.json",
    "migration.json",
    "content.legacy.json",
    "preview.html",
    "preview.png",
    "preview.pdf",
    "report.json",
  ];
  const managedDirs = ["assets", "fonts", "pages"];

  const copied: string[] = [];
  for (const file of managedFiles) {
    const from = path.join(source, file);
    if (await fileExists(from)) {
      await writeFile(path.join(target, file), await readFile(from));
      copied.push(file);
    }
  }
  for (const dir of managedDirs) {
    const from = path.join(source, dir);
    if (await fileExists(from)) {
      await cp(from, path.join(target, dir), { recursive: true });
      copied.push(`${dir}/`);
    }
  }

  return { files: copied };
}

/**
 * 重载校验：导出包在新位置可完整读取并通过结构校验
 * （离线渲染不依赖原分析服务的验证入口）。
 */
export async function reloadBundleCheck(
  bundleDir: string,
): Promise<{ ok: boolean; issues: string[] }> {
  const dir = path.resolve(bundleDir);
  const issues: string[] = [];

  for (const required of ["template.json", "content.json"]) {
    if (!(await fileExists(path.join(dir, required)))) {
      issues.push(`缺少必需文件：${required}`);
    }
  }

  try {
    const bundle = await readSceneBundle(dir, "validate");
    // 内容键与模板 text ID 一一对应（readSceneBundle 已校验）
    void bundle;
  } catch (error) {
    issues.push((error as Error).message);
  }

  return { ok: issues.length === 0, issues };
}

/** 临时导出目录帮助函数（测试与 T18 使用）。 */
export async function exportBundleToTemp(
  bundleDir: string,
): Promise<{ dir: string; files: string[] }> {
  const tempRoot = await mkdtemp(path.join(path.sep === "/" ? "/tmp" : process.env.TEMP ?? ".", "itt-export-"));
  const target = path.join(tempRoot, "bundle");
  const result = await exportBundle(bundleDir, target);
  return { dir: target, files: result.files };
}

/** 清理临时导出目录。 */
export async function cleanupTempExport(dir: string): Promise<void> {
  await rm(path.dirname(dir), { recursive: true, force: true }).catch(() => undefined);
}
