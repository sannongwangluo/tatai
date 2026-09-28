// V06-12 验证脚本（PLAN.md V06-12；DESIGN.md §3.15 / §8.5）。用法：pnpm verify:v06-12
//
// 分四段（浏览器侧在 `python scripts/verify-v06-12-ui.py`，与 V06-08 的拆分口径一致）：
//   ① 六个夹具仓库场景逐个断言：未初始化 / 未提交（有提交但工作树脏）/ 暂存·未暂存·未跟踪 /
//      冲突 / 无上游 / 读取失败（**外加**一个"已提交干净 + `.工作台/` 被忽略"的对照仓库）。
//   ② **只读自证**：探测前后 `git rev-parse HEAD`、索引登记内容（`git ls-files -s` 输出哈希）、
//      `.git/index` 文件本体（字节哈希 + mtime + size）、工作树全部文件哈希、本地引用清单，
//      必须**逐项相同**；并跑一组**反证对照**证明这条判据不是空的（裸 `git status` 确实会改索引）。
//   ③ 只读性的源码/argv 级证明：白名单子命令、每条固定 argv 的形状、写子命令一律被闸门抛错、
//      源码里不存在 shell 拼接/`execSync`/`shell: true`。
//   ④ 路由登记对账（防漂移）+ 提醒派生口径（同一批指纹稳定、提交后指纹必变＝新成果不被旧暂缓吞掉、
//      无上游不看远端同步、Git 提交不把被忽略的 `.工作台/` 当已备份、超限截断如实）。
//
// ██ 红线遵守 ██
//   · 所有**写**类 git 命令（init/add/commit/clone…）只出现在 `setupFixture()` 里，路径一律
//     `os.tmpdir()` 下自己建的目录，函数入口用 `assertUnderTmp()` 兜住；结束前整棵树删掉。
//   · 对 `D:/tatai` 本体与三个真实项目**一个写命令都不跑**；连只读探测都不在真仓库上做
//     （本脚本全程不碰真仓库，只在夹具上探测）。
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GIT_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_SUBCOMMANDS,
  GIT_WRITE_SUBCOMMANDS,
  assertReadOnlyGitArgv,
  buildVersionReminder,
  changeFingerprint,
  contentVersionOf,
  gitArgvAheadBehind,
  gitArgvUpstream,
  inspectGitStatus,
  relatedOutcomes,
  runGitReadOnly,
  type GitStatusReport,
} from "../src/server/gitStatus";
import type { CheckInput } from "../src/server/work/statusProjection";
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES, routeMentionCounts, routeMentionTotal } from "../src/server/remote-routes";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0612-verify-"));
const FIXTURES = path.join(TMP, "fixtures");

let passCount = 0;
let failCount = 0;

function ok(cond: boolean, label: string): void {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
}
const info = (msg: string): void => console.log(`[verify]   ${msg}`);
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

// ══════════════════════════ 夹具仓库（只在本函数里跑 git 写命令）══════════════════════════

function assertUnderTmp(p: string): void {
  if (!path.resolve(p).startsWith(path.resolve(TMP) + path.sep)) {
    throw new Error(`夹具路径必须在本脚本的临时目录下：${p}`);
  }
}

/** **夹具专用**：跑写类 git 命令（只允许夹具仓库用；真仓库一次都不许走这里） */
function gitWrite(cwd: string, args: string[]): void {
  assertUnderTmp(cwd);
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

const GIT_IDENTITY = ["-c", "user.email=fixture@tatai.local", "-c", "user.name=fixture"];

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
const readFile = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

/** 带空格与中文的路径（`-z` 解析的正题：这类名字不能被转义或切断） */
const P_SPACE_CN = "资料 汇总/带 空格 与中文 的文件.txt";
const P_STAGED = "已暂存 目录/新 文件.txt";
const P_UNTRACKED = "未跟踪 目录/还没 加进来的.md";

interface Fixtures {
  notRepo: string;
  dirty: string;
  conflict: string;
  upstream: string;
  corruptIndex: string;
  cleanIgnored: string;
  unborn: string;
  control: string;
}

function setupFixture(): Fixtures {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const at = (name: string): string => {
    const p = path.join(FIXTURES, name);
    assertUnderTmp(p);
    return p;
  };

  // ① 未初始化：普通目录，连 .git 都没有
  const notRepo = at("not-repo");
  writeFile(notRepo, "README.md", "# 不是仓库\n");
  writeFile(notRepo, ".工作台/chat/x.jsonl", "{\"role\":\"user\"}\n");

  // ② 未提交（有提交但工作树脏）+ 带空格/中文路径的三种桶
  const dirty = at("dirty");
  fs.mkdirSync(dirty, { recursive: true });
  gitWrite(dirty, ["init", "-q", "-b", "main", "."]);
  writeFile(dirty, P_SPACE_CN, "第一版\n");
  gitWrite(dirty, ["add", "--", P_SPACE_CN]);
  gitWrite(dirty, [...GIT_IDENTITY, "commit", "-qm", "初版"]);
  writeFile(dirty, P_SPACE_CN, "改了内容（工作树）\n"); // → modified
  writeFile(dirty, P_STAGED, "新文件但已暂存\n");
  gitWrite(dirty, ["add", "--", P_STAGED]); // → staged
  writeFile(dirty, P_UNTRACKED, "还没 add\n"); // → untracked

  // ③ 冲突（merge 冲突态）
  const conflict = at("conflict");
  fs.mkdirSync(conflict, { recursive: true });
  gitWrite(conflict, ["init", "-q", "-b", "main", "."]);
  writeFile(conflict, "冲突 文件.txt", "base\n");
  gitWrite(conflict, ["add", "--", "冲突 文件.txt"]);
  gitWrite(conflict, [...GIT_IDENTITY, "commit", "-qm", "base"]);
  gitWrite(conflict, ["checkout", "-q", "-b", "side"]);
  writeFile(conflict, "冲突 文件.txt", "side\n");
  gitWrite(conflict, ["commit", "-qam", "side"]);
  gitWrite(conflict, ["checkout", "-q", "main"]);
  writeFile(conflict, "冲突 文件.txt", "main\n");
  gitWrite(conflict, ["commit", "-qam", "main"]);
  try {
    gitWrite(conflict, ["merge", "side"]);
  } catch {
    /* 期待冲突：merge 非 0 退出 */
  }

  // ④ 有上游（bare origin + clone）：先在干净态验 up_to_date，再本地提交一次验 ahead
  const bare = at("origin.git");
  fs.mkdirSync(bare, { recursive: true });
  gitWrite(bare, ["init", "-q", "--bare", "."]);
  const upstream = at("upstream");
  execFileSync("git", ["clone", "-q", bare, upstream], { encoding: "utf8" });
  assertUnderTmp(upstream);
  writeFile(upstream, "a.txt", "1\n");
  gitWrite(upstream, ["add", "--", "a.txt"]);
  gitWrite(upstream, [...GIT_IDENTITY, "commit", "-qm", "c1"]);
  gitWrite(upstream, ["push", "-q", "origin", "HEAD"]);

  // ⑤ 读取失败：仓库在，但 `.git/index` 被写坏 → `git status` 失败（rev-parse 仍成功）
  const corruptIndex = at("corrupt-index");
  fs.cpSync(dirty, corruptIndex, { recursive: true });
  fs.writeFileSync(path.join(corruptIndex, ".git", "index"), "not-a-valid-index", "utf8");

  // ⑥ 已提交干净 + `.工作台/` 被忽略（"代码提交 ≠ 私有事实已备份"的正题）
  const cleanIgnored = at("clean-ignored");
  fs.mkdirSync(cleanIgnored, { recursive: true });
  gitWrite(cleanIgnored, ["init", "-q", "-b", "main", "."]);
  writeFile(cleanIgnored, ".gitignore", ".工作台/\n");
  writeFile(cleanIgnored, "src/index.ts", "export const v = 1;\n");
  writeFile(cleanIgnored, ".工作台/chat/会话.jsonl", "{\"role\":\"user\",\"content\":\"私有聊天\"}\n");
  writeFile(cleanIgnored, ".工作台/tasks.json", "{\"version\":1,\"tasks\":[]}\n");
  writeFile(cleanIgnored, ".工作台/work/evidence/" + "a".repeat(64) + ".json", "{}\n");
  gitWrite(cleanIgnored, ["add", "--", ".gitignore", "src/index.ts"]);
  gitWrite(cleanIgnored, [...GIT_IDENTITY, "commit", "-qm", "c1"]);

  // ⑦ 空仓库（unborn）——加分场景，不在六个点名场景里
  const unborn = at("unborn");
  fs.mkdirSync(unborn, { recursive: true });
  gitWrite(unborn, ["init", "-q", "-b", "main", "."]);
  writeFile(unborn, "f.txt", "1\n");

  // ⑧ 反证对照：一份 dirty 的副本，用来证明"裸 git status 确实会改索引"（判据不是空的）
  const control = at("control");
  fs.mkdirSync(control, { recursive: true });
  gitWrite(control, ["init", "-q", "-b", "main", "."]);
  writeFile(control, "c.txt", "1\n");
  gitWrite(control, ["add", "--", "c.txt"]);
  gitWrite(control, [...GIT_IDENTITY, "commit", "-qm", "c1"]);

  return { notRepo, dirty, conflict, upstream, corruptIndex, cleanIgnored, unborn, control };
}

// ══════════════════════════ 只读自证：探测前后判据 ══════════════════════════

interface RepoFingerprint {
  head: string;
  /** 索引**登记内容**的哈希（`git ls-files -s` 输出哈希；纯读，不往对象库塞东西） */
  index_listing_sha256: string;
  /** `.git/index` 文件本体的字节哈希（"索引文件一个字节都没被改写"的直接判据） */
  index_file_sha256: string;
  index_file_size: number;
  index_file_mtime_ms: number;
  /** 本地引用清单（分支/远端引用各指向哪个提交） */
  refs_sha256: string;
  /** 工作树全部文件（跳过 `.git`）的路径→内容哈希 */
  worktree_sha256: string;
}

function walkFiles(root: string, skipDirs: string[]): { rel: string; sha: string }[] {
  const out: { rel: string; sha: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (skipDirs.includes(rel)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        out.push({ rel, sha: sha256(fs.readFileSync(abs)) });
      }
    }
  };
  walk(root);
  return out;
}

/** 用**只读**命令 + 纯文件读，给一个夹具仓库拍指纹（不含任何写操作、不碰对象库） */
async function fingerprintOf(root: string): Promise<RepoFingerprint> {
  const headRes = await runGitReadOnly(root, ["--no-optional-locks", "rev-parse", "HEAD"]);
  const indexRes = await runGitReadOnly(root, ["--no-optional-locks", "ls-files", "-s"]);
  const refsRes = await runGitReadOnly(root, ["--no-optional-locks", "for-each-ref"]);
  const gitDir = path.join(root, ".git");
  const indexStat = fs.statSync(path.join(gitDir, "index"));
  return {
    head: headRes.stdout.trim(),
    index_listing_sha256: sha256(indexRes.stdout),
    index_file_sha256: sha256(fs.readFileSync(path.join(gitDir, "index"))),
    index_file_size: indexStat.size,
    index_file_mtime_ms: indexStat.mtimeMs,
    refs_sha256: sha256(refsRes.stdout),
    worktree_sha256: sha256(JSON.stringify(walkFiles(root, [".git"]))),
  };
}

// ══════════════════════════ 断言辅助 ══════════════════════════

function expectBuckets(s: GitStatusReport): boolean {
  return s.staged !== null && s.modified !== null && s.untracked !== null && s.conflicted !== null;
}

/** 提醒里不许出现正面的"远端已同步"断言（§3.15：无上游时不写已同步） */
function hasPositiveSyncClaim(payload: unknown): boolean {
  return JSON.stringify(payload).includes("已同步");
}

// ══════════════════════════ 主流程 ══════════════════════════

async function main(): Promise<void> {
  console.log("[verify] V06-12 只读 Git 探测 / 提醒派生 / 六夹具场景 / 只读自证（非浏览器部分）");
  console.log(`[verify]   node ${process.version} · ${process.platform} · repo ${REPO}`);
  console.log(`[verify]   夹具根 ${FIXTURES}`);

  const fx = setupFixture();
  info("夹具仓库已建：not-repo / dirty / conflict / upstream / corrupt-index / clean-ignored / unborn / control");

  // ═══════════════ ① 六个点名场景 ═══════════════
  info("① 夹具场景逐个断言（PLAN 检查项 1）");

  // ①-1 未初始化（不是仓库）
  const notRepo = await inspectGitStatus(fx.notRepo);
  ok(!notRepo.repository.is_repository, "① [未初始化] is_repository=false（不擅自认为它是仓库）");
  ok(notRepo.error === null, "① [未初始化] 不是仓库是**正常状态**，不是 error（error=null）");
  ok(
    notRepo.head.commit === null && !notRepo.head.detached && !notRepo.head.unborn,
    "① [未初始化] HEAD 三态都不认（没有提交/不游离/不是空仓库）",
  );
  ok(
    notRepo.staged === null && notRepo.modified === null && notRepo.untracked === null && notRepo.conflicted === null,
    "① [未初始化] 四桶是 **null 而不是 []**（「不知道」与「确实干净」不混为一谈）",
  );
  ok(
    notRepo.repository.note.includes("未使用 Git") && !fs.existsSync(path.join(fx.notRepo, ".git")),
    "① [未初始化] 明说「未使用 Git」，且**没有**擅自 git init（目录里仍无 .git）",
  );
  const notRepoReminder = buildVersionReminder(notRepo, { submissions: [], evidence: [] });
  ok(
    !notRepoReminder.is_repository && notRepoReminder.local_commit.state === "unknown",
    "① [未初始化] 提醒明说未使用 Git、本地版本状态为未知（不显示成「已保存」）",
  );

  // ①-2 未提交（有提交但工作树脏）+ 暂存/未暂存/未跟踪 + 空格中文路径
  const dirty = await inspectGitStatus(fx.dirty);
  ok(
    dirty.repository.is_repository && dirty.head.commit !== null && dirty.head.branch === "main",
    `① [未提交] 仓库认出来了：HEAD ${dirty.head.short} · 分支 ${dirty.head.branch}`,
  );
  ok(expectBuckets(dirty), "① [未提交] 四桶都拿到了（不是 null）");
  ok(
    (dirty.modified ?? []).includes(P_SPACE_CN),
    `① [未提交] 未暂存桶里**逐字**保留了含空格与中文的路径：${JSON.stringify(P_SPACE_CN)}`,
  );
  ok((dirty.staged ?? []).includes(P_STAGED), `① [未提交] 已暂存桶认出 ${JSON.stringify(P_STAGED)}`);
  ok((dirty.untracked ?? []).includes(P_UNTRACKED), `① [未提交] 未跟踪桶认出 ${JSON.stringify(P_UNTRACKED)}`);
  ok((dirty.conflicted ?? []).length === 0, "① [未提交] 冲突桶为空（有冲突与没冲突分得开）");
  ok(
    !(dirty.staged ?? []).includes(P_SPACE_CN) && (dirty.modified ?? []).length === 1,
    "① [未提交] 桶的归属准确：只改了工作树的那个文件没被算进「已暂存」",
  );
  // -z 解析的直接证据：非 -z 形态会把中文转义，两种形态在夹具上确实不同
  const quoted = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "--", P_SPACE_CN], {
    cwd: fx.dirty,
    encoding: "utf8",
  });
  ok(
    !quoted.includes(P_SPACE_CN) && quoted.includes("\\"),
    `① [未提交] 反证：非 -z 形态**确实**把中文转义了（${JSON.stringify(quoted.trim().slice(0, 40))}）——` +
      "所以必须用 -z 解析，路径才跟文件系统上的名字对得上",
  );

  // ①-3 冲突（merge 冲突态）
  const conflict = await inspectGitStatus(fx.conflict);
  ok(
    (conflict.conflicted ?? []).includes("冲突 文件.txt"),
    `① [冲突] 冲突桶认出 ${JSON.stringify("冲突 文件.txt")}（merge 未解决态）`,
  );
  ok(
    (conflict.staged ?? []).length === 0 && (conflict.modified ?? []).length === 0,
    "① [冲突] 冲突文件不被重复算进「已暂存/未暂存」（三态归属不串）",
  );

  // ①-4 无上游
  const noUp = await inspectGitStatus(fx.dirty);
  ok(
    noUp.tracking_observation.state === "no_upstream" && noUp.tracking_observation.upstream === null,
    "① [无上游] state=no_upstream、upstream=null（不编一个远端出来）",
  );
  const noUpReminder = buildVersionReminder(noUp, { submissions: [], evidence: [] });
  ok(
    !hasPositiveSyncClaim(noUpReminder) && !hasPositiveSyncClaim(noUp),
    "① [无上游] **整份探测结果与提醒里都不出现「已同步」**（无上游就不写远端同步结论）",
  );
  ok(
    noUp.tracking_observation.ahead === null && noUp.tracking_observation.behind === null,
    "① [无上游] 领先/落后计数为 null（没有可比对象就不编 0）",
  );
  ok(
    noUp.tracking_observation.basis === "local_refs_only" && noUp.tracking_observation.fetched === false,
    "① [无上游] 口径写明 basis=local_refs_only、fetched=false（不隐式 fetch）",
  );

  // ①-5 有上游（对照组：跟踪状态能被正确报出来）
  const upClean = await inspectGitStatus(fx.upstream);
  ok(
    upClean.tracking_observation.state === "up_to_date" && upClean.tracking_observation.upstream !== null,
    `① [有上游] 干净态 state=${upClean.tracking_observation.state}（上游 ${upClean.tracking_observation.upstream}），` +
      "且文案是「与本地记录的远端引用一致（未联网核实）」",
  );
  ok(
    upClean.tracking_observation.note.includes("未联网核实"),
    "① [有上游] up_to_date 也不冒充「联网核实过」（本地引用 ≠ 远端此刻的样子）",
  );
  writeFile(fx.upstream, "b.txt", "2\n");
  gitWrite(fx.upstream, ["add", "--", "b.txt"]);
  gitWrite(fx.upstream, [...GIT_IDENTITY, "commit", "-qm", "c2"]);
  const upAhead = await inspectGitStatus(fx.upstream);
  ok(
    upAhead.tracking_observation.state === "ahead" &&
      upAhead.tracking_observation.ahead === 1 &&
      upAhead.tracking_observation.behind === 0,
    `① [有上游] 本地多一个提交 → state=${upAhead.tracking_observation.state}、leading=${upAhead.tracking_observation.ahead}/behind=${upAhead.tracking_observation.behind}`,
  );
  ok(
    upAhead.tracking_observation.observed_at !== "" && upAhead.detected_at === upAhead.tracking_observation.observed_at,
    "① [有上游] 跟踪状态带**观测时间**（且与本次检测时间同一时刻）",
  );

  // ①-6 读取失败（仓库在，git status 失败）
  const bad = await inspectGitStatus(fx.corruptIndex);
  ok(
    bad.repository.is_repository && bad.error !== null && bad.error.code === "GIT_STATUS_FAILED",
    `① [读取失败] 如实报错：${bad.error?.code}｜${bad.error?.message.slice(0, 48)}`,
  );
  ok(
    bad.staged === null && bad.modified === null && bad.untracked === null && bad.conflicted === null,
    "① [读取失败] 四桶**保持 null**（不把「探测失败」画成「工作树干净」）",
  );
  const badReminder = buildVersionReminder(bad, { submissions: [], evidence: [] });
  ok(
    badReminder.local_commit.state === "unknown" &&
      badReminder.verification.state === "unknown" &&
      badReminder.probe_error !== null,
    "① [读取失败] 提醒也是 unknown + 带 probe_error（不显示成干净、不算稳定成果）",
  );

  // ①-7 空仓库（加分）
  const unborn = await inspectGitStatus(fx.unborn);
  ok(
    unborn.repository.is_repository && unborn.head.unborn && unborn.head.commit === null,
    "① [空仓库·加分] unborn=true、commit=null（如实说「还没有提交」）",
  );

  // ═══════════════ ② 只读自证：探测前后判据完全相同 ═══════════════
  info("② 只读自证（探测前后 HEAD / 索引 / 工作树逐项对照）");
  const before = await fingerprintOf(fx.dirty);
  // 连跑两轮探测（覆盖 status + rev-parse + for-each-ref + rev-list/check-ignore/ls-files 的各条路径）
  const probes = [
    await inspectGitStatus(fx.dirty),
    await inspectGitStatus(fx.upstream),
    await inspectGitStatus(fx.cleanIgnored),
    await inspectGitStatus(fx.conflict),
  ];
  const after = await fingerprintOf(fx.dirty);
  ok(before.head === after.head && before.head !== "", `② HEAD 未变（${before.head.slice(0, 12)}…）`);
  ok(
    before.index_listing_sha256 === after.index_listing_sha256,
    `② 索引**登记内容**未变（git ls-files -s 输出哈希 ${before.index_listing_sha256.slice(0, 12)}…）`,
  );
  ok(
    before.index_file_sha256 === after.index_file_sha256,
    `② .git/index **文件本体**未被改写（sha256 ${before.index_file_sha256.slice(0, 12)}…，字节数与 mtime 同判据）`,
  );
  ok(
    before.index_file_size === after.index_file_size && before.index_file_mtime_ms === after.index_file_mtime_ms,
    `② .git/index 的 size/mtime 也一字未动（${before.index_file_size} 字节 / ${before.index_file_mtime_ms}）`,
  );
  ok(before.refs_sha256 === after.refs_sha256, "② 本地引用清单未变（没有偷偷 update-ref）");
  ok(before.worktree_sha256 === after.worktree_sha256, "② 工作树全部文件（跳过 .git）内容哈希未变");
  ok(
    !fs.existsSync(path.join(fx.dirty, ".git", "index.lock")),
    "② 没有留下 `.git/index.lock`（未取过索引锁）",
  );
  info(`② 探测期间从 dirty 读到 ${(probes[0].modified ?? []).length} 个未暂存 / ${(probes[0].untracked ?? []).length} 个未跟踪`);

  // ②-反证：裸 `git status`（不带 --no-optional-locks）确实会改写索引 —— 证明上面那条判据不是空的
  writeFile(fx.control, "c.txt", "1\n");
  const controlBefore = await fingerprintOf(fx.control);
  execFileSync("git", ["status", "--porcelain"], { cwd: fx.control, encoding: "utf8" });
  const controlAfter = await fingerprintOf(fx.control);
  const controlChanged =
    controlBefore.index_file_sha256 !== controlAfter.index_file_sha256 ||
    controlBefore.index_file_mtime_ms !== controlAfter.index_file_mtime_ms;
  ok(
    controlChanged,
    "② **反证对照**：同一个夹具上裸跑 `git status` → `.git/index` 的字节/时间**确实变了**" +
      "（所以本模块每条命令都带 `--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`，不是形式主义）",
  );
  // 同一条命令走模块的只读通道 → 索引不动
  const guardedBefore = await fingerprintOf(fx.control);
  await runGitReadOnly(fx.control, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]);
  const guardedAfter = await fingerprintOf(fx.control);
  ok(
    guardedBefore.index_file_sha256 === guardedAfter.index_file_sha256 &&
      guardedBefore.index_file_mtime_ms === guardedAfter.index_file_mtime_ms,
    "② 同一条 status 走 `runGitReadOnly` → 索引**一个字节都没动**（闸门有效）",
  );

  // ═══════════════ ③ 只读性的源码 / argv 级证明 ═══════════════
  info("③ 「确实用了只读选项、没有写命令」的源码与 argv 级证明（PLAN 检查项 1 的后半句）");
  ok(
    GIT_READ_ONLY_COMMANDS.length >= 8,
    `③ 固定 argv 清单有 ${GIT_READ_ONLY_COMMANDS.length} 条命令（全部在源码里可数）`,
  );
  const badShape = GIT_READ_ONLY_COMMANDS.filter(
    (c) => c.argv[0] !== "--no-optional-locks" || !(GIT_READ_ONLY_SUBCOMMANDS as readonly string[]).includes(c.argv[1]),
  );
  ok(
    badShape.length === 0,
    badShape.length === 0
      ? "③ 每条固定 argv 都是「全局 --no-optional-locks + 白名单子命令」开头"
      : `③ 有 ${badShape.length} 条 argv 形状不合规：${badShape.map((c) => c.id).join("、")}`,
  );
  const writeInline = GIT_READ_ONLY_COMMANDS.flatMap((c) =>
    c.argv.filter((a) => (GIT_WRITE_SUBCOMMANDS as readonly string[]).includes(a)).map((a) => `${c.id}:${a}`),
  );
  ok(writeInline.length === 0, `③ 清单 argv 里没有出现任何写子命令（命中 ${writeInline.join("、") || "无"}）`);
  const forbiddenRejections = GIT_WRITE_SUBCOMMANDS.map((sub) => {
    try {
      assertReadOnlyGitArgv(["--no-optional-locks", sub]);
      return `${sub}→未拦`;
    } catch (e) {
      return (e as { code?: string }).code === "E_GIT_WRITE_FORBIDDEN" ? null : `${sub}→${(e as Error).message}`;
    }
  }).filter((x): x is string => x !== null);
  ok(
    forbiddenRejections.length === 0,
    `③ 运行期闸门对全部 ${GIT_WRITE_SUBCOMMANDS.length} 个写子命令（add/commit/push/fetch/pull/init/config/checkout/stash/reset/clean…）一律抛 E_GIT_WRITE_FORBIDDEN`,
  );
  const missingFlag = (() => {
    try {
      assertReadOnlyGitArgv(["status", "--porcelain"]);
      return false;
    } catch {
      return true;
    }
  })();
  ok(missingFlag, "③ 少了全局 --no-optional-locks 的 argv 直接被拒（防「忘了带就写索引」）");
  const injected = (() => {
    try {
      // 形状校验：把 `--exec=evil` 之类塞进动态片段（分支名/上游名）会被拒——数据不许当选项
      gitArgvUpstream("--exec=evil");
      return false;
    } catch {
      return true;
    }
  })();
  ok(injected, "③ 分支名等动态片段先过形状校验（以 `-` 开头当选项注入 → 抛错）");
  const injectedUpstream = (() => {
    try {
      // 带空白的名字（git 自己的 ref 名不含空白）与带换行的注入串都必须被拒
      gitArgvAheadBehind("origin/main rm -rf /");
      return false;
    } catch {
      return true;
    }
  })();
  ok(injectedUpstream, "③ 上游片段带空白（`origin/main rm -rf /`）进不了 argv——形状校验挡住命令拼接的原料");

  const gitSrc = fs.readFileSync(path.join(REPO, "src/server/gitStatus.ts"), "utf8");
  const gitCode = gitSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  ok(
    !/\bexecSync\s*\(/.test(gitCode) && !/\bexec\s*\(\s*["'`]/.test(gitCode),
    "③ 只有 `execFile`（argv 数组、无 shell），没有 execSync / exec(\"字符串命令\")",
  );
  ok(
    !/shell\s*:\s*true/.test(gitCode) && !/["'`]git["'`]\s*\+/.test(gitCode),
    "③ 没有 `shell: true`，也没有把命令拼成字符串（`\"git\" + …` 一处都找不到）",
  );
  ok(
    /execFile\(\s*\n?\s*"git",\s*\n?\s*\[/.test(gitCode) && (gitCode.match(/execFile\(/g) ?? []).length === 1,
    "③ 全模块只有**一处**进程调用，且形态是 `execFile(\"git\", [ …argv ])`（固定可数）",
  );
  ok(
    /GIT_OPTIONAL_LOCKS/.test(gitCode) && /--no-optional-locks/.test(gitCode),
    "③ 只读锁双保险都在源码里（--no-optional-locks + GIT_OPTIONAL_LOCKS=0）",
  );
  // 真仓库一次都没被本脚本碰过
  ok(
    !fs.existsSync(path.join(fx.notRepo, ".git")) && !gitSrc.includes("D:\\tatai") && !gitSrc.includes("D:/tatai"),
    "③ gitStatus.ts 里没有任何真仓库硬编码路径；本脚本全程只探测夹具",
  );

  // ═══════════════ ④ 路由登记对账 + 提醒派生口径 ═══════════════
  info("④ 新路由登记对账（remote-routes.ts ↔ index.ts 提及数）");
  const route = REMOTE_ROUTES.find((r) => r.id === "git-status-read");
  ok(route !== undefined && route.kind === "read" && route.method === "GET", "④ 只读路由 git-status-read 已登记（GET / read）");
  const indexSrc = fs.readFileSync(path.join(REPO, "src/server/index.ts"), "utf8");
  const indexCode = indexSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const count = (hay: string, needle: string): number => {
    let n = 0;
    let i = hay.indexOf(needle);
    while (i >= 0) {
      n++;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  };
  ok(
    (route?.anchors ?? []).every((a) => count(norm(indexCode), norm(a)) === 1),
    `④ 锚点在 index.ts（剥注释）里恰好命中 1 次：${(route?.anchors ?? []).join("｜")}`,
  );
  const scanned: Record<string, number> = {};
  for (const m of indexCode.matchAll(/req\.method === "(GET|POST|PUT|DELETE)"/g)) {
    scanned[m[1]] = (scanned[m[1]] ?? 0) + 1;
  }
  const manifest = routeMentionCounts();
  ok(
    (scanned.GET ?? 0) === manifest.GET && (scanned.POST ?? 0) === manifest.POST && (scanned.PUT ?? 0) === manifest.PUT,
    `④ GET/POST/PUT 提及数一致（源码 ${scanned.GET}/${scanned.POST}/${scanned.PUT} == 清单 ` +
      `${manifest.GET}/${manifest.POST}/${manifest.PUT}；清单 ${REMOTE_ROUTES.length} 条 / ${routeMentionTotal()} 处提及）`,
  );
  ok(
    (scanned.DELETE ?? 0) === (manifest.DELETE ?? 0),
    `④ DELETE 提及数对账齐平（源码 ${scanned.DELETE} == 清单 ${manifest.DELETE}）——2026-09-20 V06-13 全链落地补登记（chat-session-delete）后由红转绿`,
  );

  // ── ④-补（2026-09-20 第二轮裁定 2）：上面那条"相等"保留不动，另给**被补登记的那条 DELETE 路由**
  //    补三条身份校验。**不**把 DELETE 总数钉死（裁定明说"不必永久钉死总数为 6"）——
  //    只钉这条路由的"唯一登记 / 归属写 / 远端真被拒"，总数继续靠上面的动态相等断言把关。
  const delPath = "/api/projects/:id/chat/sessions/:sid";
  const delRegistered = REMOTE_ROUTES.filter((r) => r.method === "DELETE" && r.path === delPath);
  const delRoute = delRegistered[0] ?? null;
  const delAnchorHits = delRoute === null ? -1 : delRoute.anchors.reduce((n, a) => n + count(norm(indexCode), norm(a)), 0);
  ok(
    delRegistered.length === 1 &&
      delRoute !== null &&
      delRoute.anchors.length === 1 &&
      delAnchorHits === 1,
    `④ 唯一登记：DELETE ${delPath} 在防漂移清单里**恰好一条**（不是"至少一条"：命中 ${delRegistered.length} 条），` +
      `源码 index.ts（剥注释）里的登记点也**恰好一处**（命中 ${delAnchorHits} 处）——补登记只能落在这一条上，重复登记/漏登记都会红`,
  );
  ok(
    delRoute !== null && delRoute.kind === "write",
    `④ 该条登记 kind === "write"（实为 ${delRoute?.kind}）：删聊天会话是写动作，只读模式下必须被拦`,
  );
  // 第 3 条（远端请求真的被拒）——**间接证据**：
  // 本脚本全程只在夹具仓库上做只读 Git 探测，**不起服务、不发任何 HTTP**（见文件头红线段），
  // 进程内没有远程请求能力，所以**不硬造**一次远端请求（硬造只会得到与产品无关的自造断言）。改为：
  // ①钉住这条路由确实进了 `REMOTE_WRITE_ROUTES`（= 清单里 kind==="write" 的全集）；②钉住 `verify:s2` 段④
  // 里**遍历这张表、逐条真打、断言全部 403 REMOTE_READ_ONLY** 的那条既有断言还在（源码级指针，被删掉这里就红）。
  // 为什么是间接证据：真请求由 verify-s2 发（它起服务、造非回环来源、逐条打），这里只证明"这条路由在被真打的
  // 那张表里、且那条逐条拒绝的断言仍在"——本条自身不产生任何 HTTP 证据。
  const s2Src = fs.readFileSync(path.join(REPO, "scripts/verify-s2.ts"), "utf8");
  const delInWriteSet = delRoute !== null && REMOTE_WRITE_ROUTES.some((r) => r.id === delRoute.id);
  ok(
    delInWriteSet &&
      s2Src.includes("for (const route of REMOTE_WRITE_ROUTES)") &&
      s2Src.includes("w.res.status === 403") &&
      s2Src.includes('codeOf(w.res) === "REMOTE_READ_ONLY"'),
    `④ 远端请求真被拒（间接证据，本脚本不发 HTTP）：该路由在 REMOTE_WRITE_ROUTES（当前 ${REMOTE_WRITE_ROUTES.length} 条）` +
      "，verify:s2 段④ 正是遍历这张表逐条真打并断言 403 REMOTE_READ_ONLY（该断言仍在：源码级指针校验通过）",
  );
  ok(
    indexCode.includes("await inspectGitStatus(project.path)") && !/inspectGitStatus\(\s*(req|body|query)/.test(indexCode),
    "④ 路由里探测的是**注册表给的项目路径**（project.path），不接受请求里的任何目录参数",
  );

  info("④ 提醒派生口径（合并同一批 / 新成果不被旧暂缓吞掉 / 提交≠私有事实已备份）");
  const cleanIgnored = await inspectGitStatus(fx.cleanIgnored);
  ok(
    cleanIgnored.private_backup_known.ignored_by_git === true &&
      (cleanIgnored.private_backup_known.ignored_file_count ?? 0) >= 3,
    `④ [代码提交≠私有事实备份] 「.工作台/」被忽略（忽略文件 ${cleanIgnored.private_backup_known.ignored_file_count} 个：聊天/任务/证据都在里面）`,
  );
  ok(
    cleanIgnored.private_backup_known.code_committed === true &&
      (cleanIgnored.staged ?? []).length === 0 &&
      (cleanIgnored.modified ?? []).length === 0,
    "④ [代码提交≠私有事实备份] 代码确实已保存为本地 Git 版本（工作树干净、HEAD 有提交）",
  );
  ok(
    cleanIgnored.private_backup_known.backed_up === "unknown" &&
      cleanIgnored.private_backup_known.backup_flow_available === true,
    "④ [代码提交≠私有事实备份] 但私有事实备份仍是 **unknown**（backup_flow_available=true＝本机显式备份/恢复入口" +
      "**已交付**，V09-06）——**入口存在、代码提交，都不把被忽略的 `.工作台/` 当已备份**",
  );
  const cleanReminder = buildVersionReminder(cleanIgnored, { submissions: [], evidence: [] });
  ok(
    cleanReminder.private_facts.backed_up === "unknown" &&
      cleanReminder.private_facts.backup_flow_available === true &&
      cleanReminder.private_facts.label.includes("V06-14") &&
      cleanReminder.private_facts.label.includes("V09-06") &&
      /无法由 Git 推断/.test(cleanReminder.private_facts.label),
    `④ 提醒里同样只报 unknown，但如实说明入口已交付（backup_flow_available=${String(
      cleanReminder.private_facts.backup_flow_available,
    )}）：${cleanReminder.private_facts.label.slice(0, 70)}…`,
  );

  const fp1 = changeFingerprint(probes[0]);
  const fp2 = changeFingerprint(await inspectGitStatus(fx.dirty));
  ok(fp1 !== null && fp1 === fp2, `④ 同一批改动 → 同一枚指纹（${fp1?.slice(0, 12)}…）——这是"合并重复提醒"的钥匙`);
  const fpUpstream = changeFingerprint(await inspectGitStatus(fx.upstream));
  ok(fpUpstream !== null && fpUpstream !== fp1, "④ 不同仓库/不同改动 → 指纹不同（不会互相顶掉）");
  // 提交后（HEAD 变）指纹必变 → 旧"稍后提醒"按旧指纹记录，挡不住新一批
  const fpBeforeCommit = changeFingerprint(await inspectGitStatus(fx.conflict));
  gitWrite(fx.conflict, ["add", "--", "冲突 文件.txt"]);
  gitWrite(fx.conflict, [...GIT_IDENTITY, "commit", "-qm", "解冲突"]);
  const afterCommit = await inspectGitStatus(fx.conflict);
  const fpAfterCommit = changeFingerprint(afterCommit);
  ok(
    fpBeforeCommit !== fpAfterCommit && (afterCommit.conflicted ?? []).length === 0,
    "④ 解决冲突并提交后：工作树干净 + 指纹**必变**（旧批次的「稍后提醒」按旧指纹记，新的这一批一定重新露面）",
  );
  const samePeek = changeFingerprint(afterCommit);
  ok(
    samePeek === fpAfterCommit,
    "④ 新一批的指纹稳定（同一状态反复探测不会自己抖动，不会把同一批反复当新提醒）",
  );

  // 成果口径（补修 D 重写，见 HANDOFF/证据里的"既有断言五要素"）：
  // 改动路径与成果提交的 changed_files 相交**只说明"可能有关"**，证据在册只说明"证据可取回"；
  // 要判"已通过必要检查"还得有**真实通过结果 + 覆盖声明范围 + 证据完整当前有效 + 无未收口阻断
  // + 绑定当前实际内容版本（含未提交改动）**。下面三条断言的**验收意图一字未改**，只是夹具补齐了
  // 判定所需的真实检查记录与内容版本绑定（收紧，不放宽）。
  const dirtyPaths = [...(probes[0].modified ?? []), ...(probes[0].untracked ?? []), ...(probes[0].staged ?? [])];
  // 声明范围 = 现场改动 ∪ 成果声明；这里让成果与检查覆盖**全部**改动路径（正例该长这样）
  const dirtyScope = [...new Set(dirtyPaths.map((p) => p.replace(/\\/g, "/")))].sort();
  const fpNow = contentVersionOf(fx.dirty, dirtyScope, { head: probes[0].head.commit }).fingerprint;
  const EVID = "e".repeat(64);
  const submissionFact = {
    record_id: "sub-1",
    task_id: "T-1",
    changed_files: dirtyScope,
    evidence_refs: [EVID],
    at: "2026-09-20T10:00:00+08:00",
    submitted_by: "fixture-agent",
  };
  /** 一条**真实通过结果** + 声明范围 + 绑定当前内容版本 + 证据在册 */
  const passingCheck: CheckInput = {
    check_id: "T-1::check:0",
    object_id: "T-1",
    result: "passed",
    actor_id: "fixture-agent",
    role: "executor",
    independence: "author_self",
    binding: { revision_kind: "code", revision: fpNow ?? "" },
    evidence_sha256: EVID,
    at: "2026-09-20T10:05:00+08:00",
    method: "自检：夹具",
    scope: dirtyScope,
    record_ref: "check:T-1-self-1",
  };
  const withEvidence = relatedOutcomes(
    dirtyPaths,
    {
      submissions: [submissionFact],
      evidence: [{ evidence_id: EVID, intact: true }],
      checks: [passingCheck],
      required_checks_by_task: { "T-1": [{ check_id: "T-1::check:0", label: "T-1 验收检查项一" }] },
    },
    { repository_root: fx.dirty, head: probes[0].head.commit },
  );
  ok(
    withEvidence.verification.state === "checks_passed" && withEvidence.submission_ids.includes("sub-1"),
    "④ 成果口径：相关成果 + **真实通过结果**覆盖声明范围 + 证据在册 + 绑定当前内容版本 → 「已通过必要检查」" +
      `（实际 ${withEvidence.verification.state}）`,
  );
  const evidenceGone = relatedOutcomes(
    dirtyPaths,
    {
      submissions: [submissionFact],
      evidence: [],
      checks: [passingCheck],
      required_checks_by_task: { "T-1": [{ check_id: "T-1::check:0", label: "T-1 验收检查项一" }] },
    },
    { repository_root: fx.dirty, head: probes[0].head.commit },
  );
  ok(
    evidenceGone.verification.state !== "checks_passed" &&
      evidenceGone.verification.checks.some((c) => c.why.includes("不在册")),
    "④ 证据不在册（或对不上哈希）→ 不算「通过必要检查」且如实说清原因（不拿提交动作冒充检查）",
  );
  const noRelation = relatedOutcomes(
    ["完全不相关的文件.txt"],
    {
      submissions: [submissionFact],
      evidence: [{ evidence_id: EVID, intact: true }],
      checks: [passingCheck],
      required_checks_by_task: { "T-1": [{ check_id: "T-1::check:0", label: "T-1 验收检查项一" }] },
    },
    { repository_root: fx.dirty, head: probes[0].head.commit },
  );
  ok(
    noRelation.verification.state === "unverified" && noRelation.submission_ids.length === 0,
    "④ 与本次改动无关的成果不会被拉来背书（交集为空 → 未验证）",
  );
  const dirtyReminder = buildVersionReminder(probes[0], { submissions: [], evidence: [] }, { project_name: "夹具·未提交" });
  ok(
    dirtyReminder.local_commit.state === "unsaved" &&
      dirtyReminder.verification.state === "unverified" &&
      dirtyReminder.verification.label.includes("不是稳定成果"),
    "④ 有改动且无对应成果 → 提醒写「还没有保存为本地 Git 版本」+「未验证，不是稳定成果」",
  );
  ok(
    dirtyReminder.file_scope.total === dirtyPaths.length &&
      dirtyReminder.file_scope.files.some((f) => f.path === P_SPACE_CN) &&
      dirtyReminder.agent_note.includes(P_SPACE_CN),
    `④ 文件范围与"复制给执行 Agent 的整理说明"逐字带上含空格/中文的路径（共 ${dirtyReminder.file_scope.total} 个）`,
  );
  ok(
    dirtyReminder.agent_note.includes("塔台**没有**替你执行任何 Git 写操作") &&
      !/git\s+(add|commit|push|fetch|pull)/i.test(dirtyReminder.agent_note) &&
      !/[`"']git\s/.test(dirtyReminder.agent_note),
    "④ 整理说明里明说塔台没有替你执行 Git 写操作，且正文里不夹带任何 git 写命令（不拿说明当自动执行指令）",
  );
  ok(
    (probes[0].tracking_observation as { fetched: boolean }).fetched === false &&
      dirtyReminder.remote.fetched === false,
    "④ 探测与提醒都带 fetched=false（不隐式 fetch/联网/认证/推送）",
  );

  console.log(`\n[verify] V06-12 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
}

try {
  await main();
} catch (e) {
  console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
} finally {
  if (process.env.TATAI_KEEP_TMP === "1") {
    info(`保留现场：${TMP}`);
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}
