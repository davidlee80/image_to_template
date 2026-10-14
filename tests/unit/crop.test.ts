/**
 * T04：素材裁剪与文字/图片相交检测测试。
 *
 * 覆盖：小数坐标、画布边缘、零面积交集有确定结果；
 * 检测框与 sourceRect 分开记录；裁剪像素与 fixture 一致。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import sharp from "sharp";

import {
  cropAsset,
  findTextImageIntersections,
  planCrop,
} from "../../src/assets/crop.js";
import { isImageTemplateError } from "../../src/errors.js";

const canvas = { width: 100, height: 100 };

test("小数坐标：floor 起点、ceil 终点", () => {
  const plan = planCrop({
    element: { id: "a", x: 10.2, y: 20.7, width: 30.5, height: 40.3 },
    canvas,
  });

  assert.deepEqual(plan.sourceRect, { left: 10, top: 20, width: 31, height: 41 });
  assert.deepEqual(plan.detectionRect, { left: 10, top: 20, width: 31, height: 41 });
  assert.equal(plan.clippedByCanvas, false);
});

test("画布右/下边缘：求交并标记 clippedByCanvas", () => {
  const plan = planCrop({
    element: { id: "a", x: 90, y: 95, width: 20, height: 20 },
    canvas,
  });

  // right = 110 > 100 → 裁剪到 100；bottom = 115 > 100 → 裁剪到 100
  assert.deepEqual(plan.sourceRect, { left: 90, top: 95, width: 10, height: 5 });
  assert.equal(plan.clippedByCanvas, true);
  // 检测框保留原始声明值
  assert.deepEqual(plan.detectionRect, { left: 90, top: 95, width: 20, height: 20 });
});

test("负坐标：求交后仍非空（容差内元素）；完全出界报错", () => {
  // x=-5 但 width=20 → 交集 [0,15) 非空
  const partial = planCrop({
    element: { id: "a", x: -5, y: 10, width: 20, height: 20 },
    canvas,
  });
  assert.deepEqual(partial.sourceRect, { left: 0, top: 10, width: 15, height: 20 });
  assert.equal(partial.clippedByCanvas, true);

  // 完全在画布外 → 零面积交集，报错
  assert.throws(
    () =>
      planCrop({
        element: { id: "a", x: 150, y: 150, width: 20, height: 20 },
        canvas,
      }),
    (error: unknown) => {
      assert.ok(isImageTemplateError(error));
      assert.ok((error as Error).message.includes("交集为空"));
      return true;
    },
  );
});

test("画布内完整元素不标记 clipped", () => {
  const plan = planCrop({
    element: { id: "a", x: 5, y: 5, width: 10, height: 10 },
    canvas,
  });
  assert.equal(plan.clippedByCanvas, false);
});

test("裁剪像素与 fixture 预期一致", async () => {
  const fixtureImage = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "images",
    "synthetic-travel.png",
  );
  const normalized = await readFile(fixtureImage);

  // 合成图中 photo_trail 位于 (560,148) 尺寸 200×130
  const asset = await cropAsset(normalized, {
    element: { id: "photo_trail", x: 560, y: 148, width: 200, height: 130 },
    canvas: { width: 800, height: 600 },
  });

  assert.equal(asset.plan.sourceRect.width, 200);
  assert.equal(asset.plan.sourceRect.height, 130);

  // 与直接用 sharp extract 的结果逐字节一致
  const expected = await sharp(normalized)
    .extract({ left: 560, top: 148, width: 200, height: 130 })
    .png()
    .toBuffer();
  assert.ok(asset.png.equals(expected), "裁剪像素应与 sharp 直接裁剪一致");

  // 尺寸正确
  const meta = await sharp(asset.png).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 130);
});

test("文字与图片相交检测", () => {
  const candidates = findTextImageIntersections([
    { id: "t1", type: "text", x: 10, y: 10, width: 20, height: 20 },
    { id: "i1", type: "image", x: 20, y: 20, width: 50, height: 50 },
    { id: "t2", type: "text", x: 100, y: 100, width: 20, height: 20 },
    { id: "b1", type: "box", x: 0, y: 0, width: 500, height: 500 },
  ]);

  // t1 与 i1 在 (20,20)-(30,30) 相交；t2 不与任何图片相交；box 不参与
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].textId, "t1");
  assert.equal(candidates[0].imageId, "i1");
  // 交集 10×10=100，文字面积 400 → 0.25
  assert.ok(Math.abs(candidates[0].textOverlapRatio - 0.25) < 1e-9);
});
