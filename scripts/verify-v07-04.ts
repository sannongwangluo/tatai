// verify-v07-04：接续入口体验件（PLAN V07-04；DESIGN 附录 C.5-4）。
// 全程隔离 TATAI_HOME + 临时项目夹具；真目录、真描述符、真端口探活，不 mock 现场。
//   A doctor 服务死：无描述符 → 报"未启动"，且只读不变量（不擅自拉服务、不写字节）
//   B doctor 描述符陈旧：伪造死 pid 指针 → 点名陈旧；heal=true 才走 V07-01 自愈并复探通过
//   C doctor 服务活：真端口（本进程宿主 + 真描述符）→ 探活通过、pid 存活
//   D doctor 基线失效：真 activateBaseline 立基线 → 有效；改设计书后 → 报"在基线激活后变过"
//   E doctor 迁移状态：无事件 → 未迁移报因；真写入事件 + 备份目录在场 → 已迁移且回滚可用
//   F 事件面缺口：默认全覆盖；注入"抽走 rebind_task"的破坏性现场 → doctor 点名缺口；CLI 仍是 exit 0
//   G read_design 分段读：CRLF 夹具 + 真 DESIGN.md，range 分段/章节分段拼回去与全文逐字节一致
//   H manage_change op=open 省略批次号：形态过 CHANGE_ID_RE、重试幂等（不开第二个批次）、内容不同则不同 id
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { activateBaseline, buildSectionIndex, sha256Hex } from "../src/server/work/documents";
import { CHANGE_ID_RE, readChanges } from "../src/server/work/changes";
import { loadEvents } from "../src/server/work/eventStore";
import { checkEventSurface } from "../src/server/work/eventSurface";
import {
  WorkService,
  readServiceDescriptor,
  removeServiceDescriptor,
  writeServiceDescriptor,
} from "../src/server/work/service";
import { REGISTERED_EVENT_TYPES } from "../src/server/work/types";
import { createWorkHost } from "../src/server/workHost";
import { doctorTool, createDoctorTool } from "../src/mcp/tools/doctor";
import { readDesignTool } from "../src/mcp/tools/readDesign";
import { manageChangeTool } from "../src/mcp/tools/workObjects";
import { TOOLS } from "../src/mcp/tools/index";
import type { McpContext, McpTool } from "../src/mcp/tools/types";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results: Array<[boolean, string]> = [];
const check = (ok: boolean, msg: string): void => {
  results.push([ok, msg]);
  console.log(`[verify] ${ok ? "PASS" : "FAIL"} ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ToolCall {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | null;
}

/** 调一次工具并解析回执（回执是 JSON 文本；解析不出来时 json=null，测试据此判红） */
async function call(tool: McpTool, args: Record<string, unknown>, ctx?: McpContext): Promise<ToolCall> {
  const out = await tool.handler(args, ctx);
  const text = out.content?.[0]?.text ?? "";
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { isError: out.isError === true, text, json };
}

// ── 隔离夹具 ──

/** CRLF 设计书：分段读最容易出错的就是行尾，夹具故意做成 CRLF（切片必须原样带 \r\n） */
const DESIGN_CRLF = [
  "# 夹具设计书",
  "",
  "（前言：第一个标题之前的正文也算一节。）",
  "",
  "## 1 概述",
  "目标：验证分段读逐字节一致。",
  "",
  "## 2 方案",
  "方案 A：按行切片，行尾换行跟着行一起切出去。",
  "方案 B：按章节切片，与章节索引同一份口径。",
  "",
  "### 2.1 细则",
  "细则一句话。",
  "",
  "### 2.2 边界",
  "边界一句话。",
  "",
  "## 3 附录",
  "末节两行。",
  "末节第二行。",
  "",
].join("\r\n");

const PLAN_FIXTURE = [
  "# 夹具施工图",
  "",
  "## 当前任务",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 打地基 |  | `pnpm test` 通过 |",
  "| T-2 | todo | 砌墙 | T-1 | 验收清单勾完 |",
  "",
].join("\n");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "v0704-verify-"));
const projRoot = path.join(dataDir, "proj");
const workbench = path.join(projRoot, ".工作台");
fs.mkdirSync(workbench, { recursive: true });
const PROJECT = "v0704";
const designFile = path.join(workbench, "design.md");
const planFile = path.join(workbench, "plan.md");
const workDir = path.join(workbench, "work");
const eventsFile = path.join(workDir, "events.jsonl");

/** 注册表：夹具项目 + 一个指向 repo 根的 tatai 记录（只读真 DESIGN.md，用来验真文件的逐字节一致） */
function writeRegistry(): void {
  fs.writeFileSync(
    path.join(dataDir, "registry.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: PROJECT,
          name: "V07-04 验证夹具",
          path: projRoot,
          kind: "backend",
          registered_at: "2026-09-22T00:00:00+08:00",
          last_opened_at: "2026-09-22T00:00:00+08:00",
        },
        {
          id: "tatai",
          name: "塔台（repo 根，只读夹具）",
          path: REPO,
          kind: "backend",
          self_managed: true,
          registered_at: "2026-09-22T00:00:00+08:00",
          last_opened_at: "2026-09-22T00:00:00+08:00",
        },
      ],
    }),
  );
}

writeRegistry();
fs.writeFileSync(designFile, DESIGN_CRLF, "utf8");
fs.writeFileSync(planFile, PLAN_FIXTURE, "utf8");
process.env.TATAI_HOME = dataDir;
// 自愈闸必须开着，否则 B 段的 heal=true 探不到自愈行为；A 段的"只读不变量"也因此才有意义
delete process.env.TATAI_NO_AUTOSTART;

const eventCount = (): number => {
  try {
    return loadEvents(workDir).events.length;
  } catch {
    return 0;
  }
};
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * 1 基闭区间的"行切片"原文（测试自己的一份取法：按行数组重拼，不复用实现里的字符偏移算法）。
 * 末行之后没有换行符可吃，其余每行都带上它自己的换行（LF 或 CRLF 都原样保留）。
 */
function sectionTextOf(text: string, fromLine: number, toLine: number): string {
  const lines = text.split("\n");
  return lines
    .slice(fromLine - 1, toLine)
    .map((line, i) => (fromLine - 1 + i === lines.length - 1 ? line : `${line}\n`))
    .join("");
}

async function main(): Promise<void> {
  console.log("\n[verify] ═══ A doctor：服务死（无描述符）═══");
  {
    const before = { events: eventCount(), descriptor: fs.existsSync(path.join(dataDir, "work-service.json")) };
    const r = await call(doctorTool, { project_id: PROJECT });
    const d = r.json!;
    const service = d.service as Record<string, unknown>;
    const descriptor = service.descriptor as Record<string, unknown>;
    check(r.isError === false && d.ok === false, "A doctor 调用成功且总判定为不健康（ok=false）");
    check(service.reachable === false, "A 报「写服务不可达」（reachable=false）");
    check(
      descriptor.present === false && descriptor.ok === null,
      "A 报因指向「没有服务描述符」（descriptor.present=false），而不是含糊的 fetch failed",
    );
    check(
      (service.problems as string[]).some((p) => p.includes("没有服务描述符")),
      `A service.problems 点名缺描述符（${(service.problems as string[])[0] ?? ""}）`,
    );
    const migration = d.migration as Record<string, unknown>;
    check(migration.migrated === false && migration.ok === false, "A 同一探把「未迁移」也报出来（migrated=false）");
    check(
      (migration.problems as string[]).some((p) => p.includes("未迁移到 v2")),
      "A migration 报因点名「未迁移到 v2」并说明迁移要显式授权",
    );
    check(
      eventCount() === before.events && fs.existsSync(path.join(dataDir, "work-service.json")) === before.descriptor,
      "A 只读不变量：doctor 没有拉起服务、没有写事件（现场字节未变）",
    );
  }

  console.log("\n[verify] ═══ B doctor：描述符陈旧 与 heal=true 自愈 ═══");
  let daemonPid = 0;
  {
    const descPath = path.join(dataDir, "work-service.json");
    writeServiceDescriptor(dataDir, {
      schema_version: 2,
      pid: 9999999, // 必然已退出的 pid：描述符成死指针（与 V07-01 ③ 同一造法）
      host: "127.0.0.1",
      port: 1,
      token: "deadbeef",
      started_at: "2026-09-22T00:00:00+08:00",
      url: "http://127.0.0.1:1",
    });
    const r = await call(doctorTool, { project_id: PROJECT });
    const service = r.json!.service as Record<string, unknown>;
    const descriptor = service.descriptor as Record<string, unknown>;
    check(descriptor.present === true && descriptor.pid_alive === false, "B 描述符在场但 pid 已死（pid_alive=false）");
    check(descriptor.stale === true && descriptor.pid === 9999999, "B 判为陈旧指针（stale=true，pid=9999999）");
    check(
      (service.problems as string[]).some((p) => p.includes("描述符陈旧")),
      "B 报因点名「描述符陈旧：pid 已退出」，并说明 heal=true 才动手",
    );
    check(fs.existsSync(descPath), "B 只读不变量：默认 doctor 不撤陈旧描述符（文件仍在）");
    const heal = service.heal as Record<string, unknown>;
    check(heal.requested === false && heal.attempted === false, "B 未请求自愈时 heal.attempted=false（默认只读）");

    // heal=true：走 V07-01 自愈（清死描述符 → 按需拉起独立写入服务 → 复探）
    const healed = await call(doctorTool, { project_id: PROJECT, heal: true });
    const hService = healed.json!.service as Record<string, unknown>;
    const hHeal = hService.heal as Record<string, unknown>;
    check(hHeal.requested === true && hHeal.attempted === true, "B heal=true 触发自愈（attempted=true）");
    check(
      hService.reachable === true && (hService.descriptor as Record<string, unknown>).pid_alive === true,
      `B 自愈后探活通过（${hHeal.note ?? ""}）`,
    );
    const live = readServiceDescriptor(dataDir);
    check(live !== null && live.pid !== 9999999 && pidAlive(live.pid), "B 死描述符被换成活服务（真拉起 daemon）");
    daemonPid = live === null ? 0 : live.pid;
  }
  // 收尾：杀掉自愈拉起的 daemon（硬杀留死指针，故顺手撤描述符复位夹具）
  if (daemonPid > 0 && daemonPid !== process.pid && pidAlive(daemonPid)) {
    process.kill(daemonPid);
  }
  await sleep(400);
  removeServiceDescriptor(dataDir);
  check(!fs.existsSync(path.join(dataDir, "work-service.json")), "B 夹具复位：daemon 已杀、描述符已撤");

  console.log("\n[verify] ═══ C doctor：服务活（真端口探活）═══");
  {
    const wh = createWorkHost(dataDir);
    const srv = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      void wh.handle(req, res, pathname).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const addr = srv.address() as { port: number; address: string };
    wh.publish(addr.port, addr.address);
    const r = await call(doctorTool, { project_id: PROJECT });
    const service = r.json!.service as Record<string, unknown>;
    const descriptor = service.descriptor as Record<string, unknown>;
    check(service.reachable === true, `C 真端口探活通过（${descriptor.url ?? ""}）`);
    check(
      descriptor.present === true && descriptor.pid_alive === true && descriptor.stale === false,
      "C 描述符新鲜（pid=本进程存活、stale=false）",
    );
    check(service.ok === true && (service.problems as string[]).length === 0, "C service 段判健康且无报因");
    wh.unpublish();
    srv.close();
  }
  await sleep(200);

  console.log("\n[verify] ═══ D doctor：基线有效性 ═══");
  {
    writeRegistry();
    fs.writeFileSync(designFile, DESIGN_CRLF, "utf8");
    fs.writeFileSync(planFile, PLAN_FIXTURE, "utf8");
    const activated = activateBaseline(
      PROJECT,
      {
        approved_by: "gpt-6",
        approval_basis: "用户已委派的技术设计职责（隔离夹具）",
        approval_kind: "delegated_technical_review",
      },
      dataDir,
    );
    check(activated.created === true, `D 夹具基线真激活（${activated.baseline.baseline_id}）`);
    const okRun = await call(doctorTool, { project_id: PROJECT });
    const okBaseline = okRun.json!.baseline as Record<string, unknown>;
    check(okBaseline.ok === true && okBaseline.source_changed_since_baseline === false, "D 源未变时基线有效（ok=true）");
    check(
      (okBaseline.revalidate as string[]).length === 0,
      "D 有效基线不带任何 revalidate 报因",
    );

    fs.writeFileSync(designFile, DESIGN_CRLF + "\r\n改动后新增一行（源在基线激活后变过）。\r\n", "utf8");
    const broken = await call(doctorTool, { project_id: PROJECT });
    const badBaseline = broken.json!.baseline as Record<string, unknown>;
    check(badBaseline.ok === false && badBaseline.source_changed_since_baseline === true, "D 源变后判失效（ok=false）");
    check(
      (badBaseline.revalidate as string[]).some((p) => p.includes("在基线激活后变过")),
      "D 报因点名「设计/施工图源在基线激活后变过」（与项目入口同一份判据）",
    );
    check(
      ((broken.json!.problems as string[]) ?? []).some((p) => p.startsWith("baseline: ")),
      "D 顶层 problems 汇总带 baseline 前缀（接手 agent 一眼看到是哪一环坏）",
    );
  }

  console.log("\n[verify] ═══ E doctor：迁移状态 ═══");
  const service = new WorkService({ dataDir });
  {
    const r = await call(doctorTool, { project_id: PROJECT });
    const migration = r.json!.migration as Record<string, unknown>;
    check(migration.migrated === false && (migration.problems as string[]).length > 0, "E 未迁移：ok=false 且点名报因");
    check(migration.latest_backup_id === null, "E 未迁移时没有迁移备份目录（latest_backup_id=null）");

    // 真写入一条事件（唯一写口），让项目真的进 v2
    await service.submit({
      schema_version: 2,
      project_id: PROJECT,
      change_id: "change-none",
      entity_id: "requirement:req-v0704",
      type: "requirement.registered",
      expected_revision: null,
      actor_id: "verify-v07-04",
      role: "coordinator",
      idempotency_key: "v0704-e-req-1",
      payload: {
        source: { kind: "user", ref: "verify-v07-04" },
        problem: "迁移状态验证",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      },
    });
    const migratedRun = await call(doctorTool, { project_id: PROJECT });
    const migrated = migratedRun.json!.migration as Record<string, unknown>;
    check(migrated.migrated === true && migrated.events_file_present === true, "E 真写入事件后判为已迁移");
    check(
      migrated.latest_backup_id === null && migrated.ok === false,
      "E 已迁移但无备份目录 → 如实报「回滚不可用」（不谎报健康）",
    );
    check(
      (migrated.problems as string[]).some((p) => p.includes("回滚不可用")),
      "E 报因点名「已迁移但没有迁移备份目录」",
    );
    // 备份目录在场（夹具只造目录，迁移本身要显式授权，不是 doctor 该做的事）
    fs.mkdirSync(path.join(workDir, "migration-backup", "2026-09-22T00-00-00-000Z"), { recursive: true });
    const withBackup = await call(doctorTool, { project_id: PROJECT });
    const m2 = withBackup.json!.migration as Record<string, unknown>;
    check(m2.latest_backup_id !== null && m2.ok === true, `E 备份在场 → 回滚可用（${m2.latest_backup_id}）`);
  }

  console.log("\n[verify] ═══ F 事件面缺口 ═══");
  {
    const surface = checkEventSurface();
    check(
      surface.ok && surface.covered === REGISTERED_EVENT_TYPES.length,
      `F 真实登记面全覆盖（注册 ${surface.covered} 种，工具面出口 ${surface.toolSurfaces.length} 条）`,
    );
    const r = await call(doctorTool, { project_id: PROJECT });
    const es = r.json!.event_surface as Record<string, unknown>;
    check(es.ok === true && es.registered === REGISTERED_EVENT_TYPES.length, "F doctor 报出事件面健康且计数与注册表一致");

    // 破坏性现场：抽走 rebind_task（真实检查器跑一份被抽掉工具的名单），doctor 必须点名缺口
    const sabotaged = createDoctorTool({
      checkEventSurface: () => checkEventSurface(TOOLS.map((t) => t.name).filter((n) => n !== "rebind_task")),
    });
    const broken = await call(sabotaged, { project_id: PROJECT });
    const bes = broken.json!.event_surface as Record<string, unknown>;
    check(bes.ok === false, "F 注入缺口的现场下 doctor 报事件面不健康");
    check(
      (bes.problems as string[]).some((p) => p.includes("task.rebound") && p.includes("出口名存实亡")),
      "F 报因点名 task.rebound 的触发工具已不在注册表（出口名存实亡）",
    );
    check(
      ((broken.json!.problems as string[]) ?? []).some((p) => p.startsWith("event_surface: ")),
      "F 顶层 problems 汇总带 event_surface 前缀",
    );
    // 唯一事实源：CLI 仍从 eventSurface.ts 读并给出同一结论（退出码 0）
    const cli = await runCli(path.join(REPO, "scripts", "check-event-surface.ts"));
    check(cli.code === 0, `F CLI check-event-surface 退出码 0（exit=${cli.code}）`);
    check(
      cli.out.includes(`注册事件 ${surface.covered} 种全数登记`),
      "F CLI 输出与 doctor 同一份计数（唯一事实源没分叉）",
    );

    // ── 2026-09-22 批外缺陷修复：反向 import 环已破（工具名单改登记式）──
    // 修前 `eventSurface.ts` 反向 `import { TOOLS } from mcp/tools/index`，与 `index → doctor → eventSurface`
    // 成环：**单独** import doctor.ts 会在 index.ts 求值到 `TOOLS = [... doctorTool ...]` 时撞 TDZ
    // （`Cannot access 'doctorTool' before initialization`）。这里用真子进程**先** import doctor.ts 来证伪。
    const probeDoctor = path.join(dataDir, "probe-doctor-first.ts");
    fs.writeFileSync(
      probeDoctor,
      probeSource("  console.log('PROBE_OK ' + (m.doctorTool && m.doctorTool.name)); process.exit(0);"),
      "utf8",
    );
    const doctorFirst = await runCli(probeDoctor, {
      TATAI_PROBE_MODULE: pathToFileURL(path.join(REPO, "src", "mcp", "tools", "doctor.ts")).href,
    });
    check(
      doctorFirst.code === 0 && doctorFirst.out.includes("PROBE_OK doctor"),
      `F 单独 import doctor.ts 不再撞 TDZ（exit=${doctorFirst.code}；输出 ${doctorFirst.out.trim().split("\n").pop() ?? ""}）`,
    );

    // 反向对照：只 import 事件面模块（拿不到工具名单）→ **如实报红**，不静默全绿
    const probeSurface = path.join(dataDir, "probe-eventsurface-only.ts");
    fs.writeFileSync(
      probeSurface,
      probeSource(
        [
          "  const registered = m.toolNameSourceRegistered();",
          "  const r = m.checkEventSurface();",
          "  console.log('PROBE_SURFACE ' + JSON.stringify({ registered, ok: r.ok, problems: r.problems.length, covered: r.covered, first_problem: r.problems[0] ?? null }));",
          "  process.exit(r.ok ? 0 : 2);",
        ].join("\n"),
      ),
      "utf8",
    );
    const surfaceOnly = await runCli(probeSurface, {
      TATAI_PROBE_MODULE: pathToFileURL(path.join(REPO, "src", "server", "work", "eventSurface.ts")).href,
    });
    check(
      surfaceOnly.code === 2 && surfaceOnly.out.includes('"registered":false') && surfaceOnly.out.includes("工具名单来源未登记"),
      `F 拿不到工具名单时检查**如实报红**而不是假绿（exit=${surfaceOnly.code}；输出 ${surfaceOnly.out.trim().slice(0, 160)}）`,
    );
    check(
      surfaceOnly.out.includes(`"covered":${REGISTERED_EVENT_TYPES.length}`),
      "F 报红时仍如实给出注册事件数（不是空壳结论）",
    );
  }

  console.log("\n[verify] ═══ G read_design 分段读：逐字节一致 ═══");
  {
    const full = await call(readDesignTool, { project_id: PROJECT });
    const design = full.json!.design as Record<string, unknown>;
    const raw = fs.readFileSync(designFile, "utf8");
    check(typeof design.content === "string" && design.content === raw, "G 全文读与原文件逐字节相同（兼容口径未变）");
    check(raw.includes("\r\n"), "G 夹具确为 CRLF（行尾是分段读最容易出错的地方）");

    const indexRun = await call(readDesignTool, { project_id: PROJECT, index: true });
    const idx = indexRun.json!.design as Record<string, unknown>;
    const sections = idx.sections as { path: string; line_start: number; line_end: number }[];
    check(idx.sha256 === sha256Hex(raw) && idx.lines === raw.split("\n").length, "G index 报全文行数与哈希");
    check(sections.length === buildSectionIndex(raw).length && sections.length >= 6, `G 章节索引列出 ${sections.length} 节`);

    // ① 按行分段（每段 3 行）拼回去
    const totalLines = raw.split("\n").length;
    let byRange = "";
    for (let start = 1; start <= totalLines; start += 3) {
      const end = Math.min(start + 2, totalLines);
      const chunk = await call(readDesignTool, { project_id: PROJECT, range: { from_line: start, to_line: end } });
      const d = chunk.json!.design as Record<string, unknown>;
      const slice = chunk.json!.slice as Record<string, unknown>;
      byRange += d.content as string;
      if (start === 1) {
        check(slice.line_start === 1 && slice.line_end === end, "G range 回执带行范围与切片元信息");
      }
    }
    check(byRange === raw, "G range 分段拼接后与全文逐字节一致（含 CRLF）");
    check(sha256Hex(byRange) === idx.sha256, "G 拼接结果哈希 == index 报的全文哈希（自证没漏字节）");

    // ② 按章节分段拼回去（章节口径来自 buildSectionIndex，覆盖全文所有行）
    let bySection = "";
    for (const s of sections) {
      const chunk = await call(readDesignTool, { project_id: PROJECT, section: s.path });
      const slice = chunk.json!.slice as Record<string, unknown>;
      const info = slice.section as Record<string, unknown>;
      bySection += (chunk.json!.design as Record<string, unknown>).content as string;
      if (info.line_start !== s.line_start || info.line_end !== s.line_end) {
        check(false, `G 章节 ${s.path} 的行范围与索引不一致`);
      }
    }
    check(bySection === raw, "G 章节分段拼接后与全文逐字节一致");
    // 单节自证：读「2 方案」这一节的切片必须等于原文件对应行（按"行数组 + 换行"另写一份取法，不复用实现里的偏移算法）
    const one = await call(readDesignTool, { project_id: PROJECT, section: "2 方案" });
    const oneSlice = one.json!.slice as Record<string, unknown>;
    const expected = sectionTextOf(raw, oneSlice.line_start as number, oneSlice.line_end as number);
    check(
      (one.json!.design as Record<string, unknown>).content === expected &&
        oneSlice.sha256 === sha256Hex(expected),
      `G 单节切片与原文件对应行逐字节相同（${oneSlice.line_start}-${oneSlice.line_end}，sha256 对得上）`,
    );
    // 标题路径同样可选中同一节（路径含文档 H1 前缀，故从索引里取真实路径来读）
    const subPath = sections.find((s) => s.path.endsWith("2.1 细则"))!.path;
    const byPath = await call(readDesignTool, { project_id: PROJECT, section: subPath });
    const byPathSlice = byPath.json!.slice as Record<string, unknown>;
    check(
      byPathSlice !== undefined &&
        (byPathSlice.section as Record<string, unknown>).path === subPath &&
        sectionTextOf(raw, byPathSlice.line_start as number, byPathSlice.line_end as number) ===
          (byPath.json!.design as Record<string, unknown>).content,
      `G 标题路径可以精确定位到子节（${subPath}）`,
    );
    // 负例：章节点名；section+range 同给拒绝
    const miss = await call(readDesignTool, { project_id: PROJECT, section: "9 不存在的章节" });
    check(miss.isError && miss.text.includes("没有章节"), "G 不存在的章节点名拒绝并带候选（miss.isError）");
    const both = await call(readDesignTool, { project_id: PROJECT, section: "2 方案", range: { from_line: 1, to_line: 2 } });
    check(both.isError, "G section 与 range 同给一律拒（读哪一段必须唯一）");
    const oob = await call(readDesignTool, { project_id: PROJECT, range: { from_line: 1, to_line: totalLines + 100 } });
    check(oob.isError && oob.text.includes("超过文档末行"), "G 行范围越界点名拒绝");

    // ③ 真 DESIGN.md（塔台自身设计书）：大文件上同样逐字节一致
    const realFull = await call(readDesignTool, { project_id: "tatai" });
    const realRaw = fs.readFileSync(path.join(REPO, "DESIGN.md"), "utf8");
    check(
      (realFull.json!.design as Record<string, unknown>).content === realRaw,
      "G 真 DESIGN.md 全文读逐字节相同（只读）",
    );
    const realIndex = await call(readDesignTool, { project_id: "tatai", index: true });
    const realSections = (realIndex.json!.design as Record<string, unknown>).sections as {
      path: string;
      line_start: number;
      line_end: number;
    }[];
    let realConcat = "";
    // 只抽 3 节（含首节与末节）——大文件全节连读会拖长验证时间，抽样已能覆盖"跨节首尾相接"
    const sampled = [realSections[0], realSections[Math.floor(realSections.length / 2)], realSections[realSections.length - 1]];
    for (const s of sampled) {
      const chunk = await call(readDesignTool, { project_id: "tatai", section: s.path });
      realConcat += (chunk.json!.design as Record<string, unknown>).content as string;
    }
    const expectedConcat = sampled
      .map((s) => sectionTextOf(realRaw, s.line_start, s.line_end))
      .join("");
    check(
      realConcat === expectedConcat,
      `G 真 DESIGN.md 抽样 ${sampled.length} 节（含首末节）与原文件对应行逐字节相同`,
    );
  }

  console.log("\n[verify] ═══ H manage_change op=open 省略批次号：形态 + 幂等 ═══");
  {
    // 转接客户端只用到 submit——按 verification 惯例给最小桩（真校验/真仲裁仍在 WorkService 里跑）
    const ctx = {
      clientName: "verify-v0704",
      work: { submit: (cmd: unknown) => service.submit(cmd) },
    } as unknown as McpContext;
    const baseEventCount = eventCount();
    const baseBatches = Object.keys(readChanges(workDir).changes).length;
    const openArgs = {
      op: "open",
      project_id: PROJECT,
      role: "coordinator",
      goal: "自动批次号验证",
      authorized_scope: "仅本夹具",
      target_baseline: { baseline_id: null, design_revision: "0".repeat(64), plan_revision: "1".repeat(64) },
      affected_subsystems: ["夹具"],
      exit_criteria: "验证全绿",
    };
    const first = await call(manageChangeTool, openArgs, ctx);
    const baseEvents = baseEventCount;
    const batchId = first.json!.change_batch_id as string;
    check(first.json!.ok === true && typeof batchId === "string", `H 省略批次号即开成（回执报出 ${batchId}）`);
    check(/^change-\d{8}-[0-9a-f]{8}$/.test(batchId), "H 形态是 change-<日期>-<摘要>");
    check(CHANGE_ID_RE.test(batchId), "H 生成的 id 过 CHANGE_ID_RE");
    const afterFirst = readChanges(workDir);
    check(afterFirst.changes[batchId] !== undefined, "H 读回投影里批次已成立");
    check(eventCount() === baseEvents + 1, `H 事件恰多 1 条（change.opened，总 ${eventCount()}）`);

    const retry = await call(manageChangeTool, openArgs, ctx);
    const receipts = retry.json!.receipts as { duplicate?: boolean; event_id?: string }[];
    check(retry.json!.change_batch_id === batchId, "H 重试得到同一个批次号（稳定 id）");
    check(receipts[0]?.duplicate === true, "H 重试由幂等键仲裁：回原回执（duplicate=true），不产生第二次效果");
    check(
      eventCount() === baseEvents + 1 && Object.keys(readChanges(workDir).changes).length === baseBatches + 1,
      "H 重试没有开出第二个批次、事件数不变（幂等真的成立）",
    );

    const other = await call(manageChangeTool, { ...openArgs, goal: "另一个目标的批次" }, ctx);
    const otherId = other.json!.change_batch_id as string;
    check(otherId !== batchId && CHANGE_ID_RE.test(otherId), "H 内容不同的请求得到不同批次号（不是恒等 id）");

    const explicit = await call(manageChangeTool, { ...openArgs, change_batch_id: "change-explicit-v0704" }, ctx);
    check(
      explicit.json!.change_batch_id === "change-explicit-v0704" &&
        readChanges(workDir).changes["change-explicit-v0704"] !== undefined,
      "H 显式给批次号的口径未被改动（兼容）",
    );
    const badType = await call(manageChangeTool, { ...openArgs, change_batch_id: 42 }, ctx);
    check(
      badType.isError && badType.text.includes("必须是字符串"),
      "H 批次号给错类型不会被当成「没给」（拒，不静默生成）",
    );
  }

  // ── 收尾 ──
  const leftover = readServiceDescriptor(dataDir);
  if (leftover !== null && leftover.pid !== process.pid && pidAlive(leftover.pid)) {
    try {
      process.kill(leftover.pid);
    } catch {
      /* 尽力而为 */
    }
  }
  await sleep(300);
  if (process.env.TATAI_KEEP_TMP !== "1") {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log("[verify] 已清理隔离夹具目录（TATAI_KEEP_TMP=1 可保留现场）");
  }
  const fail = results.filter(([ok]) => !ok).length;
  console.log(`\n[verify] V07-04 结果：${results.length - fail} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

/** 跑一次 CLI（真子进程），返回退出码与合并输出；`env` 可加探针用的环境变量 */
function runCli(entry: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const tsx = (() => {
    try {
      return pathToFileURL(require.resolve("tsx")).href;
    } catch {
      return "tsx";
    }
  })();
  const child: ChildProcess = spawn(process.execPath, ["--import", tsx, entry], {
    env: { ...process.env, TATAI_HOME: dataDir, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout?.on("data", (c) => (out += String(c)));
  child.stderr?.on("data", (c) => (out += String(c)));
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: -1, out }), 30_000);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

/** 子进程探针源码：**动态** import 一个模块 URL 再执行 probe（探针文件在隔离目录里，不进仓库） */
function probeSource(probeBody: string): string {
  return [
    "// 由 verify-v07-04 生成的子进程探针：模块 URL 走环境变量，探针文件不进仓库",
    "const target = process.env.TATAI_PROBE_MODULE;",
    "import(target).then((m) => {",
    probeBody,
    "}).catch((e) => { console.error('PROBE_THREW ' + (e && e.message ? e.message : String(e))); process.exit(1); });",
    "",
  ].join("\n");
}

main().catch((e) => {
  console.error("[verify] 运行失败：", e);
  process.exit(1);
});
