/**
 * 字体交付验证（授权字体就位后的回归，2026-10-15）。
 *
 * 仓库 fonts/ 携带 SIL OFL 1.1 授权字体（思源黑体/思源宋体/Source Sans 3）；
 * 本用例验证：
 * - 携带 fonts/ 的模板包在严格模式渲染通过（fonts.missing=[]、loadCheck 全 loaded）；
 * - 中文文本真实渲染（非空白——回归本机 Chromium 无 CJK 字体的环境限制）；
 * - manifest 哈希与实际文件一致（篡改即 hash_mismatch）。
 */

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import sharp from "sharp";

import { runRender } from "../../src/pipeline/render.js";
import { readFontsManifest } from "../../src/assets/fonts.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repoFontsDir = path.join(repoRoot, "fonts");

test("授权字体就位：manifest 哈希与文件一致、严格渲染中文通过", async () => {
  // 前置：仓库字体文件已提交（缺失时明确失败而非跳过——字体是交付依赖）
  const manifest = await readFontsManifest(repoRoot, "render");
  const slots = new Map(manifest.fontSlots.map((slot) => [slot.slot, slot]));

  for (const slotName of ["sans", "serif", "latin"]) {
    const slot = slots.get(slotName);
    assert.ok(slot, `槽位 ${slotName} 应在 manifest 中`);
    assert.notEqual(slot.status, "missing", `槽位 ${slotName} 应已登记字体文件`);

    for (const [weight, ref] of Object.entries(slot.files)) {
      const file = typeof ref === "string" ? { file: ref } : ref;
      const bytes = await readFile(path.join(repoFontsDir, file.file));
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256").update(bytes).digest("hex");
      assert.equal(
        hash,
        file.sha256,
        `字体哈希应与 manifest 一致：${file.file}`,
      );
    }
  }

  // 渲染验证：三槽位 + 中文 + 符号
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-fonts-regression-"));
  const bundleDir = path.join(dir, "bundle");
  try {
    await mkdir(bundleDir, { recursive: true });
    await cp(repoFontsDir, path.join(bundleDir, "fonts"), { recursive: true });

    await writeFile(
      path.join(bundleDir, "template.json"),
      JSON.stringify({
        version: "1.0",
        canvas: { width: 500, height: 360, background: "#FFFFFF" },
        elements: [
          {
            id: "cn_title",
            type: "text",
            x: 20,
            y: 16,
            width: 460,
            height: 52,
            zIndex: 1,
            confidence: 0.9,
            text: "",
            fontSize: 38,
            fontFamily: "sans",
            fontWeight: "700",
            lineHeight: 1.3,
            letterSpacing: 0,
            color: "#193753",
            align: "left",
          },
          {
            id: "cn_body",
            type: "text",
            x: 20,
            y: 90,
            width: 460,
            height: 110,
            zIndex: 1,
            confidence: 0.9,
            text: "",
            fontSize: 16,
            fontFamily: "sans",
            fontWeight: "400",
            lineHeight: 1.6,
            letterSpacing: 0,
            color: "#514B43",
            align: "left",
          },
          {
            id: "day",
            type: "text",
            x: 400,
            y: 16,
            width: 80,
            height: 40,
            zIndex: 1,
            confidence: 0.9,
            text: "",
            fontSize: 28,
            fontFamily: "latin",
            fontWeight: "700",
            lineHeight: 1.4,
            letterSpacing: 0,
            color: "#CB923B",
            align: "right",
          },
          {
            id: "serif_quote",
            type: "text",
            x: 20,
            y: 240,
            width: 460,
            height: 60,
            zIndex: 1,
            confidence: 0.9,
            text: "",
            fontSize: 18,
            fontFamily: "serif",
            fontWeight: "400",
            lineHeight: 1.6,
            letterSpacing: 0,
            color: "#333333",
            align: "left",
          },
        ],
        notes: [],
      }),
      "utf8",
    );

    await writeFile(
      path.join(bundleDir, "content.json"),
      JSON.stringify({
        cn_title: "本溪水洞 · 天桥沟",
        cn_body:
          "Day 5 行程：天桥沟国家森林公园 → 小市羊汤 → 本溪水洞（地下暗河）。全天 12–18°C，降水概率 30%，票价 ¥128。",
        day: "DAY 5",
        serif_quote: "地下暗河 · 枫叶栈道 · 本溪味道",
      }),
      "utf8",
    );

    const render = await runRender({ bundleDir, strict: true });

    // 严格模式通过：字体全部加载、无阻断
    assert.equal(render.status, "pass");

    const report = render.report as {
      fonts: {
        missing: unknown[];
        loadCheck: Array<{ family: string; weight: string; loaded: boolean }>;
      };
    };
    assert.deepEqual(report.fonts.missing, []);
    assert.ok(
      report.fonts.loadCheck.length >= 4,
      "三槽位字重均应核查",
    );
    for (const check of report.fonts.loadCheck) {
      assert.equal(check.loaded, true, `${check.family} ${check.weight} 应加载成功`);
    }

    // 中文真实渲染：非空白（深色像素显著；无字体时均值≈254）
    const stats = await sharp(path.join(bundleDir, "preview.png")).stats();
    const mean = stats.channels[0].mean;
    assert.ok(
      mean < 250,
      `预览应含真实字形（通道均值 ${mean.toFixed(1)} < 250；空白页约 254）`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("字体哈希篡改被检出（hash_mismatch）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-fonts-tamper-"));
  const bundleDir = path.join(dir, "bundle");
  try {
    await mkdir(path.join(bundleDir, "fonts"), { recursive: true });
    await cp(
      path.join(repoFontsDir, "manifest.json"),
      path.join(bundleDir, "fonts", "manifest.json"),
    );
    // 篡改的字体文件（内容非声明的哈希）
    await writeFile(
      path.join(bundleDir, "fonts", "SourceHanSansCN-Regular.otf"),
      Buffer.from("tampered font bytes"),
    );

    await writeFile(
      path.join(bundleDir, "template.json"),
      JSON.stringify({
        version: "1.0",
        canvas: { width: 300, height: 200, background: "#FFFFFF" },
        elements: [
          {
            id: "t",
            type: "text",
            x: 10,
            y: 10,
            width: 200,
            height: 24,
            zIndex: 1,
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
        ],
        notes: [],
      }),
      "utf8",
    );
    await writeFile(
      path.join(bundleDir, "content.json"),
      JSON.stringify({ t: "标题" }),
      "utf8",
    );

    const render = await runRender({ bundleDir });
    const report = render.report as {
      fonts: { missing: Array<{ reason: string }> };
    };
    assert.ok(
      report.fonts.missing.some((m) => m.reason === "hash_mismatch"),
      "篡改字体应报 hash_mismatch",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
