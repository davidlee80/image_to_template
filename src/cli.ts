#!/usr/bin/env node
/**
 * CLI 参数与环境适配（T07）。
 *
 * 实施计划 2.3 / T07 步骤 5～7：
 * - CLI 只负责参数及环境变量适配、调用 SDK、JSON/人工可读输出、退出码映射；
 * - `--json` 的 stdout 仅一个结果或错误对象；日志/进度输出到 stderr；
 * - SDK 通过回调输出日志，不执行 process.exit（退出码由本入口设置后自然退出）；
 * - 支持设计的三个位置参数命令；同时解析 --template/--data/--output 显式参数；
 * - 退出码：0=完成且满足当前策略，1=执行/校验失败，2=严格模式待复查，64=参数错误。
 */

import { stderr, stdout } from "node:process";

import { createImageTemplate } from "./sdk.js";
import { ImageTemplateError, isImageTemplateError } from "./errors.js";
import { visionConfigFromEnv } from "./config.js";
import type { OperationResult } from "./sdk.js";

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const USAGE = `
用法：
  img-to-template extract <输入图片> <输出目录> [--overwrite] [--strict]
  img-to-template render <模板目录> [--template <文件>] [--data <content.json>]
                        [--output <png 路径>] [--strict]
  img-to-template compare <模板目录> [--reference <基准图>] [--force]

通用：
  --json        stdout 仅输出一个 JSON 结果对象（日志走 stderr）
  --strict      严格模式：阻断项导致失败（退出码 1），待复查返回 2
  --overwrite   extract：允许覆盖已存在输出目录的受管产物

退出码：
  0   完成且满足当前策略（非严格模式下 needs_review 视为完成）
  1   执行或校验失败
  2   严格模式待复查
  64  参数错误
`.trim();

/** 解析命令行参数（支持 --flag value、--flag=value、-h 短参数、布尔 flag、位置参数、-- 分隔）。 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  const valueFlags = new Set(["template", "data", "output", "reference", "input"]);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") || /^-[A-Za-z]/.test(arg)) {
      const body = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        i += 1;
        continue;
      }
      if (valueFlags.has(body)) {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new ImageTemplateError({
            code: "INVALID_ARGUMENT",
            stage: "cli",
            message: `参数 --${body} 需要一个值`,
          });
        }
        flags.set(body, value);
        i += 2;
        continue;
      }
      flags.set(body, true);
      i += 1;
      continue;
    }
    positionals.push(arg);
    i += 1;
  }

  return { command: positionals.shift(), positionals, flags };
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBool(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function paramError(message: string): never {
  throw new ImageTemplateError({
    code: "INVALID_ARGUMENT",
    stage: "cli",
    message,
  });
}

/** 状态 → 退出码（计划 6.3）。 */
export function exitCodeOf(
  status: OperationResult["status"],
  strict: boolean,
): number {
  if (status === "failed") {
    return 1;
  }
  if (status === "needs_review" && strict) {
    return 2;
  }
  return 0;
}

/** CLI 主入口（供 bin 与 tsx 复用）。返回进程退出码。 */
export async function cliMain(argv: string[]): Promise<number> {
  const jsonMode = argv.includes("--json");

  const log = (message: string): void => {
    if (!jsonMode) {
      stderr.write(`${message}\n`);
    } else {
      stderr.write(`${message}\n`);
    }
  };

  try {
    const { command, positionals, flags } = parseArgs(argv);

    if (flags.has("help") || flags.has("h")) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }

    if (command === undefined) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }

    const strict = flagBool(flags, "strict");

    // 环境变量只在 CLI 层转为显式配置（SDK 不读取环境）
    const vision = visionConfigFromEnv({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_MODEL: process.env.OPENAI_MODEL,
    });

    const instance = createImageTemplate({
      ...(vision === undefined ? {} : { vision }),
      logger: (message) => log(message),
    });

    if (command === "extract") {
      const input = positionals[0] ?? flagString(flags, "input");
      const output = positionals[1] ?? flagString(flags, "output");
      if (input === undefined || output === undefined) {
        paramError("extract 需要位置参数：<输入图片> <输出目录>（或 --input/--output）");
      }

      const result = await instance.extract({
        input,
        output,
        ...(flagBool(flags, "overwrite") ? { overwrite: true } : {}),
      });

      return reportResult(result, strict, jsonMode);
    }

    if (command === "render") {
      const bundle = positionals[0] ?? flagString(flags, "template");
      if (bundle === undefined) {
        paramError("render 需要位置参数：<模板目录>（或 --template）");
      }

      const result = await instance.render({
        template: bundle,
        ...(flagString(flags, "data") === undefined
          ? {}
          : { data: flagString(flags, "data")! }),
        ...(flagString(flags, "output") === undefined
          ? {}
          : { output: flagString(flags, "output")! }),
        ...(strict ? { strict: true } : {}),
      });

      return reportResult(result, strict, jsonMode);
    }

    if (command === "compare") {
      const bundle = positionals[0] ?? flagString(flags, "template");
      if (bundle === undefined) {
        paramError("compare 需要位置参数：<模板目录>（或 --template）");
      }

      const result = await instance.compare({
        bundle,
        ...(flagString(flags, "reference") === undefined
          ? {}
          : { reference: flagString(flags, "reference")! }),
        ...(flagBool(flags, "force") ? { force: true } : {}),
      });

      return reportResult(result, strict, jsonMode);
    }

    paramError(`未知命令：${command}`);
  } catch (error) {
    // 参数错误 64；其他执行失败 1（计划 6.3）
    if (isImageTemplateError(error) && error.code === "INVALID_ARGUMENT") {
      if (jsonMode) {
        stdout.write(
          `${JSON.stringify({ error: error.toJSON() }, null, 2)}\n`,
        );
      } else {
        stderr.write(`参数错误：${error.message}\n\n${USAGE}\n`);
      }
      return 64;
    }

    const structured = isImageTemplateError(error)
      ? error.toJSON()
      : {
          name: "UnknownError",
          code: "IO_ERROR",
          stage: "cli",
          message: (error as Error).message ?? String(error),
          retryable: false,
        };

    if (jsonMode) {
      stdout.write(`${JSON.stringify({ error: structured }, null, 2)}\n`);
    } else {
      stderr.write(`执行失败：${structured.message}\n`);
    }
    return 1;
  }
}

function reportResult(
  result: OperationResult,
  strict: boolean,
  jsonMode: boolean,
): number {
  if (jsonMode) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stderr.write(`状态：${result.status}\n`);
    for (const artifact of result.artifacts) {
      stderr.write(`产物：${artifact}\n`);
    }
  }
  return exitCodeOf(result.status, strict);
}

// 直接执行（bin 入口 / tsx）时运行；import 时无副作用
const isDirectRun =
  process.argv[1]?.replace(/\\/g, "/").endsWith("src/cli.ts") === true ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("dist/cli.js") === true;

if (isDirectRun) {
  cliMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
