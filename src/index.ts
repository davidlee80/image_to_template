/**
 * SDK 公开入口。
 *
 * 约定（实施计划 3 / 2.3）：
 * - import 本模块无任何运行副作用：不读写文件、不发起网络请求、
 *   不启动浏览器、不修改全局环境；
 * - 公开导出随实施阶段逐步增加，未实现能力通过 SDK 实例方法明确拒绝。
 */

import { ImageTemplateError } from "./errors.js";

export { createImageTemplate } from "./sdk.js";
export type {
  BatchOptions,
  BatchResult,
  CompareOptions,
  DirectoriesConfig,
  ExtractOptions,
  ImageTemplate,
  ImageTemplateConfig,
  Logger,
  OperationOptions,
  OperationResult,
  RenderOptions,
  ValidateOptions,
  CalibrateOptions,
} from "./sdk.js";

export { ImageTemplateError, isImageTemplateError } from "./errors.js";
export type {
  ImageTemplateErrorInit,
  SdkErrorCode,
  SdkStage,
} from "./errors.js";

// ---- T02：schema、几何与资源边界 ----

export {
  colorSchema,
  elementIdSchema,
  formatSceneIssues,
  imageElementSchema,
  boxElementSchema,
  textElementSchema,
  sceneElementSchema,
  sceneSpecSchema,
  parseSceneSpec,
  textElementsOf,
  imageElementsOf,
  unsafeRelativePathReason,
} from "./schemas/scene.js";
export type {
  Color,
  BoxElement,
  ImageElement,
  SceneCanvas,
  SceneElement,
  SceneIssue,
  SceneParseFailure,
  SceneParseResult,
  SceneParseSuccess,
  SceneSpec,
  TemplateSpec,
  TextElement,
} from "./schemas/scene.js";

export {
  buildContentJsonSchema,
  buildContentZodSchema,
  defaultContentLengthPolicy,
  maxLengthForTextElement,
  mergeSceneContent,
  parseSceneContent,
} from "./schemas/content.js";
export type {
  ContentIssue,
  ContentJsonSchemaResult,
  ContentLengthPolicy,
  ContentParseFailure,
  ContentParseResult,
  ContentParseSuccess,
  SceneContent,
} from "./schemas/content.js";

export {
  parseReport,
  reportSchemaVersion,
  reportSchema,
  reviewItemSchema,
} from "./schemas/report.js";
export type { Report, ReportParseFailure, ReportParseResult, ReportParseSuccess, ReportRun, ReviewItem } from "./schemas/report.js";

// ---- T03：输入标准化与视觉识别适配器 ----

export { standardizeImage, sha256Of, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, MAX_NORMALIZED_BYTES } from "./io/image.js";
export type { StandardizedImage } from "./io/image.js";

export type {
  VisionCallStats,
  VisionFailure,
  VisionProvider,
  VisionProviderFactory,
  VisionRequest,
  VisionResult,
  VisionSuccess,
} from "./analysis/provider.js";
export { visionFailureToError } from "./analysis/provider.js";

export {
  createOpenAIVisionProvider,
  createFixtureVisionProvider,
  createVisionProvider,
} from "./analysis/vision.js";
export type { OpenAIVisionOptions, VisionProviderConfig } from "./analysis/vision.js";

export {
  PROMPT_VERSION as VISION_PROMPT_VERSION,
  buildScenePrompt,
  SCENE_USER_INSTRUCTION,
  REGIONS_PROMPT_VERSION as VISION_REGIONS_PROMPT_VERSION,
  buildRegionsPrompt,
  REGION_SCENE_PROMPT_VERSION as VISION_REGION_SCENE_PROMPT_VERSION,
  buildRegionScenePrompt,
} from "./analysis/prompts.js";

export { visionConfigFromEnv } from "./config.js";

// ---- 人工对话式提取（manual spec）----

export {
  buildManualSpecPrompt,
  extractManualSpec,
  stripJsonFence,
} from "./analysis/manual-spec.js";

// ---- T05：固定字体与通用 HTML 渲染 ----

export {
  buildFontFaces,
  fontRequirementsOf,
  readFontsManifest,
} from "./assets/fonts.js";
export type {
  FontFaceCssResult,
  FontFileRef,
  FontRequirement,
  FontsManifest,
  LoadedFontFace,
  MissingFont,
  FontSlot,
} from "./assets/fonts.js";

export { buildHtml, escapeHtml, previewHtmlPath } from "./render/html.js";
export type { BuildHtmlInput, BuildHtmlResult } from "./render/html.js";

export {
  checkEditabilityStatic,
  domMismatchesToIssues,
  DOM_TEXT_CHECK_SCRIPT,
  WHOLE_PAGE_IMAGE_RATIO,
} from "./quality/editability.js";
export type { DomTextMismatch, EditabilityIssue } from "./quality/editability.js";

// ---- T06：浏览器导出与布局诊断 ----

export {
  analyzeLayout,
  layoutFindingsToReviewItems,
  OCCLUSION_RATIO,
  OVERFLOW_TOLERANCE_PX,
} from "./quality/layout.js";
export type { AllowedOverlap, LayoutAnalysis, LayoutFinding } from "./quality/layout.js";

export { renderPage, measurePageBlocks } from "./render/browser.js";
export type {
  BrowserDiagnostics,
  BrowserPageOptions,
  BrowserRenderResult,
  BlockMeasurementResult,
  MeasuredBlock,
  PageElementMetrics,
  PageImageStatus,
  PageTextMetrics,
} from "./render/browser.js";

// ---- T07：差异图、叠图与 MVP CLI ----

export {
  compareRgbaImages,
  loadRgba,
  DEFAULT_COMPARE_PARAMS,
} from "./quality/compare.js";
export type { ImageComparison, RgbaImage } from "./quality/compare.js";

export { canonicalContentHash } from "./io/json.js";

// ---- T09：分区识别、坐标回投与去重 ----

export {
  cropRegionImage,
  isNearRegionBoundary,
  planRegionCrop,
  projectLocalToGlobal,
} from "./analysis/regions.js";
export type {
  LocalBox,
  RegionCropPlan,
  RegionDefinition,
  RegionSpec,
} from "./analysis/regions.js";

export {
  iouOf,
  isDuplicate,
  mergeRegionElements,
  DEDUP_IOU_THRESHOLD,
} from "./analysis/merge.js";
export type {
  ElementSource,
  MergeFailure,
  MergeInput,
  MergeResult,
} from "./analysis/merge.js";

// ---- T10：独立 OCR、缓存与预算 ----

export {
  createFixtureOcrProvider,
  crossCheckOcrWithVision,
  crossCheckToReviewItems,
  normalizeOcrText,
  ocrTextMatches,
  overlapRatio,
  SMALL_TEXT_HEIGHT_PX,
} from "./analysis/ocr.js";
export type {
  OcrCrossCheck,
  OcrLine,
  OcrProvider,
  OcrRequest,
  OcrResult,
} from "./analysis/ocr.js";

export { ResponseCache, cacheKeyOf } from "./runtime/cache.js";
export type { CacheEntry, CacheHit, CacheKeyInput, CacheKind } from "./runtime/cache.js";

export {
  CallBudget,
  BudgetExhaustedError,
  classifyFailure,
  executeWithRetry,
  LOW_CONFIDENCE_THRESHOLD,
} from "./runtime/budget.js";
export type { BudgetConfig, RetryAttempt, RetryCategory, RetryPolicy } from "./runtime/budget.js";

export {
  parseRegionSpec,
  regionSpecSchema,
} from "./analysis/regions.js";
export { isSceneSpec } from "./schemas/scene.js";

// ---- T11：LayoutSpec、语义编译与内容迁移 ----

export {
  bindingPathSchema,
  layoutModeSchema,
  layoutSpecSchema,
  layoutStrategySchema,
  parseLayoutSpec,
  readBindingPath,
  styleFieldNames,
  styleFieldsSchema,
  walkLayoutNodes,
  writeBindingPath,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_NODES,
  paginationMetaSchema,
} from "./schemas/layout.js";
export type {
  ComponentNode,
  ContainerNodeShape,
  ImageNode,
  LayoutIssue,
  LayoutMode,
  LayoutNode,
  LayoutParseFailure,
  LayoutParseResult,
  LayoutSpec,
  LayoutStrategy,
  PaginationMeta,
  RepeatNodeShape,
  StyleFields,
  TextNode,
} from "./schemas/layout.js";

export {
  buildTravelContentJsonSchema,
  parseTravelContent,
  travelContentSchema,
} from "./schemas/travel.js";
export type {
  TravelContent,
  TravelPhoto,
  TravelRestaurantGroup,
  TravelTimelineItem,
} from "./schemas/travel.js";

export {
  buildCompiledContentJsonSchema,
  compileSceneToLayout,
} from "./semantic/compile.js";
export type {
  CompiledStructuredContent,
  CompileFailure,
  CompileResult,
  IdMappingEntry,
  SemanticCompileResult,
} from "./semantic/compile.js";

export {
  migrateBundle,
  readLayoutSpec,
  readStructuredContent,
  rollbackMigration,
} from "./semantic/migrate.js";
export type {
  MigrationFailure,
  MigrationOutcome,
  MigrationResult,
} from "./semantic/migrate.js";

export {
  requiredBindingsOf,
  resolveBindings,
  REPEAT_ITEM_PREFIX,
} from "./render/bindings.js";
export type {
  BindingIssue,
  BindingResult,
  ResolvedBindings,
} from "./render/bindings.js";

// ---- T12：旅行主题与七类布局组件 ----

export {
  applyThemeOverrides,
  defaultTravelTheme,
} from "./semantic/travel-theme.js";
export type { TravelTheme, ThemeCalibration } from "./semantic/travel-theme.js";

export {
  componentRegistry,
  registeredComponents,
} from "./render/components.js";
export type { ComponentContext, ComponentRenderer } from "./render/components.js";

export {
  buildLayoutHtml,
  precheckBindings,
} from "./render/layout-html.js";
export type {
  BuildLayoutHtmlInput,
  BuildLayoutHtmlResult,
} from "./render/layout-html.js";

// ---- T13：自适应、分页及 PDF ----

export type { OverflowStrategy } from "./pipeline/render.js";

export {
  growLayoutHeight,
  paginateBlocks,
  ESTIMATED_LINE_HEIGHT_PX,
  MIN_FONT_SIZE_PX,
} from "./render/paginate.js";
export type {
  PageAssignment,
  PageBlock,
  PaginateFailure,
  PaginateOptions,
  PaginateResult,
} from "./render/paginate.js";

export { exportPagesToPdf } from "./render/pdf.js";
export type { PdfExportOptions, PdfPageInput } from "./render/pdf.js";

// ---- T14/T15：受限补丁与自动校准 ----

export {
  DEFAULT_PATCH_LIMITS,
  FORBIDDEN_PATCH_FIELDS,
  LAYOUT_PATCHABLE_FIELDS,
  NUMERIC_PATCH_FIELDS,
  PATCH_FIELD_CATEGORY,
  PATCH_VERSION,
  SCENE_PATCHABLE_FIELDS,
  parseTemplatePatch,
  templatePatchSchema,
  validatePatchFields,
} from "./schemas/patch.js";
export type {
  PatchChange,
  PatchFieldCategory,
  PatchIssue,
  PatchMagnitudeLimits,
  PatchParseFailure,
  PatchParseResult,
  PatchParseSuccess,
  TemplatePatch,
} from "./schemas/patch.js";

export {
  applyPatchToLayout,
  applyPatchToScene,
  applyTemplatePatch,
} from "./calibration/apply.js";
export type {
  ApplyPatchFailure,
  ApplyPatchOptions,
  ApplyPatchResult,
  ApplyPatchSuccess,
  CumulativeChanges,
  PatchTarget,
} from "./calibration/apply.js";

export {
  createDeterministicProposalProvider,
  requestProposal,
} from "./calibration/propose.js";
export type {
  ProposalProvider,
  ProposalRequest,
  ProposalResult,
} from "./calibration/propose.js";

export {
  CALIBRATION_DEFAULTS,
  restoreBestSnapshot,
  runCalibrationLoop,
} from "./calibration/loop.js";
export type {
  CalibrateLoopOptions,
  CalibrationLoopResult,
  CalibrationRoundRecord,
} from "./calibration/loop.js";

export {
  listSnapshots,
  readBundleVersions,
  readSnapshot,
  restoreSnapshot,
  saveSnapshot,
} from "./runtime/versions.js";
export type { TemplateVersions, VersionedSnapshot } from "./runtime/versions.js";

export {
  defaultEvalRegions,
  scoreRegions,
} from "./quality/compare.js";
export type { EvalRegion, RegionScore } from "./quality/compare.js";

export type { ProposalProvider as CalibrationProposalProvider } from "./calibration/propose.js";

// ---- T16：严格交付检查与版本管理 ----

export {
  cleanupTempExport,
  exportBundle,
  exportBundleToTemp,
  recordResolution,
  reloadBundleCheck,
  runValidate,
} from "./quality/publish.js";
export type { ValidateReport } from "./quality/publish.js";

// ---- T17：批量任务 ----

export { runBatch, readBatchManifest } from "./pipeline/batch.js";
export type {
  BatchManifest,
  BatchRunOptions,
  BatchRunResult,
  BatchTask,
  BatchTaskKind,
  BatchTaskResult,
} from "./pipeline/batch.js";

/** SceneSpec 不允许 adaptive（计划 T13 步骤 1；不支持组合直接报错）。 */
export function assertSceneSupportsMode(
  specVersion: string,
  mode: "replica" | "adaptive",
): void {
  if (specVersion === "1.0" && mode === "adaptive") {
    throw new ImageTemplateError({
      code: "UNSUPPORTED",
      stage: "render",
      message:
        "SceneSpec 1.0（定位式模板）仅支持 replica 模式；adaptive 需要 LayoutSpec 2.0",
    });
  }
}
