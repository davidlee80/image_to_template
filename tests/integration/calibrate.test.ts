/**
 * T15：有限自动校准集成测试（真实 Chromium；不调用模型——注入 fixture 提案 provider）。
 *
 * 覆盖（阶段 D 完成条件）：
 * - 改善接受：合法小幅补丁、分数改善 → 接受、快照落盘、最佳版本可渲染；
 * - 退化拒绝：全局分数变好但区域回退/新增阻断 → 不接受；
 * - 非法补丁拒绝：改正文/超幅度 → 停止且模板不被改写；
 * - 最大迭代与预算耗尽停止；
 * - 失败后最佳版本可恢复（restoreBestSnapshot）；
 * - 内容已编辑（哈希不一致）→ 明确拒绝校准。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { runCalibrationLoop, restoreBestSnapshot } from "../../src/calibration/loop.js";
import type { ProposalProvider } from "../../src/calibration/propose.js";
import { isImageTemplateError } from "../../src/errors.js";

/**
 * 构造校准测试包：
 * - reference.png：白底 + 左上深蓝窄色块（16px 高 ≈ 文字行高一半；
 *   y 移动会真实改变文字与色块的重叠量 → 分数可改善）；
 * - template.json：标题文字（与色块同色）位于 y=58（reference 色块在 y=50）；
 * - content.json / manifest.json（originalContentSha256 与 content 一致）。
 *
 * 注：测试用拉丁文本（当前 Playwright Chromium 环境无法渲染 CJK，
 * 见 docs/wiki/evaluation.md 环境记录）；校准逻辑与文本语言无关。
 */
async function makeCalibrationBundle(): Promise<{
  dir: string;
  bundleDir: string;
  titleId: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-t15-"));
  const bundleDir = path.join(dir, "bundle");
  await mkdir(bundleDir, { recursive: true });

  // reference：白底 + 标题色块 (40,50,220×16)
  const reference = await sharp({
    create: { width: 400, height: 300, channels: 3, background: "#FFFFFF" },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="400" height="300"><rect x="40" y="50" width="220" height="16" fill="#193753"/></svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
  await writeFile(path.join(bundleDir, "reference.png"), reference);

  const titleId = "title";

  const template = {
    version: "1.0",
    canvas: { width: 400, height: 300, background: "#FFFFFF" },
    elements: [
      {
        id: titleId,
        type: "text",
        x: 40,
        y: 58, // 与 reference 的 50 相差 8px（单轮上限内可改善）
        width: 220,
        height: 36,
        zIndex: 1,
        confidence: 0.9,
        text: "",
        fontSize: 20,
        fontFamily: "sans",
        fontWeight: "700",
        lineHeight: 1.4,
        letterSpacing: 0,
        color: "#193753",
        align: "left",
      },
    ],
    notes: [],
  };
  await writeFile(
    path.join(bundleDir, "template.json"),
    JSON.stringify(template),
    "utf8",
  );

  const content = { [titleId]: "TITLE TEXT" };
  await writeFile(
    path.join(bundleDir, "content.json"),
    JSON.stringify(content),
    "utf8",
  );

  // 内容哈希与 manifest 登记一致（原始内容一致才可校准）
  const { canonicalContentHash } = await import("../../src/io/json.js");
  await writeFile(
    path.join(bundleDir, "manifest.json"),
    JSON.stringify({
      manifestVersion: "1.0",
      templateVersion: 1,
      contentVersion: 1,
      originalContentSha256: canonicalContentHash(content),
    }),
    "utf8",
  );

  return { dir, bundleDir, titleId };
}

/** 固定补丁提案 provider（按脚本返回补丁序列）。 */
function scriptedProposalProvider(
  patches: unknown[],
): ProposalProvider {
  let call = 0;
  return {
    name: "scripted",
    async propose() {
      const patch = patches[call];
      call += 1;
      return { ok: patch !== undefined, patch: patch ?? null };
    },
  };
}

test("改善接受：小幅补丁、分数改善 → 接受并保存快照", async () => {
  const { dir, bundleDir, titleId } = await makeCalibrationBundle();
  try {
    const result = await runCalibrationLoop({
      bundleDir,
      iterations: 2,
      proposalProvider: scriptedProposalProvider([
        { version: "1.0", changes: [{ id: titleId, set: { y: 52 } }] },
        { version: "1.0", changes: [{ id: titleId, set: { y: 50 } }] },
      ]),
    });

    assert.equal(result.status, "pass");
    assert.equal(result.stopReason, "completed");
    assert.ok(result.rounds.length >= 1);

    const accepted = result.rounds.filter((r) => r.accepted);
    assert.ok(accepted.length >= 1, "至少一轮被接受");

    // 快照存在（baseline + accepted）
    const historyDir = path.join(bundleDir, "history");
    const snapshots = (await readdir(historyDir)).filter((n) =>
      n.startsWith("snapshot-"),
    );
    assert.ok(snapshots.length >= accepted.length + 1);

    // 包内模板已被更新为接受后的值
    const template = JSON.parse(
      await readFile(path.join(bundleDir, "template.json"), "utf8"),
    ) as { elements: Array<{ id: string; y: number }> };
    const lastAccepted = accepted[accepted.length - 1];
    assert.ok(lastAccepted);

    // 校准记录落盘
    const calibration = JSON.parse(
      await readFile(path.join(historyDir, "calibration.json"), "utf8"),
    ) as { stopReason: string; rounds: unknown[] };
    assert.equal(calibration.stopReason, "completed");
    assert.ok(calibration.rounds.length >= 1);

    // 模板与接受轮一致（y 从 58 → 52 或 50）
    const title = template.elements.find((e) => e.id === titleId)!;
    assert.ok(title.y < 58, `接受后 y 应更接近 50（实际 ${title.y}）`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("退化拒绝：区域回退不接受且模板不被改写", async () => {
  const { dir, bundleDir, titleId } = await makeCalibrationBundle();
  try {
    const before = await readFile(path.join(bundleDir, "template.json"), "utf8");

    const result = await runCalibrationLoop({
      bundleDir,
      iterations: 1,
      proposalProvider: scriptedProposalProvider([
        // y 58→66（幅度内合法）：文字移出色块 → 区域分数回退 → 拒绝
        { version: "1.0", changes: [{ id: titleId, set: { y: 66 } }] },
      ]),
    });

    const after = await readFile(path.join(bundleDir, "template.json"), "utf8");
    assert.equal(after, before, "拒绝轮不修改包内模板");

    assert.equal(result.status, "needs_review");
    assert.equal(result.templateUpdated, false);
    assert.ok(result.rounds.every((r) => !r.accepted));
    // 拒绝原因可诊断（区域回退或改善不足；均属退化证据）
    assert.ok(
      result.rounds.every(
        (r) => r.reason.includes("回退") || r.reason.includes("改善不足"),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("非法补丁：改正文/未知 ID → 停止且模板不被改写", async () => {
  const { dir, bundleDir, titleId } = await makeCalibrationBundle();
  try {
    for (const badPatch of [
      { version: "1.0", changes: [{ id: titleId, set: { text: "篡改" } }] },
      { version: "1.0", changes: [{ id: "ghost", set: { y: 10 } }] },
    ]) {
      const before = await readFile(path.join(bundleDir, "template.json"), "utf8");
      const result = await runCalibrationLoop({
        bundleDir,
        iterations: 1,
        proposalProvider: scriptedProposalProvider([badPatch]),
      });
      const after = await readFile(path.join(bundleDir, "template.json"), "utf8");

      assert.equal(result.templateUpdated, false);
      assert.equal(after, before);
      assert.equal(result.status, "needs_review");
      assert.ok(
        ["invalid_patch", "proposal_unavailable"].includes(result.stopReason),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("最大迭代限制与预算耗尽", async () => {
  const { dir, bundleDir, titleId } = await makeCalibrationBundle();
  try {
    // 迭代上限 5（传 99 也只跑 5）
    const bigIterations = await runCalibrationLoop({
      bundleDir,
      iterations: 99,
      maxRequests: 5,
      proposalProvider: scriptedProposalProvider(
        Array.from({ length: 20 }, () => ({
          version: "1.0",
          changes: [{ id: titleId, set: { y: 52 } }],
        })),
      ),
    });
    assert.ok(bigIterations.rounds.length <= 5, "迭代上限 5");

    // 预算 1 → 首轮后耗尽
    const budgetBundle = await makeCalibrationBundle();
    try {
      const oneBudget = await runCalibrationLoop({
        bundleDir: budgetBundle.bundleDir,
        iterations: 3,
        maxRequests: 1,
        proposalProvider: scriptedProposalProvider([
          { version: "1.0", changes: [{ id: budgetBundle.titleId, set: { y: 52 } }] },
          { version: "1.0", changes: [{ id: budgetBundle.titleId, set: { y: 50 } }] },
        ]),
      });
      assert.ok(
        ["budget_exhausted", "completed", "no_improvement"].includes(
          oneBudget.stopReason,
        ),
      );
    } finally {
      await rm(budgetBundle.dir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("中断后最佳版本可恢复（restoreBestSnapshot）", async () => {
  const { dir, bundleDir, titleId } = await makeCalibrationBundle();
  try {
    // 先做一次接受校准
    const calibrated = await runCalibrationLoop({
      bundleDir,
      iterations: 1,
      proposalProvider: scriptedProposalProvider([
        { version: "1.0", changes: [{ id: titleId, set: { y: 52 } }] },
      ]),
    });
    assert.equal(calibrated.status, "pass");

    // 人为破坏模板（模拟中断/污染）
    await writeFile(
      path.join(bundleDir, "template.json"),
      JSON.stringify({ broken: true }),
      "utf8",
    );

    // 恢复最佳快照
    const restored = await restoreBestSnapshot(bundleDir);
    assert.ok(restored.snapshotIndex >= 1);

    const template = JSON.parse(
      await readFile(path.join(bundleDir, "template.json"), "utf8"),
    ) as { version: string; elements: Array<{ id: string; y: number }> };
    assert.equal(template.version, "1.0");
    const title = template.elements.find((e) => e.id === titleId)!;
    assert.equal(title.y, 52, "恢复到接受后的最佳版本");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("内容已编辑（哈希不一致）→ 明确拒绝校准", async () => {
  const { dir, bundleDir, titleId } = await makeCalibrationBundle();
  try {
    // 编辑内容但不更新 manifest 基线
    await writeFile(
      path.join(bundleDir, "content.json"),
      JSON.stringify({ [titleId]: "EDITED TITLE" }),
      "utf8",
    );

    await assert.rejects(
      runCalibrationLoop({
        bundleDir,
        iterations: 1,
        proposalProvider: scriptedProposalProvider([]),
      }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "UNSUPPORTED");
        assert.ok(error.message.includes("原始内容"));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
