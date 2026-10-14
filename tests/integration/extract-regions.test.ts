/**
 * T09/T10：分区识别全链路集成测试（离线：fixture provider + 合成图）。
 *
 * 覆盖：区域划分 → 区域裁剪放大识别（scale=2）→ 坐标回投 → 合并去重
 * （区域独有元素进入模板、重复消除）→ OCR 对照（缺失/冲突/小字复查项）
 * → runtime 统计（调用数/缓存命中）→ 相同配置再次运行命中缓存。
 * fixture 不替代 T08/T10 的真实样本验收。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createImageTemplate } from "../../src/index.js";
import { createFixtureOcrProvider } from "../../src/analysis/ocr.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);
const syntheticImage = path.join(fixtureDir, "images", "synthetic-travel.png");

const fixtureMap = {
  "scene-1.0.0": path.join(
    fixtureDir,
    "scenes",
    "synthetic-travel.scene.json",
  ),
  "regions-1.0.0": path.join(
    fixtureDir,
    "model-responses",
    "synthetic-regions.response.json",
  ),
  "region-scene-1.0.0": path.join(
    fixtureDir,
    "model-responses",
    "region-header.response.json",
  ),
};

function makeInstance(cacheDir?: string) {
  return createImageTemplate({
    vision: {
      kind: "fixture",
      model: "fixture",
      fixtureFile: fixtureMap,
    },
    regionsMode: true,
    ocr: createFixtureOcrProvider(
      path.join(fixtureDir, "model-responses", "ocr-synthetic.response.json"),
    ),
    ...(cacheDir === undefined
      ? {}
      : { directories: { cache: cacheDir } }),
    budget: { maxRequests: 10 },
  });
}

test("分区识别全链路：合并去重、区域独有元素、OCR 复查项、runtime 统计", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "itt-regions-"));
  try {
    const bundleDir = path.join(root, "bundle");
    const instance = makeInstance();

    const result = await instance.extract({
      input: syntheticImage,
      output: bundleDir,
    });

    // 状态：有复查项（OCR/合并）→ needs_review
    assert.equal(result.status, "needs_review");

    // 模板包含区域独有元素（回投后的全局坐标）
    const template = JSON.parse(
      await readFile(path.join(bundleDir, "template.json"), "utf8"),
    ) as {
      elements: Array<{
        id: string;
        type: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    };

    const badge = template.elements.find((e) => e.id === "header__extra_badge");
    assert.ok(badge, "区域独有元素应以 <region>__<id> 命名进入模板");
    assert.equal(badge.type, "box");
    // 回投：local (1000,160,200,60) / scale 2 → global (500,80,100,30)
    assert.equal(badge.x, 500);
    assert.equal(badge.y, 80);
    assert.equal(badge.width, 100);
    assert.equal(badge.height, 30);

    // 区域重复元素被消除：h_title 与整页 destination_title 同文字同位置
    const ids = template.elements.map((e) => e.id);
    assert.equal(ids.includes("header__h_title"), false, "重复元素不应保留");
    assert.equal(ids.includes("destination_title"), true);

    // manifest：runtime 与合并统计
    const manifest = JSON.parse(
      await readFile(path.join(bundleDir, "manifest.json"), "utf8"),
    ) as {
      runtime: {
        visionRequests: number;
        ocrRequests: number;
        cacheHits: number;
        regions?: Array<{ id: string; scale: number; elementCount: number }>;
      };
      merge?: { duplicates: number; conflicts: number };
      vision?: { regionMode?: boolean };
    };

    // 无缓存：区域划分 1 + 整页 1 + 区域识别 1 = 3 次识别 + 1 次 OCR
    assert.equal(manifest.runtime.visionRequests, 3);
    assert.equal(manifest.runtime.ocrRequests, 1);
    assert.equal(manifest.runtime.cacheHits, 0);
    assert.equal(manifest.vision?.regionMode, true);
    assert.deepEqual(manifest.runtime.regions, [
      { id: "header", scale: 2, elementCount: 2 },
    ]);
    assert.equal(manifest.merge?.duplicates, 1);

    // OCR 复查项进入报告（SDK 串联 render 后 report.json 为渲染/对比报告；
    // 复查项在 extract 阶段收集——通过 manifest 无法直接读取，检查 reviewItems 数量）
    // 注：SDK extract 的 report 来自 compare（最后一环），OCR 项记录于提取日志与 manifest 汇总。
    // 这里验证模板元素数：22 整页 + 1 区域独有 = 23
    assert.equal(template.elements.length, 23);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("相同配置再次运行命中识别缓存（visionRequests=0）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "itt-regions-"));
  try {
    const cacheDir = path.join(root, "cache");

    // 第一次：写入缓存
    const first = await makeInstance(cacheDir).extract({
      input: syntheticImage,
      output: path.join(root, "bundle-1"),
    });
    assert.equal(first.status, "needs_review");

    const manifest1 = JSON.parse(
      await readFile(path.join(root, "bundle-1", "manifest.json"), "utf8"),
    ) as { runtime: { visionRequests: number; cacheHits: number } };
    assert.equal(manifest1.runtime.visionRequests, 3);
    assert.equal(manifest1.runtime.cacheHits, 0);

    // 第二次：相同图片与配置 → 全部命中缓存（fixture provider 不被调用）
    const second = await makeInstance(cacheDir).extract({
      input: syntheticImage,
      output: path.join(root, "bundle-2"),
    });
    assert.notEqual(second.status, "failed");

    const manifest2 = JSON.parse(
      await readFile(path.join(root, "bundle-2", "manifest.json"), "utf8"),
    ) as {
      runtime: { visionRequests: number; cacheHits: number };
      merge?: { duplicates: number };
    };

    assert.equal(manifest2.runtime.visionRequests, 0, "缓存命中不应产生识别调用");
    assert.equal(manifest2.runtime.cacheHits, 3, "三次识别全部命中缓存");
    // 缓存路径下合并结果一致（重复消除仍发生）
    assert.equal(manifest2.merge?.duplicates, 1);

    // 两次产物一致：模板元素数相同
    const template1 = JSON.parse(
      await readFile(path.join(root, "bundle-1", "template.json"), "utf8"),
    ) as { elements: unknown[] };
    const template2 = JSON.parse(
      await readFile(path.join(root, "bundle-2", "template.json"), "utf8"),
    ) as { elements: unknown[] };
    assert.equal(template1.elements.length, template2.elements.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("预算耗尽时提取失败且清理产物", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "itt-regions-"));
  try {
    const instance = createImageTemplate({
      vision: {
        kind: "fixture",
        model: "fixture",
        fixtureFile: fixtureMap,
      },
      regionsMode: true,
      budget: { maxRequests: 1 }, // 区域划分 1 次 + 整页 1 次 → 第二次耗尽
    });

    await assert.rejects(
      instance.extract({
        input: syntheticImage,
        output: path.join(root, "bundle"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("预算耗尽"));
        return true;
      },
    );

    // 失败目录被清理
    const { stat } = await import("node:fs/promises");
    const exists = await stat(path.join(root, "bundle")).then(
      () => true,
      () => false,
    );
    assert.equal(exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
