/**
 * 渲染流水线（T06）：读取模板包 → 字体 → HTML → 浏览器导出与诊断 → 报告。
 *
 * 实施计划 T06 步骤 5～7：
 * - 固定画布截图；严格模式发现阻断项时不生成有效导出；
 * - 截图与 HTML 临时文件后原子替换；失败时不让旧 preview 被误认为本次结果；
 * - 按运行隔离临时资源；拒绝同输出目录并发写入；
 * - 完成 report 的 layout、assets、fonts、editability、reviewItems 与运行状态。
 *
 * render 不调用模型、不重新识别（计划 T07 步骤 6）。
 */

import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../sdk.js";
import { ImageTemplateError } from "../errors.js";
import { readSceneBundle } from "../io/bundle.js";
import { readJsonFile, writeJsonFileAtomic } from "../io/json.js";
import { mergeSceneContent } from "../schemas/content.js";
import { buildFontFaces, fontRequirementsOf } from "../assets/fonts.js";
import { buildHtml } from "../render/html.js";
import { renderPage } from "../render/browser.js";
import {
  analyzeLayout,
  layoutFindingsToReviewItems,
  type LayoutFinding,
} from "../quality/layout.js";
import {
  checkEditabilityStatic,
  domMismatchesToIssues,
} from "../quality/editability.js";
import { reportSchemaVersion, type ReviewItem } from "../schemas/report.js";
import { newRunId } from "./extract.js";

export interface RenderPipelineOptions {
  /** 模板包目录。 */
  bundleDir: string;
  /** 覆盖内容（已解析的对象；--data 文件由 CLI/SDK 层读取）。 */
  contentOverride?: Record<string, unknown>;
  /** 输出 PNG 路径（默认 bundle 内 preview.png）。 */
  outputPng?: string;
  /** 严格模式：阻断项导致失败且不产出有效导出。 */
  strict?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
  /** 外部指定 runId（如 extract 串联渲染时）。 */
  runId?: string;
}

export interface RenderPipelineResult {
  runId: string;
  status: "pass" | "needs_review" | "failed";
  bundleDir: string;
  /** 产物绝对路径。 */
  artifacts: string[];
  /** 完整 report 对象（与 report.json 同构）。 */
  report: Record<string, unknown>;
  reviewItems: ReviewItem[];
  findings: LayoutFinding[];
  /** 本次渲染实际使用的内容。 */
  content: Record<string, string>;
}

/** 同输出目录并发写入保护（进程内；跨进程由输出目录 CONFLICT 语义兜底）。 */
const activeRenders = new Set<string>();

export async function runRender(
  options: RenderPipelineOptions,
): Promise<RenderPipelineResult> {
  const runId = options.runId ?? newRunId();
  const startedAt = new Date().toISOString();

  const bundleDir = path.resolve(options.bundleDir);
  if (activeRenders.has(bundleDir)) {
    throw new ImageTemplateError({
      code: "CONFLICT",
      stage: "render",
      message: `输出目录正在被另一个渲染任务使用：${bundleDir}（同目录并发写入被拒绝）`,
      runId,
    });
  }
  activeRenders.add(bundleDir);

  /** 本次渲染的临时文件（同卷原子替换）。 */
  const tmpHtml = path.join(bundleDir, `.render-${runId}.html.tmp`);
  const tmpPng = path.join(bundleDir, `.render-${runId}.png.tmp`);

  try {
    options.logger?.("读取模板包", { dir: bundleDir });
    const bundle = await readSceneBundle(bundleDir, "render");

    // ---- 内容覆盖（--data）----
    let content = bundle.content;
    if (options.contentOverride !== undefined) {
      const merged = mergeSceneContent(
        bundle.spec,
        bundle.content,
        options.contentOverride,
      );
      if (!merged.ok) {
        throw new ImageTemplateError({
          code: "INVALID_ARGUMENT",
          stage: "render",
          message: `覆盖内容校验失败：${merged.issues
            .map((i) => `${i.path}: ${i.message}`)
            .join("；")}`,
          runId,
        });
      }
      content = merged.content;
    }

    // ---- 静态可编辑性检查 ----
    const editabilityIssues = checkEditabilityStatic(bundle.spec, content);

    // ---- 字体 ----
    const fontRequirements = fontRequirementsOf(bundle.spec.elements);
    const fonts = await buildFontFaces(bundleDir, fontRequirements);

    // ---- HTML ----
    const { html } = await buildHtml({
      spec: bundle.spec,
      content,
      bundleDir,
      fontFaceCss: fonts.css,
    });

    // ---- 浏览器渲染与诊断 ----
    options.logger?.("浏览器渲染与布局诊断", {
      width: bundle.spec.canvas.width,
      height: bundle.spec.canvas.height,
    });
    const requiredFontsForCheck = fonts.loaded.map((font) => ({
      family: font.familyAlias,
      weight: font.weight,
    }));

    const page = await renderPage({
      html,
      width: bundle.spec.canvas.width,
      height: bundle.spec.canvas.height,
      requiredFonts: requiredFontsForCheck,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { loadTimeoutMs: options.timeoutMs }),
    });

    // ---- 布局分析 ----
    const analysis = analyzeLayout({
      diagnostics: page.diagnostics,
      canvas: bundle.spec.canvas,
      fontFailureIsBlocker: options.strict === true,
    });

    // DOM 正文核对
    const domIssues = domMismatchesToIssues(page.diagnostics.domTextMismatches);

    // ---- 分类 ----
    const blockers = analysis.findings.filter((f) => f.severity === "blocker");
    const warnings = analysis.findings.filter((f) => f.severity === "warning");
    const hasBlocker =
      blockers.length > 0 ||
      editabilityIssues.some((i) => i.code === "REFERENCE_AS_SOURCE") ||
      domIssues.length > 0 ||
      (options.strict === true && fonts.missing.length > 0);

    const reviewItems: ReviewItem[] = [
      ...layoutFindingsToReviewItems(analysis.findings),
      ...fonts.missing.map((missing) => ({
        id: `font:${missing.slot}:${missing.weight}`,
        type: "font_missing",
        severity: "warning" as const,
        message: `字体缺失：${missing.message}（诊断模式回退系统字体；严格模式将失败）`,
        evidence: { reason: missing.reason },
        resolution: { status: "pending" as const },
      })),
      ...editabilityIssues.map((issue) => ({
        id: `editability:${issue.code}:${issue.elementId ?? "canvas"}`,
        type: "editability",
        severity: issue.code === "REFERENCE_AS_SOURCE" ? ("blocker" as const) : ("warning" as const),
        ...(issue.elementId === undefined ? {} : { elementId: issue.elementId }),
        message: issue.message,
        resolution: { status: "pending" as const },
      })),
      ...domIssues.map((issue) => ({
        id: `editability:${issue.code}:${issue.elementId ?? "canvas"}`,
        type: "editability",
        severity: "blocker" as const,
        ...(issue.elementId === undefined ? {} : { elementId: issue.elementId }),
        message: issue.message,
        resolution: { status: "pending" as const },
      })),
    ];

    const strict = options.strict === true;
    const failed = strict && hasBlocker;
    const status: RenderPipelineResult["status"] = failed
      ? "failed"
      : reviewItems.length > 0
        ? "needs_review"
        : "pass";

    // ---- 产物写入 ----
    const artifacts: string[] = [];
    const finishedAt = new Date().toISOString();

    const report = {
      schemaVersion: reportSchemaVersion,
      run: {
        runId,
        stage: "render" as const,
        status,
        startedAt,
        finishedAt,
      },
      layout: {
        overflowX: analysis.overflowX,
        overflowY: analysis.overflowY,
        findings: analysis.findings,
        allowedOverlaps: analysis.allowedOverlaps,
      },
      assets: {
        images: page.diagnostics.images,
      },
      fonts: {
        required: fontRequirements,
        loaded: fonts.loaded.map((f) => ({
          slot: f.slot,
          family: f.familyAlias,
          weight: f.weight,
          file: f.file,
          sha256: f.sha256,
        })),
        missing: fonts.missing,
        loadCheck: page.diagnostics.fontsLoaded,
      },
      editability: {
        issues: [...editabilityIssues, ...domIssues],
      },
      reviewItems,
    };

    if (failed) {
      // 严格模式失败：删除旧 preview（不让旧产物冒充本次结果），只保留报告。
      options.logger?.("严格模式失败：不生成有效导出", {
        blockers: blockers.length,
      });
      await rm(path.join(bundleDir, "preview.html"), { force: true });
      await rm(path.join(bundleDir, "preview.png"), { force: true });
    } else {
      // 临时文件后原子替换
      await writeFile(tmpHtml, html, "utf8");
      await writeFile(tmpPng, page.screenshot);

      const finalHtml = path.join(bundleDir, "preview.html");
      const finalPng = options.outputPng
        ? path.resolve(options.outputPng)
        : path.join(bundleDir, "preview.png");

      await mkdir(path.dirname(finalPng), { recursive: true });
      await rename(tmpHtml, finalHtml);
      await rename(tmpPng, finalPng);

      artifacts.push(finalHtml, finalPng);
    }

    const reportFile = path.join(bundleDir, "report.json");
    await writeJsonFileAtomic(reportFile, report, "render");
    artifacts.push(reportFile);

    options.logger?.("渲染完成", { status, warnings: warnings.length });

    return {
      runId,
      status,
      bundleDir,
      artifacts,
      report,
      reviewItems,
      findings: analysis.findings,
      content,
    };
  } finally {
    // 清理本次临时资源
    await rm(tmpHtml, { force: true }).catch(() => undefined);
    await rm(tmpPng, { force: true }).catch(() => undefined);
    activeRenders.delete(bundleDir);
  }
}

/** 读取 --data 内容文件（JSON 对象）。 */
export async function readContentOverride(
  file: string,
): Promise<Record<string, unknown>> {
  const value = await readJsonFile(file, "render");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "render",
      message: `内容文件必须是 JSON 对象：${file}`,
    });
  }
  return value as Record<string, unknown>;
}
