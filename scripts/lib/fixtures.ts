// 验证脚本的"真实数据夹具"共用口径（AGENTS.md §6 开源红线：脚本里不出现作者本机路径与真实项目名）。
//
// 三条规矩：
//   ① 全局数据目录一律走 `resolveDataDir()`（`TATAI_HOME` > 缺省 `~/.tatai/`，DESIGN.md §8.1）——
//      脚本里不写死任何盘符路径，换台机器/换个目录都不用改代码；
//   ② 真实项目 = 塔台自身（`REPO_ROOT`，不需要环境变量）＋ `TATAI_REAL_IDS` 列出的注册表项目 id；
//      另有按目录取用的真实项目走 `realDir("TATAI_DIR_XXX")`，没设或目录不存在就 SKIP 那一段；
//   ③ **SKIP 必须显式打印并进结论行**——没跑的段不许当 PASS（PLAN.md 审计约定：缺证据视为未验证）。
//      退出码：0 = 全跑且全过；3 = 有段落 SKIP（没跑全）；1 = 有断言 FAIL。
//
// 用法（脚本开头）：
//   import { REPO_ROOT, ensureSelfRegistered, finish, realHome, realDir, skip } from "./lib/fixtures";
//   const HOME = realHome();
//   const self = ensureSelfRegistered(HOME);   // 幂等：塔台自身＝本仓库
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject, getProject, listProjects, resolveDataDir, type ProjectRecord } from "../../src/server/registry";

/** 仓库根（本文件在 scripts/lib/ 下）：塔台自身的路径，不需要任何环境变量 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 全局数据目录：`TATAI_HOME` > 缺省 `~/.tatai/`（口径唯一出处 = registry.resolveDataDir） */
export function realHome(): string {
  return resolveDataDir();
}

/**
 * 真实项目目录：按环境变量候选名依次取**第一个存在**的目录；都没设/都不存在 → null。
 * 调用方拿到 null 必须 `skip(...)` 并跳过那一段，不许当 PASS。
 */
export function realDir(...envNames: string[]): string | null {
  for (const name of envNames) {
    const value = process.env[name]?.trim();
    if (value && fs.existsSync(value)) return value;
  }
  return null;
}

/**
 * 真实项目 id 清单：塔台自身 + `TATAI_REAL_IDS`（逗号分隔）。
 * 作者本机想跑全量（多个真实项目）时显式列出，例如
 * `TATAI_REAL_IDS=<id1>,<id2> TATAI_HOME=<数据目录> pnpm verify:n1`。
 */
export function realProjectIds(): string[] {
  const extra = (process.env.TATAI_REAL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return ["tatai", ...extra.filter((id) => id !== "tatai")];
}

/**
 * 幂等登记塔台自身（id `tatai`，路径 = 本仓库）。
 * 已在注册表里就原样返回（不覆盖别人登记过的记录）；没有才写一条。
 * 写的是应用自己的全局数据目录（`TATAI_HOME`/`~/.tatai/` 的 `registry.json`），不碰被纳管项目、不进仓库。
 */
export function ensureSelfRegistered(home: string = realHome()): ProjectRecord {
  const existing = getProject("tatai", home);
  if (existing) return existing;
  return addProject(
    { id: "tatai", name: "塔台", path: REPO_ROOT, kind: "fullstack", self_managed: true },
    home,
  );
}

/**
 * "私密词"探针清单（供零真实数据扫描用）：**脚本里不写死任何真实项目名**——
 *   ① 显式设了 `TATAI_HOME` 时，从该数据目录的注册表现取项目名与 id（不设则不读，避免平白碰真实数据）；
 *   ② `TATAI_PRIVATE_TOKENS`（逗号分隔）追加自定义词，例如本机复现完整自查：
 *      `TATAI_PRIVATE_TOKENS=<项目名1>,<项目名2> pnpm verify:l3`
 * 两组都没有 → 返回空数组：该组探针缺席，调用方要如实打印"这组没跑"，不许当 PASS。
 */
export function privateTokens(): string[] {
  const tokens = new Set<string>();
  if (process.env.TATAI_HOME?.trim()) {
    for (const p of listProjects(realHome())) {
      if (p.name.trim() !== "") tokens.add(p.name.trim());
      if (p.id.trim() !== "") tokens.add(p.id.trim());
    }
  }
  for (const t of (process.env.TATAI_PRIVATE_TOKENS ?? "").split(",")) {
    const v = t.trim();
    if (v !== "") tokens.add(v);
  }
  return [...tokens];
}

let skipCount = 0;

/** 记一段"没跑"：显式打印，进结论行（不是 PASS、不是 FAIL） */
export function skip(label: string, hint: string): void {
  skipCount += 1;
  console.log(`[verify] SKIP ${label}｜这一段没跑，不计为 PASS｜${hint}`);
}

/** 已跳过的段数 */
export function skips(): number {
  return skipCount;
}

/** 收尾结论 + 退出码：1 = 有断言 FAIL；3 = 有段落 SKIP（没跑全）；0 = 全跑全过 */
export function finish(): void {
  if (process.exitCode && process.exitCode !== 0) {
    console.log("[verify] 结果: FAIL（上面有 FAIL 行）");
    return;
  }
  if (skipCount > 0) {
    console.log(`[verify] 结果: 没跑全（${skipCount} 段 SKIP，见上面 SKIP 行）——退出码 3，别当全过`);
    process.exitCode = 3;
    return;
  }
  console.log("[verify] 结果: 全部 PASS");
}
