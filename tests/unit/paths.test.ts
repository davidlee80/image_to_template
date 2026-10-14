/**
 * T02：资源路径边界测试。
 *
 * 覆盖：合法相对路径通过；绝对路径、`..`、盘符/UNC、URL 拒绝；
 * 符号链接越界拒绝（Windows 无权限创建符号链接时跳过该用例）。
 */

import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveAssetPath, resolveAssetPathReal } from "../../src/io/paths.js";
import { isImageTemplateError } from "../../src/errors.js";

test("合法相对路径解析到包内", () => {
  const root = path.resolve("tests/fixtures");
  const target = resolveAssetPath(root, "images/synthetic-travel.png", "render");
  assert.equal(target, path.join(root, "images", "synthetic-travel.png"));
});

test("词法越界路径被拒绝并抛类型化错误", () => {
  const root = path.resolve("tests/fixtures");
  const badPaths = [
    "",
    "../outside.png",
    "images/../../escape.png",
    "C:/Windows/System32/evil.png",
    "C:\\Windows\\System32\\evil.png",
    "\\\\server\\share\\evil.png",
    "https://evil.example.com/x.png",
    "data:image/png;base64,xxxx",
    "/etc/passwd",
    "images\\..\\..\\escape.png",
  ];

  for (const bad of badPaths) {
    assert.throws(
      () => resolveAssetPath(root, bad, "render"),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error), `${bad} 应抛类型化错误`);
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      },
      `路径应被拒绝：${JSON.stringify(bad)}`,
    );
  }
});

test("realpath 解析存在的资源且校验真实路径边界", async () => {
  const root = path.resolve("tests/fixtures");
  const target = await resolveAssetPathReal(
    root,
    "images/synthetic-travel.png",
    "render",
  );
  assert.equal(target, path.resolve(root, "images", "synthetic-travel.png"));
});

test("realpath 对不存在的资源报 IO_ERROR", async () => {
  const root = path.resolve("tests/fixtures");
  await assert.rejects(
    resolveAssetPathReal(root, "images/not-exist.png", "render"),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "IO_ERROR");
      return true;
    },
  );
});

test("符号链接越出包根被拒绝（无法创建符号链接时跳过）", async (t) => {
  const tmpRoot = path.join(os.tmpdir(), `itt-paths-${Date.now()}`);
  await mkdir(tmpRoot, { recursive: true });
  const bundleDir = path.join(tmpRoot, "bundle");
  const outsideDir = path.join(tmpRoot, "outside");
  await mkdir(path.join(bundleDir, "assets"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "evil.png"), "not a real png");
  await writeFile(path.join(bundleDir, "assets", "safe.png"), "png");

  let linkError: unknown;
  try {
    // Windows 上创建符号链接需要开发者模式或管理员权限
    await symlink(
      path.join(outsideDir, "evil.png"),
      path.join(bundleDir, "assets", "link-evil.png"),
      "file",
    );
  } catch (error) {
    linkError = error;
  }

  if (linkError !== undefined) {
    const code = (linkError as NodeJS.ErrnoException).code;
    t.skip(`当前环境无法创建符号链接（${code}），跳过越界符号链接用例`);
    return;
  }

  // 词法检查通过（相对路径在包内）……
  assert.doesNotThrow(() =>
    resolveAssetPath(bundleDir, "assets/link-evil.png", "render"),
  );

  // ……但真实路径检查必须拒绝
  await assert.rejects(
    resolveAssetPathReal(bundleDir, "assets/link-evil.png", "render"),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, /真实路径/);
      return true;
    },
  );

  // 包内真实文件仍可通过
  await assert.doesNotReject(
    resolveAssetPathReal(bundleDir, "assets/safe.png", "render"),
  );
});
