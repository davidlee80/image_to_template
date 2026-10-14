/**
 * PDF 导出（T13 步骤 5）。
 *
 * 实施计划：PDF 根据同一页分配生成，设置页尺寸、背景及字体加载等待，
 * 不再另做一套布局。使用 Chromium page.pdf（与 PNG 同一渲染管线）。
 */

import { chromium } from "playwright";

import { ImageTemplateError } from "../errors.js";

export interface PdfPageInput {
  /** 页 HTML（每页独立文档）。 */
  html: string;
  /** 页逻辑尺寸（px；PDF 以 pt 输出：1px = 0.75pt）。 */
  width: number;
  height: number;
}

export interface PdfExportOptions {
  pages: PdfPageInput[];
  /** 输出 PDF 文件路径。 */
  outputFile: string;
  /** 页间等待超时。 */
  loadTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 生成 PDF：每页以精确页尺寸输出（printBackground 保证背景色/图片）。
 * 单页与多页共用该实现（多页 = 多个 HTML 文档按序拼接）。
 */
export async function exportPagesToPdf(
  options: PdfExportOptions,
): Promise<{ pdfBytes: Buffer; pageCount: number }> {
  const { pages, outputFile: _outputFile, loadTimeoutMs = 30_000, signal } = options;

  if (pages.length === 0) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "render",
      message: "PDF 导出需要至少一页",
    });
  }

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    const pdfs: Buffer[] = [];

    for (const page of pages) {
      if (signal?.aborted) {
        throw new ImageTemplateError({
          code: "ABORTED",
          stage: "render",
          message: "PDF 导出已取消",
        });
      }

      const browserPage = await context.newPage();
      try {
        await browserPage.setContent(page.html, {
          waitUntil: "load",
          timeout: loadTimeoutMs,
        });

        // 字体与图片加载等待（与 PNG 导出一致的策略）
        await browserPage.evaluate(
          async (timeoutMs: number) => {
            const deadline = Date.now() + timeoutMs;
            await Promise.race([
              (async () => {
                await document.fonts.ready;
                await Promise.all(
                  Array.from(document.images).map((img) =>
                    img.decode().catch(() => undefined),
                  ),
                );
              })(),
              new Promise((resolve) =>
                setTimeout(resolve, Math.max(0, deadline - Date.now())),
              ),
            ]);
          },
          loadTimeoutMs,
        );

        // 页尺寸：Playwright pdf 宽高接受 px（内部按 96dpi 换算 pt）
        const pdf = await browserPage.pdf({
          width: `${page.width}px`,
          height: `${page.height}px`,
          printBackground: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        });
        pdfs.push(Buffer.from(pdf));
      } finally {
        await browserPage.close();
      }
    }

    // 多页：逐页渲染到同一上下文后合并由调用方处理；
    // Playwright 单文档 pdf 已含分页，这里按页拼接（每页一个 pdf 文档
    // 的场景由 pipeline 以单文档多 @page 实现；此处返回首页 pdf，
    // 多页拼接由 buildMultiPagePdfHtml 使用单一文档）。
    if (pdfs.length === 1) {
      return { pdfBytes: pdfs[0], pageCount: 1 };
    }

    // 多页：重新以单文档输出（各页顺序拼接，@page 尺寸一致）
    const combined = await renderCombinedPdf(
      context,
      pages,
      loadTimeoutMs,
    );
    return { pdfBytes: combined, pageCount: pages.length };
  } catch (error) {
    if (error instanceof ImageTemplateError) {
      throw error;
    }
    throw new ImageTemplateError({
      code: "PROVIDER_ERROR",
      stage: "render",
      message: `PDF 导出失败：${(error as Error).message}`,
      cause: error,
    });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/** 单文档多页 PDF：HTML 含分页符（page-break-after），@page 统一尺寸。 */
async function renderCombinedPdf(
  context: import("playwright").BrowserContext,
  pages: PdfPageInput[],
  loadTimeoutMs: number,
): Promise<Buffer> {
  const first = pages[0];

  // 各页正文包装：每页一个 .pdf-page 容器（固定尺寸 + break）
  const sections = pages
    .map((page) => {
      // 提取 body 内容（简化： setContent 的文档整体嵌入 iframe 不可行；
      // 采用 srcdoc iframe 拼接会引入嵌套文档字体问题。
      // 直接把每页 HTML 的 body 内嵌到分节容器：
      const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(page.html);
      const body = bodyMatch?.[1] ?? page.html;
      const styleMatch = /<style[^>]*>([\s\S]*)<\/style>/i.exec(page.html);
      const style = styleMatch?.[1] ?? "";
      return `<section class="pdf-page" style="width:${first.width}px;height:${first.height}px;overflow:hidden;page-break-after:always;position:relative">${body}<style>${style}</style></section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<style>
html, body { margin: 0; padding: 0; }
@page { size: ${first.width}px ${first.height}px; margin: 0; }
.pdf-page:last-child { page-break-after: auto; }
</style>
</head>
<body>
${sections}
</body>
</html>`;

  const browserPage = await context.newPage();
  try {
    await browserPage.setContent(html, {
      waitUntil: "load",
      timeout: loadTimeoutMs,
    });
    await browserPage.evaluate(async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      await Promise.race([
        (async () => {
          await document.fonts.ready;
          await Promise.all(
            Array.from(document.images).map((img) =>
              img.decode().catch(() => undefined),
            ),
          );
        })(),
        new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, deadline - Date.now())),
        ),
      ]);
    }, loadTimeoutMs);

    return Buffer.from(
      await browserPage.pdf({
        width: `${first.width}px`,
        height: `${first.height}px`,
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      }),
    );
  } finally {
    await browserPage.close();
  }
}
