// V09-22 返工 · 源码版 stdio MCP 验证脚本（tsx 跑）。
//
// 用途：对**源码版** stdio MCP（`node --import tsx src/mcp/index.ts`，隔离 TATAI_HOME）做正式回归留档——
// 补齐上一轮 13 PASS/1 FAIL 的手工检查未落脚本的问题，并覆盖本轮返工新能力（F4 by_origin 可见/底层两口径、
// F5 顶层 collection 结构化采集完整性）。
//
// 用法：`pnpm verify:v09-22-mcp`（package.json 的脚本条目由协调器统一添加；本脚本自身**不改** package.json、
// 不跑别的脚本、不提交）。
//
// 隔离口径（AGENTS.md §5）：全流程**不碰真实 ~/.tatai、不写真实项目**——
//   · mkdtemp 两个系统 tmp 目录：一个当隔离 TATAI_HOME（registry.json 落这里），一个放夹具项目源码；
//   · spawn 子进程时 env 里清掉全部既有 `TATAI_*` 变量、只设 `TATAI_HOME=<隔离目录>`；cwd = 仓库根；
//   · 夹具项目：20 个顶层目录（mod01…mod20）各一个 .ts 文件，mod02 起 import 前一个目录的模块造出边；
//     用 `parseDirectory` 真扫出 modules.json 落到夹具项目 `.工作台/arch/modules.json`，再 `addProject` 登记进隔离 home；
//   · 收尾：子进程 kill、tmp 目录 rmSync 自清（finally），不留测试残留。
//
// 断言值来源：`counts.by_origin.code=14` / `counts.by_origin_underlying.code=20` / `counts.hidden_members=6`
// 均由**夹具 20 个顶层目录推导**（概览 15 节点＝14 真实实体＋1 个 `__more__` 聚合占位；隐藏 20−14=6），
// **不是**塔台真实项目实测值。
//
// 退出码：0 = 全部 PASS；1 = 有 FAIL。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDirectory } from "../src/arch/parse";
import { addProject } from "../src/server/registry";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_ENTRY = path.join(ROOT, "src", "mcp", "index.ts");

// ─────────────────────────────── 断言账目（ok() 风格，沿用 verify-v09-22） ───────────────────────────────
let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else fails.push(label);
};
const info = (msg: string): void => console.log(`[verify]   ${msg}`);

// ─────────────────────────────── 夹具目录（系统 tmp，收尾自清） ───────────────────────────────
const CLEANUP: string[] = [];
const mkTmp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `v0922-mcp-${tag}-`));
  CLEANUP.push(dir);
  return dir;
};

// ─────────────────────────────── MCP stdio JSON-RPC 客户端（沿用 verify-mcp-reconnect-retest 的 framing） ───────────────────────────────
interface RpcMsg {
  id?: number;
  result?: {
    serverInfo?: { name?: string; version?: string };
    tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  error?: unknown;
}

// ─────────────────────────────── 六图返回体的最小收窄形状（只取本脚本要断言的字段） ───────────────────────────────
interface ByOrigin {
  code: number;
  plan: number;
  chat: number;
}
interface GraphCounts {
  nodes: number;
  edges: number;
  underlying_nodes: number;
  hidden_members: number;
  by_origin?: ByOrigin;
  by_origin_underlying?: ByOrigin;
}
interface GraphPayload {
  mode?: string;
  counts: GraphCounts;
  nodes: { id: string }[];
  edges: { from: string; to: string }[];
}
interface Snapshot {
  snapshot_id: string;
  collection?: {
    status?: string;
    budget_exhausted?: boolean | null;
    ignored_dir_segments?: string[];
  };
  graphs?: Partial<Record<string, GraphPayload>>;
  completeness: {
    complete: boolean;
    incomplete: boolean;
    cursor: string | null;
    cursors: Partial<Record<string, string>>;
  };
}

const REQUEST_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  // ── 夹具项目：20 个顶层目录（mod01…mod20），mod02 起 import 前一个目录的模块 ──
  const isoHome = mkTmp("home");
  const projDir = mkTmp("proj");
  const TOPS = 20;
  for (let i = 1; i <= TOPS; i++) {
    const top = path.join(projDir, `mod${String(i).padStart(2, "0")}`);
    fs.mkdirSync(top, { recursive: true });
    const prev = `mod${String(i - 1).padStart(2, "0")}`;
    fs.writeFileSync(
      path.join(top, "a.ts"),
      i > 1 ? `import { a as prev } from "../${prev}/a";\nexport const a = ${i};\n` : `export const a = ${i};\n`,
      "utf8",
    );
  }
  // 真扫出 modules.json 并落盘到夹具项目 .工作台/arch/modules.json（parseDirectory 返回的 file 直接写盘）
  const parsed = parseDirectory(projDir);
  const archDir = path.join(projDir, ".工作台", "arch");
  fs.mkdirSync(archDir, { recursive: true });
  fs.writeFileSync(path.join(archDir, "modules.json"), JSON.stringify(parsed.file), "utf8");
  info(`夹具：${TOPS} 个顶层目录 → ${parsed.file.modules.length} 个模块（edges=${parsed.file.modules.reduce((n, m) => n + m.deps.length, 0)}）；隔离 home=${isoHome}`);
  // 登记进隔离 home（不碰真实 ~/.tatai）
  addProject({ id: "v0922mcp", name: "V09-22 MCP 夹具", path: projDir, kind: "backend" }, isoHome);

  // ── spawn 源码版 stdio MCP（隔离 env：清掉全部既有 TATAI_*，只留 TATAI_HOME=isoHome） ──
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("TATAI_")) delete env[k];
  env.TATAI_HOME = isoHome;
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], { cwd: ROOT, env });

  let stderrBuf = "";
  child.stderr.on("data", (d: Buffer) => {
    stderrBuf += d.toString("utf8");
  });
  child.on("error", (e) => {
    stderrBuf += `[spawn error] ${e.message}\n`;
  });

  let buf = "";
  const pending = new Map<number, (msg: RpcMsg) => void>();
  let idc = 0;
  const send = (method: string, params: unknown): Promise<RpcMsg> =>
    new Promise((resolve, reject) => {
      const id = ++idc;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`请求超时 ${REQUEST_TIMEOUT_MS}ms：${method}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method: string, params: unknown): void => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: RpcMsg;
      try {
        msg = JSON.parse(line) as RpcMsg;
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });

  /** tools/call 原始文本 + isError（isError 不抛，交给调用方按需断言） */
  const callRaw = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const r = await send("tools/call", { name, arguments: args });
    if (r.error) return { text: JSON.stringify(r.error), isError: true };
    const text = r.result?.content?.[0]?.text ?? "";
    return { text, isError: r.result?.isError === true };
  };
  /** tools/call 并解析 JSON（isError 时抛，供正常路径用） */
  const callJson = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { text, isError } = await callRaw(name, args);
    if (isError) throw new Error(`${name} isError：${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  };

  // ═════════════════════ 1. initialize 握手 ═════════════════════
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-v09-22-mcp", version: "1.0" },
  });
  notify("notifications/initialized", {});
  ok(
    init.error === undefined && typeof init.result?.serverInfo?.name === "string" && init.result.serverInfo.name !== "",
    `initialize 握手成功（serverInfo.name=${init.result?.serverInfo?.name ?? "(空)"}）`,
  );

  // ═════════════════════ 2. tools/list ═════════════════════
  const list = await send("tools/list", {});
  const tools = list.result?.tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  ok(tools.length >= 19, `tools/list 暴露 ${tools.length} 个工具（≥19）`);
  ok(names.has("get_project_graphs") && names.has("project_entry"), "tools/list 含 get_project_graphs 与 project_entry");

  // ═════════════════════ 3. get_project_graphs full 首页（module_map, limit=7） ═════════════════════
  const first = (await callJson("get_project_graphs", {
    project_id: "v0922mcp",
    graph: "module_map",
    mode: "full",
    limit: 7,
  })) as Snapshot;
  ok(typeof first.snapshot_id === "string" && first.snapshot_id !== "", `结果文本可 JSON.parse 且带 snapshot_id（${first.snapshot_id}）`);
  ok(first.completeness.incomplete === true, "full limit=7 首页 incomplete===true（不静默截断）");
  ok(typeof first.completeness.cursors.module_map === "string", `completeness.cursors.module_map 在场（${first.completeness.cursors.module_map ?? "(无)"}）`);

  // ═════════════════════ 4. 顶层 collection 字段在场（F5 新能力） ═════════════════════
  const coll = first.collection;
  ok(coll?.status === "complete", `collection.status==="complete"（实际 ${coll?.status ?? "(缺)"}）`);
  ok(coll?.budget_exhausted === false, `collection.budget_exhausted===false（实际 ${String(coll?.budget_exhausted)}）`);
  ok(
    Array.isArray(coll?.ignored_dir_segments) && coll.ignored_dir_segments.includes("node_modules"),
    `collection.ignored_dir_segments 含 "node_modules"（${(coll?.ignored_dir_segments ?? []).slice(0, 4).join("、")}…）`,
  );

  // ═════════════════════ 5. 同快照游标把 module_map/full 分页取完 ═════════════════════
  const firstUnderlying = first.graphs?.module_map?.counts.underlying_nodes;
  const nodeIds = new Set<string>();
  const seenSnapshots = new Set<string>([first.snapshot_id]);
  for (const n of first.graphs?.module_map?.nodes ?? []) nodeIds.add(n.id);
  let complete = first.completeness.complete === true;
  let cursor: string | null = first.completeness.cursors.module_map ?? first.completeness.cursor ?? null;
  let pages = 1;
  let guard = 0;
  while (!complete && cursor !== null && guard++ < 200) {
    const page = (await callJson("get_project_graphs", {
      project_id: "v0922mcp",
      graph: "module_map",
      mode: "full",
      limit: 7,
      cursor,
    })) as Snapshot;
    pages += 1;
    seenSnapshots.add(page.snapshot_id);
    for (const n of page.graphs?.module_map?.nodes ?? []) nodeIds.add(n.id);
    complete = page.completeness.complete === true;
    cursor = page.completeness.cursors.module_map ?? page.completeness.cursor ?? null;
  }
  ok(complete, `同快照游标续取到 complete===true（共 ${pages} 页）`);
  ok(firstUnderlying === TOPS, `首页 counts.underlying_nodes===${TOPS}（实际 ${String(firstUnderlying)}）`);
  ok(nodeIds.size === firstUnderlying, `分页累计节点 id 去重后数量 == 首页 underlying_nodes（${nodeIds.size} / ${String(firstUnderlying)}）`);
  ok(seenSnapshots.size === 1, `每页 snapshot_id 相同（${[...seenSnapshots].join("、")}）`);

  // ═════════════════════ 6. overview 调一次：by_origin / by_origin_underlying / hidden_members ═════════════════════
  const ov = (await callJson("get_project_graphs", {
    project_id: "v0922mcp",
    graph: "module_map",
    mode: "overview",
  })) as Snapshot;
  const oc = ov.graphs?.module_map?.counts;
  // 夹具推导：20 目录 → 概览 15 节点（14 真实 + 1 个 __more__ 聚合占位）→ by_origin.code=14、hidden_members=20-14=6
  ok(oc?.by_origin?.code === 14, `overview counts.by_origin.code===14（可见真实实体；__more__ 占位不计；实际 ${String(oc?.by_origin?.code)}）`);
  ok(oc?.by_origin_underlying?.code === 20, `overview counts.by_origin_underlying.code===20（底层未聚合并集；实际 ${String(oc?.by_origin_underlying?.code)}）`);
  ok(oc?.hidden_members === 6, `overview counts.hidden_members===6（20−14；实际 ${String(oc?.hidden_members)}）`);

  // ═════════════════════ 7. 跨模式游标拒绝 ═════════════════════
  const ovCursor = ov.completeness.cursor ?? ov.completeness.cursors.module_map ?? `${ov.snapshot_id}:overview:module_map:0`;
  const crossMode = await callRaw("get_project_graphs", {
    project_id: "v0922mcp",
    graph: "module_map",
    mode: "full",
    cursor: ovCursor,
  });
  ok(
    crossMode.isError || /快照|模式|snapshot|mode/.test(crossMode.text),
    `overview 游标传 full 被拒（isError=${crossMode.isError}；文本 ${crossMode.text.slice(0, 60)}…）`,
  );

  // ═════════════════════ 8. 游标措辞探针（修正上轮只找中文「游标」的断言缺陷） ═════════════════════
  const gpTool = tools.find((t) => t.name === "get_project_graphs");
  const props = gpTool?.inputSchema?.properties as Record<string, { description?: string }> | undefined;
  const combined = `${gpTool?.description ?? ""}\n${props?.cursor?.description ?? ""}`;
  ok(/cursor|游标/.test(combined), "get_project_graphs description 与其 cursor 描述合并文本 matches /cursor|游标/");

  // ═════════════════════ 9. project_entry：graph_summary 在场且 next_read_entry 指向 full ═════════════════════
  const entryRaw = await callRaw("project_entry", { project_id: "v0922mcp", role: "executor" });
  const entry = JSON.parse(entryRaw.text) as {
    graph_summary?: { next_read_entry?: { args?: { mode?: string } } };
  };
  ok(!entryRaw.isError && entryRaw.text.includes("graph_summary"), "project_entry 返回文本含 graph_summary");
  ok(
    entry.graph_summary?.next_read_entry?.args?.mode === "full",
    `graph_summary.next_read_entry.args.mode==="full"（实际 ${String(entry.graph_summary?.next_read_entry?.args?.mode)}）`,
  );

  // ── 收尾：子进程 kill ──
  try {
    child.stdin.end();
  } catch {
    /* 已关闭则忽略 */
  }
  child.kill();

  if (fails.length > 0 && stderrBuf.trim() !== "") info(`子进程 stderr（末 400 字）：${stderrBuf.slice(-400)}`);
}

(async () => {
  try {
    await main();
  } catch (e) {
    ok(false, `脚本异常中止：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // 夹具自清（只删本脚本在系统 tmp 下自建的目录，不碰来历不明的文件）
    for (const dir of CLEANUP) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清不掉不阻塞结论 */
      }
    }
    const leftovers = CLEANUP.filter((d) => fs.existsSync(d));
    console.log(`[verify] 夹具清理：${CLEANUP.length} 个 tmp 目录，残留 ${leftovers.length} 个`);
    console.log(`MCP stdio V09-22 返工 ${pass} PASS / ${fails.length} FAIL`);
    for (const f of fails) console.log(`[verify]   FAIL ${f}`);
    if (fails.length > 0) process.exitCode = 1;
  }
})();
