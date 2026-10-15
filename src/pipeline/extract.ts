/**
 * 提取流水线（T04 + T09/T10 扩展）：
 * 标准化 → [区域划分 → 整页识别 → 区域裁剪识别 → 回投合并 → OCR 对照]
 * → 内容分离 → 素材裁剪 → 保存模板包。
 *
 * 实施计划：
 * - T04：text 正文移入 content.json；image 整数边界裁剪；复查候选；异常产物清理；
 * - T09：首次整页识别区域，小字区域裁剪放大识别，坐标回投合并去重；
 * - T10：OCR 对照生成复查项；识别调用走响应缓存（键含图片哈希/区域/缩放/
 *   提示词版本/schema/模型/provider 参数/OCR 配置）；全部调用计入共享预算。
 *
 * 渲染与对比由 SDK 串联（T07）；本模块只产出模板包。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { zodToJsonSchema } from "zod-to-json-schema";

import type { Logger } from "../sdk.js";
import { ImageTemplateError } from "../errors.js";
import { standardizeImage, sha256Of } from "../io/image.js";
import { prepareBundleOutputDir } from "../io/bundle.js";
import { writeJsonFileAtomic, canonicalContentHash } from "../io/json.js";
import type { VisionProvider, VisionResult } from "../analysis/provider.js";
import { visionFailureToError } from "../analysis/provider.js";
import {
  PROMPT_VERSION,
  REGIONS_PROMPT_VERSION,
  REGION_SCENE_PROMPT_VERSION,
  buildRegionsPrompt,
  buildRegionScenePrompt,
} from "../analysis/prompts.js";
import {
  sceneSpecSchema,
  isSceneSpec,
  parseSceneSpec,
  type SceneSpec,
  type SceneElement,
} from "../schemas/scene.js";
import { buildContentJsonSchema } from "../schemas/content.js";
import { cropAsset, findTextImageIntersections } from "../assets/crop.js";
import type { ReviewItem } from "../schemas/report.js";
import {
  cropRegionImage,
  parseRegionSpec,
  projectLocalToGlobal,
  type RegionDefinition,
  type RegionSpec,
} from "../analysis/regions.js";
import { mergeRegionElements } from "../analysis/merge.js";
import {
  crossCheckOcrWithVision,
  crossCheckToReviewItems,
  type OcrProvider,
  type OcrResult,
} from "../analysis/ocr.js";
import { extractManualSpec } from "../analysis/manual-spec.js";
import {
  ResponseCache,
  cacheKeyOf,
  type CacheEntry,
  type CacheKind,
} from "../runtime/cache.js";
import type { CallBudget } from "../runtime/budget.js";

export interface ExtractPipelineOptions {
  /** 输入图片路径。 */
  inputPath: string;
  /** 模板包输出目录。 */
  outputDir: string;
  /**
   * 视觉识别 provider（可选）：人工 --spec 路径下可为 undefined（零模型调用）。
   */
  provider?: VisionProvider;
  /**
   * 人工提供的 SceneSpec 文件（对话式 LLM 生成；最高优先级）：
   * 提供时跳过 provider/区域/OCR 全部识别环节，直接进入内容分离与裁剪。
   */
  specFile?: string;
  /** 显式覆盖已存在的输出目录。 */
  overwrite?: boolean;
  /** 操作中止信号。 */
  signal?: AbortSignal;
  /** 日志回调。 */
  logger?: Logger;
  /** B 阶段：分区识别 + OCR 对照 + 缓存 + 预算（T09/T10）。 */
  regions?: {
    /** 启用分区识别与合并。 */
    enabled: boolean;
    /** 独立 OCR provider（可选）。 */
    ocr?: OcrProvider;
    /** 响应缓存（可选）。 */
    cache?: ResponseCache;
    /** 共享调用预算（可选；含 OCR 调用）。 */
    budget?: CallBudget;
  };
}

export interface ExtractPipelineResult {
  runId: string;
  /** 模板包目录（绝对路径）。 */
  bundleDir: string;
  /** 相对 bundleDir 的产物清单。 */
  artifacts: string[];
  /** 素材清单（含裁剪记录）。 */
  assets: Array<{
    id: string;
    file: string;
    sourceRect: { left: number; top: number; width: number; height: number };
    detectionRect: { left: number; top: number; width: number; height: number };
    clippedByCanvas: boolean;
    sha256: string;
    intersectsText: boolean;
  }>;
  /** 复查项（文字与图片相交、合并冲突、边界文字、OCR 对照等）。 */
  reviewItems: ReviewItem[];
  /** 识别统计。 */
  vision: {
    provider: string;
    model: string;
    durationMs: number;
    usage?: Record<string, number>;
  };
  /** 运行统计（T10 runtime 报告字段）。 */
  runtime: {
    /** 识别调用数（含区域与重试，不含 OCR）。 */
    visionRequests: number;
    /** OCR 调用数。 */
    ocrRequests: number;
    /** 缓存命中数。 */
    cacheHits: number;
    /** 预算用量（如提供预算）。 */
    budgetUsed?: { requests: number; elapsedMs: number };
    /** 分区识别信息（如启用）。 */
    regions?: Array<{
      id: string;
      scale: number;
      elementCount: number;
      durationMs?: number;
    }>;
    /** OCR 对照摘要（如执行）。 */
    ocr?: {
      provider: string;
      lines: number;
      matched: number;
      missing: number;
      conflicts: number;
      smallText: number;
    };
  };
  /** 原始内容哈希（replica 对比基准，T07 使用）。 */
  originalContentSha256: string;
}

/** 生成运行 ID。 */
export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readImageFile(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "extract",
      message:
        code === "ENOENT"
          ? `输入图片不存在：${file}`
          : `读取输入图片失败：${file}（${code ?? "未知错误"}）`,
      cause: error,
    });
  }
}

/** 带缓存与预算的 provider 调用（缓存命中不消耗预算）。 */
async function callVision(
  provider: VisionProvider,
  request: Parameters<VisionProvider["analyze"]>[0],
  context: {
    cache?: ResponseCache;
    budget?: CallBudget;
    label: string;
    cacheKeyInput: Parameters<typeof cacheKeyOf>[0];
  },
): Promise<{
  result: VisionResult;
  cacheHit: boolean;
  requests: number;
}> {
  const { cache, budget, label, cacheKeyInput } = context;
  const key = cacheKeyOf(cacheKeyInput);

  if (cache !== undefined) {
    const hit = await cache.get(key);
    if (hit !== null) {
      // 重读仍验证版本/schema：validated 重新走 parseSceneSpec/parseRegionSpec
      const revalidated =
        cacheKeyInput.promptVersion === REGIONS_PROMPT_VERSION
          ? await revalidateRegions(hit.entry.validated)
          : await revalidateScene(hit.entry.validated);
      if (revalidated !== null) {
        return {
          result: {
            ok: true,
            spec: revalidated,
            raw: hit.entry.raw,
            stats: {
              provider: provider.name,
              model: provider.name,
              durationMs: 0,
            },
          },
          cacheHit: true,
          requests: 0,
        };
      }
      // 校验失败的缓存条目不作为成功命中（继续真实调用）
    }
  }

  if (budget !== undefined) {
    budget.recordRequest(label);
  }

  const result = await provider.analyze(request);

  if (cache !== undefined) {
    const entry: CacheEntry = result.ok
      ? {
          key,
          kind: cacheKeyInput.kind,
          createdAt: new Date().toISOString(),
          ok: true,
          raw: result.raw,
          validated: result.spec,
        }
      : {
          key,
          kind: cacheKeyInput.kind,
          createdAt: new Date().toISOString(),
          ok: false,
          raw: null,
        };
    await cache.put(entry).catch(() => undefined);
  }

  return { result, cacheHit: false, requests: 1 };
}

function revalidateScene(value: unknown): SceneSpec | null {
  const result = parseSceneSpec(value);
  return result.ok ? result.spec : null;
}

function revalidateRegions(value: unknown): RegionSpec | null {
  const result = parseRegionSpec(value);
  return result.ok ? result.spec : null;
}

/**
 * 执行提取。失败时清理本次输出目录（异常产物不冒充成功包）。
 */
export async function runExtraction(
  options: ExtractPipelineOptions,
): Promise<ExtractPipelineResult> {
  const runId = newRunId();
  const {
    inputPath,
    outputDir,
    provider,
    specFile,
    overwrite,
    signal,
    logger,
    regions,
  } = options;

  const log = (message: string, detail?: Record<string, unknown>) =>
    logger?.(message, detail);

  const bundleDir = path.resolve(outputDir);
  const artifacts: string[] = [];

  // 输出目录策略：已存在默认拒绝（CONFLICT），显式 overwrite 只替换受管产物。
  await prepareBundleOutputDir(
    bundleDir,
    { overwrite: overwrite === true },
    "extract",
  );

  try {
    if (signal?.aborted) {
      throw new ImageTemplateError({
        code: "ABORTED",
        stage: "extract",
        message: "提取已取消",
        runId,
      });
    }

    log("读取并标准化输入图片", { input: inputPath });
    const inputBytes = await readImageFile(inputPath);
    const standardized = await standardizeImage(inputBytes);

    // 保存标准化基准图（仅用于分析和对比；禁止渲染为整页背景）
    await writeFile(path.join(bundleDir, "reference.png"), standardized.png);
    artifacts.push("reference.png");

    if (signal?.aborted) {
      throw new ImageTemplateError({
        code: "ABORTED",
        stage: "extract",
        message: "提取已取消",
        runId,
      });
    }

    // ---- 人工 spec 路径（对话式 LLM 生成；最高优先级，零模型调用）----
    /** 最终 SceneSpec：人工 spec 直接提供；否则由识别环节产出。 */
    let spec: SceneSpec | undefined;
    let visionStats: ExtractPipelineResult["vision"] = {
      provider: "manual-spec",
      model: "manual-spec",
      durationMs: 0,
    };
    let visionRequests = 0;
    let ocrRequests = 0;
    let cacheHits = 0;

    if (specFile !== undefined) {
      log("使用人工提供的 spec（跳过模型识别）", { specFile });
      const manual = await extractManualSpec(specFile);

      // 画布尺寸一致性：spec 坐标必须与标准化图同一基准
      if (
        manual.spec.canvas.width !== standardized.width ||
        manual.spec.canvas.height !== standardized.height
      ) {
        throw new ImageTemplateError({
          code: "INVALID_ARGUMENT",
          stage: "extract",
          message: `spec 画布尺寸（${manual.spec.canvas.width}×${manual.spec.canvas.height}）与图片实际尺寸（${standardized.width}×${standardized.height}）不一致：请确认提示词中的画布尺寸锚定与图片为同一版本，或让对话模型修正 canvas 后重新输出`,
          runId,
        });
      }

      spec = manual.spec;

      // 调试记录：保留人工 spec 原文（与模型路径同构，供审计）
      await writeJsonFileAtomic(
        path.join(bundleDir, "model-response.debug.json"),
        JSON.parse(manual.raw),
        "extract",
      );
    } else {
      if (provider === undefined) {
        throw new ImageTemplateError({
          code: "INVALID_CONFIG",
          stage: "extract",
          message:
            "缺少视觉识别配置：请提供 --spec <文件>（人工对话生成，零模型调用），或配置 vision provider（OPENAI_API_KEY/OPENAI_MODEL）",
          runId,
        });
      }
    }

    const sceneJsonSchema = zodToJsonSchema(sceneSpecSchema, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    const cache = regions?.cache;
    const budget = regions?.budget;

    /** 本次运行内收集的复查项（合并冲突/边界/OCR；与实例隔离）。 */
    const collectedReviewItems: ReviewItem[] = [];

    let totalVisionMs = 0;
    /** 识别环节产物（人工 spec 路径下均为空）。 */
    let regionStats: ExtractPipelineResult["runtime"]["regions"];
    let ocrSummary: ExtractPipelineResult["runtime"]["ocr"];
    let mergeInfo:
      | {
          duplicates: number;
          conflicts: number;
          sources: Record<string, { from: string; originalId?: string }>;
        }
      | undefined;

    // ---- 识别环节（人工 spec 已提供时全部跳过）----
    if (spec === undefined) {
    // spec 未提供 → provider 已在上文 else 分支校验非空
    const activeProvider = provider!;
    const modelKey = activeProvider.name;
    // ---- 区域划分识别（B 阶段）----
    let regionDefinitions: RegionDefinition[] | undefined;
    if (regions?.enabled === true) {
      log("识别页面区域划分");
      const { regionSpecSchema } = await import("../analysis/regions.js");
      const regionsJsonSchema = zodToJsonSchema(regionSpecSchema, {
        $refStrategy: "none",
      }) as Record<string, unknown>;

      const regionCall = await callVision(
        activeProvider,
        {
          image: standardized.png,
          width: standardized.width,
          height: standardized.height,
          jsonSchema: regionsJsonSchema,
          promptVersion: REGIONS_PROMPT_VERSION,
          systemPrompt: buildRegionsPrompt({
            width: standardized.width,
            height: standardized.height,
            jsonSchema: regionsJsonSchema,
          }),
          signal,
        },
        {
          ...(cache === undefined ? {} : { cache }),
          ...(budget === undefined ? {} : { budget }),
          label: "区域划分识别",
          cacheKeyInput: {
            kind: "regions",
            imageSha256: standardized.normalizedSha256,
            promptVersion: REGIONS_PROMPT_VERSION,
            schemaVersion: "1.0",
            model: modelKey,
          },
        },
      );

      visionRequests += regionCall.requests;
      cacheHits += regionCall.cacheHit ? 1 : 0;
      if (!regionCall.result.ok) {
        throw visionFailureToError(regionCall.result, runId);
      }
      const regionSpec = regionCall.result.spec;
      if (regionSpec && "regions" in regionSpec) {
        regionDefinitions = (regionSpec as RegionSpec).regions;
      }
      totalVisionMs += regionCall.result.stats.durationMs;

      // 保存区域划分调试响应
      await writeJsonFileAtomic(
        path.join(bundleDir, "regions-response.debug.json"),
        regionCall.result.raw,
        "extract",
      );
    }

    // ---- 整页识别 ----
    log("调用视觉识别 provider", { provider: activeProvider.name });
    const pageCall = await callVision(
      activeProvider,
      {
        image: standardized.png,
        width: standardized.width,
        height: standardized.height,
        jsonSchema: sceneJsonSchema,
        promptVersion: PROMPT_VERSION,
        signal,
      },
      {
        ...(cache === undefined ? {} : { cache }),
        ...(budget === undefined ? {} : { budget }),
        label: "整页识别",
        cacheKeyInput: {
          kind: "vision",
          imageSha256: standardized.normalizedSha256,
          promptVersion: PROMPT_VERSION,
          schemaVersion: "1.0",
          model: modelKey,
        },
      },
    );

    visionRequests += pageCall.requests;
    cacheHits += pageCall.cacheHit ? 1 : 0;
    if (!pageCall.result.ok) {
      throw visionFailureToError(pageCall.result, runId);
    }
    if (!isSceneSpec(pageCall.result.spec)) {
      throw new ImageTemplateError({
        code: "PROVIDER_ERROR",
        stage: "extract",
        message: "识别返回了非 SceneSpec 结果（提示词版本与响应不匹配）",
        runId,
      });
    }
    spec = pageCall.result.spec;
    visionStats = {
      provider: activeProvider.name,
      model: activeProvider.name,
      durationMs: totalVisionMs + pageCall.result.stats.durationMs,
      ...(pageCall.result.stats.usage ?? {}),
    };
    totalVisionMs += pageCall.result.stats.durationMs;

    // 调试原始响应单独保存（git 忽略；不进日志）
    await writeJsonFileAtomic(
      path.join(bundleDir, "model-response.debug.json"),
      pageCall.result.raw,
      "extract",
    );

    // ---- 区域裁剪识别、回投与合并（B 阶段）----
    let regionStatsAssigned: ExtractPipelineResult["runtime"]["regions"];

    if (regionDefinitions !== undefined && regionDefinitions.length > 0) {
      log("区域裁剪识别与合并", { regions: regionDefinitions.length });
      regionStats = [];

      const regionResults: Array<{
        region: RegionDefinition;
        elements: SceneElement[];
      }> = [];

      for (const region of regionDefinitions) {
        if (signal?.aborted) {
          throw new ImageTemplateError({
            code: "ABORTED",
            stage: "extract",
            message: "提取已取消",
            runId,
          });
        }

        const cropped = await cropRegionImage(
          standardized.png,
          region,
          { width: standardized.width, height: standardized.height },
        );
        const croppedSha = sha256Of(cropped.png);

        const regionCall = await callVision(
          activeProvider,
          {
            image: cropped.png,
            width: cropped.plan.scaledWidth,
            height: cropped.plan.scaledHeight,
            jsonSchema: sceneJsonSchema,
            promptVersion: REGION_SCENE_PROMPT_VERSION,
            systemPrompt: buildRegionScenePrompt({
              width: cropped.plan.scaledWidth,
              height: cropped.plan.scaledHeight,
              jsonSchema: sceneJsonSchema,
              regionId: region.id,
            }),
            signal,
          },
          {
            ...(cache === undefined ? {} : { cache }),
            ...(budget === undefined ? {} : { budget }),
            label: `区域识别（${region.id}）`,
            cacheKeyInput: {
              kind: "region-scene",
              imageSha256: croppedSha,
              region: region.id,
              scale: cropped.plan.scale,
              promptVersion: REGION_SCENE_PROMPT_VERSION,
              schemaVersion: "1.0",
              model: modelKey,
            },
          },
        );

        visionRequests += regionCall.requests;
        cacheHits += regionCall.cacheHit ? 1 : 0;

        if (!regionCall.result.ok) {
          // 区域识别失败：记录并跳过该区域（不中断整页骨架）
          log(`区域 ${region.id} 识别失败，跳过`, {
            reason: regionCall.result.reason,
          });
          regionStats.push({
            id: region.id,
            scale: region.scale ?? 1,
            elementCount: 0,
          });
          continue;
        }

        if (!isSceneSpec(regionCall.result.spec)) {
          continue;
        }
        totalVisionMs += regionCall.result.stats.durationMs;

        // 坐标回投：局部 → 全局
        const projected: SceneElement[] = regionCall.result.spec.elements.map(
          (element) => {
            const global = projectLocalToGlobal(
              {
                x: element.x,
                y: element.y,
                width: element.width,
                height: element.height,
              },
              cropped.plan,
            );
            return { ...element, ...global };
          },
        );

        regionResults.push({ region, elements: projected });
        regionStats.push({
          id: region.id,
          scale: region.scale ?? 1,
          elementCount: projected.length,
        });
      }

      // 合并整页骨架与区域元素
      const merged = mergeRegionElements({
        pageSpec: spec,
        regions: regionResults,
      });
      if (!merged.ok) {
        throw new ImageTemplateError({
          code: "INVALID_ARGUMENT",
          stage: "extract",
          message: `合并结果几何校验失败：${merged.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("；")}`,
          runId,
        });
      }

      spec = merged.spec;
      mergeInfo = {
        duplicates: merged.duplicates.length,
        conflicts: merged.reviewItems.filter((i) => i.type === "merge_conflict")
          .length,
        sources: merged.sources,
      };

      // 合并复查项（冲突/边界）进入最终 reviewItems（下方统一收集）
      collectedReviewItems.push(...merged.reviewItems);
    }

    if (signal?.aborted) {
      throw new ImageTemplateError({
        code: "ABORTED",
        stage: "extract",
        message: "提取已取消",
        runId,
      });
    }

    // ---- OCR 对照（B 阶段；OCR 字框不直接当 CSS 文本框）----
    let ocrSummary: ExtractPipelineResult["runtime"]["ocr"];
    if (regions?.ocr !== undefined) {
      log("独立 OCR 对照");
      if (budget !== undefined) {
        budget.recordRequest("OCR 对照");
      }
      ocrRequests = 1;

      let ocrResult: OcrResult;
      try {
        ocrResult = await regions.ocr.recognize({
          image: standardized.png,
          width: standardized.width,
          height: standardized.height,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw new ImageTemplateError({
          code: "PROVIDER_ERROR",
          stage: "extract",
          message: `OCR 调用失败：${(error as Error).message}`,
          runId,
          cause: error,
        });
      }

      const { textElementsOf } = await import("../schemas/scene.js");
      const crossCheck = crossCheckOcrWithVision(
        ocrResult.lines,
        textElementsOf(spec),
      );
      const ocrItems = crossCheckToReviewItems(crossCheck, ocrResult.lines);
      collectedReviewItems.push(...ocrItems);

      ocrSummary = {
        provider: ocrResult.provider,
        lines: ocrResult.lines.length,
        matched: crossCheck.matched.length,
        missing: crossCheck.missingInVision.length,
        conflicts: crossCheck.conflicts.length,
        smallText: crossCheck.smallTextLines.length,
      };
    }
    } // 结束识别环节（if (spec === undefined)）

    // ---- 内容分离：text 正文移入 content.json，模板正文清空 ----
    log("分离内容与样式");
    const content: Record<string, string> = {};
    for (const element of spec!.elements) {
      if (element.type === "text") {
        content[element.id] = element.text;
        element.text = "";
      }
    }
    const originalContentSha256 = canonicalContentHash(content);

    // ---- 素材裁剪 ----
    log("裁剪独立素材");
    await mkdir(path.join(bundleDir, "assets"), { recursive: true });

    const intersections = findTextImageIntersections(spec.elements);
    const intersectedTextIds = new Set(intersections.map((i) => i.textId));

    const assets: ExtractPipelineResult["assets"] = [];
    for (const element of spec.elements) {
      if (element.type !== "image") {
        continue;
      }

      const cropped = await cropAsset(standardized.png, {
        element: {
          id: element.id,
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
        },
        canvas: {
          width: standardized.width,
          height: standardized.height,
        },
      });

      const file = `assets/${element.id}.png`;
      await writeFile(path.join(bundleDir, file), cropped.png);

      element.src = file;

      assets.push({
        id: element.id,
        file,
        sourceRect: cropped.plan.sourceRect,
        detectionRect: cropped.plan.detectionRect,
        clippedByCanvas: cropped.plan.clippedByCanvas,
        sha256: cropped.sha256,
        intersectsText:
          intersectedTextIds.has(element.id) ||
          intersections.some((i) => i.imageId === element.id),
      });
    }

    // ---- 复查项：可见文字与图片相交（T04 步骤 4）----
    const reviewItems: ReviewItem[] = [
      ...collectedReviewItems,
      ...intersections.map((candidate) => ({
        id: `text-image-intersect:${candidate.textId}:${candidate.imageId}`,
        type: "asset_review",
        severity: "warning" as const,
        elementId: candidate.textId,
        message: `文字 ${candidate.textId} 与图片 ${candidate.imageId} 相交（占文字区域 ${(candidate.textOverlapRatio * 100).toFixed(0)}%）：请确认该文字是否应保持为可编辑文本，或属于素材内部固有的不可编辑内容`,
        evidence: {
          textId: candidate.textId,
          imageId: candidate.imageId,
          textOverlapRatio: candidate.textOverlapRatio,
        },
        resolution: { status: "pending" as const },
      })),
    ];

    // ---- 写模板包文件 ----
    log("保存模板包", { dir: bundleDir });

    await writeJsonFileAtomic(
      path.join(bundleDir, "template.json"),
      spec,
      "extract",
    );
    artifacts.push("template.json");

    await writeJsonFileAtomic(
      path.join(bundleDir, "content.json"),
      content,
      "extract",
    );
    artifacts.push("content.json");

    const { jsonSchema: contentSchema } = buildContentJsonSchema(spec);
    await writeJsonFileAtomic(
      path.join(bundleDir, "content.schema.json"),
      contentSchema,
      "extract",
    );
    artifacts.push("content.schema.json");

    // manifest：输入、资源、工具链、模板/内容版本与哈希
    const manifest = {
      manifestVersion: "1.0",
      runId,
      createdAt: new Date().toISOString(),
      templateVersion: 1,
      contentVersion: 1,
      schemaVersions: { scene: "1.0", content: "1.0", report: "1.0" },
      input: {
        path: path.resolve(inputPath),
        width: standardized.width,
        height: standardized.height,
        inputFormat: standardized.format.inputFormat,
        orientationApplied: standardized.format.orientationApplied,
        inputSha256: standardized.inputSha256,
        normalizedSha256: standardized.normalizedSha256,
      },
      vision: {
        provider: visionStats.provider,
        model: visionStats.model,
        promptVersion: PROMPT_VERSION,
        ...(regions?.enabled === true
          ? {
              regionMode: true,
              regionsPromptVersion: REGIONS_PROMPT_VERSION,
              regionScenePromptVersion: REGION_SCENE_PROMPT_VERSION,
            }
          : {}),
        durationMs: totalVisionMs,
      },
      runtime: {
        visionRequests,
        ocrRequests,
        cacheHits,
        ...(budget === undefined
          ? {}
          : {
              budgetUsed: {
                requests: budget.usedRequests,
                elapsedMs: budget.elapsedMs,
              },
            }),
        ...(regionStats === undefined ? {} : { regions: regionStats }),
        ...(ocrSummary === undefined ? {} : { ocr: ocrSummary }),
      },
      originalContentSha256,
      assets,
      ...(mergeInfo === undefined ? {} : { merge: mergeInfo }),
      toolchain: {
        node: process.version,
      },
    };
    await writeJsonFileAtomic(
      path.join(bundleDir, "manifest.json"),
      manifest,
      "extract",
    );
    artifacts.push("manifest.json");
    artifacts.push("assets/");

    log("提取完成", {
      elements: spec.elements.length,
      texts: Object.keys(content).length,
      assets: assets.length,
      reviewItems: reviewItems.length,
    });

    return {
      runId,
      bundleDir,
      artifacts,
      assets,
      reviewItems,
      vision: visionStats,
      runtime: {
        visionRequests,
        ocrRequests,
        cacheHits,
        ...(budget === undefined
          ? {}
          : {
              budgetUsed: {
                requests: budget.usedRequests,
                elapsedMs: budget.elapsedMs,
              },
            }),
        ...(regionStats === undefined ? {} : { regions: regionStats }),
        ...(ocrSummary === undefined ? {} : { ocr: ocrSummary }),
      },
      originalContentSha256,
    };
  } catch (error) {
    // 异常产物清理：本次失败的目录不冒充成功包。
    await rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
