// D2 验证脚本（用 tsx 跑）：HTTP + 逻辑层断言待议记录「只追加」通道与塔台自身例外口径。
// 用法：pnpm verify:d2（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目；
// 唯一例外：注册一个指向本 repo 根的 "tatai" 记录，验证塔台自身例外追加到 <repo>/DESIGN.md 附录 B——
// 追加的是一条测试条目，验证完脚本把它移除并把 DESIGN.md 逐字节恢复成开跑前的样子）
// 覆盖点（PLAN.md D2 DoD 与施工图）：
//   ① 追加一条后 design.discuss.md 多一行，且已有条目未被修改（打印前后 diff）
//   ② 追加两条/三条 → 行序正确（追加在后，不插队）
//   ③ 伪造 id 被拒（PROJECT_NOT_FOUND / 404）
//   ④ 塔台自身追加一条测试条目 → G3 已有条目原文逐字节未动、正文其他部分零改动，
//      验证完移除测试条目恢复 DESIGN.md 原状（git diff 与开跑前一致）
//   ⑤ 红线：PUT/DELETE /discuss 一律 404——全仓没有任何"编辑/删除待议记录"的接口（§3.5/§6.3）
//   ⑥ 回归：POST/PUT/DELETE /design 仍一律 404（D1 红线不破）
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendDiscuss, readDiscuss, WsError } from "../src/server/workstation";

const PORT = 8796;
const BASE = `http://localhost:${PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN_FILE = path.join(REPO_ROOT, "DESIGN.md");
/**
 * ④ 段追加到 DESIGN.md 的测试条目特征词（Q9）：既是追加内容的标识，也是**开跑前残留自愈**的判据——
 * 上一轮被 `taskkill /F`/掉电硬杀时 finally 不跑，条目会留在 tracked 的 DESIGN.md 里。
 */
const TEST_ENTRY_MARK = "D2 验证脚本测试条目";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

/**
 * `git diff --numstat -- DESIGN.md` 的输出 → [新增行, 删除行]。
 * Q9：DESIGN.md 开跑前的未提交改动可能**为 0**（基线提交把既有的 G3 附录 B 改动封存后就如此），
 * 此时输出是空串——原来的 `split(/\s+/).map(Number)` 会得到 [0, undefined]，
 * 后面的 `delD === delB` 恒假 → 假 FAIL。按 [0,0] 记才是"没有 diff"的本意。
 */
const numstatOf = (out: string): [number, number] => {
  const m = out.trim().match(/^(\d+)\s+(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

// ── 准备临时数据目录与两个临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-d2-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "d2-proj"); // 普通被纳管项目（追加设计.discuss.md）
const projEmpty = path.join(tmpBase, "d2-empty"); // 无任何待议记录的项目
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir);
fs.mkdirSync(projEmpty);

const regEntry = (id: string, p: string, selfManaged = false) => ({
  id,
  name: id,
  path: p,
  kind: "backend",
  registered_at: "2026-09-17T10:00:00+08:00",
  last_opened_at: "2026-09-17T10:00:00+08:00",
  ...(selfManaged ? { self_managed: true } : {}),
});
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        // 塔台自身例外：id=="tatai" 指向本 repo 根（REPO_ROOT），待议本体 = <repo>/DESIGN.md 附录 B
        regEntry("tatai", REPO_ROOT, true),
        regEntry("d2-proj", projDir),
        regEntry("d2-empty", projEmpty),
      ],
    },
    null,
    2,
  ),
  "utf8",
);

// ── Q9 残留自愈：上次硬杀（taskkill /F、掉电）会留下测试条目，开跑前先清掉 ──
// 只删带本脚本测试条目特征的那一行，其余内容一字不动；否则基线快照会把脏条目当成"开跑前的样子"。
const designRaw = fs.readFileSync(DESIGN_FILE, "utf8");
const residue = designRaw.split("\n").filter((l) => l.includes(TEST_ENTRY_MARK));
if (residue.length > 0) {
  fs.writeFileSync(
    DESIGN_FILE,
    designRaw.split("\n").filter((l) => !l.includes(TEST_ENTRY_MARK)).join("\n"),
    "utf8",
  );
  console.log(`[verify] 已清理上次异常退出的残留测试条目 ${residue.length} 行（Q9 自愈）`);
}

// ── 塔台 DESIGN.md 基线快照（开跑前逐字节存档 + git diff 存档，跑完必须恢复成它）──
const designBaseline = fs.readFileSync(DESIGN_FILE, "utf8");
const gitDiffBaseline = execSync("git diff -- DESIGN.md", { cwd: REPO_ROOT }).toString();
const numstatBaseline = execSync("git diff --numstat -- DESIGN.md", { cwd: REPO_ROOT })
  .toString()
  .trim();
// V08-01 定点更新：附录 B 已在 2026-09-21 清账（41 清 / 4 留），原来钉的 `[卡号 G3]` 条目已不在；
// 判据不放宽——改成取**现存的既有条目**（清账后仍在的那几条）作"追加不应改动既有原文"的证人。
const existingLine = designBaseline
  .slice(designBaseline.indexOf("## 附录 B：待议记录"))
  .split("\n")
  .find((l) => l.startsWith("- `"));
if (!existingLine) {
  console.log("[verify] FAIL 前置：DESIGN.md 附录 B 里没有可作证人的既有待议条目（施工图前提）");
  process.exit(1);
}
console.log(`[verify] 基线：DESIGN.md ${designBaseline.length} 字符，既有待议条目已定位（${existingLine.slice(0, 34)}…）`);
// 附录 B 已有条目基线数（G3 首条之后，D3 等卡会合法追加新待议——断言跟基线走，不写死 1；
// 只数附录 B 区段内的条目行，与 readDiscuss 的 count 口径一致：附录 B 是文末最后一个二级区段）
const appendixBStart = designBaseline.indexOf("## 附录 B：待议记录");
const discussCountBaseline = designBaseline
  .slice(appendixBStart)
  .split("\n")
  .filter((l) => l.startsWith("- `")).length;
console.log(`[verify] 基线：附录 B 已有待议条目 ${discussCountBaseline} 条`);

// ── 逻辑层（直接调 workstation 层，不起服务）──
const discussFile = path.join(projDir, ".工作台", "design.discuss.md");

// 初始：还没有待议记录 → exists:false（正常空态）
const d0 = readDiscuss("d2-proj", dataDir);
ok(d0.exists === false, "逻辑层：未追加前 readDiscuss → {exists:false}（正常空态）");

// ① 追加第一条：文件不存在则创建带标题头的文件
const r1 = appendDiscuss("d2-proj", "问题甲：测试问题一 ｜ 依据：§3.5 ｜ 建议：测试建议一", dataDir);
ok(fs.existsSync(discussFile), "逻辑层：首次追加后 design.discuss.md 已创建");
const text1 = fs.readFileSync(discussFile, "utf8");
ok(text1.startsWith("# 待议记录\n"), "逻辑层：新建文件带标题头（# 待议记录）");
ok(
  /^- `\d{4}-\d{2}-\d{2}` 问题甲/.test(r1.entry),
  `逻辑层：服务端补日期前缀（实际: ${r1.entry.slice(0, 30)}…）`,
);
ok(text1.includes(r1.entry), "逻辑层：第一条条目已落盘");

// ① 追加第二条：已有条目未被修改（前后 diff = 只多一行）
const r2 = appendDiscuss("d2-proj", "问题乙：测试问题二 ｜ 依据：§6.3 ｜ 建议：测试建议二", dataDir);
const text2 = fs.readFileSync(discussFile, "utf8");
console.log("[verify] ── design.discuss.md 追加第二条前后 diff ──");
console.log(`[verify]   写前 ${text1.split("\n").length - 1} 行 → 写后 ${text2.split("\n").length - 1} 行`);
console.log(`[verify]   新增行: ${r2.entry}`);
console.log("[verify] ────────────────────────────────────────────────");
ok(
  text2 === text1 + r2.entry + "\n" && text2.startsWith(text1),
  "逻辑层：追加第二条后原文前缀逐字节等于写前（已有条目未被修改，只多一行）",
);
ok(
  text2.indexOf(r1.entry) !== -1 && text2.indexOf(r1.entry) < text2.indexOf(r2.entry),
  "逻辑层：行序正确（第一条在前，第二条在后）",
);

// ② 追加第三条 → 行序 1<2<3
const r3 = appendDiscuss("d2-proj", "问题丙：多行内容\n第二行应被折叠 ｜ 依据：§3.5", dataDir);
const text3 = fs.readFileSync(discussFile, "utf8");
ok(
  text3.indexOf(r1.entry) < text3.indexOf(r2.entry) &&
    text3.indexOf(r2.entry) < text3.indexOf(r3.entry),
  "逻辑层：追加三条后行序正确（1 → 2 → 3）",
);
ok(
  !r3.entry.includes("\n") && r3.entry.includes("多行内容 第二行应被折叠"),
  "逻辑层：多行内容折叠为一行（待议一条一行，防注入伪造条目行）",
);
const dCount = readDiscuss("d2-proj", dataDir);
ok(dCount.exists === true && dCount.count === 3, "逻辑层：readDiscuss count = 3（条目行计数口径）");

// 空内容 / 纯空白内容被拒
for (const bad of ["", "   "]) {
  try {
    appendDiscuss("d2-proj", bad, dataDir);
    ok(false, `逻辑层：空内容追加被拒（实际: 未抛错, content=${JSON.stringify(bad)}）`);
  } catch (e) {
    ok(
      e instanceof WsError && e.code === "INVALID_INPUT",
      `逻辑层：空内容追加被拒（INVALID_INPUT, content=${JSON.stringify(bad)}）`,
    );
  }
}
ok(
  fs.readFileSync(discussFile, "utf8") === text3,
  "逻辑层：被拒的空追加没有污染文件（内容与三次追加后逐字节一致）",
);

// ③ 伪造 id 路径穿越被拒
try {
  appendDiscuss("..\\..\\Windows", "问题：越权追加", dataDir);
  ok(false, "逻辑层：伪造 id 追加被拒（实际: 未抛错）");
} catch (e) {
  ok(
    e instanceof WsError && e.code === "PROJECT_NOT_FOUND",
    `逻辑层：伪造 id 追加被拒（PROJECT_NOT_FOUND）（实际: ${(e as Error).message}）`,
  );
}

// 塔台自身例外（读侧，逻辑层）：readDiscuss("tatai") = 抽取附录 B 区段
const tataiDiscuss = readDiscuss("tatai", dataDir);
ok(
  tataiDiscuss.exists === true &&
    tataiDiscuss.content.startsWith("## 附录 B：待议记录") &&
    tataiDiscuss.content.includes(existingLine) &&
    tataiDiscuss.count === discussCountBaseline,
  `逻辑层：tatai readDiscuss = 附录 B 区段抽取（含 G3 条目原文，count=${discussCountBaseline}=基线条目数）`,
);

// ── 起真实后端子进程（临时 TATAI_HOME + 独立端口）──
await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
const child = spawn(
  process.execPath,
  ["--import", "tsx", path.join("src", "server", "index.ts")],
  {
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
watchChild(child, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出

async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        upPorts.add(PORT);
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("后端 10 秒内未就绪");
}

// ── 端口冲突快速失败（2026-09-18 加）────────────────────────────────
// 端口被残留服务 / 并行会话占用时，子进程 EADDRINUSE 会静默死掉，而 waitUp 会打到占用者身上，
// 导致后续莫名 404 崩溃或对错误数据假通过。这里：起前探端口 → 起后盯早退。
const upPorts = new Set<number>();

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true)); // 有人监听 = 端口被占
    sock.once("error", () => done(false)); // 拒绝连接 = 端口空闲
    sock.setTimeout(1000, () => done(false));
  });
}

/** 起前预探测：端口已被占用立刻报错退出，不拿别人的服务跑验证 */
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

/** 起后盯早退：子进程在就绪前退出（典型 EADDRINUSE）立即报错退出，不再继续验证 */
function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

interface DiscussResp {
  status: number;
  body: {
    ok?: boolean;
    discuss?: { exists: boolean; content?: string; source?: string; count?: number };
    result?: { source: string; line: number; entry: string };
    error?: { code: string; message: string };
  };
}

async function httpGetDiscuss(rawIdPath: string): Promise<DiscussResp> {
  const res = await fetch(`${BASE}/api/projects/${rawIdPath}/discuss`);
  return { status: res.status, body: (await res.json()) as DiscussResp["body"] };
}

async function httpPostDiscuss(id: string, content: string): Promise<DiscussResp> {
  const res = await fetch(`${BASE}/api/projects/${encodeURIComponent(id)}/discuss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return { status: res.status, body: (await res.json()) as DiscussResp["body"] };
}

async function httpOtherMethod(method: string, id: string, route: string): Promise<number> {
  const res = await fetch(`${BASE}/api/projects/${encodeURIComponent(id)}/${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "试图篡改" }),
  });
  await res.text();
  return res.status;
}

try {
  await waitUp();
  console.log(`[verify] server up at ${BASE} (TATAI_HOME=${dataDir})`);

  // ── HTTP 读：临时项目待议全文与磁盘逐字节一致 ──
  const g1 = await httpGetDiscuss("d2-proj");
  const diskNow = fs.readFileSync(discussFile, "utf8");
  ok(
    g1.status === 200 && g1.body.discuss?.exists === true && g1.body.discuss.content === diskNow,
    "HTTP：GET discuss 返回 design.discuss.md 全文（与磁盘逐字节一致）",
  );
  ok(g1.body.discuss?.count === 3, "HTTP：GET discuss count=3（条数徽标数据源）");

  // ── HTTP 读：无待议项目 → 200 + exists:false ──
  const g2 = await httpGetDiscuss("d2-empty");
  ok(
    g2.status === 200 && g2.body.ok === true && g2.body.discuss?.exists === false,
    "HTTP：无待议项目 → 200 + {exists:false}（正常空态，不是错误）",
  );

  // ── ① HTTP 追加第四条：已有条目未被修改 ──
  const p1 = await httpPostDiscuss("d2-proj", "问题丁：经 HTTP 追加 ｜ 依据：§3.5 ｜ 建议：走服务端写入");
  ok(p1.status === 200 && p1.body.ok === true, "HTTP：POST discuss 追加成功（200）");
  const afterP1 = fs.readFileSync(discussFile, "utf8");
  console.log("[verify] ── design.discuss.md HTTP 追加第四条前后 diff ──");
  console.log(`[verify]   写前 ${diskNow.split("\n").length - 1} 行 → 写后 ${afterP1.split("\n").length - 1} 行`);
  console.log(`[verify]   新增行: ${p1.body.result?.entry}`);
  console.log("[verify] ────────────────────────────────────────────────────");
  ok(
    afterP1.startsWith(diskNow) && p1.body.result?.entry !== undefined && afterP1.includes(p1.body.result.entry),
    "HTTP：追加后原文前缀逐字节等于写前（前三条未被修改，只多第四条）",
  );
  ok(
    /^- `\d{4}-\d{2}-\d{2}` 问题丁/.test(p1.body.result?.entry ?? ""),
    "HTTP：服务端补日期前缀格式 `- `YYYY-MM-DD` …`（前端只发了内容本体）",
  );

  // ── ③ 伪造 id（编码与未编码两种形态）──
  const forgedPost = await httpPostDiscuss("..%2F..%2FWindows", "问题：越权追加");
  ok(
    forgedPost.status === 404 && forgedPost.body.error?.code === "PROJECT_NOT_FOUND",
    "HTTP：编码形态伪造 id POST discuss → 404 PROJECT_NOT_FOUND（路径只走注册表）",
  );
  const forgedGet = await httpGetDiscuss("..%2F..%2FWindows");
  ok(
    forgedGet.status === 404 && forgedGet.body.error?.code === "PROJECT_NOT_FOUND",
    "HTTP：编码形态伪造 id GET discuss → 404 PROJECT_NOT_FOUND",
  );
  const rawRes = await fetch(`${BASE}/api/projects/../../Windows/discuss`, { method: "POST" });
  await rawRes.text();
  ok(rawRes.status === 404, "HTTP：未编码形态伪造 id → 404（路由不命中，根本不进入处理）");

  // 空内容经 HTTP 追加 → 400 INVALID_INPUT
  const emptyPost = await httpPostDiscuss("d2-proj", "   ");
  ok(
    emptyPost.status === 400 && emptyPost.body.error?.code === "INVALID_INPUT",
    "HTTP：空内容追加 → 400 INVALID_INPUT",
  );

  // ── ⑤ 红线：无任何"编辑/删除待议记录"的接口 ──
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const status = await httpOtherMethod(method, "d2-proj", "discuss");
    ok(status === 404, `红线：${method} /api/projects/:id/discuss → 404（不存在编辑/删除待议接口）`);
  }
  // 子路径形态也不存在（如 /discuss/:lineNo 的改删）
  const subStatus = await httpOtherMethod("DELETE", "d2-proj", "discuss/1");
  ok(subStatus === 404, "红线：DELETE /api/projects/:id/discuss/1 → 404（无按行删除接口）");

  // ── ⑥ 回归：D1 红线不破（POST/PUT/DELETE /design 一律 404）──
  for (const method of ["POST", "PUT", "DELETE"]) {
    const status = await httpOtherMethod(method, "tatai", "design");
    ok(status === 404, `回归：${method} /api/projects/tatai/design → 404（D1 设计书只读红线不破）`);
  }

  // ── ④ 塔台自身例外：HTTP 读附录 B 抽取 ──
  const tataiGet = await httpGetDiscuss("tatai");
  ok(
    tataiGet.status === 200 &&
      tataiGet.body.discuss?.exists === true &&
      tataiGet.body.discuss.content?.startsWith("## 附录 B：待议记录") === true &&
      tataiGet.body.discuss.content.includes(existingLine) &&
      tataiGet.body.discuss.count === discussCountBaseline,
    `HTTP：tatai GET discuss = DESIGN.md 附录 B 区段（G3 条目原文在内，count=${discussCountBaseline}=基线条目数）`,
  );
  ok(
    tataiGet.body.discuss?.source === DESIGN_FILE,
    "HTTP：tatai discuss source 指向 repo 根 DESIGN.md（自举例外，无 .工作台 副本）",
  );

  // ── ④ 塔台自身例外：HTTP 追加一条测试条目到附录 B ──
  const TEST_CONTENT = `问题：${TEST_ENTRY_MARK}（验证后移除） ｜ 依据：§3.5 ｜ 建议：无需处理`;
  const tataiPost = await httpPostDiscuss("tatai", TEST_CONTENT);
  ok(tataiPost.status === 200 && tataiPost.body.ok === true, "HTTP：tatai POST discuss 追加测试条目成功");
  const testEntry = tataiPost.body.result?.entry ?? "";
  const designAfter = fs.readFileSync(DESIGN_FILE, "utf8");
  // V08-01 定点更新：附录 B 后面现在还有「附录 C」（2026-09-21 收尾新增），插入点在附录 B 区段末尾
  // 而不是文末，所以"原文 + 一行"不再成立。判据**不放宽**：改成"把这一行原样去掉就逐字节回到原文"
  // ——这正是追加语义该守的不变量（纯插入、不动其他任何字节），比原来更强（覆盖任意插入点）。
  const withoutEntry = designAfter.replace(`${testEntry}\n`, "");
  ok(
    designAfter.includes(testEntry) && withoutEntry === designBaseline,
    "塔台例外：DESIGN.md 新内容 = 原文在附录 B 区段末尾**纯插入一行**（去掉该行逐字节回到原文；附录 C 已在文末，故不再以文末为插入点）",
  );
  ok(
    designAfter.includes(existingLine),
    "塔台例外：既有待议条目原文逐字节未动（写后仍在，内容一致）",
  );
  ok(
    designAfter.startsWith(designBaseline.slice(0, designAfter.indexOf(testEntry))),
    "塔台例外：写回后插入点之前的原文逐字节等于写前（防吞行断言，正文其他部分零改动）",
  );
  // 追加期间 diff 只允许是基线 diff + 测试条目一行：numstat 对比（基线 diff 可能为空 = [0,0]，
  // 追加后 = 基线 + 1 增 0 删）
  const numstatDuring = execSync("git diff --numstat -- DESIGN.md", { cwd: REPO_ROOT })
    .toString()
    .trim();
  const [addB, delB] = numstatOf(numstatBaseline);
  const [addD, delD] = numstatOf(numstatDuring);
  console.log(`[verify]   git diff --numstat DESIGN.md 基线 ${numstatBaseline} → 追加测试条目期间 ${numstatDuring}`);
  ok(
    addD === addB + 1 && delD === delB,
    "塔台例外：追加测试条目期间 git diff 只多一行新增（附录 B 行变化，删除数不变）",
  );

  // ── ④ 验证完：移除测试条目，恢复 DESIGN.md 原状（只删本次加的那一行）──
  const restored = designAfter.replace(testEntry + "\n", "");
  ok(restored === designBaseline, "塔台例外：移除测试行后内容与开跑前基线逐字节一致（内存校验）");
  fs.writeFileSync(DESIGN_FILE, designBaseline, "utf8");
  const diskRestored = fs.readFileSync(DESIGN_FILE, "utf8");
  ok(diskRestored === designBaseline, "塔台例外：DESIGN.md 已恢复原状（磁盘逐字节 == 开跑前基线）");
  const gitDiffAfter = execSync("git diff -- DESIGN.md", { cwd: REPO_ROOT }).toString();
  ok(
    gitDiffAfter === gitDiffBaseline,
    "塔台例外：恢复后 git diff DESIGN.md 与开跑前一致（只剩 G3 那一条附录 B 改动）",
  );
} finally {
  child.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
  // 兜底：无论断言成败，DESIGN.md 必须恢复成开跑前基线
  if (fs.readFileSync(DESIGN_FILE, "utf8") !== designBaseline) {
    fs.writeFileSync(DESIGN_FILE, designBaseline, "utf8");
    console.log("[verify] 兜底：finally 中恢复 DESIGN.md 基线");
  }
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
