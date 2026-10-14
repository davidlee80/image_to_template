/**
 * T11：模板包迁移集成测试。
 *
 * 覆盖：迁移产物完整（scene/layout/legacy content/结构化 content/schema/
 * id-mappings/migration）、逐项验证通过后登记新基线与父版本、重复迁移拒绝、
 * 旧模板仍能渲染（SceneSpec 1.0 兼容）、回退恢复原状。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { migrateBundle, rollbackMigration } from "../../src/semantic/migrate.js";
import { readSceneBundle } from "../../src/io/bundle.js";
import { canonicalContentHash } from "../../src/io/json.js";
import { parseLayoutSpec } from "../../src/schemas/layout.js";

async function makeLegacyBundle(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-migrate-"));
  await mkdir(path.join(dir, "assets"), { recursive: true });

  const template = {
    version: "1.0",
    canvas: { width: 800, height: 600, background: "#FFFFFF" },
    elements: [
      {
        id: "header_bg",
        type: "box",
        x: 0,
        y: 0,
        width: 800,
        height: 120,
        zIndex: 1,
        confidence: 0.9,
        fill: "#193753",
        borderColor: "#CCCCCC",
        borderWidth: 0,
        radius: 0,
      },
      {
        id: "title",
        type: "text",
        x: 40,
        y: 22,
        width: 420,
        height: 42,
        zIndex: 2,
        confidence: 0.95,
        text: "",
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
        confidence: 0.8,
        src: "assets/photo.png",
      },
    ],
    notes: [],
  };

  const content = { title: "本溪水洞 · 天桥沟" };

  await writeFile(path.join(dir, "template.json"), JSON.stringify(template), "utf8");
  await writeFile(path.join(dir, "content.json"), JSON.stringify(content), "utf8");
  await writeFile(path.join(dir, "assets", "photo.png"), "png");

  const manifest = {
    manifestVersion: "1.0",
    templateVersion: 1,
    contentVersion: 1,
    originalContentSha256: canonicalContentHash(content),
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");

  return dir;
}

test("迁移：产物完整、验证通过、登记新基线与父版本", async () => {
  const dir = await makeLegacyBundle();
  try {
    const result = await migrateBundle(dir);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");

    // 逐项验证记录
    assert.equal(result.migration.verification.passed, true);
    assert.equal(result.migration.verification.textCount, 1);
    assert.equal(result.migration.verification.assetCount, 1);
    assert.equal(result.migration.parentTemplateVersion, 1);
    assert.ok(result.migration.migratedContentHash.length === 64);

    // 产物清单
    for (const file of [
      "scene.json",
      "layout.json",
      "content.legacy.json",
      "content.json",
      "content.schema.json",
      "id-mappings.json",
      "migration.json",
    ]) {
      assert.ok(
        await stat(path.join(dir, file)).then(() => true),
        `缺少产物 ${file}`,
      );
    }

    // scene.json 保留原始定位基准
    const scene = JSON.parse(await readFile(path.join(dir, "scene.json"), "utf8"));
    assert.equal(scene.version, "1.0");
    assert.equal(scene.elements.length, 3);

    // layout.json 合法
    const layoutValue = JSON.parse(await readFile(path.join(dir, "layout.json"), "utf8"));
    const layout = parseLayoutSpec(layoutValue);
    assert.equal(layout.ok, true);

    // 结构化内容（新形态）
    const structured = JSON.parse(await readFile(path.join(dir, "content.json"), "utf8"));
    assert.equal(structured.schemaVersion, "1.0");
    assert.equal(structured.texts.title, "本溪水洞 · 天桥沟");
    assert.equal(structured.assets.photo.src, "assets/photo.png");

    // 旧内容快照
    const legacy = JSON.parse(await readFile(path.join(dir, "content.legacy.json"), "utf8"));
    assert.deepEqual(legacy, { title: "本溪水洞 · 天桥沟" });

    // id-mappings
    const mappings = JSON.parse(await readFile(path.join(dir, "id-mappings.json"), "utf8"));
    assert.ok(mappings.some((m: { fromId: string }) => m.fromId === "title"));
    assert.ok(mappings.some((m: { fromId: string }) => m.fromId === "photo"));

    // manifest：版本 +1、父版本基线保留
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.templateVersion, 2);
    assert.equal(manifest.parentOriginalContentSha256.length, 64);
    assert.equal(manifest.migration.verifiedTexts, 1);

    // 同正文（同哈希）：迁移后基线与正文哈希一致
    assert.equal(
      manifest.originalContentSha256,
      canonicalContentHash(structured.texts),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("重复迁移被拒绝", async () => {
  const dir = await makeLegacyBundle();
  try {
    const first = await migrateBundle(dir);
    assert.equal(first.ok, true);

    const second = await migrateBundle(dir);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.ok(second.issues[0].message.includes("不重复迁移"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("旧模板（SceneSpec 1.0）在迁移后结构保留（读取入口按版本分发）", async () => {
  const dir = await makeLegacyBundle();
  try {
    await migrateBundle(dir);

    // template.json 仍在且仍是合法 SceneSpec 1.0（定位基准保留）
    const template = JSON.parse(
      await readFile(path.join(dir, "template.json"), "utf8"),
    );
    assert.equal(template.version, "1.0");
    assert.equal(template.elements.length, 3);

    // scene.json 与 template.json 同构（原始基准）
    const scene = JSON.parse(await readFile(path.join(dir, "scene.json"), "utf8"));
    assert.deepEqual(scene, template);

    // 未迁移的旧包（另一目录）仍可完整读取：SceneSpec 1.0 兼容不破坏
    const untouched = await makeLegacyBundle();
    try {
      const bundle = await readSceneBundle(untouched, "render");
      assert.equal(bundle.spec.version, "1.0");
      assert.equal(bundle.content.title, "本溪水洞 · 天桥沟");
    } finally {
      await rm(untouched, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("回退：恢复旧内容与版本，移除 LayoutSpec 产物，保留审计记录", async () => {
  const dir = await makeLegacyBundle();
  try {
    await migrateBundle(dir);

    const rollback = await rollbackMigration(dir);
    assert.equal(rollback.ok, true);

    // content.json 恢复为 MVP 形态
    const content = JSON.parse(await readFile(path.join(dir, "content.json"), "utf8"));
    assert.deepEqual(content, { title: "本溪水洞 · 天桥沟" });

    // LayoutSpec 产物已移除
    for (const file of [
      "layout.json",
      "content.legacy.json",
      "id-mappings.json",
      "scene.json",
      "content.schema.json",
    ]) {
      const exists = await stat(path.join(dir, file)).then(
        () => true,
        () => false,
      );
      assert.equal(exists, false, `${file} 应被移除`);
    }

    // migration.rollback.json 审计记录保留
    assert.ok(
      await stat(path.join(dir, "migration.rollback.json")).then(() => true),
    );

    // manifest 版本还原
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.templateVersion, 1);
    assert.equal(manifest.migration, undefined);

    // 可再次迁移
    const remigrate = await migrateBundle(dir);
    assert.equal(remigrate.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("无迁移记录时回退报错", async () => {
  const dir = await makeLegacyBundle();
  try {
    const rollback = await rollbackMigration(dir);
    assert.equal(rollback.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
