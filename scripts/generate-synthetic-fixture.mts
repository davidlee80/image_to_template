/**
 * 生成离线测试用的合成图 fixture 与人工 SceneSpec fixture（T01）。
 *
 * 单一来源：本脚本内的元素定义表同时驱动
 *   1. 合成图 tests/fixtures/images/synthetic-travel.png（Chromium 截图，含文本/色块/照片框/中文与拉丁文字/层级）
 *   2. 人工 SceneSpec tests/fixtures/scenes/synthetic-travel.scene.json（结构与设计文档 Template 一致）
 * 两者由同一份坐标定义生成，保证对齐、不漂移。
 *
 * 运行：npm exec tsx scripts/generate-synthetic-fixture.mts
 * 前置：npx playwright install chromium
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const imageDir = path.join(rootDir, "tests", "fixtures", "images");
const sceneDir = path.join(rootDir, "tests", "fixtures", "scenes");

const CANVAS = { width: 800, height: 600, background: "#FFFFFF" } as const;

/** 照片框在合成图中的渲染提示；不进入 SceneSpec。 */
interface GradientHint {
  gradient: [string, string];
}

type FixtureText = {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  text: string;
  fontSize: number;
  fontFamily: "sans" | "serif" | "latin";
  fontWeight: "400" | "700";
  lineHeight?: number;
  letterSpacing?: number;
  color?: string;
  align?: "left" | "center" | "right";
  confidence?: number;
};

type FixtureBox = {
  id: string;
  type: "box";
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  fill?: string;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  confidence?: number;
};

type FixtureImage = {
  id: string;
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  confidence?: number;
} & GradientHint;

type FixtureElement = FixtureText | FixtureBox | FixtureImage;

/**
 * 合成旅行海报元素表：头部信息区、时间轴、编号圆点、照片框、底部信息条。
 * 坐标为 800×600 画布内的绝对像素。
 */
const elements: FixtureElement[] = [
  // 头部
  { id: "header_background", type: "box", x: 0, y: 0, width: 800, height: 120, fill: "#193753" },
  { id: "day_label", type: "text", x: 668, y: 22, width: 100, height: 28, zIndex: 2, text: "DAY 5", fontSize: 20, fontFamily: "latin", fontWeight: "700", color: "#CB923B", confidence: 0.95 },
  { id: "destination_title", type: "text", x: 40, y: 22, width: 420, height: 42, zIndex: 2, text: "本溪水洞 · 天桥沟", fontSize: 30, fontFamily: "sans", fontWeight: "700", color: "#FFFFFF", confidence: 0.95 },
  { id: "subtitle", type: "text", x: 40, y: 70, width: 420, height: 26, zIndex: 2, text: "地下暗河 · 枫叶栈道 · 本溪味道", fontSize: 16, fontFamily: "sans", fontWeight: "400", color: "#A29485", confidence: 0.9 },

  // 左栏：时间轴
  { id: "timeline_heading", type: "text", x: 40, y: 148, width: 200, height: 30, zIndex: 2, text: "今日行程", fontSize: 20, fontFamily: "sans", fontWeight: "700", color: "#193753", confidence: 0.9 },
  { id: "timeline_divider", type: "box", x: 40, y: 188, width: 480, height: 1, fill: "#D7CFC3" },
  { id: "stop1_badge", type: "box", x: 40, y: 210, width: 26, height: 26, zIndex: 1, fill: "#3C75A6", radius: 13 },
  { id: "stop1_number", type: "text", x: 40, y: 210, width: 26, height: 26, zIndex: 2, text: "1", fontSize: 14, fontFamily: "latin", fontWeight: "700", color: "#FFFFFF", align: "center", confidence: 0.9 },
  { id: "stop1_title", type: "text", x: 78, y: 210, width: 200, height: 26, zIndex: 2, text: "天桥沟", fontSize: 18, fontFamily: "sans", fontWeight: "700", color: "#514B43", confidence: 0.9 },
  { id: "stop1_time", type: "text", x: 300, y: 212, width: 130, height: 22, zIndex: 2, text: "10:00–12:00", fontSize: 14, fontFamily: "latin", fontWeight: "400", color: "#A29485", confidence: 0.85 },
  { id: "stop1_description", type: "text", x: 78, y: 240, width: 420, height: 44, zIndex: 2, text: "林间木栈道漫步看奇石，平缓不费腿。", fontSize: 14, fontFamily: "sans", fontWeight: "400", lineHeight: 1.5, color: "#514B43", confidence: 0.85 },
  { id: "stop2_badge", type: "box", x: 40, y: 320, width: 26, height: 26, zIndex: 1, fill: "#CB923B", radius: 13 },
  { id: "stop2_number", type: "text", x: 40, y: 320, width: 26, height: 26, zIndex: 2, text: "2", fontSize: 14, fontFamily: "latin", fontWeight: "700", color: "#FFFFFF", align: "center", confidence: 0.9 },
  { id: "stop2_title", type: "text", x: 78, y: 320, width: 200, height: 26, zIndex: 2, text: "本溪水洞", fontSize: 18, fontFamily: "sans", fontWeight: "700", color: "#514B43", confidence: 0.9 },
  { id: "stop2_time", type: "text", x: 300, y: 322, width: 130, height: 22, zIndex: 2, text: "13:30–16:00", fontSize: 14, fontFamily: "latin", fontWeight: "400", color: "#A29485", confidence: 0.85 },
  { id: "stop2_description", type: "text", x: 78, y: 350, width: 420, height: 44, zIndex: 2, text: "乘船游览地下暗河，洞内恒温约 12°C。", fontSize: 14, fontFamily: "sans", fontWeight: "400", lineHeight: 1.5, color: "#514B43", confidence: 0.85 },

  // 右栏：照片框（合成图中渲染为渐变占位照片）
  { id: "photo_trail", type: "image", x: 560, y: 148, width: 200, height: 130, zIndex: 1, gradient: ["#7FA8C9", "#3C75A6"], confidence: 0.8 },
  { id: "photo_trail_caption", type: "text", x: 560, y: 284, width: 200, height: 20, zIndex: 2, text: "天桥沟栈道", fontSize: 12, fontFamily: "sans", fontWeight: "400", color: "#A29485", confidence: 0.8 },
  { id: "photo_cave", type: "image", x: 560, y: 316, width: 200, height: 130, zIndex: 1, gradient: ["#5E7E99", "#193753"], confidence: 0.8 },
  { id: "photo_cave_caption", type: "text", x: 560, y: 452, width: 200, height: 20, zIndex: 2, text: "本溪水洞", fontSize: 12, fontFamily: "sans", fontWeight: "400", color: "#A29485", confidence: 0.8 },

  // 底部信息条
  { id: "footer_bar", type: "box", x: 0, y: 560, width: 800, height: 40, fill: "#F5F1EA" },
  { id: "footer_note", type: "text", x: 40, y: 570, width: 420, height: 20, zIndex: 2, text: "本溪 · 第 5 天 · 多云 22–28°C", fontSize: 13, fontFamily: "sans", fontWeight: "400", color: "#514B43", confidence: 0.85 },
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

const systemFamily: Record<FixtureText["fontFamily"], string> = {
  sans: '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  serif: '"Noto Serif CJK SC", "SimSun", serif',
  latin: 'Georgia, "Times New Roman", serif',
};

function renderElementHtml(e: FixtureElement): string {
  const position = [
    "position:absolute",
    `left:${e.x}px`,
    `top:${e.y}px`,
    `width:${e.width}px`,
    `height:${e.height}px`,
    `z-index:${e.zIndex ?? 1}`,
    "box-sizing:border-box",
  ].join(";");

  if (e.type === "text") {
    const style = [
      position,
      `font-family:${systemFamily[e.fontFamily]}`,
      `font-size:${e.fontSize}px`,
      `font-weight:${e.fontWeight}`,
      `line-height:${e.lineHeight ?? 1.4}`,
      ...(e.letterSpacing ? [`letter-spacing:${e.letterSpacing}px`] : []),
      `color:${e.color ?? "#333333"}`,
      `text-align:${e.align ?? "left"}`,
      "white-space:pre-wrap",
      "overflow-wrap:anywhere",
      "overflow:visible",
    ].join(";");
    return `<div data-text-id="${escapeHtml(e.id)}" style="${escapeHtml(style)}">${escapeHtml(e.text)}</div>`;
  }

  if (e.type === "box") {
    const style = [
      position,
      `background:${e.fill ?? "transparent"}`,
      `border:${e.borderWidth ?? 0}px solid ${e.borderColor ?? "#CCCCCC"}`,
      `border-radius:${e.radius ?? 0}px`,
    ].join(";");
    return `<div data-element-id="${escapeHtml(e.id)}" style="${escapeHtml(style)}"></div>`;
  }

  const style = [
    position,
    `background:linear-gradient(135deg, ${e.gradient[0]}, ${e.gradient[1]})`,
  ].join(";");
  return `<div data-element-id="${escapeHtml(e.id)}" style="${escapeHtml(style)}"></div>`;
}

function buildSyntheticHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
html, body { margin: 0; padding: 0; }
#canvas {
  position: relative;
  width: ${CANVAS.width}px;
  height: ${CANVAS.height}px;
  background: ${CANVAS.background};
}
</style>
</head>
<body>
<div id="canvas">
${elements.map(renderElementHtml).join("\n")}
</div>
</body>
</html>`;
}

/** 人工 SceneSpec：结构与设计文档 Template（version 1.0）一致；text 的正文在提取阶段移入 content.json，此处保留原文供校对。 */
function buildSceneSpec(): Record<string, unknown> {
  return {
    version: "1.0",
    canvas: { ...CANVAS },
    elements: elements.map((e) => {
      const base = {
        id: e.id,
        type: e.type,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        zIndex: e.zIndex ?? 1,
        confidence: e.confidence ?? 0.9,
      };

      if (e.type === "text") {
        return {
          ...base,
          text: e.text,
          fontSize: e.fontSize,
          fontFamily: e.fontFamily,
          fontWeight: e.fontWeight,
          lineHeight: e.lineHeight ?? 1.4,
          letterSpacing: e.letterSpacing ?? 0,
          color: e.color ?? "#333333",
          align: e.align ?? "left",
        };
      }

      if (e.type === "box") {
        return {
          ...base,
          fill: e.fill ?? "transparent",
          borderColor: e.borderColor ?? "#CCCCCC",
          borderWidth: e.borderWidth ?? 0,
          radius: e.radius ?? 0,
        };
      }

      return { ...base, src: "" }; // image 的 src 由提取阶段（T04）填充
    }),
    notes: [
      "人工构造的合成旅行海报 fixture：坐标、文字与 tests/fixtures/images/synthetic-travel.png 由 scripts/generate-synthetic-fixture.mts 同一来源生成。",
    ],
  };
}

async function main(): Promise<void> {
  await mkdir(imageDir, { recursive: true });
  await mkdir(sceneDir, { recursive: true });

  const html = buildSyntheticHtml();
  const htmlPath = path.join(imageDir, "synthetic-travel.source.html");
  await writeFile(htmlPath, html, "utf8");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: CANVAS.width, height: CANVAS.height },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.screenshot({
      path: path.join(imageDir, "synthetic-travel.png"),
      fullPage: false,
    });
  } finally {
    await browser.close();
  }

  await writeFile(
    path.join(sceneDir, "synthetic-travel.scene.json"),
    JSON.stringify(buildSceneSpec(), null, 2),
    "utf8",
  );

  process.stdout.write(
    "已生成 tests/fixtures/images/synthetic-travel.png 与 tests/fixtures/scenes/synthetic-travel.scene.json\n",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
