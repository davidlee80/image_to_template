/**
 * T10：缓存与预算单元测试。
 *
 * 覆盖：缓存键对图片哈希/区域/缩放/提示词版本/schema/模型/provider 参数/
 * OCR 配置敏感；失败条目不命中；损坏条目清理；预算耗尽；重试分类与
 * 全部尝试计入同一预算。
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ResponseCache,
  cacheKeyOf,
  type CacheKeyInput,
} from "../../src/runtime/cache.js";
import {
  BudgetExhaustedError,
  CallBudget,
  classifyFailure,
  executeWithRetry,
  LOW_CONFIDENCE_THRESHOLD,
} from "../../src/runtime/budget.js";
import type { VisionFailure } from "../../src/analysis/provider.js";

const baseKey: CacheKeyInput = {
  kind: "vision",
  imageSha256: "abc",
  promptVersion: "scene-1.0.0",
  schemaVersion: "1.0",
  model: "test-model",
};

test("缓存键对各输入字段敏感", () => {
  const base = cacheKeyOf(baseKey);

  // 图片哈希
  assert.notEqual(
    cacheKeyOf({ ...baseKey, imageSha256: "different" }),
    base,
  );
  // 区域与缩放
  assert.notEqual(
    cacheKeyOf({ ...baseKey, region: "header", scale: 2 }),
    base,
  );
  assert.notEqual(
    cacheKeyOf({ ...baseKey, region: "header", scale: 2 }),
    cacheKeyOf({ ...baseKey, region: "header", scale: 1 }),
  );
  // 提示词版本
  assert.notEqual(
    cacheKeyOf({ ...baseKey, promptVersion: "scene-2.0.0" }),
    base,
  );
  // schema 版本
  assert.notEqual(cacheKeyOf({ ...baseKey, schemaVersion: "2.0" }), base);
  // 模型
  assert.notEqual(cacheKeyOf({ ...baseKey, model: "other-model" }), base);
  // provider 参数
  assert.notEqual(
    cacheKeyOf({ ...baseKey, providerParams: { detail: "high" } }),
    cacheKeyOf({ ...baseKey, providerParams: { detail: "low" } }),
  );
  // OCR 配置
  assert.notEqual(
    cacheKeyOf({ ...baseKey, kind: "ocr", ocrConfig: { lang: "chi_sim" } }),
    cacheKeyOf({ ...baseKey, kind: "ocr", ocrConfig: { lang: "eng" } }),
  );

  // 相同输入稳定
  assert.equal(cacheKeyOf(baseKey), base);
  // 字段顺序不影响键
  assert.equal(
    cacheKeyOf({
      model: "test-model",
      schemaVersion: "1.0",
      promptVersion: "scene-1.0.0",
      imageSha256: "abc",
      kind: "vision",
    }),
    base,
  );
});

test("缓存：put/get 命中；失败条目不命中；损坏条目清理", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-cache-"));
  try {
    const cache = new ResponseCache(dir);
    const key = cacheKeyOf(baseKey);

    // 未命中
    assert.equal(await cache.get(key), null);

    // 写入成功条目 → 命中
    await cache.put({
      key,
      kind: "vision",
      createdAt: new Date().toISOString(),
      ok: true,
      raw: { version: "1.0" },
      validated: { version: "1.0", canvas: {}, elements: [] },
    });
    const hit = await cache.get(key);
    assert.ok(hit);
    assert.deepEqual(hit.entry.validated, {
      version: "1.0",
      canvas: {},
      elements: [],
    });

    // 失败条目（同键覆盖为 ok=false）→ 不命中
    await cache.put({
      key,
      kind: "vision",
      createdAt: new Date().toISOString(),
      ok: false,
      raw: null,
    });
    assert.equal(await cache.get(key), null);

    // 损坏条目：删除并视为未命中
    const file = path.join(dir, `${key}.json`);
    await writeFile(file, "{corrupted", "utf8");
    assert.equal(await cache.get(key), null);
    const files = await readdir(dir);
    assert.equal(files.includes(`${key}.json`), false, "损坏条目应被清理");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("预算：请求数与时间耗尽", () => {
  const budget = new CallBudget({ maxRequests: 2 });
  budget.recordRequest("a");
  budget.recordRequest("b");
  assert.equal(budget.usedRequests, 2);
  assert.equal(budget.exhausted, true);

  assert.throws(
    () => budget.recordRequest("c"),
    (error: unknown) => error instanceof BudgetExhaustedError,
  );
});

test("预算：时间预算耗尽", async () => {
  const budget = new CallBudget({ maxRequests: 100, timeoutMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(budget.exhausted, true);
  assert.throws(
    () => budget.recordRequest("x"),
    (error: unknown) => error instanceof BudgetExhaustedError,
  );
});

test("classifyFailure 分类", () => {
  const http500: VisionFailure = {
    ok: false,
    reason: "http_error",
    message: "",
    httpStatus: 500,
    retryable: true,
  };
  const http401: VisionFailure = {
    ok: false,
    reason: "http_error",
    message: "",
    httpStatus: 401,
    retryable: false,
  };
  const badJson: VisionFailure = {
    ok: false,
    reason: "json_parse",
    message: "",
    retryable: false,
  };
  const refused: VisionFailure = {
    ok: false,
    reason: "refusal",
    message: "",
    retryable: false,
  };

  assert.equal(classifyFailure(http500), "network_transient");
  assert.equal(classifyFailure(http401), "fatal");
  assert.equal(classifyFailure(badJson), "invalid_output");
  assert.equal(classifyFailure(refused), "fatal");
  assert.equal(LOW_CONFIDENCE_THRESHOLD, 0.7);
});

test("executeWithRetry：网络暂态重试一次后成功，全部尝试计入预算", async () => {
  const budget = new CallBudget({ maxRequests: 10 });
  let calls = 0;

  const result = await executeWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          failure: {
            ok: false,
            reason: "http_error",
            message: "503",
            httpStatus: 503,
            retryable: true,
          } satisfies VisionFailure,
        };
      }
      return { ok: true as const, value: "done" };
    },
    { budget, label: "test" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.value, "done");
  assert.equal(result.totalRequests, 2);
  assert.equal(budget.usedRequests, 2, "重试也计入预算");
  assert.equal(result.attempts.length, 2);
});

test("executeWithRetry：致命失败不重试", async () => {
  const budget = new CallBudget({ maxRequests: 10 });
  let calls = 0;

  const result = await executeWithRetry(
    async () => {
      calls += 1;
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "refusal",
          message: "refused",
          retryable: false,
        } satisfies VisionFailure,
      };
    },
    { budget, label: "test" },
  );

  assert.equal(result.ok, false);
  assert.equal(calls, 1, "致命失败不重试");
  assert.equal(result.totalRequests, 1);
});

test("executeWithRetry：网络重试上限后失败", async () => {
  const budget = new CallBudget({ maxRequests: 10 });

  const result = await executeWithRetry(
    async () => ({
      ok: false,
      failure: {
        ok: false,
        reason: "http_error",
        message: "503",
        httpStatus: 503,
        retryable: true,
      } satisfies VisionFailure,
    }),
    { budget, label: "test", policy: { maxNetworkRetries: 1 } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.totalRequests, 2, "1 次原始 + 1 次重试");
  assert.equal(budget.usedRequests, 2);
});

test("executeWithRetry：预算耗尽时抛出", async () => {
  const budget = new CallBudget({ maxRequests: 1 });

  await assert.rejects(
    executeWithRetry(
      async () => ({
        ok: false,
        failure: {
          ok: false,
          reason: "http_error",
          message: "503",
          retryable: true,
        } satisfies VisionFailure,
      }),
      { budget, label: "test" },
    ),
    (error: unknown) => error instanceof BudgetExhaustedError,
  );
});
