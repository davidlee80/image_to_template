/**
 * 分页算法（T13 步骤 2～4）。
 *
 * 实施计划：
 * - 按组件测量再分页：标题不孤立、图片与说明尽量同页、
 *   时间轴项/卡片默认不可拆；需要拆长正文时按行拆并保留全文；
 * - 双栏分别计算可放入页面的块，保留各栏阅读顺序；
 * - 单个不可拆块超出一页时报告 OVERSIZED_BLOCK，
 *   不静默裁切或循环产生空页；
 * - 保持字号下限，不无限缩小字体。
 *
 * 纯函数：输入测量后的块与页尺寸，输出页分配（可离线测试）。
 */

/** 可分页块（浏览器测量后的抽象）。 */
export interface PageBlock {
  /** 块 ID（稳定：组件节点 ID 或项 ID）。 */
  id: string;
  /** 栏（双栏布局的栏序；单栏为 0）。 */
  column: number;
  /** 测量高度（px）。 */
  height: number;
  /** 块类型（决定拆分规则）。 */
  kind:
    | "page-header"
    | "section-title"
    | "card"
    | "timeline-item"
    | "photo"
    | "text"
    | "info-box";
  /** 逻辑顺序（栏内阅读顺序）。 */
  order: number;
  /** 不可拆（卡片/时间轴项/图片+说明）。 */
  atomic?: boolean;
  /** 与前一个块保持同页（标题与其后第一个块）。 */
  keepWithNext?: boolean;
}

export interface PaginateOptions {
  /** 页内容高度（画布高 − 上下边距）。 */
  pageContentHeight: number;
  /** 栏间距计入块高的额外余量（安全边距）。 */
  blockSafetyMargin?: number;
}

export interface PageAssignment {
  /** 页号（从 1 开始）。 */
  page: number;
  blocks: PageBlock[];
}

export interface PaginateResult {
  ok: true;
  pages: PageAssignment[];
}

export interface PaginateFailure {
  ok: false;
  /** 超大块（单块超出页高）。 */
  oversizedBlocks: Array<{ id: string; height: number; pageContentHeight: number }>;
}

/** 长文本块按行拆分的行高估计（用于 text 拆分）。 */
export const ESTIMATED_LINE_HEIGHT_PX = 20;

/**
 * 块分页（单栏顺序流）：
 * - atomic 块不拆；超页高 → OVERSIZED_BLOCK；
 * - keepWithNext（标题）与下一块同页（否则一起移到下页）；
 * - text 块超高时按行拆：当前页放满，其余到后续页（全文保留在块集合）。
 */
export function paginateBlocks(
  blocks: PageBlock[],
  options: PaginateOptions,
): PaginateResult | PaginateFailure {
  const { pageContentHeight } = options;
  const margin = options.blockSafetyMargin ?? 2;

  // 超大不可拆块检测
  const oversizedBlocks = blocks
    .filter(
      (block) =>
        (block.atomic === true || block.kind !== "text") &&
        block.height + margin > pageContentHeight,
    )
    .map((block) => ({
      id: block.id,
      height: block.height,
      pageContentHeight,
    }));

  if (oversizedBlocks.length > 0) {
    return { ok: false, oversizedBlocks };
  }

  // 稳定排序：栏 → 顺序
  const ordered = [...blocks].sort(
    (a, b) => a.column - b.column || a.order - b.order,
  );

  const pages: PageAssignment[] = [];
  let currentPage: PageAssignment = { page: 1, blocks: [] };
  let usedHeight = 0;

  const pushPage = () => {
    if (currentPage.blocks.length > 0) {
      pages.push(currentPage);
    }
    currentPage = { page: pages.length + 1, blocks: [] };
    usedHeight = 0;
  };

  for (let i = 0; i < ordered.length; i += 1) {
    const block = ordered[i];
    const next = ordered[i + 1];
    const needed = block.height + margin;

    // keepWithNext：标题与下一块需要一起放下
    const pairNeeded =
      block.keepWithNext === true && next !== undefined
        ? needed + next.height + margin
        : needed;

    if (block.kind === "text" && needed > pageContentHeight) {
      // 长正文拆分：按行拆，保留全文（块 ID 带行区间标记）
      let remaining = block.height;
      let lineStart = 1;
      const lineHeight = ESTIMATED_LINE_HEIGHT_PX;

      while (remaining > 0) {
        const available = pageContentHeight - usedHeight;

        if (available <= lineHeight) {
          pushPage();
          continue;
        }

        const maxLines = Math.floor(available / lineHeight);
        const lines = Math.min(maxLines, Math.ceil(remaining / lineHeight));
        const chunkHeight = lines * lineHeight;

        currentPage.blocks.push({
          ...block,
          id: `${block.id}#L${lineStart}-${lineStart + lines - 1}`,
          height: chunkHeight,
        });
        usedHeight += chunkHeight + margin;
        remaining -= chunkHeight;
        lineStart += lines;

        if (remaining > 0) {
          pushPage();
        }
      }
      continue;
    }

    if (pairNeeded > pageContentHeight - usedHeight) {
      if (usedHeight > 0) {
        pushPage();
      }
      // 新页仍放不下成对块且成对块超页高 → 超大（atomic 组合）
      if (pairNeeded > pageContentHeight) {
        return {
          ok: false,
          oversizedBlocks: [
            {
              id: `${block.id}${next !== undefined ? `+${next.id}` : ""}`,
              height: pairNeeded,
              pageContentHeight,
            },
          ],
        };
      }
    }

    currentPage.blocks.push(block);
    usedHeight += needed;

    if (block.keepWithNext === true && next !== undefined) {
      // 下一块一并放入当前页
      currentPage.blocks.push(next);
      usedHeight += next.height + margin;
      i += 1;
    }

    if (usedHeight >= pageContentHeight) {
      pushPage();
    }
  }

  pushPage();

  // 空页防御：分页结果不应包含空页
  const nonEmpty = pages.filter((page) => page.blocks.length > 0);
  if (nonEmpty.length === 0 && blocks.length > 0) {
    // 全部块都被拆分逻辑消费但页为空：视为异常
    return {
      ok: false,
      oversizedBlocks: blocks.map((b) => ({
        id: b.id,
        height: b.height,
        pageContentHeight,
      })),
    };
  }

  // 重新编号（防断层）
  return {
    ok: true,
    pages: nonEmpty.map((page, index) => ({
      page: index + 1,
      blocks: page.blocks,
    })),
  };
}

/** grow 策略：全部块放入单一增高画布（总高 = max(画布高, 内容高)）。 */
export function growLayoutHeight(
  blocks: PageBlock[],
  minHeight: number,
  options: { blockSafetyMargin?: number } = {},
): number {
  const margin = options.blockSafetyMargin ?? 2;
  const total = blocks.reduce((sum, block) => sum + block.height + margin, 0);
  return Math.max(minHeight, Math.ceil(total));
}

/** 字号下限（计划 T13 步骤 2：保持字号下限，不无限缩小）。 */
export const MIN_FONT_SIZE_PX = 9;
