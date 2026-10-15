/**
 * Agent 自动提取支持测试：validate-spec 命令与模拟 agent 修复循环。
 *
 * 覆盖（AGENTS.md 规程的可执行验证）：
 * - validate-spec：合法 spec 通过（元素统计）；非法 spec 失败（消息带路径可定点修复）；
 *   画布尺寸不一致失败；--json 输出结构；
 * - 模拟 agent 循环：坏 spec（越界）→ validate-spec 失败 → 按错误消息修复
 *   → validate-spec 通过 → extract --spec 成功（验证"错误可回贴修复"闭环）。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { cliMain } from "../../src/cli.js";
import { validateManualSpec } from "../../src/analysis/manual-spec.js";
import { createImageTemplate } from "../../src/index.js";

const syntheticImage = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "images",
  "synthetic-travel.png",
);

function validSpec() {
  return {
    version: "1.0",
    canvas: { width: 800, height: 600, background: "#FFFFFF" },
    elements: [
      {
        id: "title",
        type: "text",
        x: 40,
        y: 22,
        width: 420,
        height: 42,
        zIndex: 2,
        confidence: 0.95,
        text: "本溪水洞 · 天桥沟",
        fontSize: 30,
        fontFamily: "sans",
        fontWeight: "700",
        lineHeight: 1.4,
        letterSpacing: 0,
        color: "#FFFFFF",
        align: "left",
      },
      {
        id: "photo",
        type: "image",
        x: 560,
        y: 148,
        width: 200,
        height: 130,
        zIndex: 1,
        confidence: 0.9,
        src: "",
      },
      {
        id: "header_bg",
        type: "box",
        x: 0,
        y: 0,
        width: 800,
        height: 80,
        zIndex: 0,
        confidence: 0.9,
        fill: "#193753",
      },
    ],
    notes: [],
  };
}

test("validate-spec：合法 spec 通过并给出元素统计", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-vs-ok-"));
  try {
    const specFile = path.join(dir, "spec.json");
    await writeFile(specFile, JSON.stringify(validSpec()), "utf8");

    const result = await validateManualSpec({ specFile, imagePath: syntheticImage });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.stats.elements, 3);
      assert.equal(result.stats.texts, 1);
      assert.equal(result.stats.images, 1);
      assert.equal(result.stats.boxes, 1);
      assert.ok(result.summary.includes("800×600"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate-spec：越界元素失败且消息带路径", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-vs-bad-"));
  try {
    const spec = validSpec();
    // 制造越界：y=590 + height=60 > 600
    spec.elements[0].y = 590;
    const specFile = path.join(dir, "spec.json");
    await writeFile(specFile, JSON.stringify(spec), "utf8");

    const result = await validateManualSpec({ specFile, imagePath: syntheticImage });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.message.includes("OUT_OF_CANVAS"));
      assert.ok(result.message.includes("elements[0]"), "消息应带元素索引路径");
      assert.ok(result.message.includes("title"), "消息应点名元素 ID");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate-spec：画布尺寸不一致失败", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-vs-canvas-"));
  try {
    const spec = validSpec();
    spec.canvas = { width: 1060, height: 1500, background: "#FFFFFF" };
    const specFile = path.join(dir, "spec.json");
    await writeFile(specFile, JSON.stringify(spec), "utf8");

    const result = await validateManualSpec({ specFile, imagePath: syntheticImage });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.message.includes("1060"));
      assert.ok(result.message.includes("800"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI validate-spec：退出码与输出", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-vs-cli-"));
  const captured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") captured.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    return true;
  }) as typeof process.stderr.write;

  try {
    // 合法 → 0
    const goodFile = path.join(dir, "good.json");
    await writeFile(goodFile, JSON.stringify(validSpec()), "utf8");
    captured.length = 0;
    const good = await cliMain(["validate-spec", goodFile, syntheticImage]);
    assert.equal(good, 0);
    assert.ok(captured.join("").includes("text 1"));

    // 非法 → 1（参数错误才是 64；校验失败是执行失败 1）
    const badSpec = validSpec();
    badSpec.elements[1].y = 700; // 越界
    const badFile = path.join(dir, "bad.json");
    await writeFile(badFile, JSON.stringify(badSpec), "utf8");
    captured.length = 0;
    const bad = await cliMain(["validate-spec", badFile, syntheticImage]);
    assert.equal(bad, 1);

    // 缺参数 → 64
    const missingArg = await cliMain(["validate-spec"]);
    assert.equal(missingArg, 64);

    // --json 输出可解析
    captured.length = 0;
    const jsonCode = await cliMain([
      "validate-spec",
      goodFile,
      syntheticImage,
      "--json",
    ]);
    assert.equal(jsonCode, 0);
    const parsed = JSON.parse(captured.join("")) as { valid: boolean; stats: unknown };
    assert.equal(parsed.valid, true);
    assert.ok(parsed.stats);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    await rm(dir, { recursive: true, force: true });
  }
});

test("模拟 agent 修复循环：坏 spec → 校验失败 → 修复 → 提取成功", async () => {
  // 模拟 AGENTS.md 第 3～4 步的自修复闭环：
  // agent 拿到带错误的 spec → validate-spec 报错（读消息修复）→ 通过后 extract
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-agent-loop-"));
  const bundleDir = path.join(dir, "bundle");
  const agentDir = path.join(dir, ".agent");
  try {
    await import("node:fs/promises").then((fs) => fs.mkdir(agentDir, { recursive: true }));
    const specFile = path.join(agentDir, "spec.json");

    // --- 第 1 轮：agent 生成的 spec 带两处错误（越界 + 重复 ID）---
    const broken = validSpec();
    broken.elements[0].y = 580; // 越界（580+42 > 600）
    broken.elements.push({ ...broken.elements[2], id: "header_bg" }); // 重复 ID
    await writeFile(specFile, JSON.stringify(broken), "utf8");

    const round1 = await validateManualSpec({ specFile, imagePath: syntheticImage });
    assert.equal(round1.ok, false);
    if (!round1.ok) {
      // agent 读消息应能定位两类错误
      assert.ok(round1.message.includes("OUT_OF_CANVAS"));
      assert.ok(round1.message.includes("DUPLICATE_ID"));
    }

    // --- 第 2 轮：agent 按错误消息修复（只改点名的元素）---
    const fixed = JSON.parse(await readFile(specFile, "utf8")) as ReturnType<typeof validSpec>;
    // 修复 1：把越界的 title 挪回画布内
    fixed.elements[0].y = 22;
    // 修复 2：删除重复元素（保留原始 header_bg，删除追加的副本）
    fixed.elements.pop();

    // 第 2 轮仍故意留一处错误（模拟多轮修复）：
    fixed.elements[1].width = 400; // photo: 560+400 > 800 越界
    await writeFile(specFile, JSON.stringify(fixed), "utf8");

    const round2 = await validateManualSpec({ specFile, imagePath: syntheticImage });
    assert.equal(round2.ok, false, "第 2 轮应仍报 photo 越界");
    if (!round2.ok) {
      assert.ok(round2.message.includes("photo"), "应点名 photo 元素");
    }

    // --- 第 3 轮：修复 photo 宽度 → 通过 ---
    fixed.elements[1].width = 200;
    await writeFile(specFile, JSON.stringify(fixed), "utf8");

    const round3 = await validateManualSpec({ specFile, imagePath: syntheticImage });
    assert.equal(round3.ok, true, "第 3 轮应通过");

    // --- 第 4 步：extract --spec 成功（完整管线）---
    const instance = createImageTemplate();
    const result = await instance.extract({
      input: syntheticImage,
      output: bundleDir,
      spec: specFile,
    });
    assert.notEqual(result.status, "failed");

    // 正文分离生效（agent spec 的 text 进 content.json）
    const content = JSON.parse(
      await readFile(path.join(bundleDir, "content.json"), "utf8"),
    ) as Record<string, string>;
    assert.equal(content.title, "本溪水洞 · 天桥沟");

    // 素材自动裁剪
    assert.ok(
      await stat(path.join(bundleDir, "assets", "photo.png")).then(() => true),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
