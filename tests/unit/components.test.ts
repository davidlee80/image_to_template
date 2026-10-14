/**
 * T12：旅行组件与 LayoutSpec 渲染测试。
 *
 * 覆盖：七类组件注册、空模块隐藏、repeat 稳定 ID、图片 objectFit/占位替换、
 * 绑定渲染（含转义）、主题覆盖、未知组件拒绝。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import {
  componentRegistry,
  registeredComponents,
} from "../../src/render/components.js";
import { buildLayoutHtml } from "../../src/render/layout-html.js";
import {
  applyThemeOverrides,
  defaultTravelTheme,
} from "../../src/semantic/travel-theme.js";
import { parseLayoutSpec, type LayoutSpec } from "../../src/schemas/layout.js";
import type { TravelContent } from "../../src/schemas/travel.js";

function travelContent(): TravelContent {
  return {
    schemaVersion: "1.0",
    header: {
      day: 5,
      date: "2026.07.14",
      weekday: "TUE",
      title: "本溪水洞 · 天桥沟",
      subtitle: "地下暗河 · 枫叶栈道 · 本溪味道",
    },
    weather: { text: "多云", temperature: "22–28°C", rainProbability: 25 },
    hotel: { name: "全季酒店（沈阳东中街桥津路店）", stayText: "7月14日–17日 三晚" },
    timeline: [
      {
        id: "tianqiaogou",
        number: 1,
        color: "#3C75A6",
        title: "天桥沟",
        time: "10:00–12:00",
        description: "多栈道和平路不费腿，林间木栈道漫步看奇石。",
        tags: [
          { text: "木栈道", tone: "green" },
          { text: "自然风光", tone: "blue" },
        ],
      },
      {
        id: "benxi-cave",
        number: 2,
        color: "#CB923B",
        title: "本溪水洞",
        time: "13:30–16:00",
        description: "乘船游览地下暗河。",
        tags: [],
      },
    ],
    photos: [
      { src: "assets/trail.png", alt: "栈道", caption: "天桥沟栈道", objectPosition: "50% 35%" },
      { src: "assets/cave.png", alt: "水洞", caption: "本溪水洞", objectPosition: "50% 50%" },
    ],
    foods: [{ name: "小市羊汤", description: "当地名吃" }],
    experiences: [{ text: "洞内乘船体验" }],
    photoChecklist: [{ text: "五女山合影", done: false }],
    parking: { text: "景区北门停车场，10 元/小时" },
    booking: { text: "官方公众号预约，成人 110 元" },
    restaurantGroups: [
      {
        groupName: "本溪市内",
        restaurants: [
          { name: "老边饺子", note: "人均 40" },
          { name: "长宽猪蹄", note: "" },
        ],
      },
    ],
  };
}

test("七类组件全部注册", () => {
  const names = registeredComponents();
  for (const expected of [
    "header",
    "two-column",
    "timeline",
    "photo-grid",
    "tag-group",
    "recommendation-list",
    "info-box",
  ]) {
    assert.ok(names.includes(expected), `缺少组件 ${expected}`);
  }
});

function makeSpec(children: unknown[]): LayoutSpec {
  const value = {
    version: "2.0",
    canvas: { width: 800, height: 600, background: "#FFFFFF" },
    strategy: { mode: "replica" },
    root: {
      id: "root",
      type: "container",
      layout: "column",
      style: {},
      children,
    },
    fonts: ["sans"],
    sourceElements: {},
    notes: [],
  };
  const result = parseLayoutSpec(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.spec;
}

async function makeBundleWithPhotos(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-comp-"));
  await mkdir(path.join(dir, "assets"), { recursive: true });
  for (const name of ["trail.png", "cave.png"]) {
    const png = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, "assets", name), png);
  }
  return dir;
}

test("组件渲染：header/timeline/photo-grid/推荐列表/信息框", async () => {
  const bundle = await makeBundleWithPhotos();
  try {
    const spec = makeSpec([
      { id: "hdr", type: "component", component: "header", props: {} },
      {
        id: "timeline",
        type: "component",
        component: "timeline",
        props: {},
      },
      {
        id: "pg",
        type: "component",
        component: "photo-grid",
        props: { columns: 2 },
      },
      {
        id: "foods",
        type: "component",
        component: "recommendation-list",
        props: { kind: "foods", title: "美食推荐" },
      },
      {
        id: "parking",
        type: "component",
        component: "info-box",
        props: { kind: "parking", title: "停车指南" },
      },
    ]);

    const { html } = await buildLayoutHtml({
      spec,
      content: travelContent(),
      bundleDir: bundle,
      fontFaceCss: "",
    });

    // header：标题与 Day
    assert.ok(html.includes("本溪水洞 · 天桥沟"));
    assert.ok(html.includes("DAY 5"));
    assert.ok(html.includes("22–28°C"));

    // timeline：repeat 稳定项 ID
    assert.ok(html.includes('data-item-id="timeline-tianqiaogou"'));
    assert.ok(html.includes('data-item-id="timeline-benxi-cave"'));
    assert.ok(html.includes("10:00–12:00"));
    assert.ok(html.includes("木栈道"));

    // photo-grid：data URL 嵌入 + objectPosition + caption
    assert.ok(html.includes("data:image/png;base64,"));
    assert.ok(html.includes("object-position:50% 35%"));
    assert.ok(html.includes("天桥沟栈道"));

    // 推荐列表
    assert.ok(html.includes("美食推荐"));
    assert.ok(html.includes("小市羊汤"));

    // 信息框
    assert.ok(html.includes("停车指南"));
    assert.ok(html.includes("景区北门停车场"));
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("空模块隐藏（时间轴/照片/美食/信息框为空时无输出）", async () => {
  const bundle = await makeBundleWithPhotos();
  try {
    const spec = makeSpec([
      { id: "tl", type: "component", component: "timeline", props: {} },
      { id: "pg", type: "component", component: "photo-grid", props: {} },
      {
        id: "foods",
        type: "component",
        component: "recommendation-list",
        props: { kind: "foods" },
      },
      {
        id: "parking",
        type: "component",
        component: "info-box",
        props: { kind: "parking" },
      },
    ]);

    const empty = travelContent();
    empty.timeline = [];
    empty.photos = [];
    empty.foods = [];
    delete empty.parking;

    const { html } = await buildLayoutHtml({
      spec,
      content: empty,
      bundleDir: bundle,
      fontFaceCss: "",
    });

    // 空模块不渲染（无 data-component 包装）
    assert.ok(!html.includes('data-component="timeline"'));
    assert.ok(!html.includes('data-component="photo-grid"'));
    assert.ok(!html.includes('data-component="recommendation-list"'));
    assert.ok(!html.includes('data-component="info-box"'));
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("餐厅分组列表（多餐厅）与打卡清单", async () => {
  const bundle = await makeBundleWithPhotos();
  try {
    const spec = makeSpec([
      {
        id: "restaurants",
        type: "component",
        component: "recommendation-list",
        props: { kind: "restaurantGroups" },
      },
      {
        id: "checklist",
        type: "component",
        component: "recommendation-list",
        props: { kind: "photoChecklist", title: "打卡清单" },
      },
    ]);

    const { html } = await buildLayoutHtml({
      spec,
      content: travelContent(),
      bundleDir: bundle,
      fontFaceCss: "",
    });

    assert.ok(html.includes("本溪市内"));
    assert.ok(html.includes("老边饺子"));
    assert.ok(html.includes("长宽猪蹄"));
    assert.ok(html.includes("打卡清单"));
    assert.ok(html.includes("五女山合影"));
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test("text/repeat 节点渲染：绑定值、稳定 ID、转义", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-comp-"));
  try {
    const spec = makeSpec([
      {
        id: "page_title",
        type: "text",
        binding: "header.title",
        style: { fontSize: 24 },
        overflow: "wrap",
      },
      {
        id: "stops",
        type: "repeat",
        binding: "timeline",
        gap: 10,
        itemTemplate: {
          id: "stop_name",
          type: "text",
          binding: "item.title",
          style: {},
          overflow: "wrap",
        },
      },
    ]);

    const content = travelContent();
    content.header.title = '标题<script>alert("x")</script>';

    const { html } = await buildLayoutHtml({
      spec,
      content,
      bundleDir: dir,
      fontFaceCss: "",
    });

    // 转义：脚本文本不执行
    assert.ok(!html.includes("<script>alert"));
    assert.ok(html.includes("&lt;script&gt;"));

    // repeat 稳定 ID + 绑定值
    assert.ok(html.includes('data-text-id="stop_name"'));
    assert.ok(html.includes("天桥沟"));
    assert.ok(html.includes("本溪水洞"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("未知组件拒绝；缺失必填绑定失败", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "itt-comp-"));
  try {
    const badSpec = makeSpec([
      { id: "x", type: "component", component: "nonexistent", props: {} },
    ]);
    await assert.rejects(
      buildLayoutHtml({
        spec: badSpec,
        content: travelContent(),
        bundleDir: dir,
        fontFaceCss: "",
      }),
      (error: unknown) => {
        assert.ok((error as Error).message.includes("未知组件"));
        return true;
      },
    );

    const missingSpec = makeSpec([
      {
        id: "t",
        type: "text",
        binding: "header.nonexistent",
        style: {},
        overflow: "wrap",
      },
    ]);
    await assert.rejects(
      buildLayoutHtml({
        spec: missingSpec,
        content: travelContent(),
        bundleDir: dir,
        fontFaceCss: "",
      }),
      (error: unknown) => {
        assert.ok((error as Error).message.includes("缺失必填绑定"));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("主题覆盖生效", () => {
  const theme = applyThemeOverrides(defaultTravelTheme, {
    colors: { navy: "#000080" },
    typography: { titleSize: 32 },
  });
  assert.equal(theme.colors.navy, "#000080");
  assert.equal(theme.typography.titleSize, 32);
  // 未覆盖字段保持默认
  assert.equal(theme.colors.gold, defaultTravelTheme.colors.gold);
  assert.equal(theme.page.width, defaultTravelTheme.page.width);
});

test("组件注册表可直接调用（header 含长酒店名）", () => {
  const ctx = {
    theme: defaultTravelTheme,
    resolveImageSrc: (src: string) => src,
  };
  const content = travelContent();
  content.hotel!.name =
    "一个特别特别特别长的酒店名称用于验证不换行溢出时的表现与折行";

  const html = componentRegistry.header(content, {}, ctx);
  assert.ok(html.includes("DAY 5"));
  assert.ok(html.includes("特别长"));
});
