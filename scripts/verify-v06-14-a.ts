// 补修 A（PLAN「补修分包」A / V06-14 主责，2026-09-20）：注册表 fail-open 收口验证。
//
// 覆盖 6 组场景（**全部只用隔离数据**，夹具在 os.tmpdir() 下自建、跑完整棵删掉）：
//   ① 首次初始化：全新数据目录（不存在 / 空 / 只有塔台启动骨架）首次读 → 建空表并可用（既有流程不破）
//   ② 运行中丢失：已经在用（有项目、有 agents.json）的目录里删掉 registry.json → 结构化错误、
//      **不返回空项目列表**；恢复入口可用且保留现场
//   ③ 损坏：registry.json 写成坏 JSON → 结构化错误（code 与②不同）；**写路径也不再静默清零**；
//      恢复入口两条用法（重建空表 / 从留档恢复）都核到
//   ④ 不可读 / 判不出：registry.json 是目录（EISDIR）、只读权限、数据目录本身列不出来 → 都不伪装成空
//   ⑤ 并发读写：真起多个子进程并发登记 + 并发读 → 不丢更新、不把历史清零
//   ⑥ 真实读写链路：真起后端进程（隔离 TATAI_HOME + 动态端口）走 HTTP → 首次正常、丢失态报错而不是空列表
//
// 用法：pnpm verify:v06-14-a（也可 TATAI_V0614A_RAW_DIR=<目录> 把结果 JSON 另存一份）
// 隐私（AGENTS.md §5）：全程只碰临时目录与虚构夹具，不读真实注册表、不碰三个真实项目、不贴本机路径。
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGISTRY_INIT_MARKER,
  RegistryRecoveryInputError,
  RegistryStateError,
  addProject,
  getProject,
  listProjects,
  probeRegistrySite,
  readRegistry,
  recoverRegistry,
  registryPath,
  removeProject,
  setProjectDocumentPaths,
  touchLastOpened,
} from "../src/server/registry";
import { listProjectsTool } from "../src/mcp/tools/listProjects";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0614a-verify-"));
/** 兜底：任何不小心走"默认数据目录"的代码也只能落在隔离目录里 */
process.env.TATAI_HOME = path.join(TMP, "default-home");

const sha256 = (data: string | Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");
const readBytes = (file: string): Buffer => fs.readFileSync(file);

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown): string =>
  typeof (e as { code?: unknown })?.code === "string" ? String((e as { code: string }).code) : "";
const stateOf = (e: unknown): string =>
  typeof (e as { state?: unknown })?.state === "string" ? String((e as { state: string }).state) : "";
const mkdirp = (d: string): void => void fs.mkdirSync(d, { recursive: true });

/** 断言"这一行必须抛结构化注册表错误"（返回拿到的那条，便于继续断言子字段） */
function expectRegistryError(fn: () => unknown, label: string): unknown | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof RegistryStateError) {
      ok(true, `${label} → ${e.code}（state=${e.state}）`);
      return e;
    }
    ok(false, `${label} → 抛的不是结构化注册表错误：${(e as Error).name}: ${(e as Error).message}`);
    return null;
  }
  ok(false, `${label} → 没抛错（**不许**把读不到当成正常结果）`);
  return null;
}

const regFile = (dir: string): string => registryPath(dir);
const writeProject = (dir: string, id: string): void => {
  addProject(
    { id, name: `夹具 ${id}`, path: path.join(dir, "..", "proj", id), kind: "backend" },
    dir,
  );
};

// ── 子进程收尾（Windows 下 taskkill /T，别留孤儿）──
const children = new Set<ChildProcess>();
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 已经退了
    }
  } else {
    child.kill("SIGTERM");
  }
}
function spawnWorker(args: string[], env: Record<string, string> = {}): Promise<{
  ok: boolean;
  out: string;
  err: string;
}> {
  return new Promise((resolve) => {
    const worker = path.join(REPO_ROOT, "scripts", "verify-v06-14-a-worker.ts");
    const child = spawn(process.execPath, ["--import", "tsx", worker, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.once("close", (code) => {
      children.delete(child);
      resolve({ ok: code === 0, out, err });
    });
  });
}

async function pickFreePort(): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const port = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    const busy = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (port > 0 && !busy) return port;
  }
  throw new Error("分配不到空闲端口（连续 5 次都被抢）");
}

async function main(): Promise<void> {
  console.log(`[verify] 隔离夹具根：${TMP}`);

  // ═══════════════ ① 首次初始化（既有合法流程必须继续工作）═══════════════
  {
    const d1 = path.join(TMP, "s1-fresh");
    ok(!fs.existsSync(d1), "①-0 夹具：数据目录一开始**不存在**");
    const reg = readRegistry(d1);
    ok(
      reg.version === 1 && reg.projects.length === 0,
      "①-1 全新数据目录首次读 → 空表（首次显式初始化保留合法流程）",
    );
    ok(fs.existsSync(regFile(d1)), "①-2 registry.json 已建（首次读会建表，既有脚本依赖这条）");
    ok(
      fs.existsSync(path.join(d1, REGISTRY_INIT_MARKER)),
      `①-3 同一趟落了首次初始化标记 ${REGISTRY_INIT_MARKER}（后续"丢失"判据靠它，不靠猜目录内容）`,
    );
    writeProject(d1, "p-fresh");
    ok(getProject("p-fresh", d1)?.id === "p-fresh", "①-4 首次初始化后立刻可登记并读回");

    const d1b = path.join(TMP, "s1b-empty");
    mkdirp(d1b);
    ok(
      readRegistry(d1b).projects.length === 0,
      "①-5 数据目录存在但**为空** → 仍判首次初始化（不报错）",
    );

    const d1c = path.join(TMP, "s1c-boot-skeleton");
    mkdirp(path.join(d1c, "logs"));
    fs.writeFileSync(path.join(d1c, "work-service.json"), '{"schema_version":2}\n', "utf8");
    const probe1c = probeRegistrySite(d1c);
    ok(
      probe1c.kind === "fresh" && readRegistry(d1c).projects.length === 0,
      `①-6 只有塔台**启动骨架**（work-service.json + logs/，真起后端前的形状）→ 判 fresh 并建空表（判据：${probe1c.reason}）`,
    );
  }

  // ═══════════════ ② 运行中丢失（有项目、有 agents.json，registry.json 被删）═══════════════
  {
    const d2 = path.join(TMP, "s2-lost");
    writeProject(d2, "p-a");
    writeProject(d2, "p-b");
    fs.writeFileSync(
      path.join(d2, "agents.json"),
      JSON.stringify({ version: 1, agents: [{ id: "kimi", name: "Kimi Code" }] }, null, 2),
      "utf8",
    );
    ok(listProjects(d2).length === 2, "②-0 前置：目录已是「在用」状态（2 个项目 + agents.json）");

    const probe2 = probeRegistrySite(d2);
    fs.unlinkSync(regFile(d2));
    const probe2b = probeRegistrySite(d2);
    ok(
      probe2b.kind === "missing" && probe2b.traces.includes("agents.json"),
      `②-1 判据自证：删掉 registry.json 后 probeRegistrySite → missing（痕迹：${probe2b.traces.join("、")}）`,
    );

    const e2 = expectRegistryError(() => readRegistry(d2), "②-2 删掉 registry.json 后读注册表");
    ok(codeOf(e2) === "REGISTRY_MISSING" && stateOf(e2) === "missing", "②-3 code=REGISTRY_MISSING / state=missing（与③损坏分开报）");

    let listGot: unknown = "没有走到";
    let listErr: unknown = null;
    try {
      listGot = listProjects(d2);
    } catch (e) {
      listErr = e;
    }
    ok(
      listGot === "没有走到" && codeOf(listErr) === "REGISTRY_MISSING",
      "②-4 listProjects **抛错**而不是返回 []（不把「已登记过的项目」伪装成「从没登记过」）",
    );
    ok(
      !Array.isArray(listGot),
      `②-5 拿到的不是空项目列表（实际：${Array.isArray(listGot) ? "数组" : "抛错" }）`,
    );
    ok(
      typeof (e2 as RegistryStateError | null)?.message === "string" &&
        ((e2 as RegistryStateError).message.includes("/api/registry/recover")),
      "②-6 错误文案里带**恢复入口**（人照着做就能出来）",
    );

    // MCP 消费方（Agent 侧）：list_projects 工具同口径——丢失态**抛错**，不把空数组交给 Agent
    {
      const savedHome = process.env.TATAI_HOME;
      process.env.TATAI_HOME = d2;
      let toolErr: unknown = null;
      let toolText = "";
      try {
        const r = await listProjectsTool.handler({}, undefined as never);
        toolText = JSON.stringify(r);
      } catch (e) {
        toolErr = e;
      }
      if (savedHome === undefined) delete process.env.TATAI_HOME;
      else process.env.TATAI_HOME = savedHome;
      ok(
        codeOf(toolErr) === "REGISTRY_MISSING" && toolText === "",
        `②-6b MCP 工具 list_projects 同口径：丢失态抛 ${codeOf(toolErr) || "（没抛错，返回了：" + toolText.slice(0, 60) + "）"}`,
      );
    }

    // 恢复入口（不指定来源 = 明确放弃现场、重建空表）
    const rec = recoverRegistry(d2);
    ok(
      rec.action === "rebuilt_empty" && rec.projects === 0 && fs.existsSync(regFile(d2)),
      `②-7 恢复入口显式触发 → action=${rec.action}，注册表重建为空表（0 个项目）`,
    );
    ok(
      rec.quarantined !== null &&
        rec.quarantined.startsWith("registry.json.lost.") &&
        fs.existsSync(path.join(d2, rec.quarantined)),
      `②-8 **现场已留档**：${rec.quarantined}（没有文件可改名时留一份现场记录）`,
    );
    const lostRecord = JSON.parse(
      readBytes(path.join(d2, String(rec.quarantined))).toString("utf8"),
    ) as Record<string, unknown>;
    ok(
      lostRecord.state === "missing" &&
        Array.isArray(lostRecord.traces) &&
        (lostRecord.traces as string[]).includes("agents.json"),
      "②-9 留档里留着当时的判定性质、原因与痕迹清单（事后说得清「当时现场是什么样」）",
    );
    writeProject(d2, "p-c");
    ok(getProject("p-c", d2)?.id === "p-c", "②-10 恢复后登记动作恢复可用");

    const beforeNoop = sha256(readBytes(regFile(d2)));
    const recNoop = recoverRegistry(d2);
    ok(
      recNoop.action === "noop" && sha256(readBytes(regFile(d2))) === beforeNoop,
      "②-11 表已可读时再调恢复入口 → noop、**零改动**（恢复入口不会顺手把好表清零）",
    );
    info(`② 前置探测（删之前）probe=${probe2.kind}；删之后的现场痕迹 ${probe2b.traces.join("、")}`);
  }

  // ═══════════════ ③ 损坏（坏 JSON）：读、写两条路径都不许静默清零 ═══════════════
  {
    const d3 = path.join(TMP, "s3-corrupt");
    writeProject(d3, "p-x");
    writeProject(d3, "p-y");
    const backup = "registry.json.手工备份夹具";
    fs.copyFileSync(regFile(d3), path.join(d3, backup));
    const corruptText = '{"version":1,"projects":[{"id":"p-x","name":"半截';
    fs.writeFileSync(regFile(d3), corruptText, "utf8");
    const corruptSha = sha256(readBytes(regFile(d3)));

    const e3 = expectRegistryError(() => readRegistry(d3), "③-1 坏 JSON → 读注册表");
    ok(
      codeOf(e3) === "REGISTRY_JSON_CORRUPT" && stateOf(e3) === "corrupt" && codeOf(e3) !== "REGISTRY_MISSING",
      "③-2 code=REGISTRY_JSON_CORRUPT / state=corrupt（与②「丢失」区分开）",
    );

    // ⑤ 的同族核对：**写路径**遇到坏表也不许自动清空重建（旧行为：留档+空表重建）
    const writes: { label: string; fn: () => unknown }[] = [
      { label: "③-3 addProject", fn: () => writeProject(d3, "p-z") },
      { label: "③-4 removeProject", fn: () => removeProject("p-x", d3) },
      { label: "③-5 touchLastOpened", fn: () => touchLastOpened("p-x", d3) },
      {
        label: "③-6 setProjectDocumentPaths",
        fn: () => setProjectDocumentPaths("p-x", { design_path: "a.md" }, d3),
      },
    ];
    for (const w of writes) {
      const e = expectRegistryError(w.fn, w.label);
      ok(
        codeOf(e) === "REGISTRY_JSON_CORRUPT",
        `${w.label} 报的是坏表错误（一次普通登记不许把历史缺失掩盖掉）`,
      );
    }
    ok(
      sha256(readBytes(regFile(d3))) === corruptSha,
      "③-7 四个写路径跑完，坏表**逐字节未变**（塔台不改坏文件、不清零、不覆盖）",
    );
    ok(
      !fs.existsSync(path.join(d3, `${path.basename(regFile(d3))}.corrupt.试`)) &&
        fs.readdirSync(d3).filter((f) => f.startsWith("registry.json.corrupt.")).length === 0,
      "③-8 写路径**没有**顺手留档+重建（留档只在显式恢复入口里做）",
    );

    // 恢复入口用法一：从数据目录内的留档/备份恢复
    const rec3 = recoverRegistry(d3, { from: backup });
    ok(
      rec3.action === "restored_from" && rec3.from === backup && rec3.projects === 2,
      `③-9 recoverRegistry({from:"${backup}"}) → action=${rec3.action}、恢复出 ${rec3.projects} 个项目`,
    );
    ok(
      rec3.quarantined !== null && rec3.quarantined.startsWith("registry.json.corrupt."),
      `③-10 恢复前**坏表现场先留档**：${rec3.quarantined}`,
    );
    ok(
      sha256(readBytes(path.join(d3, String(rec3.quarantined)))) === corruptSha,
      "③-11 留档里就是那份坏文件原文（一字不改，可人工修）",
    );
    ok(
      getProject("p-x", d3)?.id === "p-x" && getProject("p-y", d3)?.id === "p-y",
      "③-12 从留档恢复后两条项目记录都回来了（可恢复资料真的可恢复）",
    );

    // 恢复入口用法二：确认放弃现场、重建空表（另一个目录，别把上面恢复好的又冲掉）
    const d3b = path.join(TMP, "s3b-rebuild");
    writeProject(d3b, "p-1");
    const badText = "不是 JSON 的正文";
    fs.writeFileSync(regFile(d3b), badText, "utf8");
    const rec3b = recoverRegistry(d3b);
    ok(
      rec3b.action === "rebuilt_empty" && listProjects(d3b).length === 0,
      `③-13 空 body 调用 → action=${rec3b.action}，空表（人确认这一份救不回来时才这么用）`,
    );
    ok(
      rec3b.quarantined !== null &&
        readBytes(path.join(d3b, rec3b.quarantined)).toString("utf8") === badText,
      "③-14 重建前那份坏表现场同样留档（原文一致）",
    );

    // 恢复入口的入参边界：只接受数据目录内的文件名 + 来源必须是合法注册表
    const inputBad: { label: string; from: string }[] = [
      { label: "③-15 带路径（越界尝试）", from: "../逃逸" },
      { label: "③-16 绝对路径", from: "C:\\Windows\\win.ini" },
      { label: "③-17 不存在的留档", from: "registry.json.corrupt.不存在" },
      { label: "③-18 存在但不是合法注册表", from: "不是注册表.json" },
    ];
    fs.writeFileSync(path.join(d3, "不是注册表.json"), "{坏", "utf8");
    const beforeInput = sha256(readBytes(regFile(d3)));
    for (const c of inputBad) {
      let caught: unknown = null;
      try {
        recoverRegistry(d3, { from: c.from });
      } catch (e) {
        caught = e;
      }
      ok(
        caught instanceof RegistryRecoveryInputError && caught.code === "INVALID_INPUT",
        `${c.label}（from=${JSON.stringify(c.from)}）→ 400 口径入参错、没动现有文件`,
      );
    }
    ok(
      sha256(readBytes(regFile(d3))) === beforeInput,
      "③-19 四次非法恢复请求之后，现有注册表零变化",
    );
  }

  // ═══════════════ ④ 不可读 / 判不出（都不伪装成空）═══════════════
  {
    const d4 = path.join(TMP, "s4-unreadable");
    mkdirp(path.join(d4, "registry.json")); // 同名目录：existsSync=true，readFileSync 报 EISDIR
    fs.writeFileSync(path.join(d4, "agents.json"), '{"version":1,"agents":[]}\n', "utf8");
    const e4 = expectRegistryError(() => readRegistry(d4), "④-1 registry.json 是目录（读失败）→ 读注册表");
    ok(
      codeOf(e4) === "REGISTRY_UNREADABLE" && stateOf(e4) === "unreadable",
      "④-2 code=REGISTRY_UNREADABLE / state=unreadable（与②丢失、③损坏三码分开）",
    );
    let got4: unknown = "没有走到";
    try {
      got4 = listProjects(d4);
    } catch {
      // 预期
    }
    ok(!Array.isArray(got4), "④-3 listProjects 同口径抛错，不返回 []");

    // 只读权限（Windows 上 chmod 未必真拦读）：两条结果都合法，**唯一不许的是冒充空表**
    const d4b = path.join(TMP, "s4b-chmod");
    writeProject(d4b, "p-ro");
    fs.chmodSync(regFile(d4b), 0o000);
    let chmodOutcome: string;
    try {
      chmodOutcome = `照常读到 ${readRegistry(d4b).projects.length} 个项目`;
    } catch (e) {
      chmodOutcome =
        e instanceof RegistryStateError ? e.code : `非结构化错误 ${(e as Error).name}`;
    }
    fs.chmodSync(regFile(d4b), 0o666);
    ok(
      chmodOutcome === "照常读到 1 个项目" || chmodOutcome === "REGISTRY_UNREADABLE",
      `④-4 只读权限下：要么读到真实项目、要么结构化 REGISTRY_UNREADABLE——实测「${chmodOutcome}」`,
    );

    // 判不出（数据目录本身列不出来）→ 保持未知，不猜为空
    const notADir = path.join(TMP, "not-a-dir.txt");
    fs.writeFileSync(notADir, "这是个文件不是目录\n", "utf8");
    const e4c = expectRegistryError(() => readRegistry(notADir), "④-5 数据目录本身列不出来 → 读注册表");
    ok(
      codeOf(e4c) === "REGISTRY_STATE_UNKNOWN" && stateOf(e4c) === "unknown",
      "④-6 code=REGISTRY_STATE_UNKNOWN / state=unknown（判不出就保持未知）",
    );
    let recoveryErr: unknown = null;
    try {
      recoverRegistry(notADir);
    } catch (e) {
      recoveryErr = e;
    }
    ok(
      codeOf(recoveryErr) === "REGISTRY_STATE_UNKNOWN",
      `④-7 连现场性质都判不出时，恢复入口也**受阻**并报 ${codeOf(recoveryErr) || "（没抛错）"}——不硬来、不悄悄造一份空表`,
    );
    ok(
      !fs.existsSync(path.join(notADir, "registry.json")) && fs.statSync(notADir).isFile(),
      "④-8 受阻之后现场原样（「数据目录」仍是那个文件，没有在它旁边/里面造出注册表）",
    );
  }

  // ═══════════════ ⑤ 并发读写（真多进程）═══════════════
  {
    const d5 = path.join(TMP, "s5-concurrent");
    readRegistry(d5); // 首次初始化
    writeProject(d5, "seed");
    ok(listProjects(d5).length === 1, "⑤-0 前置：种子项目 1 条（读者全程不该看到 0）");

    const WRITERS = 4;
    const ADDS = 10;
    const READERS = 2;
    const READS = 200;
    const jobs: Promise<{ ok: boolean; out: string; err: string }>[] = [];
    for (let r = 0; r < READERS; r++) {
      jobs.push(spawnWorker(["read", `R${r}`, String(READS), d5]));
    }
    await sleep(60); // 让读者先进循环，压出"读与写交错"
    for (let w = 0; w < WRITERS; w++) {
      jobs.push(spawnWorker(["write", `W${w}`, String(ADDS), d5]));
    }
    const results = await Promise.all(jobs);
    ok(
      results.every((r) => r.ok),
      `⑤-1 ${WRITERS} 个登记进程 + ${READERS} 个读进程全部 exit 0（有非零即上面有输出）`,
    );

    const readerLines = results
      .map((r) => r.out.match(/\[worker-R\d\] (\{.*\})/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => JSON.parse(m[1]) as { min: number; max: number; errors: string[]; reads: number });
    ok(
      readerLines.length === READERS && readerLines.every((l) => l.errors.length === 0),
      `⑤-2 并发读全程零错误（各读 ${READS} 次；错误：${readerLines.flatMap((l) => l.errors).slice(0, 3).join(" | ") || "无"}）`,
    );
    ok(
      readerLines.length > 0 && readerLines.every((l) => l.min >= 1),
      `⑤-3 并发读**没有一次**读到空表/清零（各读者最小长度 ${readerLines.map((l) => l.min).join("、")}）`,
    );

    const finalIds = listProjects(d5).map((p) => p.id);
    ok(
      finalIds.length === 1 + WRITERS * ADDS,
      `⑤-4 无丢更新：最终 ${finalIds.length} 条 == 种子 1 + ${WRITERS}×${ADDS}`,
    );
    const missing = Array.from({ length: WRITERS * ADDS }, (_, i) => `W${i % WRITERS}-${Math.floor(i / WRITERS)}`).filter(
      (id) => !finalIds.includes(id),
    );
    ok(missing.length === 0, `⑤-5 每个登记 id 都在表里（缺 ${missing.length} 个${missing.length ? "：" + missing.slice(0, 5).join("、") : ""}）`);
    ok(
      JSON.parse(readBytes(regFile(d5)).toString("utf8")).projects.length === finalIds.length,
      "⑤-6 磁盘上那一份与读回来的一致（缓存没有把并发结果带歪）",
    );
  }

  // ═══════════════ ⑥ 真实读写链路（真起后端 + 真 HTTP）═══════════════
  {
    const d6 = path.join(TMP, "s6-http-home");
    const projDir = path.join(TMP, "s6-http-proj");
    mkdirp(projDir);
    const port = await pickFreePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join("src", "server", "index.ts")],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, TATAI_HOME: d6, TATAI_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(child);
    let serverLog = "";
    child.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()));
    let up = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !up) {
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
        up = r.status < 500;
      } catch {
        await sleep(250);
      }
    }
    ok(up, `⑥-1 后端在隔离 TATAI_HOME + 动态端口 ${port} 就绪（/health）`);

    const api = async (
      p: string,
      init?: RequestInit,
    ): Promise<{ status: number; body: any; text: string }> => {
      const r = await fetch(`${base}${p}`, init);
      const text = await r.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {
        // 非 JSON 就留原文
      }
      return { status: r.status, body, text };
    };

    if (up) {
      const boot = fs.readdirSync(d6).sort();
      info(`⑥ 首次启动后数据目录内容：${boot.join("、")}`);

      const first = await api("/api/projects");
      ok(
        first.status === 200 && Array.isArray(first.body) && first.body.length === 0,
        `⑥-2 **首次**（全新数据目录、只有启动骨架）GET /api/projects → ${first.status} 空数组（真实链路里的首次初始化没破）`,
      );

      const created = await api("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: projDir, id: "s6-proj", name: "HTTP 夹具项目" }),
      });
      ok(
        created.status === 200 && created.body?.ok === true,
        `⑥-3 POST /api/projects 登记成功 → ${created.status}`,
      );
      const afterCreate = await api("/api/projects");
      ok(
        afterCreate.status === 200 && Array.isArray(afterCreate.body) && afterCreate.body.length === 1,
        `⑥-4 登记后 GET /api/projects → ${afterCreate.status}，1 条`,
      );

      // 运行中丢失：把注册表删掉（服务还在跑）
      fs.unlinkSync(regFile(d6));
      const lost = await api("/api/projects");
      ok(
        lost.status === 500 && lost.body?.error?.code === "REGISTRY_MISSING",
        `⑥-5 运行中丢失（删 registry.json）→ HTTP ${lost.status} ${lost.body?.error?.code}，**不是** 200 空列表`,
      );
      ok(
        !Array.isArray(lost.body),
        `⑥-6 丢失态的响应体不是项目数组（实际顶层键：${Object.keys(lost.body ?? {}).join("、") || "无"}）`,
      );
      ok(
        typeof lost.body?.error?.recovery === "string" &&
          lost.body.error.recovery.includes("/api/registry/recover"),
        "⑥-7 响应里带恢复入口与现场性质（state/reason/recovery 都在）",
      );

      const recovered = await api("/api/registry/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      ok(
        recovered.status === 200 &&
          recovered.body?.ok === true &&
          recovered.body?.action === "rebuilt_empty" &&
          typeof recovered.body?.quarantined === "string",
        `⑥-8 POST /api/registry/recover → ${recovered.status} action=${recovered.body?.action}，现场留档 ${recovered.body?.quarantined}`,
      );
      ok(
        fs.existsSync(path.join(d6, String(recovered.body?.quarantined))),
        "⑥-9 留档文件真在盘上（可人工恢复）",
      );
      const afterRecover = await api("/api/projects");
      ok(
        afterRecover.status === 200 && Array.isArray(afterRecover.body) && afterRecover.body.length === 0,
        `⑥-10 恢复后 GET /api/projects → ${afterRecover.status} 空数组（登记动作恢复可用）`,
      );

      const badInput = await api("/api/registry/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "../..\\注册表" }),
      });
      ok(
        badInput.status === 400 && badInput.body?.error?.code === "INVALID_INPUT",
        `⑥-11 非法恢复来源（带路径）→ HTTP ${badInput.status} ${badInput.body?.error?.code}`,
      );
    }
    killTree(child);
    children.delete(child);
    info(`⑥ 后端日志尾行：${serverLog.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
  }

  // ═══════════════ 收尾：夹具清理账（不碰仓库、不碰真实数据）═══════════════
  {
    let files = 0;
    let bytes = 0;
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else {
          files++;
          bytes += fs.statSync(p).size;
        }
      }
    };
    walk(TMP);
    info(`收尾：夹具 ${files} 个文件 / ${bytes} B（${path.relative(os.tmpdir(), TMP)}）准备整棵删除`);

    for (const c of children) killTree(c);
    children.clear();
    fs.rmSync(TMP, { recursive: true, force: true });
    ok(!fs.existsSync(TMP), "⑦-1 夹具整棵已删干净（os.tmpdir() 下不留残骸）");
    ok(
      !fs.existsSync(path.join(REPO_ROOT, "registry.json")) &&
        fs.readdirSync(REPO_ROOT).filter((f) => f.startsWith("registry.json.corrupt.")).length === 0,
      "⑦-2 仓库根没有冒出 registry.json / 留档残骸（全程没在仓库里写注册表）",
    );
    const rawDir = process.env.TATAI_V0614A_RAW_DIR;
    if (rawDir && rawDir !== "") {
      mkdirp(rawDir);
      fs.writeFileSync(
        path.join(rawDir, "verify-v06-14-a-summary.json"),
        JSON.stringify({ pass: passCount, fail: failCount, tmp_removed: true }, null, 2) + "\n",
        "utf8",
      );
    }
  }

  console.log(`[verify] 结果: ${passCount} PASS / ${failCount} FAIL`);
}

await main();
