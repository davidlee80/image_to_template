/**
 * 旅行主题结构化内容 schema（T11 步骤 3，T12 组件消费）。
 *
 * 实施计划：生成 header、weather、hotel、timeline、photos、foods、
 * experiences、photoChecklist、parking、booking、restaurantGroups 的
 * 结构化内容 schema；可选模块和列表数量采用明确约束。
 * 字段为可迁移模板包的内容契约（与模板 schema 分开）。
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const nonEmptyText = z.string().min(1).max(500);

/** 标题区。 */
export const travelHeaderSchema = z.object({
  day: z.number().int().min(1).max(365),
  date: nonEmptyText,
  weekday: nonEmptyText,
  title: nonEmptyText,
  subtitle: z.string().max(200).default(""),
});

/** 天气。 */
export const travelWeatherSchema = z.object({
  text: nonEmptyText,
  temperature: nonEmptyText,
  rainProbability: z.number().int().min(0).max(100),
});

/** 酒店。 */
export const travelHotelSchema = z.object({
  name: nonEmptyText,
  stayText: nonEmptyText,
});

/** 时间轴项（可重复；数量约束 0～12）。 */
export const travelTimelineItemSchema = z.object({
  id: z.string().min(1).max(64),
  number: z.number().int().min(1).max(99),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#3C75A6"),
  title: nonEmptyText,
  time: nonEmptyText,
  description: z.string().max(1000).default(""),
  transferBefore: z
    .object({
      icon: z.enum(["car", "walk", "metro"]),
      text: nonEmptyText,
    })
    .optional(),
  tags: z
    .array(
      z.object({
        text: nonEmptyText,
        tone: z.enum(["blue", "green", "gold", "red"]),
      }),
    )
    .max(8)
    .default([]),
});

/** 照片（可替换；裁剪焦点）。 */
export const travelPhotoSchema = z.object({
  src: nonEmptyText,
  alt: z.string().max(200).default(""),
  caption: z.string().max(200).default(""),
  objectPosition: z
    .string()
    .regex(/^\d{1,3}% \d{1,3}%$/)
    .default("50% 50%"),
});

/** 美食推荐。 */
export const travelFoodSchema = z.object({
  name: nonEmptyText,
  description: z.string().max(500).default(""),
});

/** 体验/亲子推荐。 */
export const travelExperienceSchema = z.object({
  text: nonEmptyText,
});

/** 打卡清单。 */
export const travelPhotoChecklistItemSchema = z.object({
  text: nonEmptyText,
  done: z.boolean().default(false),
});

/** 停车指南。 */
export const travelParkingSchema = z.object({
  text: nonEmptyText,
});

/** 门票预约。 */
export const travelBookingSchema = z.object({
  text: nonEmptyText,
});

/** 餐厅分组（可重复；每组餐厅数量 0～8）。 */
export const travelRestaurantGroupSchema = z.object({
  groupName: nonEmptyText,
  restaurants: z
    .array(z.object({ name: nonEmptyText, note: z.string().max(300).default("") }))
    .max(8)
    .default([]),
});

/** 旅行页面结构化内容（可选模块用 optional 表示）。 */
export const travelContentSchema = z.object({
  schemaVersion: z.literal("1.0"),
  header: travelHeaderSchema,
  weather: travelWeatherSchema.optional(),
  hotel: travelHotelSchema.optional(),
  timeline: z.array(travelTimelineItemSchema).max(12).default([]),
  photos: z.array(travelPhotoSchema).max(24).default([]),
  foods: z.array(travelFoodSchema).max(12).default([]),
  experiences: z.array(travelExperienceSchema).max(12).default([]),
  photoChecklist: z.array(travelPhotoChecklistItemSchema).max(24).default([]),
  parking: travelParkingSchema.optional(),
  booking: travelBookingSchema.optional(),
  restaurantGroups: z.array(travelRestaurantGroupSchema).max(6).default([]),
});

export type TravelContent = z.infer<typeof travelContentSchema>;
export type TravelTimelineItem = z.infer<typeof travelTimelineItemSchema>;
export type TravelPhoto = z.infer<typeof travelPhotoSchema>;
export type TravelRestaurantGroup = z.infer<typeof travelRestaurantGroupSchema>;

/** 生成结构化内容的 JSON Schema（content.schema.json 用）。 */
export function buildTravelContentJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(travelContentSchema, {
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

/** 解析结构化内容（缺必填/超数量报具体路径）。 */
export function parseTravelContent(
  value: unknown,
):
  | { ok: true; content: TravelContent }
  | { ok: false; issues: Array<{ path: string; message: string }> } {
  const result = travelContentSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }
  return { ok: true, content: result.data };
}
