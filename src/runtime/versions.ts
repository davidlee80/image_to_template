/**
 * 模板/内容版本管理与快照（T15 步骤 5 / T16 步骤 4）。
 *
 * 实施计划：
 * - 保存每轮补丁、前后评分、约束检查、接受/拒绝原因、工具链和
 *   模板/内容版本；禁止候选直接覆盖唯一成功包；
 * - 模板版本和内容版本独立维护；纯正文变更只更新内容版本；
 * - 快照按序保存于 history/，支持中断后用最佳快照重新渲染/回滚。
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { ImageTemplateError, type SdkStage } from "../errors.js";

/** history/ 内受管理的快照文件名。 */
export const SNAPSHOT_FILES = [
  "template.json",
  "content.json",
  "content.schema.json",
  "manifest.json",
] as const;

export interface TemplateVersions {
  /** 模板版本（结构/样式/补丁变更递增）。 */
  templateVersion: number;
  /** 内容版本（纯正文变更递增）。 */
  contentVersion: number;
}

export interface VersionedSnapshot {
  /** 快照序号（从 1 开始）。 */
  index: number;
  /** 保存时间。 */
  savedAt: string;
  /** 快照来源轮次（0 = 校准起始模板）。 */
  round: number;
  /** 快照备注（如 "round-2-accepted" / "baseline"）。 */
  label: string;
  /** 各文件 SHA-256（完整性核对）。 */
  hashes: Record<string, string>;
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function sha256OfFile(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** 读取 manifest 中的版本号（缺省 1/1）。 */
export async function readBundleVersions(
  bundleDir: string,
  stage: SdkStage,
): Promise<TemplateVersions> {
  const manifestFile = path.join(bundleDir, "manifest.json");
  if (!(await fileExists(manifestFile))) {
    return { templateVersion: 1, contentVersion: 1 };
  }
  const manifest = JSON.parse(
    await readFile(manifestFile, "utf8"),
  ) as Partial<TemplateVersions>;
  return {
    templateVersion:
      typeof manifest.templateVersion === "number" ? manifest.templateVersion : 1,
    contentVersion:
      typeof manifest.contentVersion === "number" ? manifest.contentVersion : 1,
  };
}

/** 计算文件 SHA-256（供 manifest/快照登记）。 */
export async function hashBundleFile(
  bundleDir: string,
  relative: string,
): Promise<string> {
  return sha256OfFile(path.join(bundleDir, relative));
}

/**
 * 保存快照到 history/snapshot-<index>/（受管文件副本 + 快照描述）。
 * 不覆盖任何现有快照；index 由调用方按 history 内最大序号 +1 分配。
 */
export async function saveSnapshot(
  bundleDir: string,
  options: {
    index: number;
    round: number;
    label: string;
  },
): Promise<VersionedSnapshot> {
  const snapshotDir = path.join(bundleDir, "history", `snapshot-${options.index}`);

  if (await fileExists(snapshotDir)) {
    throw new ImageTemplateError({
      code: "CONFLICT",
      stage: "calibrate",
      message: `快照目录已存在：${snapshotDir}（不覆盖历史快照）`,
    });
  }

  await mkdir(snapshotDir, { recursive: true });

  const hashes: Record<string, string> = {};
  for (const file of SNAPSHOT_FILES) {
    const source = path.join(bundleDir, file);
    if (await fileExists(source)) {
      await writeFile(path.join(snapshotDir, file), await readFile(source));
      hashes[file] = await sha256OfFile(source);
    }
  }

  const snapshot: VersionedSnapshot = {
    index: options.index,
    savedAt: new Date().toISOString(),
    round: options.round,
    label: options.label,
    hashes,
  };
  await writeFile(
    path.join(snapshotDir, "snapshot.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );

  return snapshot;
}

/** 列出全部快照（按序号升序）。 */
export async function listSnapshots(
  bundleDir: string,
): Promise<VersionedSnapshot[]> {
  const historyDir = path.join(bundleDir, "history");
  if (!(await fileExists(historyDir))) {
    return [];
  }

  const entries = (await import("node:fs/promises")).readdir(historyDir);
  const dirs = (await entries).filter(
    (name) => name.startsWith("snapshot-"),
  );

  const snapshots: VersionedSnapshot[] = [];
  for (const name of dirs.sort()) {
    const metaFile = path.join(historyDir, name, "snapshot.json");
    if (!(await fileExists(metaFile))) {
      continue;
    }
    snapshots.push(
      JSON.parse(await readFile(metaFile, "utf8")) as VersionedSnapshot,
    );
  }
  return snapshots.sort((a, b) => a.index - b.index);
}

/** 读取指定快照（供重新渲染或回滚）。 */
export async function readSnapshot(
  bundleDir: string,
  index: number,
): Promise<{
  snapshot: VersionedSnapshot;
  files: Record<string, Buffer>;
}> {
  const snapshotDir = path.join(bundleDir, "history", `snapshot-${index}`);
  const metaFile = path.join(snapshotDir, "snapshot.json");
  if (!(await fileExists(metaFile))) {
    throw new ImageTemplateError({
      code: "IO_ERROR",
      stage: "calibrate",
      message: `快照不存在：${snapshotDir}`,
    });
  }

  const snapshot = JSON.parse(
    await readFile(metaFile, "utf8"),
  ) as VersionedSnapshot;

  const files: Record<string, Buffer> = {};
  for (const file of Object.keys(snapshot.hashes)) {
    const bytes = await readFile(path.join(snapshotDir, file));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== snapshot.hashes[file]) {
      throw new ImageTemplateError({
        code: "IO_ERROR",
        stage: "calibrate",
        message: `快照文件哈希不一致：${file}（快照可能已损坏）`,
      });
    }
    files[file] = bytes;
  }

  return { snapshot, files };
}

/** 将快照内容恢复到包根（受管文件级回滚）。 */
export async function restoreSnapshot(
  bundleDir: string,
  index: number,
): Promise<VersionedSnapshot> {
  const { snapshot, files } = await readSnapshot(bundleDir, index);
  for (const [file, bytes] of Object.entries(files)) {
    await writeFile(path.join(bundleDir, file), bytes);
  }
  return snapshot;
}

/** 删除快照（测试/清理用；不删除 history 目录本身）。 */
export async function removeSnapshot(
  bundleDir: string,
  index: number,
): Promise<void> {
  await rm(path.join(bundleDir, "history", `snapshot-${index}`), {
    recursive: true,
    force: true,
  });
}
