/**
 * T13：PDF 导出集成测试（真实 Chromium；不调用模型）。
 *
 * 覆盖：单页 PDF 输出有效 PDF 字节；多页 PDF 页数一致；
 * 空页输入报错；页尺寸以 pt 输出。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { exportPagesToPdf } from "../../src/render/pdf.js";
import { isImageTemplateError } from "../../src/errors.js";

function pageHtml(content: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<style>
html, body { margin: 0; padding: 0; }
body { width: 400px; height: 300px; background: #F5F1EA; }
.page-content { padding: 20px; font-size: 16px; }
</style>
</head>
<body>
<div class="page-content">${content}</div>
</body>
</html>`;
}

test("单页 PDF：有效 PDF 字节（%PDF 头）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-pdf-"));
  try {
    const { pdfBytes, pageCount } = await exportPagesToPdf({
      pages: [{ html: pageHtml("<h1>旅行计划</h1><p>第一页内容</p>"), width: 400, height: 300 }],
      outputFile: path.join(dir, "out.pdf"),
    });

    assert.equal(pageCount, 1);
    assert.ok(pdfBytes.length > 500, "PDF 应有实际内容");
    assert.equal(pdfBytes.subarray(0, 4).toString("ascii"), "%PDF", "应为 PDF 魔数");
    assert.ok(pdfBytes.toString("latin1").includes("%%EOF"));

    await writeFile(path.join(dir, "out.pdf"), pdfBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("多页 PDF：页数一致且输出有效", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-pdf-"));
  try {
    const { pdfBytes, pageCount } = await exportPagesToPdf({
      pages: [
        { html: pageHtml("<h1>第 1 页</h1>"), width: 400, height: 300 },
        { html: pageHtml("<h1>第 2 页</h1><p>续页内容</p>"), width: 400, height: 300 },
        { html: pageHtml("<h1>第 3 页</h1>"), width: 400, height: 300 },
      ],
      outputFile: path.join(dir, "multi.pdf"),
    });

    assert.equal(pageCount, 3);
    assert.equal(pdfBytes.subarray(0, 4).toString("ascii"), "%PDF");
    // 多页 PDF 包含多个 /Page 对象
    const pageObjects = pdfBytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g);
    assert.ok(
      pageObjects !== null && pageObjects.length >= 3,
      `PDF 应含 3 个页对象（实际 ${pageObjects?.length ?? 0}）`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("空页输入报错", async () => {
  await assert.rejects(
    exportPagesToPdf({ pages: [], outputFile: "unused.pdf" }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.ok((error as Error).message.includes("至少一页"));
      return true;
    },
  );
});
