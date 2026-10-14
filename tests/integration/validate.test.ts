/**
 * T16：严格交付检查集成测试（真实 Chromium；不调用模型）。
 *
 * 覆盖：
 * - 完整包 validate：阻断项/复查项/版本哈希汇总，report 合并 validate 段；
 * - 严格有效导出必须通过所有阻断检查（长文溢出 → failed）；
 * - 复查结论哈希绑定：模板/内容变化后结论失效（stale 检出）；
 * - 模板包导出/重载：离线完整包在新位置通过结构校验；
 * - 删除字体/图片等资源缺失 → failed 且可诊断。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import {
  runValidate,
  recordResolution,
  exportBundle,
  reloadBundleCheck,
} from "../../src/quality/publish.js";

/** 构造可验证的 SceneSpec 模板包。 */
async function makeBundle(options: { longText?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-t16-"));
  const bundleDir = path.join(dir, "bundle");
  await mkdir(path.join(bundleDir, "assets"), { recursive: true });

  const png = await sharp({
    create: { width: 30, height: 30, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(bundleDir, "assets", "photo.png"), png);

  const template = {
    version: "1.0",
    canvas: { width: 300, height: 200, background: "#FFFFFF" },
    elements: [
      {
        id: "title",
        type: "text",
        // 长文用例：声明框靠画布底（框合法），长文渲染溢出越界；
        // 正常用例：顶部短文不越界
        x: 10,
        y: options.longText === true ? 170 : 10,
        width: 200,
        height: 25,
        zIndex: 2,
        confidence: 0.9,
        text: "",
        fontSize: 16,
        fontFamily: "sans",
        fontWeight: "400",
        lineHeight: 1.4,
        letterSpacing: 0,
        color: "#333333",
        align: "left",
      },
      {
        id: "photo",
        type: "image",
        x: 240,
        y: 140,
        width: 30,
        height: 30,
        zIndex: 1,
        confidence: 0.8,
        src: "assets/photo.png",
      },
    ],
    notes: [],
  };
  await writeFile(path.join(bundleDir, "template.json"), JSON.stringify(template), "utf8");

  await writeFile(
    path.join(bundleDir, "content.json"),
    JSON.stringify({
      title:
        options.longText === true
          ? "This is a very long text that will definitely overflow the declared box and beyond canvas bottom edge for validation blocking checks"
          : "TITLE",
    }),
    "utf8",
  );

  await writeFile(
    path.join(bundleDir, "manifest.json"),
    JSON.stringify({
      manifestVersion: "1.0",
      templateVersion: 1,
      contentVersion: 1,
    }),
    "utf8",
  );

  return bundleDir;
}

test("完整包 validate：版本/哈希登记与 report validate 段", async () => {
  const bundleDir = await makeBundle();
  try {
    const result = await runValidate({ bundleDir });

    // 无字体 manifest → 字体缺失复查项 → needs_review（诊断模式）
    assert.equal(result.status, "needs_review");
    assert.equal(result.blockers.length, 0);
    assert.ok(result.reviewItems.some((i) => i.type === "font_missing"));

    // 版本与哈希
    assert.equal(result.versions.templateVersion, 1);
    assert.equal(result.versions.contentVersion, 1);
    assert.ok(result.versions.templateSha256.length === 64);
    assert.ok(result.versions.contentSha256.length === 64);

    // report 合并 validate 段
    const report = JSON.parse(
      await readFile(path.join(bundleDir, "report.json"), "utf8"),
    ) as {
      run: { stage: string; status: string; templateHash?: string };
      validate: { strict: boolean; versions: { templateSha256: string } };
    };
    assert.equal(report.run.stage, "validate");
    assert.equal(report.validate.versions.templateSha256, result.versions.templateSha256);
    assert.ok(report.run.templateHash);
  } finally {
    await rm(path.dirname(bundleDir), { recursive: true, force: true });
  }
});

test("严格模式：长文溢出阻断 → failed", async () => {
  const bundleDir = await makeBundle({ longText: true });
  try {
    const result = await runValidate({ bundleDir, strict: true });
    assert.equal(result.status, "failed");
    assert.ok(
      result.blockers.some((b) => b.code === "TEXT_BEYOND_CANVAS"),
      "长文应产生 TEXT_BEYOND_CANVAS 阻断",
    );
  } finally {
    await rm(path.dirname(bundleDir), { recursive: true, force: true });
  }
});

test("复查结论哈希绑定：模板变化后结论失效", async () => {
  const bundleDir = await makeBundle();
  try {
    // 登记一条结论
    await recordResolution(bundleDir, {
      itemId: "font:sans:400",
      status: "accepted",
      note: "人工确认可回退",
    });

    // 未变化时：结论有效
    const before = await runValidate({ bundleDir });
    assert.equal(before.resolutions.valid, 1);
    assert.equal(before.resolutions.stale, 0);

    // 修改模板（结构变化）→ 结论失效
    const template = JSON.parse(
      await readFile(path.join(bundleDir, "template.json"), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      path.join(bundleDir, "template.json"),
      JSON.stringify({ ...template, notes: ["edited"] }),
      "utf8",
    );

    const after = await runValidate({ bundleDir });
    assert.equal(after.resolutions.stale, 1);
    assert.ok(
      after.reviewItems.some((i) => i.type === "resolution_stale"),
      "失效结论应产生复查项",
    );
  } finally {
    await rm(path.dirname(bundleDir), { recursive: true, force: true });
  }
});

test("模板包导出/重载：完整包在新位置通过结构校验", async () => {
  const bundleDir = await makeBundle();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "itt-t16-export-"));
  try {
    const target = path.join(tempRoot, "relocated");
    const exported = await exportBundle(bundleDir, target);

    // 必需文件已复制
    assert.ok(exported.files.includes("template.json"));
    assert.ok(exported.files.includes("content.json"));
    assert.ok(exported.files.includes("assets/"));

    // 重载校验（离线结构完整）
    const check = await reloadBundleCheck(target);
    assert.equal(check.ok, true, `重载问题：${check.issues.join("；")}`);

    // 新位置可渲染（不依赖原路径）
    const { runRender } = await import("../../src/pipeline/render.js");
    const render = await runRender({ bundleDir: target });
    assert.notEqual(render.status, "failed");
  } finally {
    await rm(path.dirname(bundleDir), { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("资源缺失（删除图片）→ failed 且可诊断", async () => {
  const bundleDir = await makeBundle();
  try {
    await rm(path.join(bundleDir, "assets", "photo.png"), { force: true });

    const result = await runValidate({ bundleDir });
    assert.equal(result.status, "failed");
    assert.ok(
      result.blockers.some(
        (b) => b.code === "RESOURCE_MISSING" || b.code === "IMAGE_LOAD_FAILED",
      ),
      `应有资源缺失阻断（实际：${result.blockers.map((b) => b.code).join(",")}）`,
    );
  } finally {
    await rm(path.dirname(bundleDir), { recursive: true, force: true });
  }
});
