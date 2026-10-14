/**
 * T03：视觉识别 provider 测试。
 *
 * 覆盖（实施计划 T03 验证项）：fixture provider 覆盖正常、截断、非法 JSON、
 * 错误结构、HTTP 错误和超时；请求结构符合 Responses API（input_image +
 * text.format json_object）；schema 失败返回具体 issue。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  createFixtureVisionProvider,
  createOpenAIVisionProvider,
  createVisionProvider,
} from "../../src/analysis/vision.js";
import { sceneSpecSchema, isSceneSpec } from "../../src/schemas/scene.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { PROMPT_VERSION } from "../../src/analysis/prompts.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

const sceneFixtureFile = path.join(
  fixtureDir,
  "scenes",
  "synthetic-travel.scene.json",
);

const jsonSchema = zodToJsonSchema(sceneSpecSchema, {
  $refStrategy: "none",
}) as Record<string, unknown>;

const tinyPng = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    image: tinyPng,
    width: 800,
    height: 600,
    jsonSchema,
    promptVersion: PROMPT_VERSION,
    ...overrides,
  };
}

/** 构造 Responses API 成功响应。 */
function successResponse(outputText: string): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: outputText }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 构造带拒绝内容的响应。 */
function refusalResponse(): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "不合适的内容" }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function makeProvider(fetchImpl: typeof fetch) {
  return createOpenAIVisionProvider({
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://mock.example/v1",
    fetchImpl,
  });
}

test("成功路径：请求结构正确、输出经 schema 校验、统计完整", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  let capturedUrl: string | undefined;
  let capturedAuth: string | undefined;

  const sceneValue = JSON.parse(await readFile(sceneFixtureFile, "utf8"));
  const provider = makeProvider(async (url, init) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string>).Authorization;
    capturedBody = JSON.parse(String(init?.body));
    return successResponse(JSON.stringify(sceneValue));
  });

  const result = await provider.analyze(baseRequest());

  assert.equal(result.ok, true);
  if (result.ok && isSceneSpec(result.spec)) {
    assert.equal(result.spec.version, "1.0");
    assert.equal(result.spec.elements.length, sceneValue.elements.length);
    assert.equal(result.stats.model, "test-model");
    assert.equal(result.stats.usage?.totalTokens, 150);
    assert.ok(result.stats.durationMs >= 0);
  }

  // 请求结构符合 Responses API
  assert.equal(capturedUrl, "https://mock.example/v1/responses");
  assert.equal(capturedAuth, "Bearer test-key");
  assert.ok(capturedBody);
  assert.equal(capturedBody.model, "test-model");
  assert.equal(
    (capturedBody as { text?: { format?: { type?: string } } }).text?.format
      ?.type,
    "json_object",
  );

  const input = (capturedBody as { input?: Array<Record<string, unknown>> })
    .input ?? [];
  assert.equal(input.length, 2);
  assert.equal(input[0].role, "system");
  const userContent = input[1].content as Array<Record<string, unknown>>;
  assert.equal(userContent[0].type, "input_text");
  assert.equal(userContent[1].type, "input_image");
  const imageUrl = userContent[1].image_url as string;
  assert.ok(imageUrl.startsWith("data:image/png;base64,"), "应为 base64 data URL");
  assert.equal(userContent[1].detail, "high");
});

test("HTTP 500 标记可重试，401 不重试", async () => {
  const provider500 = makeProvider(
    async () => new Response("boom", { status: 500 }),
  );
  const r500 = await provider500.analyze(baseRequest());
  assert.equal(r500.ok, false);
  if (!r500.ok) {
    assert.equal(r500.reason, "http_error");
    assert.equal(r500.httpStatus, 500);
    assert.equal(r500.retryable, true);
  }

  const provider401 = makeProvider(
    async () => new Response("unauthorized", { status: 401 }),
  );
  const r401 = await provider401.analyze(baseRequest());
  assert.equal(r401.ok, false);
  if (!r401.ok) {
    assert.equal(r401.httpStatus, 401);
    assert.equal(r401.retryable, false);
  }
});

test("网络错误标记可重试", async () => {
  const provider = makeProvider(async () => {
    throw new Error("ECONNRESET");
  });
  const result = await provider.analyze(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "http_error");
    assert.equal(result.retryable, true);
  }
});

test("输出未正常结束（incomplete）", async () => {
  const provider = makeProvider(
    async () =>
      new Response(
        JSON.stringify({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: '{"version":"1.0","can' },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
  );

  const result = await provider.analyze(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "incomplete");
    assert.equal(result.retryable, false);
  }
});

test("模型拒绝（refusal）", async () => {
  const provider = makeProvider(async () => refusalResponse());
  const result = await provider.analyze(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "refusal");
  }
});

test("空输出（empty_output）", async () => {
  const provider = makeProvider(async () => successResponse(""));
  const result = await provider.analyze(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "empty_output");
  }
});

test("输出不是合法 JSON（json_parse）", async () => {
  const provider = makeProvider(async () => successResponse("这不是 JSON"));
  const result = await provider.analyze(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "json_parse");
  }
});

test("输出结构非法（schema）且返回具体 issue 路径", async () => {
  const provider = makeProvider(async () =>
    successResponse(
      JSON.stringify({
        version: "1.0",
        canvas: { width: 100, height: 100, background: "#FFFFFF" },
        elements: [
          { id: "a", type: "text", x: -5, y: 0, width: 10, height: 10, text: "负坐标" },
        ],
      }),
    ),
  );

  const result = await provider.analyze(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "schema");
    assert.ok(result.issues && result.issues.length > 0);
    assert.ok(result.issues!.some((issue) => issue.path.includes("x")));
  }
});

test("超时中止请求", async () => {
  const provider = createOpenAIVisionProvider({
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://mock.example/v1",
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("AbortError"), { name: "AbortError" })),
        );
      }),
  });

  const result = await provider.analyze(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "http_error");
    assert.ok(!result.retryable, "中止/超时不应标记为可重试");
    assert.ok(result.message.includes("中止") || result.message.includes("超时"));
  }
});

test("外部 signal 触发时中止", async () => {
  const controller = new AbortController();
  const provider = createOpenAIVisionProvider({
    model: "test-model",
    apiKey: "test-key",
    baseUrl: "https://mock.example/v1",
    timeoutMs: 10_000,
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("AbortError"), { name: "AbortError" })),
        );
      }),
  });

  setTimeout(() => controller.abort(), 10);
  const result = await provider.analyze(baseRequest({ signal: controller.signal }));
  assert.equal(result.ok, false);
});

test("fixture provider：合法响应走同一校验链路", async () => {
  const provider = createFixtureVisionProvider(sceneFixtureFile);
  const result = await provider.analyze(baseRequest());

  assert.equal(result.ok, true);
  if (result.ok && isSceneSpec(result.spec)) {
    assert.equal(result.spec.canvas.width, 800);
    assert.equal(result.stats.provider, "fixture");
  }
});

test("fixture provider：非法响应报 schema 失败", async () => {
  const provider = createFixtureVisionProvider(
    path.join(fixtureDir, "model-responses", "invalid-scene.response.json"),
  );
  const result = await provider.analyze(baseRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "schema");
  }
});

test("createVisionProvider 工厂：缺 apiKey / fixtureFile 明确报错", () => {
  assert.throws(() =>
    createVisionProvider({ kind: "openai-http", model: "m" } as never),
  );
  assert.throws(() =>
    createVisionProvider({ kind: "fixture", model: "fixture" } as never),
  );
});
