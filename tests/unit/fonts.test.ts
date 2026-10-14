/**
 * T05：固定字体管理测试。
 *
 * 覆盖：字体需求收集、@font-face 生成与 base64 嵌入、
 * 缺失槽位/字重/文件/哈希不匹配的报告。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildFontFaces,
  fontRequirementsOf,
  readFontsManifest,
} from "../../src/assets/fonts.js";
import { isImageTemplateError } from "../../src/errors.js";

/** 构造带字体文件的临时模板包。 */
async function makeFontsBundle(
  overrides: {
    slots?: unknown;
    files?: Record<string, string | Buffer>;
  } = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-fonts-"));
  await mkdir(path.join(dir, "fonts"), { recursive: true });

  const manifest = {
    version: "1.0",
    fontSlots:
      overrides.slots ??
      [
        {
          slot: "sans",
          familyAlias: "Template-sans",
          weights: ["400", "700"],
          files: {
            "400": { file: "sans-400.woff2" },
            "700": { file: "sans-700.woff2" },
          },
        },
      ],
  };

  await writeFile(
    path.join(dir, "fonts", "manifest.json"),
    JSON.stringify(manifest),
    "utf8",
  );

  const files: Record<string, string | Buffer> = overrides.files ?? {
    "sans-400.woff2": "fake-font-bytes-400",
    "sans-700.woff2": "fake-font-bytes-700",
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, "fonts", name), content);
  }

  return dir;
}

test("fontRequirementsOf 收集 text 元素的槽位与字重并去重", () => {
  const requirements = fontRequirementsOf([
    { type: "text", fontFamily: "sans", fontWeight: "400" },
    { type: "text", fontFamily: "sans", fontWeight: "700" },
    { type: "text", fontFamily: "sans", fontWeight: "400" },
    { type: "text", fontFamily: "latin", fontWeight: "400" },
    { type: "box" },
    { type: "image" },
  ]);

  assert.deepEqual(requirements, [
    { slot: "sans", weight: "400" },
    { slot: "sans", weight: "700" },
    { slot: "latin", weight: "400" },
  ]);
});

test("存在的字体生成 @font-face 且 base64 嵌入", async () => {
  const bundle = await makeFontsBundle();
  try {
    const result = await buildFontFaces(bundle, [
      { slot: "sans", weight: "400" },
      { slot: "sans", weight: "700" },
    ]);

    assert.equal(result.missing.length, 0);
    assert.equal(result.loaded.length, 2);

    assert.ok(result.css.includes('font-family: "Template-sans"'));
    assert.ok(result.css.includes("font-weight: 400"));
    assert.ok(result.css.includes("font-weight: 700"));
    assert.ok(
      result.css.includes(Buffer.from("fake-font-bytes-400").toString("base64")),
    );

    const sans400 = result.loaded.find((f) => f.weight === "400");
    assert.ok(sans400);
    assert.equal(sans400.familyAlias, "Template-sans");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("缺失槽位 / 字重 / 文件分别报告原因", async () => {
  const bundle = await makeFontsBundle({
    files: { "sans-400.woff2": "fake-font-bytes-400" }, // sans-700 文件不存在
  });
  try {
    const result = await buildFontFaces(bundle, [
      { slot: "sans", weight: "400" },
      { slot: "sans", weight: "700" },
      { slot: "serif", weight: "400" }, // 槽位不存在
    ]);

    assert.equal(result.loaded.length, 1);
    assert.equal(result.missing.length, 2);

    const noFile = result.missing.find((m) => m.reason === "file_missing");
    assert.ok(noFile);
    assert.equal(noFile.slot, "sans");
    assert.equal(noFile.weight, "700");

    const noSlot = result.missing.find((m) => m.reason === "no_slot");
    assert.ok(noSlot);
    assert.equal(noSlot.slot, "serif");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("manifest 声明字重但 files 映射缺项报告 no_file", async () => {
  const bundle = await makeFontsBundle({
    slots: [
      {
        slot: "latin",
        familyAlias: "Template-latin",
        weights: ["400"],
        files: {},
      },
    ],
  });
  try {
    const result = await buildFontFaces(bundle, [{ slot: "latin", weight: "400" }]);
    assert.equal(result.loaded.length, 0);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].reason, "no_file");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("哈希不匹配报告 hash_mismatch 且不嵌入", async () => {
  const bundle = await makeFontsBundle({
    slots: [
      {
        slot: "sans",
        familyAlias: "Template-sans",
        weights: ["400"],
        files: {
          "400": { file: "sans-400.woff2", sha256: "deadbeef" },
        },
      },
    ],
  });
  try {
    const result = await buildFontFaces(bundle, [{ slot: "sans", weight: "400" }]);

    assert.equal(result.loaded.length, 0);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].reason, "hash_mismatch");
    assert.equal(result.css.trim(), "");
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("manifest 缺失或非法报类型化错误", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-fonts-"));
  try {
    await assert.rejects(
      readFontsManifest(dir),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "IO_ERROR");
        return true;
      },
    );

    await mkdir(path.join(dir, "fonts"), { recursive: true });
    await writeFile(
      path.join(dir, "fonts", "manifest.json"),
      '{"fontSlots": "not-array"}',
      "utf8",
    );
    await assert.rejects(
      readFontsManifest(dir),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
