/**
 * T09：区域裁剪计划与坐标回投测试。
 *
 * 覆盖（计划验证项）：scale=1、scale=2、padding、重叠区域与边缘元素的
 * 回投误差在 1 px 内；无 padding 退化为设计公式；裁剪像素正确。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import sharp from "sharp";

import {
  cropRegionImage,
  isNearRegionBoundary,
  planRegionCrop,
  projectLocalToGlobal,
} from "../../src/analysis/regions.js";
import { isImageTemplateError } from "../../src/errors.js";

const canvas = { width: 800, height: 600 };

test("scale=1 无 padding：回投退化为设计公式", () => {
  const region = {
    id: "header",
    box: { x: 0, y: 0, width: 800, height: 120 },
  };
  const plan = planRegionCrop(region, canvas);

  assert.deepEqual(
    {
      originX: plan.originX,
      originY: plan.originY,
      paddingX: plan.paddingX,
      paddingY: plan.paddingY,
      scale: plan.scale,
    },
    { originX: 0, originY: 0, paddingX: 0, paddingY: 0, scale: 1 },
  );
  assert.equal(plan.clippedByCanvas, false);

  // globalX = region.x + localX / scale（设计公式）
  const global = projectLocalToGlobal(
    { x: 100, y: 50, width: 200, height: 30 },
    plan,
  );
  assert.deepEqual(global, { x: 100, y: 50, width: 200, height: 30 });
});

test("scale=2 无 padding：回投精确除以 scale", () => {
  const region = {
    id: "right-column",
    box: { x: 560, y: 130, width: 200, height: 440 },
    scale: 2,
  };
  const plan = planRegionCrop(region, canvas);

  assert.equal(plan.originX, 560);
  assert.equal(plan.originY, 130);
  assert.equal(plan.scaledWidth, 400);
  assert.equal(plan.scaledHeight, 880);

  // 局部坐标 (200, 100) → 全局 (560 + 200/2, 130 + 100/2) = (660, 180)
  const global = projectLocalToGlobal(
    { x: 200, y: 100, width: 100, height: 60 },
    plan,
  );
  assert.equal(global.x, 660);
  assert.equal(global.y, 180);
  assert.equal(global.width, 50);
  assert.equal(global.height, 30);
});

test("padding：裁剪向外扩展，回投扣除 padding", () => {
  const region = {
    id: "sidebar",
    box: { x: 560, y: 130, width: 200, height: 440 },
    scale: 2,
    padding: 10,
  };
  const plan = planRegionCrop(region, canvas);

  // origin = box - padding
  assert.equal(plan.originX, 550);
  assert.equal(plan.originY, 120);
  assert.equal(plan.paddingX, 10);
  assert.equal(plan.paddingY, 10);
  assert.equal(plan.cropWidth, 220);
  assert.equal(plan.cropHeight, 460);

  // 回投公式：globalX = originX + (localX - paddingX) / scale
  // 区域框左上角在放大图中的局部坐标 = (560-550)*2+10 = 30 → 全局 (560, 130)
  const global = projectLocalToGlobal({ x: 30, y: 30, width: 40, height: 20 }, plan);
  assert.equal(global.x, 560);
  assert.equal(global.y, 130);
  assert.equal(global.width, 20);
  assert.equal(global.height, 10);

  // 另一验证点：local (20,20) → 550 + (20-10)/2 = 555
  const point = projectLocalToGlobal({ x: 20, y: 20, width: 4, height: 2 }, plan);
  assert.equal(point.x, 555);
  assert.equal(point.y, 125);
});

test("区域贴近画布边缘：求交并标记 clippedByCanvas，padding 收缩", () => {
  const region = {
    id: "footer",
    box: { x: 780, y: 580, width: 100, height: 100 }, // 超出画布
    padding: 10,
  };
  const plan = planRegionCrop(region, canvas);

  // 请求 [770, 890] → 求交 [770, 800]，宽 30
  assert.equal(plan.originX, 770);
  assert.equal(plan.cropWidth, 30);
  assert.equal(plan.clippedByCanvas, true);
  // 实际 padding：box.x - originX = 780 - 770 = 10
  assert.equal(plan.paddingX, 10);
});

test("负坐标区域：求交后仍非空；完全出界报错", () => {
  const partial = planRegionCrop(
    { id: "left", box: { x: -20, y: 100, width: 100, height: 100 } },
    canvas,
  );
  assert.equal(partial.originX, 0);
  assert.equal(partial.cropWidth, 80);
  assert.equal(partial.clippedByCanvas, true);

  assert.throws(
    () =>
      planRegionCrop(
        { id: "out", box: { x: 900, y: 0, width: 100, height: 100 } },
        canvas,
      ),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.ok((error as Error).message.includes("交集为空"));
      return true;
    },
  );
});

test("scale < 1 或负 padding 报错", () => {
  assert.throws(() =>
    planRegionCrop(
      { id: "r", box: { x: 0, y: 0, width: 10, height: 10 }, scale: 0.5 },
      canvas,
    ),
  );
  assert.throws(() =>
    planRegionCrop(
      { id: "r", box: { x: 0, y: 0, width: 10, height: 10 }, padding: -1 },
      canvas,
    ),
  );
});

test("回投往返误差在 1px 内（scale=2 + padding）", () => {
  const region = {
    id: "right-column",
    box: { x: 560, y: 130, width: 200, height: 440 },
    scale: 2,
    padding: 8,
  };
  const plan = planRegionCrop(region, canvas);

  // 一组全局点 → 投到局部 → 回投 → 与原值比较
  const globals = [
    { x: 560, y: 130, width: 50, height: 25 },
    { x: 700, y: 400, width: 40, height: 20 },
    { x: 568, y: 138, width: 184, height: 424 },
  ];

  for (const g of globals) {
    // 正向：局部坐标 = (globalX - originX) * scale + paddingX
    const local = {
      x: (g.x - plan.originX) * plan.scale + plan.paddingX,
      y: (g.y - plan.originY) * plan.scale + plan.paddingY,
      width: g.width * plan.scale,
      height: g.height * plan.scale,
    };
    const back = projectLocalToGlobal(local, plan);

    assert.ok(Math.abs(back.x - g.x) < 1, `x 误差 ${Math.abs(back.x - g.x)}`);
    assert.ok(Math.abs(back.y - g.y) < 1, `y 误差 ${Math.abs(back.y - g.y)}`);
    assert.ok(
      Math.abs(back.width - g.width) < 1,
      `width 误差 ${Math.abs(back.width - g.width)}`,
    );
    assert.ok(
      Math.abs(back.height - g.height) < 1,
      `height 误差 ${Math.abs(back.height - g.height)}`,
    );
  }
});

test("cropRegionImage 裁剪并放大（像素级验证）", async () => {
  const fixtureImage = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "images",
    "synthetic-travel.png",
  );
  const normalized = await readFile(fixtureImage);

  // scale=1：与 sharp 直接裁剪一致
  const scale1 = await cropRegionImage(
    normalized,
    { id: "header", box: { x: 0, y: 0, width: 800, height: 120 } },
    canvas,
  );
  const expected = await sharp(normalized)
    .extract({ left: 0, top: 0, width: 800, height: 120 })
    .png()
    .toBuffer();
  assert.ok(scale1.png.equals(expected));

  // scale=2：尺寸放大一倍
  const scale2 = await cropRegionImage(
    normalized,
    { id: "photo", box: { x: 560, y: 148, width: 200, height: 130 }, scale: 2 },
    canvas,
  );
  const meta = await sharp(scale2.png).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 260);
  assert.equal(scale2.plan.scaledWidth, 400);
});

test("isNearRegionBoundary 检测边界元素", () => {
  const region = { id: "r", box: { x: 100, y: 100, width: 200, height: 200 } };

  // 贴左边界
  assert.deepEqual(
    isNearRegionBoundary({ x: 102, y: 150, width: 50, height: 20 }, region),
    { near: true, edges: ["left"] },
  );

  // 区域中央
  assert.equal(
    isNearRegionBoundary({ x: 180, y: 180, width: 40, height: 20 }, region).near,
    false,
  );

  // 跨右边界（元素右缘贴区域右缘）
  assert.deepEqual(
    isNearRegionBoundary({ x: 250, y: 150, width: 50, height: 20 }, region).edges,
    ["right"],
  );
});
