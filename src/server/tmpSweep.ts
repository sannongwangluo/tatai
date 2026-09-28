import fs from "node:fs";
import path from "node:path";
import { listProjects, resolveDataDir } from "./registry";

// 原子写残骸清扫（Q66，2026-09-18 审计）。
//
// 背景：全仓的原子写一律是"先写临时名，再 renameSync 覆盖目标"。临时名有**两种形状**——
// 绝大多数写点是 `<目标>.<pid>.<毫秒时间戳>.tmp`（两段式），另有 `auth.ts` 的明文口令副本与
// `remote-write.ts` 的写态文件用 `<目标>.<pid>.tmp`（单段式，没有时间戳）。
// write 与 rename 之间被 kill（或磁盘异常）时，那份 tmp 就永远留在原地：全仓**没有任何清扫代码**，
// 也没有启动期清残骸——而它每次写都会换一个新名字，所以是逐个累积（不是被下次写覆盖）。
//
// 口径：
//   · 只认上面两种形状（`TMP_RESIDUE_RE`）。Q158（2026-09-19 二轮审计）：正则此前写死两段式
//     `/\.\d+\.\d+\.tmp$/`，单段式（`auth.json.<pid>.tmp`——**明文口令副本**、`write-mode.json.<pid>.tmp`）
//     一个也匹配不上，永不入清扫、逐次累积；现在单段的时间戳部分可选。
//     固定名的两处（layoutStore / foldStore 的 `<文件>.tmp`，无 pid 段）不匹配、也被下次写覆盖，不动它们；
//   · 只清**够老**的（默认 5 分钟）：正在写的临时文件活不过毫秒级，5 分钟意味着不可能误删在途文件
//     （MCP 进程与 HTTP 进程同时在写，所以必须留这个安全边际，不能见 tmp 就删）；
//   · 走查有上限（MAX_DIRS），删不掉（被占用/权限）就留着下次再说——清扫失败绝不影响服务启动。

/** 残骸命名口径：`<目标文件>.<pid>.tmp` 或 `<目标文件>.<pid>.<毫秒时间戳>.tmp`（时间戳段可选） */
const TMP_RESIDUE_RE = /\.\d+(\.\d+)?\.tmp$/;
/** 只清"够老"的（在途临时文件活不过毫秒级） */
const STALE_MS = 5 * 60_000;
/** 单次清扫的目录数上限（防清扫本身变成一次全盘遍历） */
const MAX_DIRS = 400;
/** 递归走查时跳过的目录段 */
const SKIP_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

export interface TmpSweepResult {
  /** 清掉的残骸文件数 */
  removed: number;
  /** 清掉的字节数 */
  bytes: number;
  /** 实际走查的目录数（可能小于实际，见 truncated） */
  scanned_dirs: number;
  /** 是否因目录数上限提前停手 */
  truncated: boolean;
}

function emptyResult(): TmpSweepResult {
  return { removed: 0, bytes: 0, scanned_dirs: 0, truncated: false };
}

/** 清一个目录里的原子写残骸；`recursive` = 是否往下走子目录 */
export function sweepStaleTmpFiles(
  dir: string,
  recursive: boolean,
  olderThanMs: number = STALE_MS,
): TmpSweepResult {
  const res = emptyResult();
  if (!fs.existsSync(dir)) return res;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    if (res.scanned_dirs >= MAX_DIRS) {
      res.truncated = true;
      break;
    }
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // 无权限/已消失：跳过
    }
    res.scanned_dirs++;
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (recursive && !SKIP_SEGMENTS.has(e.name)) stack.push(abs);
        continue;
      }
      if (!e.isFile() || !TMP_RESIDUE_RE.test(e.name)) continue;
      try {
        const st = fs.statSync(abs);
        if (Date.now() - st.mtimeMs < olderThanMs) continue; // 还年轻：可能有人在写
        fs.rmSync(abs, { force: true });
        res.removed++;
        res.bytes += st.size;
      } catch {
        // 删不掉就留着，下次启动再试
      }
    }
  }
  return res;
}

/** 清扫范围：全局数据目录 + 每个已登记项目的 `.工作台/`（递归）与其项目根（只顶层，AGENTS.md/DESIGN.md 的残骸） */
export function sweepAllTmpResidue(dataDir: string = resolveDataDir()): TmpSweepResult {
  const total = emptyResult();
  const merge = (r: TmpSweepResult): void => {
    total.removed += r.removed;
    total.bytes += r.bytes;
    total.scanned_dirs += r.scanned_dirs;
    total.truncated = total.truncated || r.truncated;
  };

  merge(sweepStaleTmpFiles(dataDir, true));
  let projects: { path: string }[] = [];
  try {
    projects = listProjects(dataDir);
  } catch {
    projects = []; // 注册表坏了不拦清扫（也不拦启动）
  }
  for (const p of projects) {
    merge(sweepStaleTmpFiles(path.join(p.path, ".工作台"), true));
    merge(sweepStaleTmpFiles(p.path, false));
  }
  return total;
}
