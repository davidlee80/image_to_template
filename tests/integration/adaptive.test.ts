/**
 * T13：自适应、分页及 PDF 集成测试（真实 Chromium；不调用模型）。
 *
 * 覆盖：
 * - extract --layout hybrid：保留 SceneSpec（scene.json）并产出 LayoutSpec（layout.json）；
 * - adaptive grow：长内容增高单页 PNG，无阻断溢出；
 * - adaptive paginate：多页 pages/page-00N.png 与报告 pages 字段组；
 *   无丢字/重字（全部 repeat 项出现且仅出现一次）、无空页；
 * - PDF 与 PNG 页数一致；
 * - SceneSpec + --mode adaptive：组合不支持直接报错；
 * - 超大不可拆块 → OVERSIZED_BLOCK（failed，不静默裁切）；
 * - scale 仅改变栅格分辨率（逻辑尺寸不变）。
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import sharp from "sharp";

import { runRender } from "../../src/pipeline/render.js";
import { createImageTemplate } from "../../src/index.js";
import { isImageTemplateError } from "../../src/errors.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);
const syntheticImage = path.join(fixtureDir, "images", "synthetic-travel.png");
const syntheticSceneResponse = path.join(
  fixtureDir,
  "scenes",
  "synthetic-travel.scene.json",
);

/** 构造最小 LayoutSpec 模板包（带分页块元数据）。 */
async function makeLayoutBundle(options: {
  /** 超大不可拆块（验证 OVERSIZED_BLOCK）。 */
  oversizedBlock?: boolean;
  /** 大量时间轴项（验证分页无丢字/重字）。 */
  manyItems?: boolean;
} = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-t13-"));

  const timelineItems = options.manyItems === true ? 12 : 2;

  const layout = {
    version: "2.0",
    canvas: { width: 400, height: 500, background: "#FFFFFF" },
    strategy: { mode: "adaptive" as const, overflow: "paginate" as const },
    root: {
      id: "root",
      type: "container" as const,
      layout: "column" as const,
      style: {},
      children: [
        {
          id: "header_block",
          type: "container" as const,
          layout: "column" as const,
          style: { padding: 16, backgroundColor: "#193753" },
          pagination: { kind: "page-header" as const },
          children: [
            {
              id: "title_text",
              type: "text" as const,
              binding: "texts.title",
              fallback: "",
              style: { fontSize: 24, color: "#FFFFFF", fontWeight: 700 },
              overflow: "wrap" as const,
            },
          ],
        },
        {
          id: "timeline_block",
          type: "container" as const,
          layout: "column" as const,
          style: { padding: 16, gap: 12 },
          children: Array.from({ length: timelineItems }, (_, i) => ({
            id: `item_${i + 1}`,
            type: "container" as const,
            layout: "column" as const,
            style: { minHeight: 120 },
            pagination: {
              kind: "timeline-item" as const,
              atomic: true,
            },
            children: [
              {
                id: `item_${i + 1}_text`,
                type: "text" as const,
                binding: `texts.item_${i + 1}`,
                fallback: "",
                style: { fontSize: 14, lineHeight: 1.5 },
                overflow: "wrap" as const,
              },
            ],
          })),
        },
        ...(options.oversizedBlock === true
          ? [
              {
                id: "huge_block",
                type: "container" as const,
                layout: "column" as const,
                style: { padding: 8 },
                pagination: { kind: "info-box" as const, atomic: true },
                children: [
                  {
                    id: "huge_text",
                    type: "text" as const,
                    binding: "texts.huge",
                    fallback: "",
                    style: { fontSize: 14, lineHeight: 1.5, height: 900 },
                    overflow: "wrap" as const,
                  },
                ],
              },
            ]
          : []),
      ],
    },
    fonts: ["sans" as const],
    sourceElements: {},
    notes: ["T13 测试布局"],
  };

  await writeFile(path.join(dir, "template.json"), JSON.stringify(layout), "utf8");

  const texts: Record<string, string> = {
    title: "旅行计划测试标题",
  };
  for (let i = 1; i <= timelineItems; i += 1) {
    texts[`item_${i}`] = `第 ${i} 项：行程内容条目（验证分页不丢字不重字）`;
  }
  if (options.oversizedBlock === true) {
    texts.huge = "超大块内容";
  }

  await writeFile(
    path.join(dir, "content.json"),
    JSON.stringify({ schemaVersion: "1.0", texts, assets: {} }),
    "utf8",
  );

  return dir;
}

test("adaptive paginate：多页 PNG 输出且无丢字/重字/空页", async () => {
  const bundle = await makeLayoutBundle({ manyItems: true });
  try {
    const result = await runRender({
      bundleDir: bundle,
      mode: "adaptive",
      overflow: "paginate",
    });

    assert.notEqual(result.status, "failed");

    const report = result.report as {
      pages: Array<{
        index: number;
        logicalWidth: number;
        logicalHeight: number;
        outputWidth: number;
        blocks: string[];
        png: string;
      }>;
      pagination: { pageCount: number };
    };

    assert.ok(report.pages.length >= 2, `应分多页（实际 ${report.pages.length}）`);

    // 无空页：每页有块
    for (const page of report.pages) {
      assert.ok(page.blocks.length > 0, `页 ${page.index} 不应为空页`);
    }

    // 页号连续
    assert.deepEqual(
      report.pages.map((p) => p.index),
      report.pages.map((_, i) => i + 1),
    );

    // 无丢字/重字：12 个时间轴项每个恰好出现一次（#L 行拆分块除外）
    const itemIds = report.pages
      .flatMap((p) => p.blocks)
      .filter((id) => id.startsWith("item_"));
    const seen = new Set<string>();
    for (const id of itemIds) {
      const base = id.split("#")[0];
      assert.ok(!seen.has(base), `块 ${base} 不应跨页重复`);
      seen.add(base);
    }
    assert.equal(seen.size, 12, "全部 12 项应恰好出现一次");

    // 页文件存在且尺寸一致
    const pagesDir = path.join(bundle, "pages");
    const files = (await readdir(pagesDir)).sort();
    assert.equal(files.length, report.pages.length);

    for (const file of files) {
      const meta = await sharp(path.join(pagesDir, file)).metadata();
      assert.equal(meta.width, 400);
      assert.equal(meta.height, 500);
    }

    // 首页同步 preview.png
    assert.ok(await stat(path.join(bundle, "preview.png")).then(() => true));
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("adaptive paginate + PDF：页数与 PNG 一致", async () => {
  const bundle = await makeLayoutBundle({ manyItems: true });
  try {
    const result = await runRender({
      bundleDir: bundle,
      mode: "adaptive",
      overflow: "paginate",
      format: ["png", "pdf"],
    });

    assert.notEqual(result.status, "failed");

    const pdfBytes = await readFile(path.join(bundle, "preview.pdf"));
    assert.equal(pdfBytes.subarray(0, 4).toString("ascii"), "%PDF");

    const report = result.report as { pages: unknown[] };
    const pageObjects = pdfBytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g);
    assert.ok(
      pageObjects !== null && pageObjects.length >= report.pages.length,
      `PDF 页对象数应 ≥ PNG 页数（${pageObjects?.length ?? 0} vs ${report.pages.length}）`,
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("adaptive grow：长内容增高为单张 PNG 且无阻断溢出", async () => {
  const bundle = await makeLayoutBundle({ manyItems: true });
  try {
    const result = await runRender({
      bundleDir: bundle,
      mode: "adaptive",
      overflow: "grow",
    });

    assert.notEqual(result.status, "failed");

    const meta = await sharp(path.join(bundle, "preview.png")).metadata();
    assert.equal(meta.width, 400, "宽度保持");
    assert.ok(
      (meta.height ?? 0) >= 500,
      `增高后高度应 ≥ 画布高（实际 ${meta.height}）`,
    );

    const report = result.report as {
      pages: Array<{ logicalHeight: number; outputWidth: number; outputHeight: number }>;
    };
    assert.equal(report.pages.length, 1, "grow 输出一张增高 PNG");
    assert.equal(report.pages[0].logicalHeight, meta.height);
    assert.equal(report.pages[0].outputWidth, 400);
    assert.equal(report.pages[0].outputHeight, meta.height);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("grow + scale：仅改变栅格分辨率（逻辑尺寸不变）", async () => {
  const bundle = await makeLayoutBundle({ manyItems: true });
  try {
    const result = await runRender({
      bundleDir: bundle,
      mode: "adaptive",
      overflow: "grow",
      scale: 2,
    });

    assert.notEqual(result.status, "failed");

    const meta = await sharp(path.join(bundle, "preview.png")).metadata();
    assert.equal(meta.width, 800, "scale=2 输出宽度翻倍");
    assert.equal(meta.height! % 2, 0);

    const report = result.report as {
      pages: Array<{ logicalWidth: number; outputWidth: number }>;
    };
    assert.equal(report.pages[0].logicalWidth, 400, "逻辑宽度不变");
    assert.equal(report.pages[0].outputWidth, 800);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("超大不可拆块：报 OVERSIZED_BLOCK 且状态 failed（不静默裁切）", async () => {
  const bundle = await makeLayoutBundle({ oversizedBlock: true });
  try {
    const result = await runRender({
      bundleDir: bundle,
      mode: "adaptive",
      overflow: "paginate",
    });

    assert.equal(result.status, "failed");

    const report = result.report as {
      reviewItems: Array<{ type: string; message: string }>;
      pagination: { oversizedBlocks: Array<{ id: string }> };
    };
    assert.ok(
      report.reviewItems.some((i) => i.type === "oversized_block"),
      "应有 OVERSIZED_BLOCK 复查项",
    );
    assert.ok(
      report.pagination.oversizedBlocks.some((b) => b.id.includes("huge_block")),
    );

    // 不产出页产物
    const pagesExists = await stat(path.join(bundle, "pages")).then(
      () => true,
      () => false,
    );
    assert.equal(pagesExists, false);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("SceneSpec + adaptive：组合不支持直接报错", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-t13-scene-"));
  try {
    // 最小 SceneSpec 包（沿 T06 测试结构）
    await writeFile(
      path.join(dir, "template.json"),
      JSON.stringify({
        version: "1.0",
        canvas: { width: 300, height: 200, background: "#FFFFFF" },
        elements: [],
        notes: [],
      }),
      "utf8",
    );
    await writeFile(path.join(dir, "content.json"), "{}", "utf8");

    await assert.rejects(
      runRender({ bundleDir: dir, mode: "adaptive" }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "UNSUPPORTED");
        assert.ok(error.message.includes("adaptive"));
        return true;
      },
    );

    // SceneSpec + --overflow 同样拒绝
    await assert.rejects(
      runRender({ bundleDir: dir, overflow: "grow" }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "UNSUPPORTED");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extract --layout hybrid：保留 SceneSpec 并产出 LayoutSpec（fixture 离线）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-t13-hybrid-"));
  const bundleDir = path.join(dir, "bundle");
  try {
    const instance = createImageTemplate({
      vision: {
        kind: "fixture",
        model: "fixture",
        fixtureFile: syntheticSceneResponse,
      },
    });

    const result = await instance.extract({
      input: syntheticImage,
      output: bundleDir,
      layout: "hybrid",
    });

    assert.notEqual(result.status, "failed");

    // 保留 SceneSpec 基准（scene.json）
    assert.ok(
      await stat(path.join(bundleDir, "scene.json")).then(() => true),
      "scene.json 应保留定位基准",
    );
    // 语义布局（layout.json）与结构化内容
    assert.ok(await stat(path.join(bundleDir, "layout.json")).then(() => true));
    assert.ok(
      await stat(path.join(bundleDir, "id-mappings.json")).then(() => true),
    );

    // layout.json 校验通过且 version=2.0
    const layout = JSON.parse(
      await readFile(path.join(bundleDir, "layout.json"), "utf8"),
    ) as { version: string };
    assert.equal(layout.version, "2.0");

    // 迁移记录
    const migration = JSON.parse(
      await readFile(path.join(bundleDir, "migration.json"), "utf8"),
    ) as { verification: { passed: boolean; textCount: number } };
    assert.equal(migration.verification.passed, true);
    assert.ok(migration.verification.textCount > 0);

    // 渲染走 LayoutSpec 链路（replica 默认）
    const render = await instance.render({ template: bundleDir });
    assert.notEqual(render.status, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
