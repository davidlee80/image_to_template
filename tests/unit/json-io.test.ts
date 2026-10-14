/**
 * T02：JSON 读写与原子写入测试。
 *
 * 覆盖：读写在临时目录闭环；非法 JSON、文件不存在抛类型化错误（带路径）；
 * 原子写入不留临时文件；写入内容 UTF-8 无 BOM。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  formatIssues,
  readJsonFile,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "../../src/io/json.js";
import { isImageTemplateError } from "../../src/errors.js";

test("JSON 读写闭环且无 BOM、末尾换行", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-json-"));
  try {
    const file = path.join(dir, "nested", "data.json");
    await writeJsonFileAtomic(file, { hello: "世界", n: 1 }, "render");

    const raw = await readFile(file, "utf8");
    assert.equal(raw.charCodeAt(0), 0x7b, "首字符应为 {（无 BOM）");
    assert.ok(raw.endsWith("\n"), "末尾应有换行");

    const value = await readJsonFile(file, "render");
    assert.deepEqual(value, { hello: "世界", n: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("原子写入不留临时文件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-json-"));
  try {
    const file = path.join(dir, "a.json");
    await writeJsonFileAtomic(file, { a: 1 }, "render");
    await writeJsonFileAtomic(file, { a: 2 }, "render");

    const entries = await readdir(dir);
    assert.deepEqual(entries, ["a.json"]);
    assert.deepEqual(await readJsonFile(file, "render"), { a: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("文件不存在报 IO_ERROR 且消息带路径", async () => {
  const missing = path.join(os.tmpdir(), `itt-json-missing-${Date.now()}.json`);
  await assert.rejects(
    readJsonFile(missing, "render"),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "IO_ERROR");
      assert.ok(error.message.includes(missing), "消息应包含文件路径");
      return true;
    },
  );
});

test("非法 JSON 报 IO_ERROR 且消息带路径与原因", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-json-"));
  try {
    const file = path.join(dir, "bad.json");
    await writeFile(file, "{ not valid json", "utf8");

    await assert.rejects(
      readJsonFile(file, "render"),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "IO_ERROR");
        assert.ok(error.message.includes(file));
        assert.ok(error.message.includes("JSON 解析失败"));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("带 BOM 的 JSON 也能读取（容错历史编辑器产物）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-json-"));
  try {
    const file = path.join(dir, "bom.json");
    await writeFile(file, "\uFEFF{\"a\":1}", "utf8");
    assert.deepEqual(await readJsonFile(file, "render"), { a: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("文本原子写入（截图等产物的写入策略基础）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-json-"));
  try {
    const file = path.join(dir, "preview.html");
    await writeTextFileAtomic(file, "<!doctype html>", "render");
    assert.equal(await readFile(file, "utf8"), "<!doctype html>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatIssues 保留路径信息", () => {
  const message = formatIssues([
    { path: "elements[0].id", message: "重复元素 ID：title" },
    { path: "canvas.width", message: "必须为正整数" },
  ]);
  assert.match(message, /elements\[0\]\.id: 重复元素 ID：title/);
  assert.match(message, /canvas\.width: 必须为正整数/);
});
