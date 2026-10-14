/**
 * 有限自动校准循环（T15 步骤 2～6）。
 *
 * 实施计划：
 * - 仅对原始内容一致的 replica 提供自动校准；
 * - 每个候选使用隔离临时包：应用、校验、渲染、诊断、比较；
 * - 硬约束优先：文本/绑定集合与内容哈希不变、可编辑性不降低、
 *   无新增阻断溢出/遮挡/资源失败；通过后才评价视觉改善；
 * - 固定最小改善幅度和可接受区域回退范围；默认关键区域不回退；
 * - 默认 3 次迭代，最大 5 次；连续 2 次无有效改善、超时或预算耗尽即停止；
 * - 保存每轮补丁、前后评分、接受/拒绝原因；禁止候选直接覆盖唯一成功包；
 * - 中断后可使用最佳快照重新渲染。
 */

import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Logger } from "../sdk.js";
import { ImageTemplateError } from "../errors.js";
import { readJsonFile, writeJsonFileAtomic, canonicalContentHash } from "../io/json.js";
import { readSceneBundle } from "../io/bundle.js";
import {
  loadRgba,
  defaultEvalRegions,
  scoreRegions,
  type RegionScore,
} from "../quality/compare.js";
import { applyTemplatePatch, type CumulativeChanges } from "./apply.js";
import {
  requestProposal,
  createDeterministicProposalProvider,
  type ProposalProvider,
} from "./propose.js";

export type { ProposalProvider } from "./propose.js";
import {
  saveSnapshot,
  listSnapshots,
  restoreSnapshot,
  readBundleVersions,
} from "../runtime/versions.js";
import { CallBudget } from "../runtime/budget.js";
import { reportSchemaVersion, type ReviewItem } from "../schemas/report.js";
import { newRunId } from "../pipeline/extract.js";
import { runRender } from "../pipeline/render.js";

/** 校准循环配置。 */
export interface CalibrateLoopOptions {
  /** 模板包目录（SceneSpec 1.0 replica；原始内容一致）。 */
  bundleDir: string;
  /** 最大迭代次数（默认 3；上限 5）。 */
  iterations?: number;
  /** 共享调用预算：最大请求数（默认 5）。 */
  maxRequests?: number;
  /** 总耗时预算（毫秒）。 */
  timeoutMs?: number;
  /** 补丁提案 provider（默认确定性建议器；真实校准注入模型实现）。 */
  proposalProvider?: ProposalProvider;
  /** 最小改善幅度（全页 mismatchRatio 下降至少此值才算有效改善）。 */
  minImprovement?: number;
  /** 关键区域（默认全部区域不可回退超过容差）。 */
  regionRegressionTolerance?: number;
  signal?: AbortSignal;
  logger?: Logger;
}

/** 校准循环结果（写入 report.calibration 字段组）。 */
export interface CalibrationRoundRecord {
  round: number;
  /** 本轮补丁（T14 schema 原样保存）。 */
  patch: unknown;
  /** 硬约束检查结果。 */
  constraints: {
    passed: boolean;
    /** 违反项描述。 */
    violations: string[];
  };
  /** 前后评分（全页 + 区域）。 */
  before: { mismatchRatio: number; regions: RegionScore[] };
  after: { mismatchRatio: number; regions: RegionScore[] };
  /** 改善量（before.mismatchRatio - after.mismatchRatio；正值=改善）。 */
  improvement: number;
  accepted: boolean;
  /** 接受/拒绝原因。 */
  reason: string;
  /** 本轮快照序号（接受时存在）。 */
  snapshotIndex?: number;
}

export interface CalibrationLoopResult {
  runId: string;
  status: "pass" | "needs_review" | "failed";
  /** 实际执行轮次。 */
  rounds: CalibrationRoundRecord[];
  /** 停止原因。 */
  stopReason:
    | "completed"
    | "no_improvement"
    | "budget_exhausted"
    | "timeout"
    | "aborted"
    | "invalid_patch"
    | "proposal_unavailable";
  /** 最佳已接受版本的快照序号（至少有起始快照）。 */
  bestSnapshotIndex: number;
  /** 最佳评分（全页 mismatchRatio）。 */
  bestMismatchRatio: number;
  /** 产物路径。 */
  artifacts: string[];
  /** 校准后是否已把最佳版本写回包（accept 后包内容 = 最佳）。 */
  templateUpdated: boolean;
}

/** 校准默认参数（策略参数；写入 evaluation 待样本校准）。 */
export const CALIBRATION_DEFAULTS = {
  defaultIterations: 3,
  maxIterations: 5,
  defaultMaxRequests: 5,
  /** 全页最小改善幅度。 */
  minImprovement: 0.0005,
  /** 区域回退容差（任何区域 mismatchRatio 上升超过此值即拒绝）。 */
  regionRegressionTolerance: 0.002,
} as const;

interface ScoreSnapshot {
  mismatchRatio: number;
  regions: RegionScore[];
}

/** 深拷贝模板包到隔离临时目录（候选评估用；不污染唯一成功包）。 */
async function copyBundleToTemp(bundleDir: string): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "itt-calibrate-"));
  const target = path.join(tempRoot, "candidate");
  await cp(bundleDir, target, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(bundleDir, source);
      // 不复制渲染产物与历史（候选只评估模板+内容）
      return (
        rel === "" ||
        (!rel.startsWith("history") &&
          !rel.startsWith("pages") &&
          !["preview.png", "preview.html", "preview.pdf", "diff.png", "overlay.png", "report.json"].includes(
            path.basename(rel),
          ))
      );
    },
  });
  return target;
}

/** 候选评分结果：视觉分数 + 硬约束指标（与基线对比）。 */
interface CandidateEvaluation extends ScoreSnapshot {
  /** 阻断项数（与基线对比：不允许新增）。 */
  blockers: number;
  /** DOM 正文/可编辑性问题数（与基线对比：不允许增加）。 */
  domIssues: number;
  /** 内容规范化哈希（补丁不得改正文 → 必须与基线一致）。 */
  contentHash: string;
}

/** 计算候选包评分：诊断模式渲染 + 对比（临时目录内完成）。 */
async function scoreCandidate(
  candidateDir: string,
  referenceFile: string,
  options: { signal?: AbortSignal; logger?: Logger },
): Promise<CandidateEvaluation> {
  // 诊断模式渲染：校准动机是基线有差异；阻断项按"无新增"对比而非基线零阻断
  const render = await runRender({
    bundleDir: candidateDir,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    logger: options.logger,
  });

  if (render.status === "failed") {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "calibrate",
      message: `候选渲染失败（阻断项）：${render.findings
        .filter((f) => f.severity === "blocker")
        .map((f) => f.message)
        .join("；")}`,
    });
  }

  const report = render.report as {
    editability?: { issues?: unknown[] };
  };

  const reference = await loadRgba(referenceFile);
  const preview = await loadRgba(path.join(candidateDir, "preview.png"));

  const { compareRgbaImages, DEFAULT_COMPARE_PARAMS } = await import(
    "../quality/compare.js"
  );
  const comparison = await compareRgbaImages(reference, preview, {
    ...DEFAULT_COMPARE_PARAMS,
  });

  const { canonicalContentHash } = await import("../io/json.js");
  const candidateBundle = await readSceneBundle(candidateDir, "calibrate");

  return {
    mismatchRatio: comparison.mismatchRatio,
    regions: scoreRegions(
      reference,
      preview,
      defaultEvalRegions({ width: comparison.width, height: comparison.height }),
    ),
    blockers: render.findings.filter((f) => f.severity === "blocker").length,
    domIssues: report.editability?.issues?.length ?? 0,
    contentHash: canonicalContentHash(candidateBundle.content),
  };
}

/** 硬约束检查（T15 步骤 2：内容哈希不变 + 可编辑性不降低 + 无新增阻断）。 */
function checkHardConstraints(
  before: { blockers: number; contentHash: string; domIssues: number },
  after: { blockers: number; contentHash: string; domIssues: number },
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];

  if (after.contentHash !== before.contentHash) {
    violations.push(`内容哈希发生变化（${before.contentHash.slice(0, 12)}… → ${after.contentHash.slice(0, 12)}…）：补丁不得改正文`);
  }
  if (after.blockers > before.blockers) {
    violations.push(`阻断项增加（${before.blockers} → ${after.blockers}）：不允许新增阻断溢出/遮挡/资源失败`);
  }
  if (after.domIssues > before.domIssues) {
    violations.push(`可编辑性问题增加（${before.domIssues} → ${after.domIssues}）：可编辑性不能降低`);
  }

  return { passed: violations.length === 0, violations };
}

/** 区域回退检查：任一关键区域 mismatchRatio 上升超过容差即拒绝。 */
function checkRegionRegression(
  before: RegionScore[],
  after: RegionScore[],
  tolerance: number,
): { passed: boolean; regression?: { id: string; delta: number } } {
  for (const b of before) {
    const a = after.find((r) => r.id === b.id);
    if (a === undefined) {
      continue;
    }
    const delta = a.mismatchRatio - b.mismatchRatio;
    if (delta > tolerance) {
      return { passed: false, regression: { id: b.id, delta } };
    }
  }
  return { passed: true };
}

/**
 * 执行有限自动校准循环。
 * 包内最终保留最佳已接受版本；每轮记录与快照落盘 history/。
 */
export async function runCalibrationLoop(
  options: CalibrateLoopOptions,
): Promise<CalibrationLoopResult> {
  const runId = newRunId();
  const startedAt = Date.now();

  const bundleDir = path.resolve(options.bundleDir);
  const iterations = Math.min(
    options.iterations ?? CALIBRATION_DEFAULTS.defaultIterations,
    CALIBRATION_DEFAULTS.maxIterations,
  );
  const minImprovement =
    options.minImprovement ?? CALIBRATION_DEFAULTS.minImprovement;
  const regionTolerance =
    options.regionRegressionTolerance ??
    CALIBRATION_DEFAULTS.regionRegressionTolerance;

  const budget = new CallBudget({
    maxRequests: options.maxRequests ?? CALIBRATION_DEFAULTS.defaultMaxRequests,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const proposalProvider =
    options.proposalProvider ?? createDeterministicProposalProvider();

  const log = (message: string, detail?: Record<string, unknown>) =>
    options.logger?.(message, detail);

  // ---- 前置条件：仅原始内容一致的 replica ----
  const bundle = await readSceneBundle(bundleDir, "calibrate");
  const originalHash = (await readJsonFile(
    path.join(bundleDir, "manifest.json"),
    "calibrate",
  ).catch(() => undefined)) as { originalContentSha256?: string } | undefined;

  const currentHash = canonicalContentHash(bundle.content);
  if (
    originalHash?.originalContentSha256 !== undefined &&
    currentHash !== originalHash.originalContentSha256
  ) {
    throw new ImageTemplateError({
      code: "UNSUPPORTED",
      stage: "calibrate",
      message:
        "自动校准仅适用于原始内容一致的 replica 模板包：内容已编辑，请先恢复原始内容或提供新的匹配基准",
      runId,
    });
  }

  const referenceFile = path.join(bundleDir, "reference.png");
  if (!(await stat(referenceFile).then(() => true))) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "calibrate",
      message: `基准图不存在：${referenceFile}（校准需要原图对比）`,
      runId,
    });
  }

  // ---- 起始快照（round 0；禁止候选覆盖唯一成功包的保障）----
  const existingSnapshots = await listSnapshots(bundleDir);
  let snapshotCounter = existingSnapshots.length;
  const baselineSnapshot = await saveSnapshot(bundleDir, {
    index: snapshotCounter + 1,
    round: 0,
    label: "calibrate-baseline",
  });
  snapshotCounter += 1;
  const baselineSnapshotIndex = baselineSnapshot.index;

  // ---- 起始评分（在隔离临时包中渲染，不动包内 preview）----
  const baselineCandidate = await copyBundleToTemp(bundleDir);
  let bestScore: CandidateEvaluation;
  try {
    bestScore = await scoreCandidate(baselineCandidate, referenceFile, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      logger: options.logger,
    });
  } finally {
    await rm(path.dirname(baselineCandidate), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  const rounds: CalibrationRoundRecord[] = [];
  let cumulative: CumulativeChanges = {};
  let bestSnapshotIndex = baselineSnapshotIndex;
  let templateUpdated = false;
  let stopReason: CalibrationLoopResult["stopReason"] = "completed";
  let consecutiveNoImprovement = 0;
  const artifacts: string[] = [];

  // 基线硬约束指标（阻断项/DOM 问题按"无新增"对比；内容哈希必须不变）
  const baseline = bestScore;

  // 起始模板（内存中工作副本；接受时才写回包）
  let workingTemplate: Parameters<typeof applyTemplatePatch>[0] = bundle.spec;

  for (let round = 1; round <= iterations; round += 1) {
    if (options.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    if (budget.exhausted) {
      stopReason = "budget_exhausted";
      break;
    }

    log(`校准第 ${round}/${iterations} 轮`, {});

    // ---- 提案（计入预算）----
    budget.recordRequest(`第 ${round} 轮提案`);
    const proposal = await requestProposal(proposalProvider, {
      referenceImage: await import("node:fs/promises").then((fs) =>
        fs.readFile(referenceFile),
      ),
      previewImage: Buffer.alloc(0), // 区域分数已含差异信息；预览字节由 provider 策略决定
      regionScores: bestScore.regions,
      elements: bundle.spec.elements.map((element) => ({
        id: element.id,
        fields: Object.fromEntries(
          Object.entries(element).filter(
            ([, v]) => typeof v === "number",
          ) as Array<[string, number]>,
        ),
      })),
      width: bundle.spec.canvas.width,
      height: bundle.spec.canvas.height,
    });

    if (!proposal.ok) {
      stopReason = proposal.issues.every((i) => i.code === "SCHEMA")
        ? "invalid_patch"
        : "proposal_unavailable";
      rounds.push({
        round,
        patch: null,
        constraints: { passed: false, violations: proposal.issues.map((i) => i.message) },
        before: bestScore,
        after: bestScore,
        improvement: 0,
        accepted: false,
        reason: `提案无效：${proposal.issues.map((i) => i.message).join("；")}`,
      });
      break;
    }

    // ---- 应用补丁（幅度/白名单/累计校验）----
    const applied = applyTemplatePatch(workingTemplate, proposal.patch, {
      cumulative,
    });
    if (!applied.ok) {
      rounds.push({
        round,
        patch: proposal.patch,
        constraints: {
          passed: false,
          violations: applied.issues.map((i) => i.message),
        },
        before: bestScore,
        after: bestScore,
        improvement: 0,
        accepted: false,
        reason: `补丁被拒绝：${applied.issues.map((i) => i.message).join("；")}`,
      });
      stopReason = "invalid_patch";
      break;
    }

    // ---- 隔离临时包评估 ----
    const candidateDir = await copyBundleToTemp(bundleDir);
    let candidateScore: CandidateEvaluation | undefined;

    try {
      // 候选模板写入临时包
      await writeJsonFileAtomic(
        path.join(candidateDir, "template.json"),
        applied.target,
        "calibrate",
      );

      // 渲染 + 诊断 + 对比（评分含硬约束指标）
      candidateScore = await scoreCandidate(candidateDir, referenceFile, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        logger: options.logger,
      });
    } catch (error) {
      // 候选渲染异常（阻断项等）：记录拒绝并继续下一轮
      rounds.push({
        round,
        patch: proposal.patch,
        constraints: {
          passed: false,
          violations: [(error as Error).message],
        },
        before: bestScore,
        after: bestScore,
        improvement: 0,
        accepted: false,
        reason: `候选评估失败：${(error as Error).message}`,
      });
      continue;
    } finally {
      await rm(path.dirname(candidateDir), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }

    // ---- 硬约束（先于视觉改善）----
    const constraints = checkHardConstraints(
      baseline,
      candidateScore,
    );

    if (!constraints.passed) {
      rounds.push({
        round,
        patch: proposal.patch,
        constraints,
        before: bestScore,
        after: candidateScore!,
        improvement: 0,
        accepted: false,
        reason: `硬约束未通过：${constraints.violations.join("；")}`,
      });
      continue;
    }

    // ---- 区域回退检查 ----
    const regression = checkRegionRegression(
      bestScore.regions,
      candidateScore!.regions,
      regionTolerance,
    );
    if (!regression.passed) {
      rounds.push({
        round,
        patch: proposal.patch,
        constraints,
        before: bestScore,
        after: candidateScore!,
        improvement: 0,
        accepted: false,
        reason: `关键区域 ${regression.regression!.id} 回退 ${(
          regression.regression!.delta * 100
        ).toFixed(3)}%（容差 ${(regionTolerance * 100).toFixed(2)}%）`,
      });
      continue;
    }

    // ---- 视觉改善评价 ----
    const improvement = bestScore.mismatchRatio - candidateScore!.mismatchRatio;
    if (improvement < minImprovement) {
      consecutiveNoImprovement += 1;
      rounds.push({
        round,
        patch: proposal.patch,
        constraints,
        before: bestScore,
        after: candidateScore!,
        improvement,
        accepted: false,
        reason: `改善不足：${(improvement * 100).toFixed(4)}%（要求 ≥ ${(
          minImprovement * 100
        ).toFixed(3)}%）`,
      });
      if (consecutiveNoImprovement >= 2) {
        stopReason = "no_improvement";
        break;
      }
      continue;
    }

    // ---- 接受：更新工作副本 + 原子写回包 + 快照 ----
    workingTemplate = applied.target;
    cumulative = applied.cumulative;
    bestScore = candidateScore;

    await writeJsonFileAtomic(
      path.join(bundleDir, "template.json"),
      applied.target,
      "calibrate",
    );
    templateUpdated = true;

    const snapshot = await saveSnapshot(bundleDir, {
      index: snapshotCounter + 1,
      round,
      label: `round-${round}-accepted`,
    });
    snapshotCounter += 1;
    bestSnapshotIndex = snapshot.index;

    consecutiveNoImprovement = 0;
    rounds.push({
      round,
      patch: proposal.patch,
      constraints,
      before: rounds.length > 0 ? rounds[rounds.length - 1].after : bestScore,
      after: candidateScore!,
      improvement,
      accepted: true,
      reason: `改善 ${(improvement * 100).toFixed(4)}%，无区域回退与新增阻断`,
      snapshotIndex: snapshot.index,
    });

    log(`第 ${round} 轮接受`, { improvement });
  }

  // ---- 耗时/超时检查 ----
  if (stopReason === "completed" && budget.exhausted) {
    stopReason = "budget_exhausted";
  }

  // ---- 最佳版本重新渲染（包内 preview 与最佳模板一致）----
  if (templateUpdated) {
    await runRender({
      bundleDir,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      logger: options.logger,
    }).catch((error) => {
      log("最佳版本重新渲染失败（模板已更新）", {
        error: (error as Error).message,
      });
    });
  }

  // ---- manifest 版本递增（模板变更）----
  const versions = await readBundleVersions(bundleDir, "calibrate");
  const manifestFile = path.join(bundleDir, "manifest.json");
  if (templateUpdated && (await stat(manifestFile).then(() => true))) {
    const manifest = (await readJsonFile(manifestFile, "calibrate")) as Record<
      string,
      unknown
    >;
    await writeJsonFileAtomic(
      manifestFile,
      {
        ...manifest,
        templateVersion: versions.templateVersion + 1,
      },
      "calibrate",
    );
  }

  // ---- 校准记录落盘（history/calibration.json + report 合并）----
  const calibrationRecord = {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    provider: proposalProvider.name,
    iterationsRequested: iterations,
    stopReason,
    bestSnapshotIndex,
    bestMismatchRatio: bestScore.mismatchRatio,
    rounds,
  };

  const historyFile = path.join(bundleDir, "history", "calibration.json");
  await writeJsonFileAtomic(historyFile, calibrationRecord, "calibrate");
  artifacts.push(historyFile);

  // report 合并（保留其他字段组；重写 calibration）
  const reportFile = path.join(bundleDir, "report.json");
  const report = (await stat(reportFile).then(
    () => readJsonFile(reportFile, "calibrate"),
    () => ({}),
  )) as Record<string, unknown>;

  const acceptedCount = rounds.filter((r) => r.accepted).length;
  const status: CalibrationLoopResult["status"] =
    acceptedCount > 0 ? "pass" : "needs_review";

  const mergedReport = {
    ...report,
    schemaVersion: reportSchemaVersion,
    run: {
      ...((report.run as Record<string, unknown>) ?? {}),
      runId,
      stage: "calibrate" as const,
      status,
      startedAt: calibrationRecord.startedAt,
      finishedAt: calibrationRecord.finishedAt,
    },
    calibration: {
      provider: proposalProvider.name,
      stopReason,
      bestSnapshotIndex,
      bestMismatchRatio: bestScore.mismatchRatio,
      rounds: rounds.map((r) => ({
        round: r.round,
        accepted: r.accepted,
        improvement: r.improvement,
        reason: r.reason,
        ...(r.snapshotIndex === undefined ? {} : { snapshotIndex: r.snapshotIndex }),
      })),
    },
  };
  await writeJsonFileAtomic(reportFile, mergedReport, "calibrate");
  artifacts.push(reportFile);

  return {
    runId,
    status,
    rounds,
    stopReason,
    bestSnapshotIndex,
    bestMismatchRatio: bestScore.mismatchRatio,
    artifacts,
    templateUpdated,
  };
}

/** 中断恢复：用最佳快照重新渲染（T15 步骤 6）。 */
export async function restoreBestSnapshot(
  bundleDir: string,
): Promise<{ snapshotIndex: number }> {
  const snapshots = await listSnapshots(bundleDir);
  if (snapshots.length === 0) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "calibrate",
      message: `没有可用快照：${path.join(bundleDir, "history")}`,
    });
  }

  const best = snapshots[snapshots.length - 1];
  await restoreSnapshot(bundleDir, best.index);

  await runRender({ bundleDir }).catch(() => undefined);
  return { snapshotIndex: best.index };
}

export type { ReviewItem };
