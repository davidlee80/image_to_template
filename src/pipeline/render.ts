/**
 * 渲染流水线（T06 + T13 扩展）：
 * 读取模板包 → 字体 → HTML → 浏览器导出与诊断 → 报告。
 *
 * 实施计划 T06 步骤 5～7：
 * - 固定画布截图；严格模式发现阻断项时不生成有效导出；
 * - 截图与 HTML 临时文件后原子替换；失败时不让旧 preview 被误认为本次结果；
 * - 按运行隔离临时资源；拒绝同输出目录并发写入；
 * - 完成 report 的 layout、assets、fonts、editability、reviewItems 与运行状态。
 *
 * T13：
 * - 双版本分发：template.json version 1.0 → SceneSpec 链路；
 *   2.0（或 layout.json 存在）→ LayoutSpec 链路；
 * - adaptive 两种策略：grow 保持宽度自动增高 / paginate 保持页尺寸按块分页；
 * - SceneSpec 不允许 adaptive（组合不支持直接报错）；
 * - 每页输出同尺寸 PNG 与 page index；PDF 与 PNG 来自同一页分配；
 * - scale 仅改变栅格导出分辨率，不改变逻辑排版与 PDF 页尺寸；
 * - report 记录逻辑尺寸和实际输出尺寸（pages 字段组）。
 *
 * render 不调用模型、不重新识别（计划 T07 步骤 6）。
 */

import { mkdir, readdir, rm, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../sdk.js";
import { ImageTemplateError } from "../errors.js";
import { readSceneBundle } from "../io/bundle.js";
import { readJsonFile, writeJsonFileAtomic } from "../io/json.js";
import { mergeSceneContent } from "../schemas/content.js";
import { buildFontFaces, fontRequirementsOf } from "../assets/fonts.js";
import { buildHtml } from "../render/html.js";
import { renderPage, measurePageBlocks } from "../render/browser.js";
import { buildLayoutHtml } from "../render/layout-html.js";
import { readLayoutSpec } from "../semantic/migrate.js";
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
import {
  growLayoutHeight,
  paginateBlocks,
  type PageBlock,
} from "../render/paginate.js";
import { exportPagesToPdf, type PdfPageInput } from "../render/pdf.js";
import type { LayoutNode, LayoutSpec, PaginationMeta } from "../schemas/layout.js";

/** 溢出策略（T13 步骤 1）：grow 增高 / paginate 分页；error 固定页检查。 */
export type OverflowStrategy = "error" | "grow" | "paginate";

export interface RenderPipelineOptions {
  /** 模板包目录。 */
  bundleDir: string;
  /** 覆盖内容（已解析的对象；--data 文件由 CLI/SDK 层读取）。 */
  contentOverride?: Record<string, unknown>;
  /** 输出 PNG 路径（默认 bundle 内 preview.png；单 PNG 可用文件路径）。 */
  outputPng?: string;
  /** 严格模式：阻断项导致失败且不产出有效导出。 */
  strict?: boolean;
  /** 渲染模式（T13）：replica 固定 / adaptive 流式；默认按模板 strategy。 */
  mode?: "replica" | "adaptive";
  /** 溢出策略（T13）：仅 adaptive；默认按模板 strategy.overflow（无则 grow）。 */
  overflow?: OverflowStrategy;
  /** 输出格式（T13）：png / pdf；默认 png。 */
  format?: Array<"png" | "pdf">;
  /** 栅格缩放（T13）：仅改变 PNG 分辨率，不影响逻辑排版与 PDF。 */
  scale?: number;
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

/** 读取模板 JSON 的 version 字段（分发依据；不完整解析在校验模块）。 */
async function readTemplateVersion(
  bundleDir: string,
): Promise<string | undefined> {
  try {
    const value = (await readJsonFile(
      path.join(bundleDir, "template.json"),
      "render",
    )) as { version?: unknown };
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

/** 读取 template.json 为 LayoutSpec（version 2.0 直接作为语义模板）。 */
async function readTemplateAsLayoutSpec(
  bundleDir: string,
): Promise<import("../schemas/layout.js").LayoutSpec> {
  const { parseLayoutSpec } = await import("../schemas/layout.js");
  const value = await readJsonFile(
    path.join(bundleDir, "template.json"),
    "render",
  );
  const result = parseLayoutSpec(value);
  if (!result.ok) {
    throw new ImageTemplateError({
      code: "UNSUPPORTED_VERSION",
      stage: "render",
      message: `template.json 校验失败：${result.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("；")}`,
    });
  }
  return result.spec;
}

/** LayoutSpec 渲染所需的字体声明（按槽位展开）。 */
function layoutFontRequirements(spec: LayoutSpec) {
  const requirements: Array<{ slot: string; weight: string }> = [];
  for (const slot of spec.fonts) {
    // 主题组件使用 400/700 两个字重；重复项去重
    for (const weight of ["400", "700"]) {
      if (!requirements.some((r) => r.slot === slot && r.weight === weight)) {
        requirements.push({ slot, weight });
      }
    }
  }
  return requirements;
}

/** 分页块信息（任意带 pagination 元数据的节点 → PageBlock）。 */
function collectPaginationBlocks(spec: LayoutSpec): PageBlock[] {
  const blocks: PageBlock[] = [];
  let documentOrder = 0;

  const metaOf = (node: LayoutNode): PaginationMeta | undefined => {
    if (node.type === "container") {
      return node.pagination;
    }
    return undefined;
  };

  const visit = (node: LayoutNode): void => {
    const meta = metaOf(node);
    if (meta !== undefined) {
      blocks.push({
        id: node.id,
        column: meta.column ?? 0,
        height: 0, // 浏览器测量后回填
        kind: meta.kind,
        order: meta.order ?? documentOrder,
        ...(meta.atomic === undefined ? {} : { atomic: meta.atomic }),
        ...(meta.keepWithNext === undefined
          ? {}
          : { keepWithNext: meta.keepWithNext }),
      });
      documentOrder += 1;
    }

    if (node.type === "container") {
      for (const child of node.children) {
        visit(child);
      }
    } else if (node.type === "repeat") {
      visit(node.itemTemplate);
    }
  };

  visit(spec.root);
  return blocks;
}

/** scale → 栅格缩放倍数（限制 0.25～4，防过大像素）。 */
function normalizeScale(scale: number | undefined): number {
  if (scale === undefined) {
    return 1;
  }
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 4) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "render",
      message: `scale 必须在 0.25～4 之间（收到 ${scale}）；scale 仅改变栅格分辨率，不改变逻辑排版`,
    });
  }
  return scale;
}

/** PNG 字节按 scale 重采样（保持逻辑排版不变；仅改栅格分辨率）。 */
async function rescalePng(
  png: Buffer,
  width: number,
  height: number,
  scale: number,
): Promise<Buffer> {
  if (scale === 1) {
    return png;
  }
  const { default: sharp } = await import("sharp");
  return sharp(png)
    .resize({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      kernel: "cubic",
    })
    .png()
    .toBuffer();
}

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

    // ---- 版本分发（T13）----
    // 迁移后的包：layout.json 存在 → LayoutSpec（content 已是结构化形态，
    // 不能再按 SceneSpec content 解析）；
    // 未迁移：template.json version 1.0 → SceneSpec；2.0 → LayoutSpec。
    const hasLayoutJson = await stat(
      path.join(bundleDir, "layout.json"),
    ).then(
      () => true,
      () => false,
    );
    const templateVersion = await readTemplateVersion(bundleDir);

    const isLayout = hasLayoutJson || templateVersion === "2.0";

    if (!isLayout) {
      // SceneSpec 组合校验在读取前拒绝（不支持的组合直接报错，不做 I/O 解析）
      if (options.mode === "adaptive") {
        throw new ImageTemplateError({
          code: "UNSUPPORTED",
          stage: "render",
          message:
            "SceneSpec 1.0（定位式模板）仅支持 replica 模式；adaptive 需要 LayoutSpec 2.0（extract --layout hybrid 或 migrate）",
          runId,
        });
      }
      if (options.overflow !== undefined) {
        throw new ImageTemplateError({
          code: "UNSUPPORTED",
          stage: "render",
          message: `--overflow 仅适用于 adaptive 模式；SceneSpec 1.0 固定画布（replica）不支持 ${options.overflow}`,
          runId,
        });
      }
    }

    if (isLayout) {
      return await renderLayoutBundle(options, {
        runId,
        startedAt,
        bundleDir,
        tmpHtml,
        tmpPng,
      });
    }

    // ---- SceneSpec 1.0 链路（原有实现）----
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

    const report: Record<string, unknown> = {
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

/** LayoutSpec 渲染链路（T13）：grow / paginate + 多页 PNG/PDF + pages 报告。 */
async function renderLayoutBundle(
  options: RenderPipelineOptions,
  context: {
    runId: string;
    startedAt: string;
    bundleDir: string;
    tmpHtml: string;
    tmpPng: string;
  },
): Promise<RenderPipelineResult> {
  const { runId, startedAt, bundleDir, tmpHtml, tmpPng } = context;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs;

  // LayoutSpec 来源：迁移包 layout.json 优先；未迁移的 2.0 template.json 备选
  const layoutJsonExists = await stat(path.join(bundleDir, "layout.json")).then(
    () => true,
    () => false,
  );
  const spec = layoutJsonExists
    ? await readLayoutSpec(bundleDir)
    : await readTemplateAsLayoutSpec(bundleDir);

  // ---- 模式与策略解析（不支持组合直接报错）----
  const mode = options.mode ?? spec.strategy.mode;
  const overflow: OverflowStrategy =
    options.overflow ?? spec.strategy.overflow ?? "grow";

  if (mode === "replica" && options.overflow !== undefined) {
    throw new ImageTemplateError({
      code: "UNSUPPORTED",
      stage: "render",
      message: `--overflow 仅适用于 adaptive 模式；replica 固定画布不支持 ${options.overflow}`,
      runId,
    });
  }
  if (mode === "adaptive" && overflow === "error") {
    throw new ImageTemplateError({
      code: "UNSUPPORTED",
      stage: "render",
      message:
        "adaptive 模式不支持 --overflow error（固定页检查请使用 replica 模式）",
      runId,
    });
  }

  const scale = normalizeScale(options.scale);
  const formats = options.format ?? ["png"];

  // ---- 内容 ----
  let content: Record<string, unknown>;
  if (options.contentOverride !== undefined) {
    content = options.contentOverride;
  } else {
    content = (await readJsonFile(
      path.join(bundleDir, "content.json"),
      "render",
    )) as Record<string, unknown>;
  }

  // ---- 字体 ----
  const fontRequirements = layoutFontRequirements(spec);
  const fonts = await buildFontFaces(bundleDir, fontRequirements);

  const htmlInput = {
    spec,
    content,
    bundleDir,
    fontFaceCss: fonts.css,
  };

  const strict = options.strict === true;
  const artifacts: string[] = [];
  const reviewItems: ReviewItem[] = [
    ...fonts.missing.map((missing) => ({
      id: `font:${missing.slot}:${missing.weight}`,
      type: "font_missing",
      severity: (strict ? "blocker" : "warning") as "blocker" | "warning",
      message: `字体缺失：${missing.message}（诊断模式回退系统字体；严格模式将失败）`,
      evidence: { reason: missing.reason },
      resolution: { status: "pending" as const },
    })),
  ];

  /** 页分配结果（report.pages）。 */
  let pagesReport: Array<{
    index: number;
    logicalWidth: number;
    logicalHeight: number;
    outputWidth: number;
    outputHeight: number;
    blocks: string[];
    png?: string;
  }> = [];

  /** 输出模式描述（report）。 */
  let renderModeNote = "";

  // 清理旧多页产物（重渲染不让旧页冒充本次结果）
  const pagesDir = path.join(bundleDir, "pages");
  await rm(pagesDir, { recursive: true, force: true }).catch(() => undefined);

  if (mode === "replica") {
    renderModeNote = "replica：固定画布";
    const { html } = await buildLayoutHtml({ ...htmlInput, mode: "replica" });
    const page = await renderPage({
      html,
      width: spec.canvas.width,
      height: spec.canvas.height,
      requiredFonts: fonts.loaded.map((f) => ({
        family: f.familyAlias,
        weight: f.weight,
      })),
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { loadTimeoutMs: timeoutMs }),
    });

    const analysis = analyzeLayout({
      diagnostics: page.diagnostics,
      canvas: spec.canvas,
      fontFailureIsBlocker: strict,
    });
    const domIssues = domMismatchesToIssues(page.diagnostics.domTextMismatches);

    const blockers = analysis.findings.filter((f) => f.severity === "blocker");
    const hasBlocker =
      blockers.length > 0 ||
      domIssues.length > 0 ||
      (strict && fonts.missing.length > 0);

    for (const finding of analysis.findings.filter(
      (f) => f.severity === "warning",
    )) {
      reviewItems.push({
        id: `layout:${finding.code}:${finding.elementId ?? "canvas"}`,
        type: `layout_${finding.code.toLowerCase()}`,
        severity: "warning",
        ...(finding.elementId === undefined
          ? {}
          : { elementId: finding.elementId }),
        message: finding.message,
        ...(finding.evidence === undefined
          ? {}
          : { evidence: finding.evidence }),
        resolution: { status: "pending" },
      });
    }
    for (const issue of domIssues) {
      reviewItems.push({
        id: `editability:${issue.code}:${issue.elementId ?? "canvas"}`,
        type: "editability",
        severity: "blocker",
        ...(issue.elementId === undefined
          ? {}
          : { elementId: issue.elementId }),
        message: issue.message,
        resolution: { status: "pending" },
      });
    }

    const failed = strict && hasBlocker;
    const status: RenderPipelineResult["status"] = failed
      ? "failed"
      : reviewItems.length > 0
        ? "needs_review"
        : "pass";

    if (!failed) {
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

      pagesReport = [
        {
          index: 1,
          logicalWidth: spec.canvas.width,
          logicalHeight: spec.canvas.height,
          outputWidth: Math.round(spec.canvas.width * scale),
          outputHeight: Math.round(spec.canvas.height * scale),
          blocks: [],
          png: path.relative(bundleDir, finalPng),
        },
      ];

      // PDF（与 PNG 同一布局）
      if (formats.includes("pdf")) {
        const pdfBytes = await exportPagesToPdf({
          pages: [
            { html, width: spec.canvas.width, height: spec.canvas.height },
          ],
          outputFile: path.join(bundleDir, "preview.pdf"),
          ...(signal === undefined ? {} : { signal }),
        });
        const finalPdf = path.join(bundleDir, "preview.pdf");
        await writeFile(finalPdf, pdfBytes.pdfBytes);
        artifacts.push(finalPdf);
      }
    } else {
      await rm(path.join(bundleDir, "preview.html"), { force: true });
      await rm(path.join(bundleDir, "preview.png"), { force: true });
    }

    const report: Record<string, unknown> = {
      schemaVersion: reportSchemaVersion,
      run: {
        runId,
        stage: "render",
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
      },
      template: { version: "2.0", mode, overflow: null },
      mode,
      renderModeNote,
      layout: {
        findings: analysis.findings,
        allowedOverlaps: analysis.allowedOverlaps,
        overflowX: analysis.overflowX,
        overflowY: analysis.overflowY,
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
        issues: domIssues,
      },
      pages: pagesReport,
      reviewItems,
    };

    const reportFile = path.join(bundleDir, "report.json");
    await writeJsonFileAtomic(reportFile, report, "render");
    artifacts.push(reportFile);

    return {
      runId,
      status,
      bundleDir,
      artifacts,
      report,
      reviewItems,
      findings: analysis.findings,
      content: content as Record<string, string>,
    };
  }

  // ---- adaptive ----
  if (overflow === "grow") {
    renderModeNote = "adaptive-grow：保持宽度自动增高（单张 PNG）";
    options.logger?.("adaptive grow：测量内容高度");

    const probe = await buildLayoutHtml({ ...htmlInput, mode: "adaptive" });
    const measured = await measurePageBlocks({
      html: probe.html,
      width: spec.canvas.width,
      height: spec.canvas.height,
      requiredFonts: [],
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { loadTimeoutMs: timeoutMs }),
    });

    const growHeight = Math.max(
      spec.canvas.height,
      Math.ceil(measured.contentHeight),
    );

    const { html } = await buildLayoutHtml({
      ...htmlInput,
      mode: "adaptive",
      growHeight,
    });
    const page = await renderPage({
      html,
      width: spec.canvas.width,
      height: growHeight,
      requiredFonts: fonts.loaded.map((f) => ({
        family: f.familyAlias,
        weight: f.weight,
      })),
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { loadTimeoutMs: timeoutMs }),
    });

    const analysis = analyzeLayout({
      diagnostics: page.diagnostics,
      canvas: { width: spec.canvas.width, height: growHeight },
      fontFailureIsBlocker: strict,
    });
    const domIssues = domMismatchesToIssues(page.diagnostics.domTextMismatches);
    const blockers = analysis.findings.filter((f) => f.severity === "blocker");
    const hasBlocker =
      blockers.length > 0 ||
      domIssues.length > 0 ||
      (strict && fonts.missing.length > 0);

    for (const finding of analysis.findings.filter(
      (f) => f.severity === "warning",
    )) {
      reviewItems.push({
        id: `layout:${finding.code}:${finding.elementId ?? "canvas"}`,
        type: `layout_${finding.code.toLowerCase()}`,
        severity: "warning",
        ...(finding.elementId === undefined
          ? {}
          : { elementId: finding.elementId }),
        message: finding.message,
        ...(finding.evidence === undefined
          ? {}
          : { evidence: finding.evidence }),
        resolution: { status: "pending" },
      });
    }
    for (const issue of domIssues) {
      reviewItems.push({
        id: `editability:${issue.code}:${issue.elementId ?? "canvas"}`,
        type: "editability",
        severity: "blocker",
        ...(issue.elementId === undefined
          ? {}
          : { elementId: issue.elementId }),
        message: issue.message,
        resolution: { status: "pending" },
      });
    }

    const failed = strict && hasBlocker;
    const status: RenderPipelineResult["status"] = failed
      ? "failed"
      : reviewItems.length > 0
        ? "needs_review"
        : "pass";

    if (!failed) {
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

      // scale 缩放输出
      if (scale !== 1) {
        const scaled = await rescalePng(
          page.screenshot,
          spec.canvas.width,
          growHeight,
          scale,
        );
        await writeFile(finalPng, scaled);
      }

      pagesReport = [
        {
          index: 1,
          logicalWidth: spec.canvas.width,
          logicalHeight: growHeight,
          outputWidth: Math.round(spec.canvas.width * scale),
          outputHeight: Math.round(growHeight * scale),
          blocks: measured.blocks.map((b) => b.id),
          png: path.relative(bundleDir, finalPng),
        },
      ];

      if (formats.includes("pdf")) {
        const pdfBytes = await exportPagesToPdf({
          pages: [
            { html, width: spec.canvas.width, height: growHeight },
          ],
          outputFile: path.join(bundleDir, "preview.pdf"),
          ...(signal === undefined ? {} : { signal }),
        });
        await writeFile(path.join(bundleDir, "preview.pdf"), pdfBytes.pdfBytes);
        artifacts.push(path.join(bundleDir, "preview.pdf"));
      }
    } else {
      await rm(path.join(bundleDir, "preview.html"), { force: true });
      await rm(path.join(bundleDir, "preview.png"), { force: true });
    }

    const report: Record<string, unknown> = {
      schemaVersion: reportSchemaVersion,
      run: {
        runId,
        stage: "render",
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
      },
      template: { version: "2.0", mode, overflow },
      mode,
      renderModeNote,
      layout: {
        findings: analysis.findings,
        allowedOverlaps: analysis.allowedOverlaps,
        overflowX: analysis.overflowX,
        overflowY: analysis.overflowY,
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
        issues: domIssues,
      },
      pages: pagesReport,
      reviewItems,
    };

    const reportFile = path.join(bundleDir, "report.json");
    await writeJsonFileAtomic(reportFile, report, "render");
    artifacts.push(reportFile);

    return {
      runId,
      status,
      bundleDir,
      artifacts,
      report,
      reviewItems,
      findings: analysis.findings,
      content: content as Record<string, string>,
    };
  }

  // ---- adaptive + paginate（按块分页）----
  renderModeNote = "adaptive-paginate：保持页尺寸按块分页";
  options.logger?.("adaptive paginate：测量分页块");

  const probeHtml = await buildLayoutHtml({ ...htmlInput, mode: "adaptive" });
  const measured = await measurePageBlocks({
    html: probeHtml.html,
    width: spec.canvas.width,
    height: spec.canvas.height,
    requiredFonts: [],
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { loadTimeoutMs: timeoutMs }),
  });

  const heightById = new Map(measured.blocks.map((b) => [b.id, b.height]));
  const blocks = collectPaginationBlocks(spec).map((block) => ({
    ...block,
    height: heightById.get(block.id) ?? block.height,
  }));

  // 页内容高度：画布高 − 上下边距（使用主题默认 padding）
  const pageContentHeight = Math.max(
    100,
    spec.canvas.height - 80,
  );

  const paginated = paginateBlocks(blocks, { pageContentHeight });
  if (!paginated.ok) {
    // OVERSIZED_BLOCK：不静默裁切、不循环空页
    const items: ReviewItem[] = paginated.oversizedBlocks.map((block) => ({
      id: `pagination:OVERSIZED_BLOCK:${block.id}`,
      type: "oversized_block",
      severity: "blocker",
      message: `块 ${block.id} 高度 ${Math.round(block.height)}px 超过页内容高度 ${block.pageContentHeight}px：不可拆块超出一页，无法自动分页（请拆分内容或使用 --overflow grow）`,
      evidence: { height: block.height, pageContentHeight: block.pageContentHeight },
      resolution: { status: "pending" as const },
    }));

    const report: Record<string, unknown> = {
      schemaVersion: reportSchemaVersion,
      run: {
        runId,
        stage: "render",
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
      },
      template: { version: "2.0", mode, overflow },
      mode,
      renderModeNote,
      pages: [],
      reviewItems: [...reviewItems, ...items],
      pagination: {
        pageContentHeight,
        oversizedBlocks: paginated.oversizedBlocks,
      },
    };
    await writeJsonFileAtomic(
      path.join(bundleDir, "report.json"),
      report,
      "render",
    );
    return {
      runId,
      status: "failed",
      bundleDir,
      artifacts: [path.join(bundleDir, "report.json")],
      report,
      reviewItems: [...reviewItems, ...items],
      findings: [],
      content: content as Record<string, string>,
    };
  }

  // 逐页渲染（块过滤 + 续页标记）
  await mkdir(pagesDir, { recursive: true });
  const pdfPages: PdfPageInput[] = [];
  const allFindings: LayoutFinding[] = [];
  const allDomIssues: ReturnType<typeof domMismatchesToIssues> = [];

  for (const assignment of paginated.pages) {
    if (signal?.aborted) {
      throw new ImageTemplateError({
        code: "ABORTED",
        stage: "render",
        message: "渲染已取消",
        runId,
      });
    }

    const blockIds = new Set(
      assignment.blocks
        .map((b) => b.id.split("#")[0])
        .filter((id) => heightById.has(id)),
    );

    const { html } = await buildLayoutHtml({
      ...htmlInput,
      mode: "adaptive",
      includeBlockIds: blockIds,
      ...(assignment.page > 1
        ? {
            continuationLabel: `续页 ${assignment.page}/${paginated.pages.length}`,
          }
        : {}),
    });

    const page = await renderPage({
      html,
      width: spec.canvas.width,
      height: spec.canvas.height,
      requiredFonts: fonts.loaded.map((f) => ({
        family: f.familyAlias,
        weight: f.weight,
      })),
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { loadTimeoutMs: timeoutMs }),
    });

    const analysis = analyzeLayout({
      diagnostics: page.diagnostics,
      canvas: spec.canvas,
      fontFailureIsBlocker: strict,
    });
    allFindings.push(...analysis.findings);
    allDomIssues.push(...domMismatchesToIssues(page.diagnostics.domTextMismatches));

    const pageFile = path.join(
      pagesDir,
      `page-${String(assignment.page).padStart(3, "0")}.png`,
    );
    await writeFile(
      pageFile,
      await rescalePng(
        page.screenshot,
        spec.canvas.width,
        spec.canvas.height,
        scale,
      ),
    );
    artifacts.push(pageFile);

    pagesReport.push({
      index: assignment.page,
      logicalWidth: spec.canvas.width,
      logicalHeight: spec.canvas.height,
      outputWidth: Math.round(spec.canvas.width * scale),
      outputHeight: Math.round(spec.canvas.height * scale),
      blocks: assignment.blocks.map((b) => b.id),
      png: path.relative(bundleDir, pageFile),
    });

    pdfPages.push({
      html,
      width: spec.canvas.width,
      height: spec.canvas.height,
    });

    // 首页同步输出 preview（兼容下游 compare 单图约定）
    if (assignment.page === 1) {
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
  }

  // PDF：与 PNG 同一页分配
  if (formats.includes("pdf") && pdfPages.length > 0) {
    const pdfBytes = await exportPagesToPdf({
      pages: pdfPages,
      outputFile: path.join(bundleDir, "preview.pdf"),
      ...(signal === undefined ? {} : { signal }),
    });
    await writeFile(path.join(bundleDir, "preview.pdf"), pdfBytes.pdfBytes);
    artifacts.push(path.join(bundleDir, "preview.pdf"));
  }

  const blockers = allFindings.filter((f) => f.severity === "blocker");
  const hasBlocker =
    blockers.length > 0 ||
    allDomIssues.length > 0 ||
    (strict && fonts.missing.length > 0);

  for (const finding of allFindings.filter((f) => f.severity === "warning")) {
    reviewItems.push({
      id: `layout:${finding.code}:${finding.elementId ?? "canvas"}`,
      type: `layout_${finding.code.toLowerCase()}`,
      severity: "warning",
      ...(finding.elementId === undefined
        ? {}
        : { elementId: finding.elementId }),
      message: finding.message,
      ...(finding.evidence === undefined
        ? {}
        : { evidence: finding.evidence }),
      resolution: { status: "pending" },
    });
  }
  for (const issue of allDomIssues) {
    reviewItems.push({
      id: `editability:${issue.code}:${issue.elementId ?? "canvas"}`,
      type: "editability",
      severity: "blocker",
      ...(issue.elementId === undefined ? {} : { elementId: issue.elementId }),
      message: issue.message,
      resolution: { status: "pending" },
    });
  }

  const failed = strict && hasBlocker;
  const status: RenderPipelineResult["status"] = failed
    ? "failed"
    : reviewItems.length > 0
      ? "needs_review"
      : "pass";

  if (failed) {
    // 严格失败：移除本次页产物（不让旧页冒充有效导出）
    await rm(pagesDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(path.join(bundleDir, "preview.html"), { force: true });
    await rm(path.join(bundleDir, "preview.png"), { force: true });
    pagesReport = [];
  }

  const report: Record<string, unknown> = {
    schemaVersion: reportSchemaVersion,
    run: {
      runId,
      stage: "render",
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    template: { version: "2.0", mode, overflow },
    mode,
    renderModeNote,
    layout: {
      findings: allFindings,
      overflowX: 0,
      overflowY: 0,
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
    },
    editability: {
      issues: allDomIssues,
    },
    pages: pagesReport,
    pagination: {
      pageContentHeight,
      pageCount: paginated.pages.length,
      measuredBlocks: measured.blocks.length,
    },
    reviewItems,
  };

  const reportFile = path.join(bundleDir, "report.json");
  await writeJsonFileAtomic(reportFile, report, "render");
  artifacts.push(reportFile);

  options.logger?.("分页渲染完成", {
    pages: paginated.pages.length,
    status,
  });

  return {
    runId,
    status,
    bundleDir,
    artifacts,
    report,
    reviewItems,
    findings: allFindings,
    content: content as Record<string, string>,
  };
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
