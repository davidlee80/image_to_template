/**
 * T07：CLI 测试。
 *
 * 覆盖：parseArgs（位置参数/显式参数/值参数/--分隔）、退出码映射、
 * help=0、未知命令=64、--json 输出结构、缺环境变量 extract 的失败路径。
 * 离线：不调用真实模型。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cliMain, exitCodeOf, parseArgs } from "../../src/cli.js";
import { ImageTemplateError } from "../../src/errors.js";

test("parseArgs：位置参数、布尔 flag、值 flag", () => {
  const parsed = parseArgs([
    "extract",
    "input/a.png",
    "output/b",
    "--overwrite",
    "--strict",
    "--template",
    "x.json",
  ]);

  assert.equal(parsed.command, "extract");
  assert.deepEqual(parsed.positionals, ["input/a.png", "output/b"]);
  assert.equal(parsed.flags.get("overwrite"), true);
  assert.equal(parsed.flags.get("strict"), true);
  assert.equal(parsed.flags.get("template"), "x.json");
});

test("parseArgs：--flag=value 形式", () => {
  const parsed = parseArgs(["render", "--data=updated.json", "--output=o.png"]);
  assert.equal(parsed.command, "render");
  assert.equal(parsed.flags.get("data"), "updated.json");
  assert.equal(parsed.flags.get("output"), "o.png");
});

test("parseArgs：-- 之后全部为位置参数", () => {
  const parsed = parseArgs(["render", "--", "--looks-like-flag"]);
  assert.deepEqual(parsed.positionals, ["--looks-like-flag"]);
});

test("parseArgs：值参数缺值时报错", () => {
  assert.throws(
    () => parseArgs(["render", "--data"]),
    (error: unknown) => {
      assert.ok(error instanceof ImageTemplateError);
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    },
  );
});

test("exitCodeOf：状态与严格模式映射", () => {
  assert.equal(exitCodeOf("pass", false), 0);
  assert.equal(exitCodeOf("pass", true), 0);
  assert.equal(exitCodeOf("needs_review", false), 0);
  assert.equal(exitCodeOf("needs_review", true), 2);
  assert.equal(exitCodeOf("failed", false), 1);
  assert.equal(exitCodeOf("failed", true), 1);
});

test("CLI：help 返回 0", async () => {
  const code = await cliMain(["--help"]);
  assert.equal(code, 0);

  const codeH = await cliMain(["-h"]);
  assert.equal(codeH, 0);
});

test("CLI：未知命令返回 64", async () => {
  const code = await cliMain(["frobnicate", "a", "b"]);
  assert.equal(code, 64);
});

test("CLI：extract 参数缺失返回 64", async () => {
  const code = await cliMain(["extract", "only-one-arg"]);
  assert.equal(code, 64);

  const codeNoArgs = await cliMain(["extract"]);
  assert.equal(codeNoArgs, 64);
});

test("CLI：render 模板包不存在返回 1（执行失败，非参数错误）", async () => {
  const code = await cliMain(["render", "Z:/definitely/not/exist"]);
  assert.equal(code, 1);
});

test("CLI：无模型环境变量时 extract 明确失败（退出码 1）", async () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedModel = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;

  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "itt-cli-"));
    try {
      const code = await cliMain([
        "extract",
        "input/travel_plan_page_0005.png",
        path.join(dir, "out"),
      ]);
      // 缺视觉配置 → INVALID_CONFIG（非 INVALID_ARGUMENT）→ 1
      assert.equal(code, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    if (savedModel !== undefined) process.env.OPENAI_MODEL = savedModel;
  }
});

test("CLI：--json 下错误对象可从 stdout 解析", async () => {
  // 捕获 stdout
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") {
      captured += chunk;
    }
    return true;
  }) as typeof process.stdout.write;

  try {
    const code = await cliMain(["--json", "render", "Z:/definitely/not/exist"]);
    assert.equal(code, 1);

    const parsed = JSON.parse(captured) as {
      error: { code: string; stage: string; message: string };
    };
    assert.ok(parsed.error);
    assert.equal(parsed.error.code, "IO_ERROR");
    assert.equal(parsed.error.stage, "render");
  } finally {
    process.stdout.write = originalWrite;
  }
});
