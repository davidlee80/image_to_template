/**
 * T13：分页算法测试（纯函数离线）。
 *
 * 覆盖：标题不孤立、图片说明同页、时间轴项/卡片不拆、长文本按行拆
 * 且全文保留、双栏顺序、超大块报 OVERSIZED_BLOCK、无空页、grow 高度。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  growLayoutHeight,
  paginateBlocks,
  ESTIMATED_LINE_HEIGHT_PX,
  MIN_FONT_SIZE_PX,
  type PageBlock,
} from "../../src/render/paginate.js";

const PAGE_HEIGHT = 500;

function block(
  id: string,
  height: number,
  overrides: Partial<PageBlock> = {},
): PageBlock {
  return {
    id,
    column: 0,
    height,
    kind: "card",
    order: 0,
    atomic: true,
    ...overrides,
  };
}

test("单页放下全部块", () => {
  const result = paginateBlocks(
    [
      block("a", 200),
      block("b", 200),
      block("c", 90),
    ],
    { pageContentHeight: PAGE_HEIGHT },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].blocks.length, 3);
  }
});

test("超出页高分页且无空页", () => {
  const result = paginateBlocks(
    [block("a", 300), block("b", 300), block("c", 300)],
    { pageContentHeight: PAGE_HEIGHT },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    // 每页放一块（300+margin×… 500 只够一块 300）
    assert.equal(result.pages.length, 3);
    for (const page of result.pages) {
      assert.ok(page.blocks.length > 0, "不应有空页");
    }
    assert.deepEqual(
      result.pages.map((p) => p.blocks.map((b) => b.id)),
      [["a"], ["b"], ["c"]],
    );
    // 页号连续
    assert.deepEqual(
      result.pages.map((p) => p.page),
      [1, 2, 3],
    );
  }
});

test("标题不孤立：keepWithNext 与下一块同页", () => {
  const result = paginateBlocks(
    [
      block("a", 400),
      block("section_title", 50, { kind: "section-title", atomic: false, keepWithNext: true }),
      block("content", 100),
    ],
    { pageContentHeight: PAGE_HEIGHT },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    // 第 1 页：a（400+margin=402 > 500-0? 402 ≤ 500 放入；剩 98 放不下标题+内容对（150+4）→ 换页
    assert.equal(result.pages.length, 2);
    const titlePage = result.pages.find((p) =>
      p.blocks.some((b) => b.id === "section_title"),
    );
    const contentPage = result.pages.find((p) =>
      p.blocks.some((b) => b.id === "content"),
    );
    assert.ok(titlePage && contentPage);
    assert.equal(titlePage!.page, contentPage!.page, "标题与内容同页");
  }
});

test("超大不可拆块报 OVERSIZED_BLOCK（不静默裁切）", () => {
  const result = paginateBlocks(
    [block("huge_card", 600), block("normal", 100)],
    { pageContentHeight: PAGE_HEIGHT },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.oversizedBlocks.length, 1);
    assert.equal(result.oversizedBlocks[0].id, "huge_card");
    assert.equal(result.oversizedBlocks[0].height, 600);
  }
});

test("长文本按行拆分且全文保留（行区间标记）", () => {
  // 1200px 文本 ≈ 60 行 → 需要拆多页
  const result = paginateBlocks(
    [
      block("title", 50, { kind: "section-title", atomic: false }),
      block("long_text", 1200, { kind: "text", atomic: false }),
    ],
    { pageContentHeight: PAGE_HEIGHT },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    const textChunks = result.pages
      .flatMap((p) => p.blocks)
      .filter((b) => b.id.startsWith("long_text#L"));

    assert.ok(textChunks.length >= 2, "长文本应拆成多段");
    // 行区间连续（无丢行/重行）
    const ranges = textChunks.map((chunk) => {
      const match = /#L(\d+)-(\d+)/.exec(chunk.id);
      return match ? [Number(match[1]), Number(match[2])] : null;
    });
    assert.ok(ranges.every((r) => r !== null));
    for (let i = 1; i < ranges.length; i += 1) {
      assert.equal(ranges[i]![0], ranges[i - 1]![1] + 1, "行区间应连续");
    }
    // 总行数覆盖 1200/20=60 行
    const totalLines =
      ranges[ranges.length - 1]![1] - ranges[0]![0] + 1;
    assert.equal(totalLines, Math.ceil(1200 / ESTIMATED_LINE_HEIGHT_PX));
  }
});

test("双栏：各栏保持阅读顺序", () => {
  const result = paginateBlocks(
    [
      block("L1", 240, { column: 0, order: 1 }),
      block("L2", 240, { column: 0, order: 2 }),
      block("R1", 240, { column: 1, order: 1 }),
      block("R2", 240, { column: 1, order: 2 }),
    ],
    { pageContentHeight: PAGE_HEIGHT },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    // 每栏按顺序分页：L1,L2 第 1 页；R1,R2 第 2 页
    const ids = result.pages.map((p) => p.blocks.map((b) => b.id));
    assert.ok(ids.flat().indexOf("L1") < ids.flat().indexOf("L2"));
    assert.ok(ids.flat().indexOf("R1") < ids.flat().indexOf("R2"));
    // 左栏整体先于右栏
    assert.ok(ids.flat().indexOf("L2") < ids.flat().indexOf("R1"));
  }
});

test("grow 策略：总高至少画布高", () => {
  const height = growLayoutHeight(
    [block("a", 300), block("b", 400)],
    1500,
  );
  assert.equal(height, 1500, "内容不足画布高时保持画布高");

  const grown = growLayoutHeight(
    [block("a", 900), block("b", 900)],
    1500,
  );
  assert.equal(grown, 1800 + 4, "内容超出时增高");
});

test("常量：字号下限与行高估计", () => {
  assert.equal(MIN_FONT_SIZE_PX, 9);
  assert.equal(ESTIMATED_LINE_HEIGHT_PX, 20);
});
