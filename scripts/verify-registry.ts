// R1 验证脚本（用 tsx 跑）：写入塔台自身记录并回读校验。
//
// 隔离口径（2026-09-28 起硬性）：本脚本**只在自带的临时 TATAI_HOME 里跑**——
// 早期版本直接用 `resolveDataDir()`（环境变量 > `~/.tatai/`），会在用户真实全局数据目录里
// 删掉并重建 id 为 `tatai` 的真实登记记录（AGENTS.md §5「使用隔离夹具，避免验证脚本改动真实数据」）。
// 现在：临时目录夹具 + 开工前自检——即使环境里继承了用户的 TATAI_HOME，也一律覆盖为本脚本的临时目录，
// 用户真实注册表一个字节都不碰（本脚本也不再作为登记塔台自身的途径，登记走应用自身的接入流程）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finish } from "./lib/fixtures";
import {
  addProject,
  getProject,
  listProjects,
  readRegistry,
  registryPath,
  removeProject,
  resolveDataDir,
  touchLastOpened,
} from "../src/server/registry";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 夹具：临时全局数据目录 + 临时被纳管项目目录 ──
// mkdtemp 每次唯一，天然可反复跑；结尾统一清理。
const TMP_ROOT = os.tmpdir();
const HOME = fs.mkdtempSync(path.join(TMP_ROOT, "tatai-verify-registry-home-"));
const FIXTURE_PROJECT = fs.mkdtempSync(path.join(TMP_ROOT, "tatai-verify-registry-project-"));
const CLEANUP: string[] = [HOME, FIXTURE_PROJECT];

// 隔离自检①：环境变量显式改写到临时目录——之后任何缺省解析（resolveDataDir()）都落在这里，
// 不再依赖每个调用点都记得传参。继承来的 TATAI_HOME 在这一行被覆盖，用户目录从根上写不进。
process.env.TATAI_HOME = HOME;

// 隔离自检②：两道断言——解析结果必须就是临时目录，且临时目录必须在系统 tmp 下。
// 任何一道不成立立即 FAIL 并跳过全部读写（宁可没跑，不可写错地方）。
const resolved = resolveDataDir();
const isolated = resolved === HOME && HOME.startsWith(TMP_ROOT) && FIXTURE_PROJECT.startsWith(TMP_ROOT);
console.log(`[verify] 夹具数据目录（临时）：${HOME}`);
console.log(`[verify] 夹具项目目录（临时）：${FIXTURE_PROJECT}`);
console.log(`[verify] 用户 TATAI_HOME 已被覆盖为上面的临时目录（继承值不生效）`);
ok(isolated, `隔离自检：resolveDataDir() == 临时夹具目录且位于 ${TMP_ROOT} 下`);
console.log(`[verify] registry file: ${registryPath(HOME)}`);

// ── 夹具预置：一份"已有登记"的注册表（tatai + 另一个项目），再在它上面做增删改查 ──
// 预置另一条记录，验证本脚本的删/写不会波及同表里的其他项目（回归护栏）。
fs.writeFileSync(
  registryPath(HOME),
  JSON.stringify(
    {
      version: 1,
      projects: [
        {
          id: "tatai",
          name: "旧塔台登记（夹具预置，待脚本删除重建）",
          path: path.join(HOME, "stale-tatai-path"),
          kind: "fullstack",
          registered_at: "2026-01-01T00:00:00+08:00",
          last_opened_at: "2026-01-01T00:00:00+08:00",
          self_managed: true,
        },
        {
          id: "demo-other",
          name: "夹具里的另一个项目（不应被动到）",
          path: path.join(HOME, "demo-other-path"),
          kind: "backend",
          registered_at: "2026-01-02T00:00:00+08:00",
          last_opened_at: "2026-01-02T00:00:00+08:00",
        },
      ],
    },
    null,
    2,
  ),
);

if (!isolated) {
  console.log("[verify] 隔离自检未过：不执行任何注册表读写（见上 FAIL 行）");
} else {
  // 幂等：夹具里已登记过先移除，保证脚本可反复跑
  ok(removeProject("tatai", HOME) === true, "removeProject 删掉夹具预置的旧 tatai 记录（返回 true）");

  const record = addProject(
    {
      id: "tatai",
      name: "塔台",
      path: FIXTURE_PROJECT,
      kind: "fullstack",
      self_managed: true,
    },
    HOME,
  );
  console.log("[verify] addProject ->", JSON.stringify(record, null, 2));

  const got = getProject("tatai", HOME);
  ok(got?.id === "tatai", "getProject(tatai) 命中");
  ok(got?.name === "塔台", "name == 塔台");
  ok(got?.kind === "fullstack", "kind == fullstack");
  ok(got?.self_managed === true, "self_managed == true");
  ok(got?.path === path.resolve(FIXTURE_PROJECT), "path == 夹具项目目录（不是真实仓库目录）");
  ok(typeof got?.registered_at === "string", "registered_at 存在");
  ok(typeof got?.last_opened_at === "string", "last_opened_at 存在");

  touchLastOpened("tatai", HOME);
  ok(
    (getProject("tatai", HOME)?.last_opened_at ?? "") >= record.last_opened_at,
    "touchLastOpened 生效",
  );

  const reg = readRegistry(HOME);
  ok(reg.version === 1, "version == 1");
  ok(Array.isArray(reg.projects) && reg.projects.length >= 1, "projects 非空");
  console.log(`[verify] listProjects 共 ${listProjects(HOME).length} 条`);

  // 同表其他记录不受波及：预置的 demo-other 原样还在，字段一字未改
  const other = getProject("demo-other", HOME);
  ok(other?.name === "夹具里的另一个项目（不应被动到）", "预置的其他项目记录仍在（删/写不波及同表其他项目）");
  ok(other?.last_opened_at === "2026-01-02T00:00:00+08:00", "其他项目记录字段未被改动");
  ok(listProjects(HOME).length === 2, "最终注册表恰好 2 条（tatai + demo-other）");

  // 非法 kind 必须报错
  try {
    addProject({ id: "bad", name: "坏", path: ".", kind: "oops" as never }, HOME);
    ok(false, "非法 kind 应抛错");
  } catch (e) {
    ok(true, `非法 kind 抛错: ${(e as Error).message}`);
  }
}

// ── 清理：夹具目录全部删除，tmp 里不留东西（FAIL 也清——失败行已打印足够定位信息） ──
for (const dir of CLEANUP) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.log(`[verify] WARN 清理夹具目录失败（${dir}）：${(e as Error).message}`);
  }
}
ok(!fs.existsSync(HOME) && !fs.existsSync(FIXTURE_PROJECT), "夹具临时目录已清理（tmp 不留残留）");

finish();
