/**
 * 对话式人工生成模板（manual spec）支持：
 * - buildManualSpecPrompt：为"人工把提示词粘贴到对话式 LLM 网页"生成完整提示词
 *   （含画布尺寸锚定、使用说明与 schema）；
 * - stripJsonFence：剥离对话模型输出常见的 ```json 围栏与前后噪音；
 * - extractManualSpec：读取并校验人工提供的 SceneSpec 文件
 *   （与 vision provider 输出走同一校验链路）。
 *
 * 设计依据：模型只在"图片→结构化模板"一步出现；人工通过对话式网页完成该步时，
 * 本程序零模型调用（--spec 路径），错误信息可整段回贴给对话模型定点修复。
 */

import { readFile } from "node:fs/promises";

import { ImageTemplateError } from "../errors.js";
import { standardizeImage } from "../io/image.js";
import {
  buildScenePrompt,
  PROMPT_VERSION,
  SCENE_USER_INSTRUCTION,
} from "./prompts.js";
import {
  parseSceneSpec,
  formatSceneIssues,
  type SceneSpec,
} from "../schemas/scene.js";

/** 生成"人工对话"场景的完整提示词（含操作说明，供直接复制到对话 UI）。 */
export async function buildManualSpecPrompt(input: {
  /** 原始图片路径（用于测量真实尺寸；图片本体由使用者手动上传到对话 UI）。 */
  imagePath: string;
}): Promise<{
  /** 完整提示词（复制粘贴用）。 */
  prompt: string;
  /** 测量得到的画布尺寸（供使用说明展示）。 */
  width: number;
  height: number;
  /** 提示词版本（记录用）。 */
  promptVersion: string;
}> {
  const bytes = await readFile(input.imagePath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "extract",
      message:
        code === "ENOENT"
          ? `输入图片不存在：${input.imagePath}`
          : `读取输入图片失败：${input.imagePath}（${code ?? "未知错误"}）`,
      cause: error,
    });
  });

  const standardized = await standardizeImage(bytes);

  const sceneJsonSchema = await import("zod-to-json-schema").then(
    async ({ zodToJsonSchema }) => {
      const { sceneSpecSchema } = await import("../schemas/scene.js");
      return zodToJsonSchema(sceneSpecSchema, {
        $refStrategy: "none",
      }) as Record<string, unknown>;
    },
  );

  const core = buildScenePrompt({
    width: standardized.width,
    height: standardized.height,
    jsonSchema: sceneJsonSchema,
  });

  const prompt = `【操作说明（给你，模型）】
使用者会随这条消息附上一张图片。请严格按下方规则分析该图片，
只输出一个符合 schema 的 JSON 对象。不要解释、不要 Markdown 围栏。

【使用者须知（复制后请删除本段之前不需要的内容，仅保留"你是页面版式分析器"起的核心提示词）】
1. 把本提示词整体粘贴到对话窗口，并把原始图片作为附件一并发送。
2. 模型输出的 JSON 保存为文件（如 my-spec.json，UTF-8 编码）。
3. 运行：img-to-template extract <原始图片> <输出目录> --spec my-spec.json
4. 若程序报校验错误，把错误信息原样粘贴回对话，让模型修复后重新保存。

${SCENE_USER_INSTRUCTION}

${core}`;

  return {
    prompt,
    width: standardized.width,
    height: standardized.height,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * 剥离对话模型输出中的 JSON 围栏与前后噪音：
 * - ```json ... ``` / ``` ... ``` 围栏；
 * - 围栏外的前导寒暄与尾随说明（取首个 { 到最后一个 } 的范围）。
 */
export function stripJsonFence(raw: string): string {
  const text = raw.trim();

  // 围栏形式：```json\n{...}\n``` 或 ```\n{...}\n```
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced !== null ? fenced[1]! : text;

  // 无围栏但可能带前后说明文字：截取最外层花括号
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return body.slice(first, last + 1);
  }
  return body;
}

/** 读取人工提供的 spec 文件 → 剥围栏 → 走同一 SceneSpec 校验链路。 */
export async function extractManualSpec(
  specFile: string,
): Promise<{ spec: SceneSpec; raw: string }> {
  let raw: string;
  try {
    raw = await readFile(specFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "extract",
      message:
        code === "ENOENT"
          ? `spec 文件不存在：${specFile}`
          : `读取 spec 文件失败：${specFile}（${code ?? "未知错误"}）`,
      cause: error,
    });
  }

  // 去 BOM（编辑器可能写入）
  const stripped =
    raw.charCodeAt(0) === 0xfeff ? stripJsonFence(raw.slice(1)) : stripJsonFence(raw);

  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch (error) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "extract",
      message: `spec 文件不是合法 JSON：${specFile}（${(error as Error).message}）。
若内容来自对话模型输出，请确认已完整复制（未被截断）且不含围栏外的说明文字。`,
      cause: error,
    });
  }

  const result = parseSceneSpec(value);
  if (!result.ok) {
    throw new ImageTemplateError({
      code: "INVALID_ARGUMENT",
      stage: "extract",
      message: `模板校验失败（${specFile}）：${formatSceneIssues(result.issues)}

把上面这段错误信息粘贴回对话窗口，让模型修复对应元素后重新输出。`,
    });
  }

  return { spec: result.spec, raw: stripped };
}
