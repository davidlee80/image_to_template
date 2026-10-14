/**
 * T02：模板包输出目录管理与读取测试。
 *
 * 覆盖：输出目录已存在默认拒绝（CONFLICT）；overwrite 只替换受管产物、
 * 保留其他文件；readSceneBundle 读取并校验核心文件。
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  managedBundleFiles,
  prepareBundleOutputDir,
  readSceneBundle,
} from "../../src/io/bundle.js";
import { isImageTemplateError } from "../../src/errors.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

async function makeTempBundle(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-bundle-"));
  // 模拟一个已存在的模板包（含受管产物与用户文件）
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await mkdir(path.join(dir, "fonts"), { recursive: true });
  for (const file of managedBundleFiles) {
    await writeFile(path.join(dir, file), "old");
  }
  await writeFile(path.join(dir, "assets", "photo.png"), "old");
  await writeFile(path.join(dir, "fonts", "sans-400.woff2"), "old");
  await writeFile(path.join(dir, "user-notes.txt"), "用户自己的文件");
  return dir;
}

test("输出目录不存在时创建", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "itt-bundle-"));
  try {
    const dir = path.join(root, "new-bundle");
    await prepareBundleOutputDir(dir, {}, "extract");
    const entries = await readdir(dir);
    assert.deepEqual(entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("输出目录已存在且未显式 overwrite 时抛 CONFLICT", async () => {
  const dir = await makeTempBundle();
  try {
    await assert.rejects(
      prepareBundleOutputDir(dir, {}, "extract"),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "CONFLICT");
        assert.ok(error.message.includes(dir));
        return true;
      },
    );

    // 未删除任何文件
    const entries = await readdir(dir);
    assert.ok(entries.includes("template.json"));
    assert.ok(entries.includes("user-notes.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("overwrite 只替换受管产物，保留用户文件", async () => {
  const dir = await makeTempBundle();
  try {
    await prepareBundleOutputDir(dir, { overwrite: true }, "extract");

    const entries = await readdir(dir);
    assert.deepEqual(entries, ["user-notes.txt"]);
    assert.equal(
      await readFile(path.join(dir, "user-notes.txt"), "utf8"),
      "用户自己的文件",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSceneBundle 读取并校验核心文件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-bundle-"));
  try {
    // 用人工 fixture 组装一个最小模板包
    const sceneValue = JSON.parse(
      await readFile(
        path.join(fixtureDir, "scenes", "synthetic-travel.scene.json"),
        "utf8",
      ),
    );
    // 提取阶段的最终形态：text 正文清空、内容移入 content.json
    const content: Record<string, string> = {};
    for (const element of sceneValue.elements) {
      if (element.type === "text") {
        content[element.id] = element.text;
        element.text = "";
      }
    }

    await writeFile(
      path.join(dir, "template.json"),
      JSON.stringify(sceneValue),
      "utf8",
    );
    await writeFile(
      path.join(dir, "content.json"),
      JSON.stringify(content),
      "utf8",
    );

    const bundle = await readSceneBundle(dir, "render");
    assert.equal(bundle.spec.version, "1.0");
    assert.equal(bundle.spec.elements.length, sceneValue.elements.length);
    assert.equal(bundle.content["destination_title"], "本溪水洞 · 天桥沟");
    // 分离后的模板正文为空串
    const title = bundle.spec.elements.find((e) => e.id === "destination_title");
    assert.ok(title && title.type === "text" && title.text === "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSceneBundle 对非法模板抛带路径信息的错误", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-bundle-"));
  try {
    // 重复 ID 的非法模板
    const badScene = {
      version: "1.0",
      canvas: { width: 100, height: 100, background: "#FFFFFF" },
      elements: [
        { id: "a", type: "box", x: 0, y: 0, width: 1, height: 1 },
        { id: "a", type: "box", x: 0, y: 2, width: 1, height: 1 },
      ],
    };
    await writeFile(
      path.join(dir, "template.json"),
      JSON.stringify(badScene),
      "utf8",
    );
    await writeFile(path.join(dir, "content.json"), "{}", "utf8");

    await assert.rejects(
      readSceneBundle(dir, "render"),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "INVALID_ARGUMENT");
        assert.ok(error.message.includes("重复元素 ID"));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
