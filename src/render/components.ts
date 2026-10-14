/**
 * 旅行主题布局组件（T12 步骤 2～5）。
 *
 * 实施计划：
 * - 按顺序实现七类组件：标题区、双栏布局、时间轴、图片网格、标签组、
 *   推荐列表、信息框；复用基础组件覆盖旅行模块；
 * - 页面与装饰按约束定位，文本和列表走正常流；徽章/线条在组件内
 *   局部 absolute，正文不全部写死全局坐标；
 * - 图片绑定支持 src/alt、objectFit: cover|contain、受限 objectPosition；
 *   图片替换无需改渲染器；
 * - 支持空模块隐藏、少/多行程、多标签、多餐厅及长酒店名；
 *   repeat 项使用稳定 ID 关联报告与补丁。
 *
 * 组件输出 HTML 片段；样式由 TravelTheme token 生成（白名单），
 * 所有正文经转义（复用 escapeHtml）。
 */

import { escapeHtml } from "./html.js";
import type {
  TravelContent,
  TravelTimelineItem,
  TravelPhoto,
  TravelRestaurantGroup,
} from "../schemas/travel.js";
import type { TravelTheme } from "../semantic/travel-theme.js";

/** 组件渲染上下文。 */
export interface ComponentContext {
  theme: TravelTheme;
  /** 图片 src 解析（内容中的 src → 可嵌入形式；由渲染器注入）。 */
  resolveImageSrc: (src: string) => string;
  /** repeat 项稳定 ID 前缀（供报告/补丁关联）。 */
  idPrefix?: string;
}

/** 组件渲染函数签名。 */
export type ComponentRenderer = (
  content: TravelContent,
  props: Record<string, string | number | boolean>,
  ctx: ComponentContext,
) => string;

function text(value: string | undefined): string {
  return escapeHtml(value ?? "");
}

/** 1. 标题区：Day/标题/副标题/日期天气/酒店（深蓝底；正常流）。 */
const headerRenderer: ComponentRenderer = (content, _props, ctx) => {
  const { theme } = ctx;
  const { header, weather, hotel } = content;

  const weatherLine =
    weather !== undefined
      ? `<div class="tt-header-weather">${text(weather.text)} · ${text(
          weather.temperature,
        )} · 降水 ${weather.rainProbability}%</div>`
      : "";

  const hotelLine =
    hotel !== undefined
      ? `<div class="tt-header-hotel">${text(hotel.name)}｜${text(
          hotel.stayText,
        )}</div>`
      : "";

  return `
<header class="tt-header" style="background:${theme.colors.navy};padding:${theme.spacing.cardPadding * 2}px ${theme.page.paddingX}px">
  <div class="tt-header-row" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1 class="tt-header-title" style="font-family:${theme.typography.headingFamily};font-size:${theme.typography.titleSize}px;font-weight:700;color:#FFFFFF;margin:0">${text(
        header.title,
      )}</h1>
      <div class="tt-header-subtitle" style="font-size:${theme.typography.subtitleSize}px;color:${theme.colors.muted};margin-top:6px">${text(
        header.subtitle,
      )}</div>
    </div>
    <div class="tt-header-day" style="font-family:${theme.typography.dayFamily};font-size:${theme.typography.titleSize}px;font-weight:700;color:${theme.colors.gold}">DAY ${header.day}</div>
  </div>
  <div class="tt-header-meta" style="margin-top:${theme.spacing.itemGap}px;font-size:${theme.typography.bodySize}px;color:#FFFFFF;display:flex;gap:${theme.spacing.itemGap * 2}px;flex-wrap:wrap">
    <span>${text(header.date)} ${text(header.weekday)}</span>
    ${weatherLine}
    ${hotelLine}
  </div>
</header>`.trim();
};

/** 2. 双栏布局：主栏 + 侧栏（grid 两列）。 */
const twoColumnRenderer: ComponentRenderer = (_content, props, ctx) => {
  const { theme } = ctx;
  // 主/侧栏内容由容器 children 提供；组件提供布局骨架
  const mainWidth = typeof props.mainWidth === "number" ? props.mainWidth : 640;
  void theme;
  return `<div class="tt-two-column" style="display:grid;grid-template-columns:${mainWidth}px 1fr;gap:${ctx.theme.spacing.sectionGap}px;align-items:start"></div>`;
};

/** 3. 时间轴：编号徽章（局部 absolute）+ 标题/时间/描述/标签（正常流）。 */
const timelineRenderer: ComponentRenderer = (content, _props, ctx) => {
  const { theme } = ctx;
  const items = content.timeline ?? [];
  const prefix = ctx.idPrefix ?? "timeline";

  // 空模块隐藏（不留异常空框）
  if (items.length === 0) {
    return "";
  }

  const itemHtml = items
    .map((item: TravelTimelineItem, index: number) => {
      const tags = item.tags
        .map(
          (tag) =>
            `<span class="tt-tag tt-tag-${tag.tone}" data-item-id="${text(`${prefix}-${item.id}`)}-tag" style="font-size:${theme.typography.smallSize}px;padding:2px 8px;border-radius:10px;border:1px solid ${theme.colors.divider}">${text(tag.text)}</span>`,
        )
        .join("");

      const transfer =
        item.transferBefore !== undefined
          ? `<div class="tt-transfer" style="font-size:${theme.typography.smallSize}px;color:${theme.colors.muted};margin-bottom:4px">🚗 ${text(item.transferBefore.text)}</div>`.replace(
              "🚗",
              `[${item.transferBefore.icon}]`,
            )
          : "";

      return `
<article class="tt-timeline-item" data-item-id="${text(`${prefix}-${item.id}`)}" data-element-id="${text(`${prefix}-${item.id}`)}" style="position:relative;padding-left:${theme.timeline.badgeSize + 16}px;margin-bottom:${theme.spacing.itemGap}px">
  <div class="tt-timeline-badge" style="position:absolute;left:0;top:0;width:${theme.timeline.badgeSize}px;height:${theme.timeline.badgeSize}px;border-radius:50%;background:${item.color};color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-family:${theme.typography.dayFamily};font-weight:700;font-size:${theme.typography.itemTitleSize}px">${item.number}</div>
  <div class="tt-timeline-time" style="font-family:${theme.typography.dayFamily};font-size:${theme.typography.bodySize}px;color:${theme.colors.muted}">${text(item.time)}</div>
  <h3 class="tt-timeline-title" style="font-family:${theme.typography.headingFamily};font-size:${theme.typography.itemTitleSize}px;font-weight:700;color:${theme.colors.body};margin:2px 0 4px">${text(item.title)}</h3>
  ${transfer}
  <div class="tt-timeline-description" style="font-size:${theme.typography.bodySize}px;line-height:${theme.typography.bodyLineHeight};color:${theme.colors.body};white-space:pre-wrap">${text(item.description)}</div>
  <div class="tt-tags" style="display:flex;gap:${theme.spacing.tagGap}px;margin-top:6px;flex-wrap:wrap">${tags}</div>
</article>`.trim();
    })
    .join("\n");

  return `<section class="tt-timeline" data-element-id="${text(prefix)}">${itemHtml}</section>`;
};

/** 4. 图片网格：photos[]（objectFit/objectPosition；替换无拉伸）。 */
const photoGridRenderer: ComponentRenderer = (content, props, ctx) => {
  const { theme } = ctx;
  const photos = content.photos ?? [];
  const prefix = ctx.idPrefix ?? "photos";
  const columns =
    typeof props.columns === "number" ? props.columns : theme.photoGrid.columns;
  const objectFit = props.objectFit === "contain" ? "contain" : "cover";

  if (photos.length === 0) {
    return "";
  }

  const items = photos
    .map(
      (photo: TravelPhoto, index: number) => `
<figure class="tt-photo" data-item-id="${text(`${prefix}-${index}`)}" data-element-id="${text(`${prefix}-${index}`)}" style="margin:0">
  <img class="tt-photo-img" src="${ctx.resolveImageSrc(photo.src)}" alt="${text(photo.alt)}" style="width:100%;display:block;object-fit:${objectFit};object-position:${photo.objectPosition};background:${theme.colors.divider}">
  ${photo.caption !== "" ? `<figcaption class="tt-photo-caption" style="font-size:${theme.typography.smallSize}px;color:${theme.colors.muted};margin-top:4px;text-align:center">${text(photo.caption)}</figcaption>` : ""}
</figure>`.trim(),
    )
    .join("\n");

  return `<section class="tt-photo-grid" data-element-id="${text(prefix)}" style="display:grid;grid-template-columns:repeat(${columns},1fr);gap:${theme.photoGrid.gap}px">${items}</section>`;
};

/** 5. 标签组：任意字符串列表（空数组隐藏）。 */
const tagGroupRenderer: ComponentRenderer = (_content, props, ctx) => {
  const { theme } = ctx;
  // 标签数据由 props.tags 传入（逗号分隔）或绑定内容；此处支持显式 props
  const tagsRaw = typeof props.tags === "string" ? props.tags : "";
  const tags = tagsRaw.split(/[,，]/).map((t) => t.trim()).filter((t) => t !== "");

  if (tags.length === 0) {
    return "";
  }

  const items = tags
    .map(
      (tag) =>
        `<span class="tt-tag" style="font-size:${theme.typography.smallSize}px;padding:2px 8px;border-radius:10px;border:1px solid ${theme.colors.divider};color:${theme.colors.body}">${text(tag)}</span>`,
    )
    .join("");

  return `<div class="tt-tag-group" style="display:flex;gap:${theme.spacing.tagGap}px;flex-wrap:wrap">${items}</div>`;
};

/** 6. 推荐列表：美食/体验/打卡/餐厅分组（复用同一列表形态）。 */
const recommendationListRenderer: ComponentRenderer = (content, props, ctx) => {
  const { theme } = ctx;
  const kind = typeof props.kind === "string" ? props.kind : "foods";
  const title = typeof props.title === "string" ? props.title : "";
  const prefix = ctx.idPrefix ?? kind;

  let entries: Array<{ id: string; primary: string; secondary: string }> = [];

  if (kind === "foods") {
    entries = (content.foods ?? []).map((food, i) => ({
      id: `food-${i}`,
      primary: food.name,
      secondary: food.description,
    }));
  } else if (kind === "experiences") {
    entries = (content.experiences ?? []).map((exp, i) => ({
      id: `experience-${i}`,
      primary: exp.text,
      secondary: "",
    }));
  } else if (kind === "photoChecklist") {
    entries = (content.photoChecklist ?? []).map((item, i) => ({
      id: `checklist-${i}`,
      primary: item.text,
      secondary: item.done ? "已打卡" : "",
    }));
  } else if (kind === "restaurantGroups") {
    const groups: TravelRestaurantGroup[] = content.restaurantGroups ?? [];
    if (groups.length === 0) {
      return "";
    }
    const groupHtml = groups
      .map((group, gi) => {
        const restaurants = group.restaurants
          .map(
            (restaurant, ri) =>
              `<li class="tt-restaurant" data-item-id="${text(`${prefix}-${gi}-${ri}`)}" data-element-id="${text(`${prefix}-${gi}-${ri}`)}">${text(restaurant.name)}${restaurant.note !== "" ? ` <span style="color:${theme.colors.muted}">· ${text(restaurant.note)}</span>` : ""}</li>`,
          )
          .join("");
        return `<div class="tt-restaurant-group" data-item-id="${text(`${prefix}-${gi}`)}"><div class="tt-restaurant-group-name" style="font-weight:700;color:${theme.colors.navy};margin-bottom:4px">${text(group.groupName)}</div><ul style="margin:0;padding-left:18px">${restaurants}</ul></div>`;
      })
      .join("");
    return `<section class="tt-recommendation" data-element-id="${text(prefix)}">${groupHtml}</section>`;
  }

  if (entries.length === 0) {
    return "";
  }

  const items = entries
    .map(
      (entry) =>
        `<li class="tt-recommendation-item" data-item-id="${text(`${prefix}-${entry.id}`)}" data-element-id="${text(`${prefix}-${entry.id}`)}">${text(entry.primary)}${entry.secondary !== "" ? ` <span style="color:${theme.colors.muted}">· ${text(entry.secondary)}</span>` : ""}</li>`,
    )
    .join("");

  const heading =
    title !== ""
      ? `<h3 class="tt-recommendation-title" style="font-family:${theme.typography.headingFamily};font-size:${theme.typography.sectionTitleSize}px;font-weight:700;color:${theme.colors.navy};margin:0 0 ${theme.spacing.itemGap}px">${text(title)}</h3>`
      : "";

  return `<section class="tt-recommendation" data-element-id="${text(prefix)}">${heading}<ul style="margin:0;padding-left:18px;font-size:${theme.typography.bodySize}px;line-height:${theme.typography.bodyLineHeight};color:${theme.colors.body}">${items}</ul></section>`;
};

/** 7. 信息框：停车/预约等单段信息（卡片底色）。 */
const infoBoxRenderer: ComponentRenderer = (content, props, ctx) => {
  const { theme } = ctx;
  const kind = typeof props.kind === "string" ? props.kind : "parking";
  const title = typeof props.title === "string" ? props.title : "";
  const prefix = ctx.idPrefix ?? kind;

  let body = "";
  if (kind === "parking" && content.parking !== undefined) {
    body = content.parking.text;
  } else if (kind === "booking" && content.booking !== undefined) {
    body = content.booking.text;
  } else if (kind === "custom" && typeof props.text === "string") {
    body = props.text;
  }

  // 空模块隐藏
  if (body === "") {
    return "";
  }

  const heading =
    title !== ""
      ? `<div class="tt-info-title" style="font-weight:700;color:${theme.colors.navy};margin-bottom:4px">${text(title)}</div>`
      : "";

  return `<section class="tt-info-box" data-element-id="${text(prefix)}" style="background:${theme.colors.background};border:1px solid ${theme.colors.divider};border-radius:8px;padding:${theme.spacing.cardPadding}px;font-size:${theme.typography.bodySize}px;line-height:${theme.typography.bodyLineHeight};color:${theme.colors.body}">${heading}<div class="tt-info-body" style="white-space:pre-wrap">${text(body)}</div></section>`;
};

/** 组件注册表（七类 + 双栏骨架）。 */
export const componentRegistry: Record<string, ComponentRenderer> = {
  header: headerRenderer,
  "two-column": twoColumnRenderer,
  timeline: timelineRenderer,
  "photo-grid": photoGridRenderer,
  "tag-group": tagGroupRenderer,
  "recommendation-list": recommendationListRenderer,
  "info-box": infoBoxRenderer,
};

/** 已注册组件名。 */
export function registeredComponents(): string[] {
  return Object.keys(componentRegistry);
}
