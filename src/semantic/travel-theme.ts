/**
 * 旅行主题设计参数（T12 步骤 1）。
 *
 * 实施计划：将尺寸、颜色、字体、字号、行高、栏宽、间距和线条收敛为
 * TravelTheme；设计初值只作为待校准默认值（真实测量在 T08 后回填）。
 */

/** 主题 token。 */
export interface TravelTheme {
  page: {
    width: number;
    height: number;
    paddingX: number;
    paddingTop: number;
  };
  colors: {
    navy: string;
    gold: string;
    body: string;
    muted: string;
    divider: string;
    background: string;
  };
  typography: {
    headingFamily: string;
    bodyFamily: string;
    dayFamily: string;
    bodySize: number;
    bodyLineHeight: number;
    titleSize: number;
    subtitleSize: number;
    sectionTitleSize: number;
    itemTitleSize: number;
    smallSize: number;
  };
  spacing: {
    sectionGap: number;
    itemGap: number;
    tagGap: number;
    cardPadding: number;
  };
  timeline: {
    badgeSize: number;
    lineWidth: number;
  };
  photoGrid: {
    gap: number;
    columns: number;
  };
}

/** 设计文档初值（待校准默认值；T08 真实测量后替换）。 */
export const defaultTravelTheme: TravelTheme = {
  page: {
    width: 1060,
    height: 1500,
    paddingX: 50,
    paddingTop: 40,
  },
  colors: {
    navy: "#193753",
    gold: "#CB923B",
    body: "#514B43",
    muted: "#A29485",
    divider: "#D7CFC3",
    background: "#FFFFFF",
  },
  typography: {
    headingFamily: '"Template-sans", sans-serif',
    bodyFamily: '"Template-sans", sans-serif',
    dayFamily: '"Template-latin", Georgia, serif',
    bodySize: 14,
    bodyLineHeight: 1.5,
    titleSize: 28,
    subtitleSize: 16,
    sectionTitleSize: 20,
    itemTitleSize: 18,
    smallSize: 12,
  },
  spacing: {
    sectionGap: 28,
    itemGap: 18,
    tagGap: 6,
    cardPadding: 12,
  },
  timeline: {
    badgeSize: 48,
    lineWidth: 2,
  },
  photoGrid: {
    gap: 10,
    columns: 2,
  },
};

/** 深度部分覆盖（主题 token 覆盖只填变更项）。 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** 主题校准记录：token → 测量来源（T08 人工校准后填写）。 */
export interface ThemeCalibration {
  calibratedAt: string;
  /** 与默认值不同的 token 及其测量依据。 */
  overrides: DeepPartial<TravelTheme>;
  /** 校准依据说明（如"基准图 header 高度实测 128px"）。 */
  notes: string[];
}

/** 合并主题覆盖（受限深合并：仅覆盖已知 token）。 */
export function applyThemeOverrides(
  base: TravelTheme,
  overrides: DeepPartial<TravelTheme>,
): TravelTheme {
  return {
    ...base,
    ...overrides,
    page: { ...base.page, ...(overrides.page ?? {}) },
    colors: { ...base.colors, ...(overrides.colors ?? {}) },
    typography: { ...base.typography, ...(overrides.typography ?? {}) },
    spacing: { ...base.spacing, ...(overrides.spacing ?? {}) },
    timeline: { ...base.timeline, ...(overrides.timeline ?? {}) },
    photoGrid: { ...base.photoGrid, ...(overrides.photoGrid ?? {}) },
  };
}
