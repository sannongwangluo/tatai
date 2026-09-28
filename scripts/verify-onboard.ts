// R2 验证脚本（用 tsx 跑）：覆盖 R2 卡 DoD 四条。
// 用法：pnpm verify:onboard（真实项目目录走 TATAI_DIR_* 环境变量；塔台自身＝本仓库，无需环境变量）
// 真实项目目录（DESIGN.md §11.5 三种项目形态）一律从环境变量读，脚本里不写死作者本机路径：
//   · 真实项目① 前后端 = 本仓库（REPO_ROOT）；
//   · 真实项目② 纯后端：TATAI_DIR_BACKEND=<目录>；
//   · 真实项目③ 静态站：TATAI_DIR_STATIC=<目录>；
//   没给的那两条 → 对应断言 SKIP（明确提示），不当 PASS。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkGitignore, detectKind, onboardProject } from "../src/server/onboard";
import { listProjects, registryPath } from "../src/server/registry";
import { REPO_ROOT, finish, realDir, skip } from "./lib/fixtures";
import { SYNTH_HINT, synthEnabled, synthOnboardBackend, synthOnboardStatic } from "./lib/synth";

// 本段往**临时数据目录**写记录（不碰真实注册表、不往主人的注册表塞验证记录）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-onboard-home-"));
console.log(`[verify] data dir（临时夹具）: ${dataDir}`);
console.log(`[verify] registry file: ${registryPath(dataDir)}`);

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// 真实目录：① 前后端 = 本仓库；② 纯后端 / ③ 静态站 = 环境变量给（没给 → SKIP）
// TATAI_SYNTH=1 且真实 env 没给 → 临时目录造授权合成夹具，断言原样跑（Q6）
const DIR_TATAI = REPO_ROOT;
const DIR_BACKEND = realDir("TATAI_DIR_BACKEND") ?? (synthEnabled() ? synthOnboardBackend() : null);
const DIR_STATIC = realDir("TATAI_DIR_STATIC") ?? (synthEnabled() ? synthOnboardStatic() : null);
if (synthEnabled()) {
  console.log(`[verify] TATAI_SYNTH=1：合成 纯后端=${DIR_BACKEND} 静态站=${DIR_STATIC}`);
}
const REAL_DIRS: Array<[string, string, string]> = [
  [DIR_TATAI, "fullstack", "真实项目①（前后端）"],
];
if (DIR_BACKEND) REAL_DIRS.push([DIR_BACKEND, "backend", "真实项目②（纯后端）"]);
if (DIR_STATIC) REAL_DIRS.push([DIR_STATIC, "static", "真实项目③（Astro 静态站）"]);

// ── DoD① 不存在的路径 → 明确错误，不崩溃不抛裸栈 ──────────────
const bad = onboardProject(
  { path: path.join(os.tmpdir(), "tatai-不存在的目录-r2-verify") },
  dataDir,
);
console.log("[verify] 不存在路径返回 ->", JSON.stringify(bad));
ok(bad.ok === false, "DoD① 返回 ok:false 而非抛异常");
ok(!bad.ok && bad.error.code === "PATH_NOT_FOUND", "DoD① 错误码 PATH_NOT_FOUND");
ok(!bad.ok && bad.error.message.includes("路径不存在"), "DoD① 错误信息可读");

// ── DoD② 真实目录 kind 判定（对照 DESIGN.md §11.5；对照表里三种项目形态）─────
if (!DIR_BACKEND) {
  skip("DoD② 真实项目②（纯后端）kind 判定", `设 TATAI_DIR_BACKEND=<纯后端项目目录> 后可跑，${SYNTH_HINT}`);
}
if (!DIR_STATIC) {
  skip("DoD② 真实项目③（静态站）kind 判定", `设 TATAI_DIR_STATIC=<Astro 静态站项目目录> 后可跑，${SYNTH_HINT}`);
}
for (const [dir, expect, label] of REAL_DIRS) {
  const d = detectKind(dir);
  console.log(`[verify] detectKind(${label}) -> ${d.kind}；依据: ${d.reasons.join("；")}`);
  ok(d.kind === expect, `DoD② ${label} kind == ${expect}`);
}

// ── DoD③ .gitignore 缺 `.工作台/` 行 → 提示（DESIGN.md §8.2）───
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-onboard-verify-"));
const tmpMissing = path.join(tmpBase, "missing");
const tmpHas = path.join(tmpBase, "has");
fs.mkdirSync(tmpMissing);
fs.mkdirSync(tmpHas);
fs.writeFileSync(path.join(tmpMissing, ".gitignore"), "node_modules/\ndist/\n", "utf8");
fs.writeFileSync(
  path.join(tmpHas, ".gitignore"),
  "node_modules/\n.工作台/\n",
  "utf8",
);
const gMissing = checkGitignore(tmpMissing);
const gHas = checkGitignore(tmpHas);
console.log(`[verify] 缺行项目 hint -> ${gMissing.hint}`);
ok(gMissing.has_workbench_line === false && gMissing.hint !== null, "DoD③ 缺行 → 有提示");
ok(gHas.has_workbench_line === true && gHas.hint === null, "DoD③ 有行 → 无提示");
// 真实项目现状（只提示，不改人家文件）
for (const [dir, , label] of REAL_DIRS) {
  const g = checkGitignore(dir);
  console.log(
    `[verify] ${label} .gitignore: exists=${g.exists} has_workbench_line=${g.has_workbench_line}${g.hint ? "（已给出提示）" : ""}`,
  );
}
fs.rmSync(tmpBase, { recursive: true, force: true });

// ── DoD④ 幂等重接入：真实项目各接入两次，记录数不增（写临时数据目录）────
const inputs = [
  { id: "tatai", name: "塔台", path: DIR_TATAI, self_managed: true },
  ...(DIR_BACKEND ? [{ id: "real-backend", name: "真实项目②", path: DIR_BACKEND }] : []),
  ...(DIR_STATIC ? [{ id: "real-static", name: "真实项目③", path: DIR_STATIC }] : []),
];
for (const input of inputs) {
  const first = onboardProject(input, dataDir);
  ok(first.ok, `DoD④ 首次接入 ${input.id} 成功`);
  if (first.ok) {
    console.log(
      `[verify] onboard(${input.id}) -> already_registered=${first.already_registered} kind=${first.record.kind}`,
    );
  }
}
const countAfterFirst = listProjects(dataDir).length;
for (const input of inputs) {
  const second = onboardProject(input, dataDir);
  ok(
    second.ok && second.already_registered === true,
    `DoD④ 重复接入 ${input.id} → already_registered`,
  );
}
const countAfterSecond = listProjects(dataDir).length;
ok(countAfterSecond === countAfterFirst, `DoD④ 记录数不增（${countAfterFirst} -> ${countAfterSecond}）`);

// 注册表落盘核对（只贴 id/name/kind/self_managed，不贴别人项目的文件内容）
const records = listProjects(dataDir).map((p) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  self_managed: p.self_managed ?? false,
}));
console.log("[verify] registry 记录 ->", JSON.stringify(records, null, 2));
const kindOf = (id: string) => records.find((r) => r.id === id)?.kind;
ok(kindOf("tatai") === "fullstack", "DoD④ registry: 真实项目①（前后端）kind == fullstack");
if (DIR_BACKEND) {
  ok(kindOf("real-backend") === "backend", "DoD④ registry: 真实项目②（纯后端）kind == backend");
}
if (DIR_STATIC) {
  ok(kindOf("real-static") === "static", "DoD④ registry: 真实项目③（静态站）kind == static");
}

fs.rmSync(dataDir, { recursive: true, force: true });
finish();
