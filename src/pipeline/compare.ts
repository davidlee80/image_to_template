/**
 * 对比流水线（T07）：模板包 preview vs reference → 差异图/叠图/报告合并。
 *
 * 实施计划 T07 步骤 3～4：
 * - 在同一份报告中合并 compare 数据；render 后的旧对比分数已随报告重写失效；
 * - 原始内容哈希写入 manifest（T04）；仅同内容、同画布、replica 可直接和原图比较；
 * - 编辑后默认跳过原图差异（applicable=false，记录原因，不保留旧 mismatchRatio）；
 *   显式 compare 发现内容不一致时失败，除非提供新的匹配基准。
 */

import path from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";

import type { Logger } from "../sdk.js";
import { ImageTemplateError } from "../errors.js";
import { readSceneBundle } from "../io/bundle.js";
import {
  canonicalContentHash,
  readJsonFile,
  writeJsonFileAtomic,
} from "../io/json.js";
import {
  compareRgbaImages,
  loadRgba,
  DEFAULT_COMPARE_PARAMS,
  defaultEvalRegions,
  scoreRegions,
  type ImageComparison,
  type RegionScore,
} from "../quality/compare.js";
import { reportSchemaVersion } from "../schemas/report.js";
import { newRunId } from "./extract.js";

export interface ComparePipelineOptions {
  /** 模板包目录。 */
  bundleDir: string;
  /**
   * 新的匹配基准图片路径（可选）：
   * 内容已编辑但用户提供了与当前内容匹配的基准时使用。
   */
  reference?: string;
  /** 内容已改变时仍强制对比（发现不一致时 failed）。 */
  force?: boolean;
  signal?: AbortSignal;
  logger?: Logger;
  runId?: string;
}

export interface ComparePipelineResult {
  runId: string;
  status: "pass" | "needs_review" | "failed";
  bundleDir: string;
  artifacts: string[];
  report: Record<string, unknown>;
  /** 对比是否实际执行。 */
  applicable: boolean;
  /** 不适用原因（applicable=false 时）。 */
  skippedReason?: string;
  mismatchRatio?: number;
}

interface BundleManifest {
  originalContentSha256?: string;
  input?: { width?: number; height?: number };
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

export async function runCompare(
  options: ComparePipelineOptions,
): Promise<ComparePipelineResult> {
  const runId = options.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  const bundleDir = path.resolve(options.bundleDir);

  const bundle = await readSceneBundle(bundleDir, "compare");
  const currentContentHash = canonicalContentHash(bundle.content);

  const manifestFile = path.join(bundleDir, "manifest.json");
  let manifest: BundleManifest = {};
  if (await fileExists(manifestFile)) {
    manifest = (await readJsonFile(manifestFile, "compare")) as BundleManifest;
  }
  const originalContentHash = manifest.originalContentSha256;

  const previewFile = path.join(bundleDir, "preview.png");
  if (!(await fileExists(previewFile))) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "compare",
      message: `preview.png 不存在：请先执行 render（${previewFile}）`,
      runId,
    });
  }

  const referenceFile =
    options.reference !== undefined
      ? path.resolve(options.reference)
      : path.join(bundleDir, "reference.png");
  if (!(await fileExists(referenceFile))) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "compare",
      message: `对比基准图不存在：${referenceFile}`,
      runId,
    });
  }

  // ---- 适用性判定：仅同内容（或提供新基准）的 replica 可直接对比 ----
  const contentChanged =
    originalContentHash !== undefined &&
    currentContentHash !== originalContentHash;

  const artifacts: string[] = [];
  let comparison: ImageComparison | undefined;
  let regionScores: RegionScore[] | undefined;
  let applicable = true;
  let skippedReason: string | undefined;
  let status: ComparePipelineResult["status"] = "pass";

  if (contentChanged && options.reference === undefined) {
    if (options.force === true) {
      // 显式对比发现不一致：失败（不能把编辑后的内容当作原文对比）
      status = "failed";
      applicable = false;
      skippedReason = "content_changed";
    } else {
      // 编辑后默认跳过原图差异（不能沿用旧分数）
      applicable = false;
      skippedReason = "content_changed";
    }
  } else {
    options.logger?.("执行像素对比", { reference: referenceFile });
    const reference = await loadRgba(referenceFile);
    const preview = await loadRgba(previewFile);
    comparison = await compareRgbaImages(
      reference,
      preview,
      { ...DEFAULT_COMPARE_PARAMS },
    );

    // T14：区域评价（头部/时间轴/照片/侧栏固定区域；仅 replica 适用场景）
    regionScores = scoreRegions(
      reference,
      preview,
      defaultEvalRegions({
        width: comparison.width,
        height: comparison.height,
      }),
    );

    // 写 diff / overlay
    const diffFile = path.join(bundleDir, "diff.png");
    const overlayFile = path.join(bundleDir, "overlay.png");
    await writeFile(diffFile, comparison.diffPng);
    await writeFile(overlayFile, comparison.overlayPng);
    artifacts.push(diffFile, overlayFile);

    options.logger?.("对比完成", {
      mismatchRatio: comparison.mismatchRatio,
    });
  }

  // ---- 合并报告：保留 run/layout 等字段，重写 comparison ----
  const reportFile = path.join(bundleDir, "report.json");
  let report: Record<string, unknown> = {};
  if (await fileExists(reportFile)) {
    report = (await readJsonFile(reportFile, "compare")) as Record<
      string,
      unknown
    >;
  }

  const finishedAt = new Date().toISOString();
  const comparisonSection: Record<string, unknown> = applicable
    ? {
        applicable: true,
        reference: path.relative(bundleDir, referenceFile),
        referenceSha256: undefined, // 下方填充
        params: comparison!.params,
        width: comparison!.width,
        height: comparison!.height,
        mismatchedPixels: comparison!.mismatchedPixels,
        mismatchRatio: comparison!.mismatchRatio,
        diff: "diff.png",
        overlay: "overlay.png",
        note: "mismatchRatio 是辅助指标（策略参数随 evaluation 记录校准），不是还原度百分比",
        // T14：区域分数（评分不是还原百分比）
        ...(regionScores === undefined ? {} : { regionScores }),
      }
    : {
        applicable: false,
        reason:
          skippedReason === "content_changed"
            ? "内容已编辑：默认跳过原图差异；如需对比请提供新的匹配基准（--reference），或显式 --force（将报告内容不一致为失败）"
            : skippedReason,
      };

  if (applicable) {
    comparisonSection.referenceSha256 = await sha256OfFile(referenceFile);
  }

  const mergedReport = {
    ...report,
    schemaVersion: reportSchemaVersion,
    run: {
      ...((report.run as Record<string, unknown>) ?? {}),
      runId,
      stage: "compare",
      status,
      startedAt,
      finishedAt,
    },
    // 原内容对比基准（manifest 中的原始内容哈希；无则说明包不完整）
    comparison: comparisonSection,
  };

  await writeJsonFileAtomic(reportFile, mergedReport, "compare");
  artifacts.push(reportFile);

  return {
    runId,
    status,
    bundleDir,
    artifacts,
    report: mergedReport,
    applicable,
    ...(skippedReason === undefined ? {} : { skippedReason }),
    ...(comparison === undefined ? {} : { mismatchRatio: comparison.mismatchRatio }),
  };
}

async function sha256OfFile(file: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
