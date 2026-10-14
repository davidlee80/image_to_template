/**
 * 浏览器导出与页面诊断（T06）。
 *
 * 实施计划 T06 步骤 1～2：
 * - 锁定 viewport、deviceScaleFactor=1、locale、timezone；replica 按原始像素导出；
 * - 等待 document.fonts.ready 与所有图片 decode；显式核查已声明字体加载成功、
 *   图片 naturalWidth/naturalHeight 非零；设置加载超时；
 * - 采集布局诊断数据（溢出、文字实际边界、重叠/遮挡候选）供 quality/layout 分析。
 *
 * 无论成功、失败或取消都关闭模块创建的浏览器，不终止宿主进程。
 *
 * 注：页面侧脚本以字符串表达式传入 page.evaluate，
 * 避免 tsx/esbuild 编译注入的辅助函数（如 __name）破坏浏览器序列化。
 */

import { chromium } from "playwright";

import { ImageTemplateError } from "../errors.js";
import type { DomTextMismatch } from "../quality/editability.js";

export interface BrowserPageOptions {
  html: string;
  width: number;
  height: number;
  /** 需要核查加载的字体（family + weight）。 */
  requiredFonts: Array<{ family: string; weight: string }>;
  /** locale；默认 zh-CN（锁定环境，跨运行一致）。 */
  locale?: string;
  /** timezone；默认 Asia/Shanghai。 */
  timezoneId?: string;
  /** 加载等待超时（毫秒）；默认 30_000。 */
  loadTimeoutMs?: number;
  signal?: AbortSignal;
}

/** 页面内图片加载状态。 */
export interface PageImageStatus {
  elementId: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
}

/** 页面内文本实测边界（视觉有效边界，union of range rects）。 */
export interface PageTextMetrics {
  id: string;
  /** 元素盒（声明框）。 */
  elementBox: { x: number; y: number; width: number; height: number };
  /** 文字实际渲染边界（Range rect 并集）。 */
  textBounds: { x: number; y: number; width: number; height: number } | null;
  overflowX: number;
  overflowY: number;
}

export interface PageElementMetrics {
  id: string;
  type: string;
  zIndex: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface BrowserDiagnostics {
  canvas: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  texts: PageTextMetrics[];
  elements: PageElementMetrics[];
  images: PageImageStatus[];
  fontsLoaded: Array<{ family: string; weight: string; loaded: boolean }>;
  domTextMismatches: DomTextMismatch[];
}

export interface BrowserRenderResult {
  /** 固定画布截图字节（PNG）。 */
  screenshot: Buffer;
  diagnostics: BrowserDiagnostics;
}

/** 页面侧加载等待脚本（字符串表达式；不接受外部作用域引用）。 */
const LOAD_WAIT_SOURCE = `
async (timeoutMs) => {
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
}
`;

/** 页面侧诊断脚本（字符串表达式；返回可序列化结果）。 */
const DIAGNOSTICS_SOURCE = `
(requiredFonts) => {
  const canvas = document.getElementById("canvas");

  const rect = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

  const texts = [];
  for (const node of document.querySelectorAll("[data-text-id]")) {
    const el = node;
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects());
    let textBounds = null;
    if (rects.length > 0) {
      const left = Math.min(...rects.map((r) => r.left));
      const top = Math.min(...rects.map((r) => r.top));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      textBounds = { x: left, y: top, width: right - left, height: bottom - top };
    }
    texts.push({
      id: el.getAttribute("data-text-id"),
      elementBox: rect(box),
      textBounds,
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
    });
  }

  const elements = [];
  for (const node of document.querySelectorAll("[data-element-id]")) {
    const el = node;
    const box = el.getBoundingClientRect();
    elements.push({
      id: el.getAttribute("data-element-id"),
      type: el.tagName === "IMG" ? "image" : (el.hasAttribute("data-text-id") ? "text" : "box"),
      zIndex: Number(el.style.zIndex || 1),
      box: rect(box),
    });
  }

  const images = [];
  for (const node of document.querySelectorAll("img[data-element-id]")) {
    const img = node;
    images.push({
      elementId: img.getAttribute("data-element-id"),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    });
  }

  const fontsLoaded = requiredFonts.map((f) => ({
    family: f.family,
    weight: f.weight,
    loaded: document.fonts.check(f.weight + ' 16px "' + f.family + '"'),
  }));

  const domTextMismatches = [];
  for (const node of document.querySelectorAll("[data-text-id]")) {
    const el = node;
    const id = el.getAttribute("data-text-id");
    const declared = el.getAttribute("data-expected-text");
    const actual = el.textContent ?? "";
    if (declared === null) {
      domTextMismatches.push({ id, code: "DOM_TEXT_MISSING", message: "缺少 data-expected-text 声明" });
    } else if (actual !== declared) {
      domTextMismatches.push({ id, code: "DOM_TEXT_MISMATCH", message: "DOM 文本与 content 不一致", expected: declared, actual });
    }
  }

  return {
    canvas: {
      scrollWidth: canvas.scrollWidth,
      scrollHeight: canvas.scrollHeight,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
    },
    texts,
    elements,
    images,
    fontsLoaded,
    domTextMismatches,
  };
}
`;

/** 页面侧块测量脚本（T13 paginate：data-block-id 元素的实测几何）。 */
const MEASURE_BLOCKS_SOURCE = `
() => {
  const blocks = [];
  for (const node of document.querySelectorAll("[data-block-id]")) {
    const el = node;
    const box = el.getBoundingClientRect();
    blocks.push({
      id: el.getAttribute("data-block-id"),
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  }
  const canvas = document.getElementById("canvas");
  return {
    blocks,
    contentHeight: canvas === null ? 0 : canvas.scrollHeight,
  };
}
`;

export interface MeasuredBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlockMeasurementResult {
  blocks: MeasuredBlock[];
  /** 画布实际内容高度（grow 策略依据）。 */
  contentHeight: number;
}

/**
 * 渲染 HTML 并测量分页块几何（T13：按组件测量再分页）。
 * 与 renderPage 同一浏览器策略；测量后关闭浏览器。
 */
export async function measurePageBlocks(
  options: BrowserPageOptions,
): Promise<BlockMeasurementResult> {
  const {
    html,
    width,
    height,
    locale = "zh-CN",
    timezoneId = "Asia/Shanghai",
    loadTimeoutMs = 30_000,
    signal,
  } = options;

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      locale,
      timezoneId,
    });
    const page = await context.newPage();

    if (signal?.aborted) {
      throw abortedError();
    }

    await page.setContent(html, { waitUntil: "load", timeout: loadTimeoutMs });
    await page.evaluate(
      `(${LOAD_WAIT_SOURCE})(${JSON.stringify(loadTimeoutMs)})`,
    );

    if (signal?.aborted) {
      throw abortedError();
    }

    const result = (await page.evaluate(
      `(${MEASURE_BLOCKS_SOURCE})()`,
    )) as BlockMeasurementResult;
    return result;
  } catch (error) {
    if (signal?.aborted) {
      throw abortedError();
    }
    if (error instanceof ImageTemplateError) {
      throw error;
    }
    const message = (error as Error).message ?? String(error);
    const isTimeout = message.includes("Timeout") || message.includes("timeout");
    throw new ImageTemplateError({
      code: isTimeout ? "TIMEOUT" : "PROVIDER_ERROR",
      stage: "render",
      message: `块测量失败：${message}`,
      cause: error,
    });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/**
 * 渲染 HTML 到固定画布并采集诊断。
 * 模块每次调用启动并关闭自己的浏览器实例（不与宿主共享）。
 */
export async function renderPage(
  options: BrowserPageOptions,
): Promise<BrowserRenderResult> {
  const {
    html,
    width,
    height,
    requiredFonts,
    locale = "zh-CN",
    timezoneId = "Asia/Shanghai",
    loadTimeoutMs = 30_000,
    signal,
  } = options;

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      locale,
      timezoneId,
    });
    const page = await context.newPage();

    if (signal?.aborted) {
      throw abortedError();
    }

    await page.setContent(html, { waitUntil: "load", timeout: loadTimeoutMs });

    // 字体与图片加载等待（页面内自行限时；拒绝无限等待）
    await page.evaluate(
      `(${LOAD_WAIT_SOURCE})(${JSON.stringify(loadTimeoutMs)})`,
    );

    if (signal?.aborted) {
      throw abortedError();
    }

    const diagnostics = (await page.evaluate(
      `(${DIAGNOSTICS_SOURCE})(${JSON.stringify(requiredFonts)})`,
    )) as BrowserDiagnostics;

    if (signal?.aborted) {
      throw abortedError();
    }

    const screenshot = await page.screenshot({
      fullPage: false,
      timeout: loadTimeoutMs,
    });

    return { screenshot: Buffer.from(screenshot), diagnostics };
  } catch (error) {
    if (signal?.aborted) {
      throw abortedError();
    }
    if (error instanceof ImageTemplateError) {
      throw error;
    }
    // Playwright 超时等执行错误转为类型化错误
    const message = (error as Error).message ?? String(error);
    const isTimeout = message.includes("Timeout") || message.includes("timeout");
    throw new ImageTemplateError({
      code: isTimeout ? "TIMEOUT" : "PROVIDER_ERROR",
      stage: "render",
      message: `浏览器渲染失败：${message}`,
      cause: error,
    });
  } finally {
    // 无论成功、失败或取消都关闭模块创建的浏览器
    await browser?.close().catch(() => undefined);
  }
}

function abortedError(): ImageTemplateError {
  return new ImageTemplateError({
    code: "ABORTED",
    stage: "render",
    message: "渲染已取消",
  });
}
