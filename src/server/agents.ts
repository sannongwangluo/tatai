// M4 agent 登记层（PLAN.md M4，DESIGN.md §3.1 左栏上半「Agent 管理」数据源）。
// 口径：任一 agent 首次调用任一 MCP 工具时登记——名字取 initialize 握手自报的
// clientInfo.name（拿不到记 "unknown"）；数据落【全局数据目录】<TATAI_HOME>/agents.json
// （§8.1 第一层），不进任何被纳管项目、不进仓库。MCP 侧触发写入（src/mcp/server.ts
// CallTool 分发处统一挂钩），HTTP 侧读取（GET /api/agents），两边共用本模块。
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./fileLock";
import { resolveDataDir } from "./registry";
import { nowIso, compareIsoTime } from "./time";
import { WsError } from "./workstation";

/** agent 登记记录（§2.3 之外的轻量全局数据，M4 新增） */
export interface AgentRecord {
  /** 稳定标识：name slug 化，冲突时加短后缀 */
  id: string;
  /** MCP 客户端自报名（clientInfo.name），显示用 */
  name: string;
  /** 首次登记时间（本地时间 ISO，带时区偏移） */
  first_seen_at: string;
  /** 最近一次工具调用时间（左栏"最近活跃"即此字段） */
  last_active_at: string;
}

/** agents.json 顶层结构 */
export interface AgentStore {
  version: 1;
  agents: AgentRecord[];
}

const AGENTS_FILE = "agents.json";

export function agentsPath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, AGENTS_FILE);
}

function validateStore(raw: unknown): AgentStore {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("agents.json 顶层必须是对象");
  }
  const store = raw as AgentStore;
  if (store.version !== 1) throw new Error(`不支持的 version: ${store.version}`);
  if (!Array.isArray(store.agents)) throw new Error("agents 必须是数组");
  for (const a of store.agents) {
    if (typeof a.id !== "string" || typeof a.name !== "string") {
      throw new Error("agents 条目缺 id/name");
    }
  }
  return store;
}

/**
 * 读登记表；文件不存在返回空表（读路径不落盘——GET /api/agents 是纯只读）。
 * Q63（2026-09-18 审计）：坏文件此前直接抛裸 Error——HTTP 侧落 500 INTERNAL（错误码含糊、
 * 界面只有红字且"刷新永远不会好"），MCP 侧整段静默吞。现在解析/校验失败一律转成结构化的
 * `AGENTS_JSON_CORRUPT`（HTTP 侧带可操作文案），读路径仍然**不落盘、不猜内容**：
 * 真正把它修好的是下面的 registerAgentActivity（写路径改名留档后重建）。
 */
export function readAgents(dataDir: string = resolveDataDir()): AgentStore {
  const file = agentsPath(dataDir);
  if (!fs.existsSync(file)) return { version: 1, agents: [] };
  const text = fs.readFileSync(file, "utf8");
  try {
    return validateStore(JSON.parse(text));
  } catch (e) {
    throw new WsError(
      "AGENTS_JSON_CORRUPT",
      `全局数据目录下的 agents.json 读不出来（${(e as Error).message}）：` +
        "删掉这一份即可——任一 agent 下次调用 MCP 工具时会自动重建登记表（塔台不猜、不改坏文件）",
    );
  }
}

/** 原子写登记表：先写临时文件再 rename，防半截文件（与 registry 同一惯例） */
function writeAgents(store: AgentStore, dataDir: string = resolveDataDir()): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = agentsPath(dataDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** name → slug 作 id 基础；清不出字符时退化为 "agent" */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "agent" : slug;
}

/**
 * 登记一次 agent 活动（任一 MCP 工具被调即记）：
 * 同名已有 → 只刷 last_active_at；新名字 → 新增条目（id = slug，冲突加短后缀）。
 * Q23（2026-09-18 审计）：读—改—写整段进跨进程锁。本函数在**每次 MCP 工具调用**都跑，
 * 而 HTTP 侧只读、多 agent 各有自己的 MCP 进程——无锁时后写的进程会拿旧表覆盖掉对方刚登记的
 * 名字（丢登记）与刚刷新的 last_active_at（时间回退）。
 * Q63（2026-09-18 审计）：agents.json 坏了要有**修复分支**——此前读侧裸抛、写侧被静默吞，
 * 登记永久失效且全仓无处可修。现在这里（写路径）把坏文件**改名留档**（不删、不猜内容）后从空表重建：
 * 登记表是纯派生数据（每个 agent 下次调用工具就会重新登记），所以"留档 + 重建"不丢信息，
 * 而读路径（GET /api/agents）保持只读，只报 AGENTS_JSON_CORRUPT + 可操作文案。
 */
export function registerAgentActivity(
  name: string,
  dataDir: string = resolveDataDir(),
): AgentRecord {
  const trimmed = name.trim() === "" ? "unknown" : name.trim();
  return withFileLock(agentsPath(dataDir), () => {
    let store: AgentStore;
    try {
      store = readAgents(dataDir);
    } catch (e) {
      if (!(e instanceof WsError) || e.code !== "AGENTS_JSON_CORRUPT") throw e;
      const file = agentsPath(dataDir);
      const quarantine = `${file}.corrupt.${Date.now()}`;
      fs.renameSync(file, quarantine); // 留档：内容一个字不改，只是换个名字
      console.warn(
        `[agents] agents.json 损坏，已留档为 ${path.basename(quarantine)} 并从空表重建（agent 会随工具调用重新登记）`,
      );
      store = { version: 1, agents: [] };
    }
    const now = nowIso();
    const existing = store.agents.find((a) => a.name === trimmed);
    if (existing) {
      existing.last_active_at = now;
      writeAgents(store, dataDir);
      return existing;
    }
    let id = slugify(trimmed);
    if (store.agents.some((a) => a.id === id)) {
      id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const record: AgentRecord = {
      id,
      name: trimmed,
      first_seen_at: now,
      last_active_at: now,
    };
    store.agents.push(record);
    writeAgents(store, dataDir);
    return record;
  });
}

/** 列表：按 last_active_at 倒序（最近活跃在前，左栏展示口径） */
export function listAgents(dataDir: string = resolveDataDir()): AgentRecord[] {
  // 时间串可能来自不同偏移（含外部/跨机写入的 agents.json）：按真实时刻倒序，非法/缺失排最后。
  return [...readAgents(dataDir).agents].sort((a, b) =>
    compareIsoTime(b.last_active_at, a.last_active_at),
  );
}
