/**
 * T04：提取流水线集成测试（离线：fixture provider + 合成图）。
 *
 * 覆盖：完整模板包产物（reference/template/content/content.schema/manifest/assets）、
 * 正文仅由 content 驱动（模板 text 清空）、manifest 可追溯每个素材、
 * 输出目录冲突、异常产物清理、文字与图片相交生成复查项。
 * fixture 不替代 T08 的真实识别验收。
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import sharp from "sharp";

import { runExtraction } from "../../src/pipeline/extract.js";
import { createFixtureVisionProvider } from "../../src/analysis/vision.js";
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
const overlappingSceneResponse = path.join(
  fixtureDir,
  "model-responses",
  "overlapping-scene.response.json",
);

async function withTempBundle<T>(
  fn: (dir: string, bundleDir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-extract-"));
  try {
    return await fn(dir, path.join(dir, "bundle"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("完整模板包产物与内容分离", async () => {
  await withTempBundle(async (_dir, bundleDir) => {
    const result = await runExtraction({
      inputPath: syntheticImage,
      outputDir: bundleDir,
      provider: createFixtureVisionProvider(syntheticSceneResponse),
    });

    // 产物清单
    assert.ok(await stat(path.join(bundleDir, "reference.png")).then(() => true));
    assert.ok(await stat(path.join(bundleDir, "template.json")).then(() => true));
    assert.ok(await stat(path.join(bundleDir, "content.json")).then(() => true));
    assert.ok(
      await stat(path.join(bundleDir, "content.schema.json")).then(() => true),
    );
    assert.ok(await stat(path.join(bundleDir, "manifest.json")).then(() => true));

    // 内容分离：模板 text 全部清空，正文仅由 content 驱动
    const template = JSON.parse(
      await readFile(path.join(bundleDir, "template.json"), "utf8"),
    ) as { elements: Array<{ type: string; id: string; text?: string }> };
    const texts = template.elements.filter((e) => e.type === "text");
    assert.ok(texts.length > 0);
    for (const text of texts) {
      assert.equal(text.text, "", `元素 ${text.id} 的正文应已移入 content.json`);
    }

    const content = JSON.parse(
      await readFile(path.join(bundleDir, "content.json"), "utf8"),
    ) as Record<string, string>;
    assert.equal(content["destination_title"], "本溪水洞 · 天桥沟");
    assert.equal(Object.keys(content).length, texts.length);

    // 素材：合成场景包含 2 个 image 元素
    const assetsDir = path.join(bundleDir, "assets");
    const assetFiles = await readdir(assetsDir);
    assert.equal(assetFiles.length, 2);
    assert.ok(assetFiles.includes("photo_trail.png"));
    assert.ok(assetFiles.includes("photo_cave.png"));

    // 模板 image src 指向包内相对路径
    const images = template.elements.filter((e) => e.type === "image");
    for (const image of images) {
      const src = (image as unknown as { src: string }).src;
      assert.ok(src.startsWith("assets/"), `image src 应为包内相对路径：${src}`);
    }

    // manifest 可追溯每个素材
    const manifest = JSON.parse(
      await readFile(path.join(bundleDir, "manifest.json"), "utf8"),
    ) as {
      assets: Array<{
        id: string;
        file: string;
        sourceRect: { left: number; top: number; width: number; height: number };
        sha256: string;
        clippedByCanvas: boolean;
      }>;
      originalContentSha256: string;
      templateVersion: number;
      contentVersion: number;
      input: { normalizedSha256: string };
    };
    assert.equal(manifest.assets.length, 2);
    assert.equal(manifest.templateVersion, 1);
    assert.equal(manifest.contentVersion, 1);
    assert.ok(manifest.originalContentSha256.length === 64);

    const trail = manifest.assets.find((a) => a.id === "photo_trail");
    assert.ok(trail);
    assert.deepEqual(trail.sourceRect, { left: 560, top: 148, width: 200, height: 130 });

    // 素材哈希与实际文件一致
    const trailBytes = await readFile(path.join(bundleDir, "assets", "photo_trail.png"));
    const { createHash } = await import("node:crypto");
    assert.equal(
      createHash("sha256").update(trailBytes).digest("hex"),
      trail.sha256,
    );

    // 裁剪像素正确：素材与直接从 reference.png 裁剪一致
    const reference = await readFile(path.join(bundleDir, "reference.png"));
    const expected = await sharp(reference)
      .extract({ left: 560, top: 148, width: 200, height: 130 })
      .png()
      .toBuffer();
    assert.ok(trailBytes.equals(expected));

    // 调试原始响应已保存（git 忽略 *.debug-response.json 之外的这个命名）
    assert.ok(
      await stat(path.join(bundleDir, "model-response.debug.json")).then(
        () => true,
      ),
    );

    // 无文字与图片相交 → 无复查项
    assert.deepEqual(result.reviewItems, []);
    assert.ok(result.runId.startsWith("run-"));
  });
});

test("文字与图片相交生成复查候选", async () => {
  await withTempBundle(async (_dir, bundleDir) => {
    const result = await runExtraction({
      inputPath: syntheticImage,
      outputDir: bundleDir,
      provider: createFixtureVisionProvider(overlappingSceneResponse),
    });

    assert.equal(result.reviewItems.length, 1);
    const item = result.reviewItems[0];
    assert.equal(item.type, "asset_review");
    assert.equal(item.elementId, "caption_on_photo");
    assert.ok(item.id.includes("caption_on_photo"));
    assert.ok(item.id.includes("photo"));
    assert.equal(item.resolution.status, "pending");

    // 相交素材在 manifest 中被标记
    const manifest = JSON.parse(
      await readFile(path.join(bundleDir, "manifest.json"), "utf8"),
    ) as { assets: Array<{ id: string; intersectsText: boolean }> };
    const photo = manifest.assets.find((a) => a.id === "photo");
    assert.ok(photo);
    assert.equal(photo.intersectsText, true);
  });
});

test("输出目录已存在时默认拒绝，显式 overwrite 允许", async () => {
  await withTempBundle(async (_dir, bundleDir) => {
    // 第一次成功
    await runExtraction({
      inputPath: syntheticImage,
      outputDir: bundleDir,
      provider: createFixtureVisionProvider(syntheticSceneResponse),
    });

    // 默认拒绝重复输出
    await assert.rejects(
      runExtraction({
        inputPath: syntheticImage,
        outputDir: bundleDir,
        provider: createFixtureVisionProvider(syntheticSceneResponse),
      }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "CONFLICT");
        return true;
      },
    );

    // 显式 overwrite 成功
    await runExtraction({
      inputPath: syntheticImage,
      outputDir: bundleDir,
      overwrite: true,
      provider: createFixtureVisionProvider(syntheticSceneResponse),
    });
  });
});

test("识别失败时清理输出目录（异常产物不冒充成功包）", async () => {
  await withTempBundle(async (dir, bundleDir) => {
    await assert.rejects(
      runExtraction({
        inputPath: syntheticImage,
        outputDir: bundleDir,
        provider: createFixtureVisionProvider(
          path.join(fixtureDir, "model-responses", "invalid-scene.response.json"),
        ),
      }),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        return true;
      },
    );

    // 输出目录已被清理
    const exists = await stat(bundleDir).then(
      () => true,
      () => false,
    );
    assert.equal(exists, false);
  });
});

test("SDK extract()：fixture provider 配置完整链路（识别→裁剪→渲染→对比）", async () => {
  await withTempBundle(async (_dir, bundleDir) => {
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
    });

    // 串联后：无字体 manifest → font_missing 复查项 → needs_review
    assert.equal(result.status, "needs_review");
    assert.ok(result.runId.startsWith("run-"));

    // 一次完成全部产物（T07 验证项）
    assert.ok(result.artifacts.some((a) => a.endsWith("template.json")));
    assert.ok(result.artifacts.some((a) => a.endsWith("content.json")));
    assert.ok(result.artifacts.some((a) => a.endsWith("manifest.json")));
    assert.ok(result.artifacts.some((a) => a.endsWith("preview.png")));
    assert.ok(result.artifacts.some((a) => a.endsWith("preview.html")));
    assert.ok(result.artifacts.some((a) => a.endsWith("diff.png")));
    assert.ok(result.artifacts.some((a) => a.endsWith("overlay.png")));
    assert.ok(result.artifacts.some((a) => a.endsWith("report.json")));

    // 报告含 comparison（同内容 → 可对比）
    const report = result.report as {
      comparison: { applicable: boolean; mismatchRatio?: number };
    };
    assert.equal(report.comparison.applicable, true);
    assert.ok(
      report.comparison.mismatchRatio !== undefined &&
        report.comparison.mismatchRatio >= 0,
    );
  });
});

test("SDK extract()：visionProviderFactory 替换实现生效", async () => {
  await withTempBundle(async (_dir, bundleDir) => {
    const instance = createImageTemplate({
      visionProviderFactory: () =>
        createFixtureVisionProvider(syntheticSceneResponse),
    });

    const result = await instance.extract({
      input: syntheticImage,
      output: bundleDir,
    });
    assert.notEqual(result.status, "failed");
  });
});
