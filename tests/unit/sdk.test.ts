/**
 * T01：SDK 骨架测试。
 *
 * 覆盖：
 * - import 公开入口无运行副作用（不产生输出、不挂起）；
 * - createImageTemplate 返回配置隔离实例；
 * - 未实现能力明确拒绝（NOT_IMPLEMENTED，含 code/stage/retryable）；
 * - 非法配置抛 INVALID_CONFIG；
 * - 类型化错误结构（toJSON / isImageTemplateError）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createImageTemplate,
  ImageTemplateError,
  isImageTemplateError,
} from "../../src/index.js";

test("import 公开入口不产生副作用且导出形状正确", () => {
  assert.equal(typeof createImageTemplate, "function");
  assert.equal(typeof ImageTemplateError, "function");
  assert.equal(typeof isImageTemplateError, "function");
});

test("createImageTemplate 返回具备全部操作方法的实例", () => {
  const instance = createImageTemplate();
  for (const method of [
    "extract",
    "render",
    "compare",
    "validate",
    "calibrate",
    "batch",
  ] as const) {
    assert.equal(typeof instance[method], "function", `缺少方法 ${method}`);
  }
});

test("未实现能力明确拒绝并携带 code/stage/retryable", async () => {
  const instance = createImageTemplate();

  // T04 起 extract 已实现：缺视觉配置时明确报 INVALID_CONFIG
  await assert.rejects(
    instance.extract({ input: "input/x.png", output: "output/x" }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "INVALID_CONFIG");
      assert.equal(error.stage, "extract");
      return true;
    },
  );

  // T06 起 render 已实现：模板包不存在时报 IO_ERROR
  await assert.rejects(
    instance.render({ template: "output/not-exist-bundle" }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "IO_ERROR");
      return true;
    },
  );

  // T07 起 compare 已实现：模板包不存在时报 IO_ERROR
  await assert.rejects(
    instance.compare({ bundle: "output/not-exist-bundle" }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "IO_ERROR");
      return true;
    },
  );

  for (const [method, options] of [
    ["validate", { bundle: "output/x" }],
    ["calibrate", { bundle: "output/x" }],
    ["batch", { manifest: "tests/fixtures/batch.json" }],
  ] as const) {
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 骨架阶段统一验证拒绝行为
      (instance[method] as any)(options),
      (error: unknown) => {
        assert.ok(isImageTemplateError(error));
        assert.equal(error.code, "NOT_IMPLEMENTED");
        return true;
      },
    );
  }
});

test("非法配置抛 INVALID_CONFIG", () => {
  assert.throws(
    () => createImageTemplate({ logger: "not-a-function" as unknown as never }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "INVALID_CONFIG");
      assert.equal(error.stage, "config");
      return true;
    },
  );

  assert.throws(
    () =>
      createImageTemplate({
        directories: { output: 123 as unknown as string },
      }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.equal(error.code, "INVALID_CONFIG");
      return true;
    },
  );
});

test("合法配置被接受（logger / directories）", () => {
  const logs: string[] = [];
  const instance = createImageTemplate({
    logger: (message) => logs.push(message),
    directories: { output: "output", cache: ".cache", temp: ".cache/tmp" },
  });
  assert.equal(typeof instance.render, "function");
  assert.deepEqual(logs, []);
});

test("ImageTemplateError 的 toJSON 结构完整", () => {
  const error = new ImageTemplateError({
    code: "TIMEOUT",
    stage: "render",
    message: "渲染超时",
    runId: "run-001",
    retryable: true,
  });

  const json = error.toJSON();
  assert.equal(json.code, "TIMEOUT");
  assert.equal(json.stage, "render");
  assert.equal(json.message, "渲染超时");
  assert.equal(json.runId, "run-001");
  assert.equal(json.retryable, true);

  // 未提供 runId 时省略该字段
  const minimal = new ImageTemplateError({
    code: "IO_ERROR",
    stage: "extract",
    message: "读取失败",
  });
  assert.equal("runId" in minimal.toJSON(), false);
});

test("isImageTemplateError 拒绝非本类型错误", () => {
  assert.equal(isImageTemplateError(new Error("普通错误")), false);
  assert.equal(isImageTemplateError("字符串"), false);
  assert.equal(isImageTemplateError(null), false);
});
