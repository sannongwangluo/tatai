// R1 验证脚本（用 tsx 跑）：写入塔台自身记录并回读校验。
// 用法：TATAI_HOME=<全局数据目录> pnpm verify:registry（不设即缺省 ~/.tatai/）
import { REPO_ROOT, finish } from "./lib/fixtures";
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

const dataDir = resolveDataDir();
console.log(`[verify] data dir: ${dataDir}`);
console.log(`[verify] registry file: ${registryPath(dataDir)}`);

// 幂等：已登记过先移除，保证脚本可反复跑
removeProject("tatai", dataDir);

const record = addProject(
  {
    id: "tatai",
    name: "塔台",
    path: REPO_ROOT,
    kind: "fullstack",
    self_managed: true,
  },
  dataDir,
);
console.log("[verify] addProject ->", JSON.stringify(record, null, 2));

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const got = getProject("tatai", dataDir);
ok(got?.id === "tatai", "getProject(tatai) 命中");
ok(got?.name === "塔台", "name == 塔台");
ok(got?.kind === "fullstack", "kind == fullstack");
ok(got?.self_managed === true, "self_managed == true");
ok(typeof got?.registered_at === "string", "registered_at 存在");
ok(typeof got?.last_opened_at === "string", "last_opened_at 存在");

touchLastOpened("tatai", dataDir);
ok(
  (getProject("tatai", dataDir)?.last_opened_at ?? "") >= record.last_opened_at,
  "touchLastOpened 生效",
);

const reg = readRegistry(dataDir);
ok(reg.version === 1, "version == 1");
ok(Array.isArray(reg.projects) && reg.projects.length >= 1, "projects 非空");
console.log(`[verify] listProjects 共 ${listProjects(dataDir).length} 条`);

// 非法 kind 必须报错
try {
  addProject({ id: "bad", name: "坏", path: ".", kind: "oops" as never }, dataDir);
  ok(false, "非法 kind 应抛错");
} catch (e) {
  ok(true, `非法 kind 抛错: ${(e as Error).message}`);
}

finish();
