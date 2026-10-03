// 外部执行的回执协议、受控启动配置与中断恢复核对（PLAN.md V06-11；DESIGN.md §5.4、§6.5–§6.7）。
//
// 五条硬口径（每条在代码里都有落点，别混）：
//   ① **塔台只记协作事实，不拉起进程**：本模块**不 spawn 任何东西**——外部协调器（Claude Code 等）
//      负责启动/终止执行进程与目录隔离（§6.5）。这里产出的是**启动计划**（argv 数组 + cwd + 超时）
//      和**回执协议**，执行与终止都在塔台之外发生。故本仓不新增第二套 worker / 调度中心。
//   ② **外部命令模板来自受控配置**：argv 只从受控配置的**数组模板**渲染，占位符白名单校验；
//      调用方给**字符串命令**（例如从模型回答里抄来的命令行）一律拒收 `COMMAND_FROM_TEXT_REJECTED`（§6.5）。
//   ③ **未配置客户端/缺凭据 = 不可启动**：`resolveStartable` 明确返回 `CLIENT_NOT_CONFIGURED` /
//      `CLIENT_UNAVAILABLE` / `CREDENTIAL_MISSING` 与缺什么，**不替用户换一个服务顶上**（§6.5）。
//   ④ **无心跳 ≠ 已停止**：心跳缺失/超期只把运行现场判成 `unknown`（`NO_HEARTBEAT_NOTE` 逐字在场）；
//      只有带确认依据的 `execution.stopped` 才算已停止。停止未确认时**不往同一个可写目录派新执行**
//      （`dispatchGuard` 给出 `STOP_NOT_CONFIRMED_SAME_WORKSPACE` 并把新 attempt 落到隔离目录）。
//   ⑤ **外部动作先声明后确认**：动作前记 `effect_id` + 目标 + 授权 + 核实方法（`effect_declared`），
//      动作后回执关联实际结果标识（`effect_confirmed`）；恢复时**先查询实际效果**，查不清就标
//      `unverifiable` 并**暂停该动作的自动重试**，不盲重放（§5.4「已发生但回执未落盘」）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProject, listProjects } from "../registry";
import { nowIso, latestByTime, compareIsoTime } from "../time";
import { projectWorkDir } from "../workstation";
import {
  claimRecordsOf,
  defaultWorkspace,
  liveClaimRecord,
  readClaimEvents,
  type ClaimSubmitter,
} from "./claims";
import { loadEvents } from "./eventStore";
import { readTaskStates } from "./tasks";
import {
  SCHEMA_VERSION,
  WorkError,
  isWorkError,
  type WorkCommand,
  type WorkErrorCode,
  type WorkEvent,
  type WorkReceipt,
} from "./types";

// ── 事件词表（实体 `execution:<execution_id>`） ──
//
// 五类必备事件（§6.5「上报执行/保存检查点/提交结果」+ 卡面契约的 启动/心跳/检查点/停止/交付）
// 再加"外部动作先声明后确认"的三个与一条失败回执，共十一个。
// **2026-09-20 父代理裁定**：本词表已并入 `types.ts#REGISTERED_EVENT_TYPES`（登记面=能力发现，
// `service.info().registered_event_types` 里能看到这 11 个）；`verify-v06-09` 的 ④-2 断言
// 已按新事实改成"四个模块词表的并集"（判据仍是恰好相等）。

export const EXECUTION_EVENT_TYPES = [
  "execution.start_requested",
  "execution.started",
  "execution.heartbeat",
  "execution.checkpoint",
  "execution.stop_requested",
  "execution.stopped",
  "execution.failed",
  "execution.effect_declared",
  "execution.effect_confirmed",
  "execution.effect_unverified",
  "execution.delivered",
] as const;
export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

export const EXECUTION_ENTITY_PREFIX = "execution:";
export const executionEntityId = (executionId: string): string => `${EXECUTION_ENTITY_PREFIX}${executionId}`;
export const executionIdOfEntity = (entityId: string): string | null =>
  entityId.startsWith(EXECUTION_ENTITY_PREFIX) ? entityId.slice(EXECUTION_ENTITY_PREFIX.length) : null;

/**
 * 运行现场状态（DESIGN.md §5.4「运行现场」维度逐字：启动请求中/运行中/等待输入/停止请求中/已停止/失联/已结束）。
 * `unreachable`（失联）是**观测结论**，不是执行器自报状态，由 `livenessOf` 派生。
 */
export const RUN_SITE_STATES = [
  "start_requested",
  "running",
  "awaiting_input",
  "stop_requested",
  "stopped",
  "unreachable",
  "ended",
] as const;
export type RunSiteState = (typeof RUN_SITE_STATES)[number];

export const RUN_SITE_LABELS: Readonly<Record<RunSiteState, string>> = {
  start_requested: "启动请求中",
  running: "运行中",
  awaiting_input: "等待输入",
  stop_requested: "停止请求中",
  stopped: "已停止",
  unreachable: "失联",
  ended: "已结束",
};

/** 故障恢复顺序（DESIGN.md §5.4 逐字七步；`planRecovery` 按这个顺序出场） */
export const RECOVERY_STEPS = [
  "read_last_checkpoint",
  "query_effect",
  "old_run_write_possible",
  "worktree_baseline",
  "result_evidence_validity",
  "stale_claim",
  "new_attempt",
  "continue",
] as const;
export type RecoveryStep = (typeof RECOVERY_STEPS)[number];

export const RECOVERY_STEP_LABELS: Readonly<Record<RecoveryStep, string>> = {
  read_last_checkpoint: "读最后检查点",
  query_effect: "查询外部动作的实际效果",
  old_run_write_possible: "确认旧 run 是否仍有写入可能",
  worktree_baseline: "核对当前工作树与基线",
  result_evidence_validity: "判断哪些成果/证据仍有效",
  stale_claim: "处理旧认领（隔离目录或确认失效）",
  new_attempt: "为剩余工作建立新 attempt",
  continue: "继续",
};

/** 心跳语义的**唯一措辞**（§5.4；判活与回执都用它，不许改写成「进程已停止」） */
export const NO_HEARTBEAT_NOTE =
  "无心跳（心跳缺失或超期）只说明「运行现场未知」，不等于进程已停止；停止必须有确认依据（DESIGN.md §5.4/§2.7）";

/** 停止未确认时的派发口径（§5.4：没有实际确认不能重派到同一可写目录） */
export const STOP_UNCONFIRMED_NOTE =
  "停止未确认：不往同一个可写目录派新执行，改用隔离的新工作目录，或先把旧进程的停止证据补齐";

/** 效果无法核实时（§5.4「已发生但回执未落盘」） */
export const EFFECT_UNVERIFIED_NOTE =
  "效果待核实：结果无法核实时暂停该动作的自动重试，由协调器调查，必要时交用户决定补偿或再执行";

/** 未配置客户端/缺凭据（§6.5：不替用户选择新服务） */
export const NO_SUBSTITUTE_NOTE =
  "不替用户选择新服务：未配置的客户端或缺失的凭据不会被其它服务顶替——明确报不可启动，由用户决定装、配或换哪一家（DESIGN.md §6.5）";

/** 缺省心跳超期阈值（超过即按"现场未知"处理，**不**判已停止） */
export const DEFAULT_HEARTBEAT_STALE_MS = 120_000;
/** 缺省执行超时上限（外部 worker 调用要小而可控，别无限等） */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 8 * 60 * 1000;

/** 调用层失败码（**不是**写入服务错误码，不扩 `WORK_ERROR_CODES`；与 V06-10 的 `ClaimFailureCode` 同一层） */
export type ExecutionFailureCode =
  | WorkErrorCode
  | "CLIENT_NOT_CONFIGURED"
  | "CLIENT_UNAVAILABLE"
  | "CREDENTIAL_MISSING"
  | "TEMPLATE_INVALID"
  | "COMMAND_FROM_TEXT_REJECTED"
  | "WORKSPACE_NOT_ISOLATED"
  | "EXECUTION_UNKNOWN"
  | "CLAIM_HELD"
  | "CLAIM_NOT_YOURS"
  | "STOP_NOT_CONFIRMED"
  | "EFFECT_DECLARATION_MISSING"
  | "EFFECT_UNVERIFIED"
  | "BLIND_REPLAY_BLOCKED";

export const EXECUTION_FAILURE_CODES: readonly ExecutionFailureCode[] = [
  "CLIENT_NOT_CONFIGURED",
  "CLIENT_UNAVAILABLE",
  "CREDENTIAL_MISSING",
  "TEMPLATE_INVALID",
  "COMMAND_FROM_TEXT_REJECTED",
  "WORKSPACE_NOT_ISOLATED",
  "EXECUTION_UNKNOWN",
  "CLAIM_HELD",
  "CLAIM_NOT_YOURS",
  "STOP_NOT_CONFIRMED",
  "EFFECT_DECLARATION_MISSING",
  "EFFECT_UNVERIFIED",
  "BLIND_REPLAY_BLOCKED",
];

export interface ExecutionFailure {
  ok: false;
  code: ExecutionFailureCode;
  message: string;
  /** 如实给出的现场（重新读状态的入口） */
  current_revision: number | null;
  read_again: string;
  /** 逐条失败项（如实，不合并成一句） */
  failures: string[];
}
export type ExecutionOutcome<T> = ({ ok: true } & T) | ExecutionFailure;

// ══════════════════════ 一、受控客户端配置与启动计划（§6.5） ══════════════════════

/** 凭据要求：**只报在不在**，绝不回传密钥原文 */
export interface CredentialRequirement {
  kind: "env" | "toml_key" | "json_key";
  /** env 变量名 / 配置文件路径模板（支持 `${KIMI_CODE_HOME}`、`${HOME}`、`${USERPROFILE}`） */
  name: string;
  /** toml_key：段落名（如 `providers.deepseek`）；json_key：点分路径（如 `env.ANTHROPIC_AUTH_TOKEN`） */
  key?: string;
  label: string;
}

/**
 * 客户端档案（受控配置里的一条）。`launch_template` 必须是**字符串数组**，
 * 占位符只允许 `ARGV_PLACEHOLDERS` 里的那些——**字符串命令不收**（§6.5）。
 */
export interface ClientProfile {
  client_id: string;
  label: string;
  /** 版本探测 argv（只读；实测命令见 docs/agent-integration.md） */
  version_probe: string[];
  /** 实测到的版本号（本机核过的那一个） */
  verified_version: string;
  /** 是否支持非交互一次性执行 */
  non_interactive: boolean;
  /** 非交互启动模板（数组；`<prompt>` 必含） */
  launch_template: string[];
  /** 缺省 model 标识/别名 */
  default_model: string | null;
  /** 档位参数名（如 `--effort`）与合法取值；没有就给 null / [] */
  effort_flag: string | null;
  effort_values: string[];
  /** 凭据要求（`credential_mode` 决定"全部满足"还是"任一满足"才算有可用凭据） */
  credentials: CredentialRequirement[];
  /** "all"（缺省）= 每条都要满足；"any" = 有任意一条就算凭据齐（同一客户端的不同凭据来源） */
  credential_mode?: "all" | "any";
  /** 隔离工作目录约定（人话一句，进回执与档案） */
  workspace_convention: string;
  /** 档案来源（实测出处；人话引用） */
  source: string;
}

export const ARGV_PLACEHOLDERS = [
  "<prompt>",
  "<model>",
  "<effort>",
  "<workspace>",
  "<task_id>",
  "<run_id>",
  "<attempt_id>",
] as const;

/**
 * 内置受控档案 = **本机实测**（`docs/agent-integration.md` 是档案正文，这里只放机器可读的那几栏）。
 * 项目可以用 `<项目>/.工作台/agents.json` 覆盖/追加自己的档案；没有就用这份内置的。
 */
export const BUILTIN_CLIENT_PROFILES: readonly ClientProfile[] = [
  {
    client_id: "kimi-code",
    label: "Kimi Code CLI（kimi）",
    version_probe: ["--version"],
    verified_version: "0.41.0",
    non_interactive: true,
    // `-p`（prompt 模式）与 `--auto` / `-y` **互斥**（实测：`error: Cannot combine --prompt with --auto.`），
    // 无人值守的权限口径由受控配置的 `default_permission_mode` 决定（本机实测 = "auto"）。
    launch_template: ["-p", "<prompt>", "--model", "<model>", "--output-format", "text"],
    default_model: "deepseek-v41-flash",
    effort_flag: null,
    effort_values: [],
    credentials: [
      { kind: "toml_key", name: "${KIMI_CODE_HOME}/config.toml", key: "providers.deepseek", label: "Kimi Code 配置里的 DeepSeek 供应商密钥" },
    ],
    workspace_convention:
      "协调器把子进程 cwd 设为隔离工作目录（`os.tmpdir()` 下的演练目录，或 `<项目>/.工作台/runs/<task>/<attempt>`）；不把项目根当执行目录",
    source: "docs/agent-integration.md §2（kimi --version / --help 实测）",
  },
  {
    client_id: "claude-code",
    label: "Claude Code（claude）",
    version_probe: ["--version"],
    verified_version: "2.1.274",
    non_interactive: true,
    launch_template: ["-p", "<prompt>", "--bare"],
    default_model: null,
    effort_flag: "--effort",
    effort_values: ["low", "medium", "high", "xhigh", "max"],
    credentials: [
      { kind: "json_key", name: "${HOME}/.claude/settings.json", key: "env.ANTHROPIC_AUTH_TOKEN", label: "Claude Code settings.json 的本地网关令牌" },
      { kind: "env", name: "ANTHROPIC_API_KEY", label: "Anthropic API key（--bare 下的严格凭据）" },
    ],
    credential_mode: "any",
    workspace_convention: "cwd = 隔离工作目录；`--bare` 跳过 hooks/插件自动发现，只带显式给的上下文",
    source: "docs/agent-integration.md §3（claude --version / --help 实测）",
  },
];

/** 项目受控配置（`<项目>/.工作台/agents.json`）的校验结论 */
export interface ClientProfileLoad {
  profiles: ClientProfile[];
  source: "project_config" | "builtin";
  config_path: string | null;
  /** 配置里有问题的条目（如实列出，不让坏配置静默失效） */
  problems: string[];
}

export const AGENT_CONFIG_FILE = "agents.json";

function workDirOf(projectId: string, dataDir?: string): string {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
  }
  return projectWorkDir(projectId, dataDir);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim()) : [];

/** 把一条配置条目读成 `ClientProfile`（坏条目给 reasons，不当成"已配置"） */
export function parseClientProfile(raw: unknown): { profile: ClientProfile } | { errors: string[] } {
  if (!isPlainObject(raw)) return { errors: ["条目不是 JSON 对象"] };
  const errors: string[] = [];
  const client_id = strOrNull(raw.client_id);
  if (client_id === null) errors.push("缺 client_id");
  const launch_template = strList(raw.launch_template);
  if (launch_template.length === 0) errors.push("缺 launch_template（必须是 argv 数组，不是命令字符串）");
  if (typeof raw.launch_template === "string") errors.push("launch_template 是字符串：命令字符串不收，必须是数组");
  if (!launch_template.includes("<prompt>")) errors.push("launch_template 必须含 <prompt> 占位符");
  const unknown = launch_template.filter((t) => t.startsWith("<") && !(ARGV_PLACEHOLDERS as readonly string[]).includes(t));
  if (unknown.length > 0) errors.push(`launch_template 有未登记占位符：${unknown.join(" ")}`);
  const credentials: CredentialRequirement[] = [];
  if (raw.credentials !== undefined) {
    if (!Array.isArray(raw.credentials)) errors.push("credentials 必须是数组");
    else {
      for (const c of raw.credentials) {
        if (!isPlainObject(c)) {
          errors.push("credentials 里有非对象条目");
          continue;
        }
        const kind = c.kind;
        const name = strOrNull(c.name);
        if (kind !== "env" && kind !== "toml_key" && kind !== "json_key") {
          errors.push(`凭据条目 kind 只认 env/toml_key/json_key：${JSON.stringify(kind)}`);
          continue;
        }
        if (name === null) {
          errors.push("凭据条目缺 name");
          continue;
        }
        credentials.push({
          kind,
          name,
          ...(strOrNull(c.key) === null ? {} : { key: strOrNull(c.key) as string }),
          label: strOrNull(c.label) ?? name,
        });
      }
    }
  }
  if (errors.length > 0 || client_id === null) return { errors: errors.length > 0 ? errors : ["条目不完整"] };
  const version_probe = strList(raw.version_probe);
  return {
    profile: {
      client_id,
      label: strOrNull(raw.label) ?? client_id,
      version_probe: version_probe.length > 0 ? version_probe : ["--version"],
      verified_version: strOrNull(raw.verified_version) ?? "未实测",
      non_interactive: raw.non_interactive !== false,
      launch_template,
      default_model: strOrNull(raw.default_model),
      effort_flag: strOrNull(raw.effort_flag),
      effort_values: strList(raw.effort_values),
      credentials,
      ...(raw.credential_mode === "any" || raw.credential_mode === "all" ? { credential_mode: raw.credential_mode } : {}),
      workspace_convention: strOrNull(raw.workspace_convention) ?? "隔离目录由协调器决定",
      source: strOrNull(raw.source) ?? `${AGENT_CONFIG_FILE}（项目受控配置）`,
    },
  };
}

/**
 * 读客户端档案：项目受控配置优先（`<项目>/.工作台/agents.json`），没有就用内置实测档案。
 * 配置文件坏了**不放行**：`source` 仍标 `project_config` 并把问题逐条列出（调用方据此报不可启动）。
 */
export function loadClientProfiles(projectId: string, dataDir?: string): ClientProfileLoad {
  const configPath = path.join(workDirOf(projectId, dataDir), AGENT_CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return { profiles: [...BUILTIN_CLIENT_PROFILES], source: "builtin", config_path: null, problems: [] };
  }
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    return {
      profiles: [],
      source: "project_config",
      config_path: configPath,
      problems: [`受控配置读不出来（${(e as Error).message}）：不退回内置档案，按不可启动处理`],
    };
  }
  const list = isPlainObject(raw) && Array.isArray(raw.clients) ? raw.clients : [];
  if (list.length === 0) problems.push("受控配置里没有 clients 数组（或为空）");
  const profiles: ClientProfile[] = [];
  list.forEach((entry, i) => {
    const parsed = parseClientProfile(entry);
    if ("errors" in parsed) {
      const id = isPlainObject(entry) ? String(entry.client_id ?? `#${i}`) : `#${i}`;
      problems.push(`${id}: ${parsed.errors.join("；")}`);
      return;
    }
    profiles.push(parsed.profile);
  });
  return { profiles, source: "project_config", config_path: configPath, problems };
}

/** 找一个档案（`client_id` 精确匹配） */
export function profileOf(clientId: string, profiles: readonly ClientProfile[]): ClientProfile | null {
  return profiles.find((p) => p.client_id === clientId) ?? null;
}

// ── 可执行文件定位（不 spawn，只查 PATH） ──

/** 在 PATH 上找可执行文件（Windows 认 PATHEXT；找不到返回 null，不猜） */
export function findExecutable(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((s) => s !== "")
      : [""];
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((s) => s !== "");
  const candidates = path.extname(bin) === "" ? exts.map((e) => `${bin}${e}`) : [bin];
  for (const dir of dirs) {
    for (const cand of candidates) {
      const abs = path.join(dir, cand);
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
      } catch {
        // 读不到就跳过这一条
      }
    }
  }
  return null;
}

// ── 凭据检查（只报在不在，不回传原文） ──

function expandTemplate(tpl: string, env: NodeJS.ProcessEnv): string {
  return tpl.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");
}

/** `[providers.<id>]` 段落里的 `api_key` 是否非空（轻量 TOML 扫描；只回布尔，不回原文） */
export function tomlSectionKeyPresent(text: string, section: string, key = "api_key"): boolean {
  const wanted = [section, `"${section}"`];
  if (!section.startsWith("providers.")) {
    wanted.push(`providers.${section}`, `providers."${section}"`);
  }
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header !== null) {
      const name = header[1].trim();
      inSection = wanted.includes(name);
      continue;
    }
    if (!inSection) continue;
    const kv = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"\\s*$`));
    if (kv !== null && kv[1].trim() !== "") return true;
  }
  return false;
}

/** JSON 点分路径取值是否非空（如 `env.ANTHROPIC_AUTH_TOKEN`；只回布尔） */
export function jsonPathPresent(raw: unknown, dotted: string): boolean {
  let cur: unknown = raw;
  for (const part of dotted.split(".")) {
    if (!isPlainObject(cur)) return false;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur.trim() !== "" : cur !== undefined && cur !== null;
}

/** 单条凭据要求的结论（present=false 时给怎么补，不回传密钥） */
export function checkCredential(
  req: CredentialRequirement,
  env: NodeJS.ProcessEnv = process.env,
): { present: boolean; detail: string } {
  if (req.kind === "env") {
    const v = env[req.name];
    return { present: typeof v === "string" && v.trim() !== "", detail: `环境变量 ${req.name}` };
  }
  const file = expandTemplate(req.name, env);
  if (file === "" || !fs.existsSync(file)) return { present: false, detail: `配置文件不存在：${file || req.name}` };
  const text = fs.readFileSync(file, "utf8");
  if (req.kind === "toml_key") {
    const ok = req.key !== undefined && tomlSectionKeyPresent(text, req.key);
    return { present: ok, detail: `${file} 的 [${req.key ?? "?"}] api_key` };
  }
  try {
    const ok = req.key !== undefined && jsonPathPresent(JSON.parse(text), req.key);
    return { present: ok, detail: `${file} 的 ${req.key ?? "?"}` };
  } catch (e) {
    return { present: false, detail: `${file} 解析失败：${(e as Error).message}` };
  }
}

// ── 启动判定与启动计划 ──

export interface StartabilityVerdict {
  startable: boolean;
  client_id: string;
  code: "OK" | "CLIENT_NOT_CONFIGURED" | "CLIENT_UNAVAILABLE" | "CREDENTIAL_MISSING";
  message: string;
  /** 缺什么，逐条列（不合并成"不可用"） */
  missing: string[];
  /** 档案里的实测版本与隔离目录约定（如实转述，便于回执记录） */
  verified_version: string | null;
  workspace_convention: string | null;
  /** 凭据检查结论（只报在不在） */
  credentials: { label: string; present: boolean; detail: string }[];
  /** §6.5：不替用户选新服务 */
  note: string;
  /** 配置来源与坏条目（坏配置不放行） */
  config_source: ClientProfileLoad["source"];
  config_path: string | null;
  config_problems: string[];
}

/**
 * 能不能启动：**未配置的客户端 / 缺凭据 → 明确不可启动**，并给"缺什么"。
 * 这里不 spawn、不试跑、不换服务顶上（§6.5）。
 */
/** 档案里的二进制名（受控映射：client_id → 可执行文件名；未列出的按 client_id 原样找） */
export const CLIENT_BIN_NAMES: Readonly<Record<string, string>> = {
  "kimi-code": "kimi",
  "claude-code": "claude",
};

/** 找档案对应的可执行文件（PATH + PATHEXT；找不到返回 null，不猜） */
export function resolveClientBin(profile: ClientProfile, env: NodeJS.ProcessEnv = process.env): string | null {
  const name = CLIENT_BIN_NAMES[profile.client_id] ?? profile.client_id;
  return findExecutable(name, env) ?? findExecutable(profile.client_id, env);
}

export function resolveStartable(input: {
  project_id: string;
  client_id: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}): StartabilityVerdict {
  const env = input.env ?? process.env;
  const load = loadClientProfiles(input.project_id, input.dataDir);
  const base = {
    client_id: input.client_id,
    note: NO_SUBSTITUTE_NOTE,
    config_source: load.source,
    config_path: load.config_path,
    config_problems: load.problems,
  };
  if (load.problems.length > 0) {
    return {
      ...base,
      startable: false,
      code: "CLIENT_NOT_CONFIGURED",
      message: `受控配置有问题，不放行：${load.problems.join("；")}`,
      missing: load.problems,
      verified_version: null,
      workspace_convention: null,
      credentials: [],
    };
  }
  const profile = profileOf(input.client_id, load.profiles);
  if (profile === null) {
    return {
      ...base,
      startable: false,
      code: "CLIENT_NOT_CONFIGURED",
      message: `没有 ${input.client_id} 的受控档案（${load.source === "builtin" ? "内置实测档案" : load.config_path ?? "受控配置"}里找不到）。${NO_SUBSTITUTE_NOTE}`,
      missing: [`client_id=${input.client_id} 的档案`],
      verified_version: null,
      workspace_convention: null,
      credentials: [],
    };
  }
  const credentials = profile.credentials.map((c) => ({ label: c.label, ...checkCredential(c, env) }));
  const credentialMode = profile.credential_mode ?? "all";
  const presentCount = credentials.filter((c) => c.present).length;
  const credentialsOk =
    credentials.length === 0 ? true : credentialMode === "any" ? presentCount > 0 : presentCount === credentials.length;
  const missingCreds = credentialsOk ? [] : credentials.filter((c) => !c.present).map((c) => c.label);
  const bin = resolveClientBin(profile, env);
  if (bin === null) {
    return {
      ...base,
      startable: false,
      code: "CLIENT_UNAVAILABLE",
      message: `档案 ${profile.client_id} 声明可用，但 PATH 上找不到它的可执行文件（版本探测 ${profile.version_probe.join(" ")} 也跑不了）。${NO_SUBSTITUTE_NOTE}`,
      missing: [`可执行文件（client_id=${profile.client_id}）`],
      verified_version: profile.verified_version,
      workspace_convention: profile.workspace_convention,
      credentials,
    };
  }
  if (missingCreds.length > 0) {
    return {
      ...base,
      startable: false,
      code: "CREDENTIAL_MISSING",
      message: `${profile.label} 缺可用凭据（要求：${credentialMode === "any" ? "任一" : "全部"}满足）：${missingCreds.join("；")}。${NO_SUBSTITUTE_NOTE}`,
      missing: missingCreds,
      verified_version: profile.verified_version,
      workspace_convention: profile.workspace_convention,
      credentials,
    };
  }
  return {
    ...base,
    startable: true,
    code: "OK",
    message: `${profile.label}（实测 ${profile.verified_version}）可启动：凭据齐、档案来自 ${load.source === "builtin" ? "内置实测档案" : load.config_path ?? "项目受控配置"}`,
    missing: [],
    verified_version: profile.verified_version,
    workspace_convention: profile.workspace_convention,
    credentials,
  };
}

/**
 * 渲染 argv：只从**数组模板**来，占位符白名单外的一律拒。
 * 传字符串命令（模型说明文本里抄来的命令行）→ `COMMAND_FROM_TEXT_REJECTED`（§6.5）。
 */
export function renderArgv(
  template: unknown,
  values: Record<string, string>,
): ExecutionOutcome<{ argv: string[] }> {
  if (typeof template === "string") {
    return reject(
      "COMMAND_FROM_TEXT_REJECTED",
      "命令字符串不收：外部命令必须来自受控配置的 argv 数组模板（DESIGN.md §6.5——模型生成的说明文本不能直接成为命令）",
      ["传进来的是字符串命令"],
    );
  }
  if (!Array.isArray(template) || template.some((t) => typeof t !== "string")) {
    return reject("TEMPLATE_INVALID", "argv 模板必须是字符串数组", ["模板不是字符串数组"]);
  }
  const argv: string[] = [];
  const bad: string[] = [];
  for (const token of template as string[]) {
    let out = token;
    const holes = token.match(/<[^>]*>/g) ?? [];
    for (const hole of holes) {
      if (!(ARGV_PLACEHOLDERS as readonly string[]).includes(hole)) {
        bad.push(`未登记占位符 ${hole}`);
        continue;
      }
      const value = values[hole];
      if (value === undefined || value === "") {
        bad.push(`占位符 ${hole} 没给值`);
        continue;
      }
      out = out.replaceAll(hole, value);
    }
    argv.push(out);
  }
  if (bad.length > 0) return reject("TEMPLATE_INVALID", `模板渲染失败：${bad.join("；")}`, bad);
  if (argv.includes(""))
    return reject("TEMPLATE_INVALID", "渲染后有空参数：参数值里不能夹空串", ["空参数"]);
  return { ok: true, argv };
}

/** argv 的稳定指纹（回执里记它，事后能对账"跑的是哪条命令"，但**不**回传命令正文） */
export function argvDigest(argv: readonly string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

export interface LaunchPlan {
  client_id: string;
  client_label: string;
  verified_version: string;
  /** 可执行文件绝对路径（档案 client_id → 二进制名，PATH 上找到的那个；协调器照它 spawn） */
  bin: string;
  argv: string[];
  /** 完整命令行 = [bin, ...argv]（给协调器直接 spawn 用；塔台自己不执行） */
  command: string[];
  argv_digest: string;
  cwd: string;
  workspace: string;
  model: string | null;
  effort: string | null;
  timeout_ms: number;
  /** 这条模板从哪来（受控配置的出处；回执如实转述） */
  template_source: string;
  /** 只读探测命令（版本核对；同样只从档案来） */
  version_probe: string[];
  /** 协调器自己负责的事（塔台不代劳，§6.5） */
  coordinator_duties: string[];
}

export interface BuildLaunchPlanInput {
  project_id: string;
  client_id: string;
  prompt: string;
  workspace: string;
  task_id?: string;
  run_id?: string;
  attempt_id?: string;
  model?: string;
  effort?: string;
  timeout_ms?: number;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

const COORDINATOR_DUTIES = [
  "拉起与终止子进程（塔台不 spawn：§6.5 外部协调器负责启动和终止执行进程）",
  "把子进程 cwd 设为隔离工作目录，并把现场（stdout/stderr/退出码/diff）落证据",
  "终止要有确认依据（进程真的没了）后才算停止；未确认不往同一可写目录重派",
] as const;

/** workspace 隔离校验：不许是注册项目根，也不许是它的祖先（§5.4 隔离工作目录或串行化） */
export function assertIsolatedWorkspace(
  workspace: string,
  dataDir?: string,
): ExecutionOutcome<{ workspace: string }> {
  const abs = path.resolve(workspace);
  if (!path.isAbsolute(workspace)) {
    return reject("WORKSPACE_NOT_ISOLATED", `工作目录必须是绝对路径：${workspace}`, ["工作目录不是绝对路径"]);
  }
  const projects = listProjects(dataDir);
  const failures: string[] = [];
  for (const p of projects) {
    const root = path.resolve(p.path);
    if (abs === root) {
      failures.push(`工作目录就是项目根 ${root}（项目 ${p.id}）：执行必须在隔离目录里，或由协调器明确串行化`);
      continue;
    }
    if (root.startsWith(abs + path.sep)) {
      failures.push(`工作目录 ${abs} 是项目 ${p.id} 根目录的祖先：会把项目根一起暴露给外部执行器`);
      continue;
    }
    if (abs.startsWith(root + path.sep)) {
      const runsRoot = path.join(root, ".工作台", "runs") + path.sep;
      if (!abs.startsWith(runsRoot)) {
        failures.push(`工作目录在项目 ${p.id} 内但不是隔离运行区（应落在 ${runsRoot}）：明文拒绝，避免直接改工作树`);
      }
    }
  }
  if (failures.length > 0) {
    return reject("WORKSPACE_NOT_ISOLATED", `工作目录不合隔离口径：${failures.join("；")}`, failures);
  }
  return { ok: true, workspace: abs };
}

/**
 * 产出**启动计划**（argv + cwd + 超时 + 协调器职责），**不执行**。
 * 不可启动时按 `resolveStartable` 的失败码原样返回，一个字节都不写。
 */
export function buildLaunchPlan(input: BuildLaunchPlanInput): ExecutionOutcome<{ plan: LaunchPlan }> {
  const verdict = resolveStartable({
    project_id: input.project_id,
    client_id: input.client_id,
    ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }),
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  if (!verdict.startable) {
    return {
      ok: false,
      code: verdict.code === "OK" ? "CLIENT_NOT_CONFIGURED" : verdict.code,
      message: verdict.message,
      current_revision: null,
      read_again: `重新核实客户端配置：docs/agent-integration.md；项目受控配置 ${verdict.config_path ?? "(未使用)"}`,
      failures: verdict.missing.length > 0 ? verdict.missing : [verdict.message],
    };
  }
  const load = loadClientProfiles(input.project_id, input.dataDir);
  const profile = profileOf(input.client_id, load.profiles);
  if (profile === null) {
    return reject("CLIENT_NOT_CONFIGURED", `档案在二次读取时消失：${input.client_id}`, ["档案不见了"]);
  }
  const model = input.model ?? profile.default_model ?? "";
  const effort = input.effort ?? "";
  if (input.effort !== undefined && profile.effort_flag !== null && !profile.effort_values.includes(input.effort)) {
    return reject(
      "TEMPLATE_INVALID",
      `档位 ${input.effort} 不在档案 ${profile.client_id} 的合法取值里（${profile.effort_values.join("/")}）`,
      [`档位 ${input.effort} 不合法`],
    );
  }
  const template = input.effort !== undefined && profile.effort_flag !== null
    ? [...profile.launch_template, profile.effort_flag, "<effort>"]
    : profile.launch_template;
  const rendered = renderArgv(template, {
    "<prompt>": input.prompt,
    "<model>": model,
    "<effort>": effort,
    "<workspace>": path.resolve(input.workspace),
    "<task_id>": input.task_id ?? "",
    "<run_id>": input.run_id ?? "",
    "<attempt_id>": input.attempt_id ?? "",
  });
  if (!rendered.ok) return rendered;
  const iso = assertIsolatedWorkspace(input.workspace, input.dataDir);
  if (!iso.ok) return iso;
  const argv = rendered.argv;
  const bin = resolveClientBin(profile, input.env ?? process.env);
  if (bin === null) {
    return reject("CLIENT_UNAVAILABLE", `PATH 上找不到 ${profile.client_id} 的可执行文件：起不了`, [`可执行文件缺失`]);
  }
  const plan: LaunchPlan = {
    client_id: profile.client_id,
    client_label: profile.label,
    verified_version: profile.verified_version,
    bin,
    argv,
    command: [bin, ...argv],
    argv_digest: argvDigest(argv),
    cwd: iso.workspace,
    workspace: iso.workspace,
    model: model === "" ? null : model,
    effort: effort === "" ? null : effort,
    timeout_ms: input.timeout_ms ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    template_source: profile.source,
    version_probe: [...profile.version_probe],
    coordinator_duties: [...COORDINATOR_DUTIES],
  };
  return { ok: true, plan };
}

// ══════════════════════ 二、回执提交（五类事件 + 效果声明） ══════════════════════

function reject(code: ExecutionFailureCode, message: string, failures: string[], currentRevision: number | null = null, readAgain = ""): ExecutionFailure {
  return {
    ok: false,
    code,
    message,
    current_revision: currentRevision,
    read_again: readAgain === "" ? "重新读现场：读 execution:<execution_id> 的事件与任务当前认领（`.工作台/work/events.jsonl`）" : readAgain,
    failures: failures.length > 0 ? failures : [message],
  };
}

/** 新执行 id（一个 attempt 一个；重派换新 id，不覆盖旧执行的记录） */
export function newExecutionId(taskId: string, attemptId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `ex-${safe(taskId)}-${safe(attemptId)}-${crypto.randomBytes(3).toString("hex")}`;
}

export interface ExecutionTarget {
  project_id: string;
  /** 执行实体 id（不给就由 task+attempt 生成） */
  execution_id?: string;
  task_id: string;
  run_id: string;
  attempt_id: string;
  attempt?: number | null;
  /** 父执行（协调器自己也是被塔台跟踪的一次执行时给出，形成父子链；§5.4 协调器自身退出也按恢复顺序走） */
  parent_execution_id?: string | null;
  parent_run_id?: string | null;
  /** 协调器身份（谁在拉起（§6.5）；只有协作记录作用，角色名不是安全凭证） */
  coordinator_id: string;
  /** 本次认领 token（所有回执都核当前认领） */
  claim_token: string;
  owner_id: string;
  owner_role: string;
  change_id: string;
  workspace: string;
  /** 实际客户端 / model / effort（**实际**，不是"请求的"） */
  client_id: string;
  model?: string | null;
  effort?: string | null;
  /**
   * 期望的执行实体版本。缺省 = 现读现场（原子性由唯一写入服务的版本检查保证）；
   * **补交同一意图时带上原次的那个版本**：服务先查幂等再查版本，同键同内容才返回原回执（§5.4）。
   */
  expected_revision?: number;
  occurred_at?: string;
}

/** 回执里"实际客户端/model/effort/workspace"的统一形状（每次回执都记，便于事后追溯） */
export interface ActualRuntime {
  client_id: string;
  client_version: string | null;
  model: string | null;
  effort: string | null;
  workspace: string;
  pid: number | null;
  parent_execution_id: string | null;
  parent_run_id: string | null;
  coordinator_id: string;
}

interface ReceiptContext {
  workDir: string;
  executionRevision: number;
  claimToken: string | null;
  claimOwner: string | null;
  /** 认领事件里记的隔离目录（回执声明的目录可能不同：重派换目录是允许的） */
  claimWorkspace: string | null;
  taskRevision: number;
  taskStatus: string | null;
}

function executionRevisionOf(events: readonly WorkEvent[], entityId: string): number {
  return events.reduce((rev, e) => (e.entity_id === entityId ? e.entity_revision : rev), 0);
}

/** 回执共同前置：项目存在、任务有运行状态、认领 token 是当前那个 */
function receiptContext(target: ExecutionTarget, dataDir?: string): ExecutionOutcome<ReceiptContext> {
  const workDir = workDirOf(target.project_id, dataDir);
  const events = readClaimEvents(workDir);
  const state = readTaskStates(workDir).states[target.task_id] ?? null;
  if (state === null) {
    return reject(
      "EXECUTION_UNKNOWN",
      `任务 ${target.task_id} 在当前事件现场里没有运行状态：先导入施工定义并领取任务`,
      [`任务 ${target.task_id} 没有运行状态`],
    );
  }
  if (state.claim_token === null) {
    return reject(
      "CLAIM_HELD",
      `任务 ${target.task_id} 当前没有有效认领：回执只接当前认领持有人提交的执行事件（DESIGN.md §6.5）`,
      ["没有有效认领"],
      state.revision,
    );
  }
  if (state.claim_token !== target.claim_token) {
    return reject(
      "CLAIM_NOT_YOURS",
      `认领 token 不是当前那个（现场 ${String(state.claim_token).slice(0, 12)}…）：只有有效认领能提交执行回执`,
      ["认领 token 不符"],
      state.revision,
    );
  }
  if (state.owner_id !== null && state.owner_id !== target.owner_id) {
    return reject(
      "CLAIM_NOT_YOURS",
      `持有者是 ${state.owner_id}，不是 ${target.owner_id}：不能替别人报执行现场`,
      ["持有者不符"],
      state.revision,
    );
  }
  // 认领记录里带的隔离目录与回执声明的目录不一致时**不回退**：重派本来就换目录，
  // 回执里记的是"这一次实际用的目录"（`execution.started` 会把它固定下来）。
  const held = liveClaimRecord(claimRecordsOf(events)[target.task_id]);
  if (held === null) {
    return reject(
      "CLAIM_HELD",
      `任务 ${target.task_id} 在认领事件里没有有效持有记录：执行回执只接持有者提交（DESIGN.md §6.5）`,
      ["没有有效认领记录"],
      state.revision,
    );
  }
  if (held.claim_token !== null && held.claim_token !== target.claim_token) {
    return reject(
      "CLAIM_NOT_YOURS",
      `认领事件里的 token 与调用方给的不一致（现场 ${String(held.claim_token).slice(0, 12)}…）`,
      ["认领记录 token 不符"],
      state.revision,
    );
  }
  if (target.workspace.trim() === "") {
    return reject(
      "INVALID_COMMAND",
      "执行回执必须带隔离工作目录（workspace）：恢复时要按它核对旧进程与未提交改动（DESIGN.md §5.4）",
      ["workspace 为空"],
      state.revision,
    );
  }
  return {
    ok: true,
    workDir,
    executionRevision: executionRevisionOf(events, executionEntityId(executionKey(target))),
    claimToken: state.claim_token,
    claimOwner: state.owner_id,
    claimWorkspace: held.workspace,
    taskRevision: state.revision,
    taskStatus: state.status,
  };
}

function executionKey(target: ExecutionTarget): string {
  return target.execution_id ?? `ex-${target.task_id}-${target.attempt_id}`;
}

// ── 幂等键的构造口径（每条回执的键都从"稳定意图"算，**不含**当前实体版本） ──
//
// 键 = `<execution_id>:<事件类型>[:<该事件的稳定判别符>]`：心跳/检查点用观测时间、效果用 effect_id
// （确认再加实际结果标识）、失败用 phase、启动请求/启动确认/停止确认/交付各一条。
// **不含 `expected_revision`**：补交语义要求调用方在恢复后能由稳定意图重算出同一个键（§5.4
// 「恢复后按幂等键补交」）；把当前版本塞进键里，同一次意图重发会算出新键 → 变成第二次效果。

function executionCommand(args: {
  target: ExecutionTarget;
  type: ExecutionEventType;
  entityId: string;
  expectedRevision: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}): WorkCommand {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: args.target.project_id,
    change_id: args.target.change_id,
    entity_id: args.entityId,
    expected_revision: args.expectedRevision,
    type: args.type,
    actor_id: args.target.coordinator_id,
    role: args.target.owner_role,
    idempotency_key: args.idempotencyKey,
    ...(args.target.occurred_at === undefined ? {} : { occurred_at: args.target.occurred_at }),
    payload: args.payload,
  };
}

function runtimePayload(target: ExecutionTarget, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: target.task_id,
    run_id: target.run_id,
    attempt_id: target.attempt_id,
    attempt: target.attempt ?? null,
    claim_token: target.claim_token,
    owner_id: target.owner_id,
    coordinator_id: target.coordinator_id,
    client_id: target.client_id,
    model: target.model ?? null,
    effort: target.effort ?? null,
    workspace: target.workspace,
    parent_execution_id: target.parent_execution_id ?? null,
    parent_run_id: target.parent_run_id ?? null,
    ...extra,
  };
}

async function submit(
  submitter: ClaimSubmitter,
  args: Parameters<typeof executionCommand>[0],
  target: ExecutionTarget,
  workDir: string,
  what: string,
): Promise<WorkReceipt | ExecutionFailure> {
  try {
    return await submitter.submit(executionCommand(args));
  } catch (e) {
    if (isWorkError(e) && e.code === "VERSION_CONFLICT") {
      const detail = e.detail as { current_revision?: unknown };
      return reject(
        "VERSION_CONFLICT",
        `${what}被拒（原子写版本检查）：${e.message}`,
        [e.message],
        typeof detail.current_revision === "number" ? detail.current_revision : null,
        `重新读状态：events.jsonl（${workDir}）里实体 ${args.entityId}`,
      );
    }
    if (isWorkError(e) && e.code === "IDEMPOTENCY_CONFLICT") {
      // 同一个幂等键换内容重发 = 明确拒绝（**不是**产生第二次效果，也不是静默丢弃）
      return reject(
        "IDEMPOTENCY_CONFLICT",
        `${what}被拒（同键异内容）：${e.message}。补交要按**原次意图**重发（同一个 observed_at / effect_id / 原次 expected_revision）`,
        [e.message],
        null,
        `对账：events.jsonl（${workDir}）里 idempotency_key`,
      );
    }
    throw e;
  }
}

export interface StartRequestedInput extends ExecutionTarget {
  /** 这次要跑什么（人话；**不进 argv**——命令只来自受控模板） */
  goal: string;
  argv_digest: string;
  template_source: string;
  timeout_ms: number;
}

/**
 * ① 启动请求：记录"我要拉起谁、在哪个隔离目录、用哪条受控模板、超时多少"。
 * **此时还不是"运行中"**——启动失败必须回 `execution.failed` 并带现场（§6.5）。
 */
export async function recordStartRequested(
  input: StartRequestedInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string }>> {
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const entityId = executionEntityId(executionId);
  const iso = assertIsolatedWorkspace(input.workspace, dataDir);
  if (!iso.ok) return iso;
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.start_requested",
      entityId,
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.start_requested:${input.change_id}:${input.claim_token}`,
      payload: runtimePayload(input, {
        goal: input.goal,
        argv_digest: input.argv_digest,
        template_source: input.template_source,
        timeout_ms: input.timeout_ms,
        site_state: "start_requested",
        meaning: "已提启动请求；**尚未**确认进程跑起来（DESIGN.md §5.4 运行现场：启动请求中）",
      }),
    },
    input,
    ctx.workDir,
    "启动请求",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId };
}

export interface StartedInput extends ExecutionTarget {
  client_version: string;
  pid?: number | null;
  argv_digest: string;
  started_at?: string;
}

/** ② 启动确认：**实际**客户端/版本/model/effort/workspace 与父执行在此固定下来 */
export async function recordStarted(
  input: StartedInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string; actual: ActualRuntime }>> {
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const actual: ActualRuntime = {
    client_id: input.client_id,
    client_version: input.client_version,
    model: input.model ?? null,
    effort: input.effort ?? null,
    workspace: input.workspace,
    pid: input.pid ?? null,
    parent_execution_id: input.parent_execution_id ?? null,
    parent_run_id: input.parent_run_id ?? null,
    coordinator_id: input.coordinator_id,
  };
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.started",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.started:${input.change_id}:${input.claim_token}`,
      payload: runtimePayload(input, {
        actual,
        argv_digest: input.argv_digest,
        started_at: input.started_at ?? nowIso(),
        site_state: "running",
        meaning: "进程已确认跑起来（运行现场：运行中）",
      }),
    },
    input,
    ctx.workDir,
    "启动确认",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId, actual };
}

export interface ReceiptBeatInput extends ExecutionTarget {
  /** 观测到的现场（人话；如"正在改 calc.js"） */
  note?: string;
  /** 执行器自己说在等输入时给 true（运行现场：等待输入） */
  awaiting_input?: boolean;
  /** 观测时间（缺省 now） */
  observed_at?: string;
}

/** ③ 心跳：**只说明"这一刻还有信号"**，缺失/超期不等于停止（`NO_HEARTBEAT_NOTE`） */
export async function recordHeartbeat(
  input: ReceiptBeatInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string }>> {
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.heartbeat",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.heartbeat:${input.observed_at ?? nowIso()}`,
      payload: runtimePayload(input, {
        observed_at: input.observed_at ?? nowIso(),
        awaiting_input: input.awaiting_input === true,
        site_state: input.awaiting_input === true ? "awaiting_input" : "running",
        note: input.note ?? null,
        liveness_note: NO_HEARTBEAT_NOTE,
      }),
    },
    input,
    ctx.workDir,
    "心跳",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId };
}

export interface CheckpointInput extends ReceiptBeatInput {
  /** 检查点内容（做完了什么、现场在哪） */
  note: string;
  /** 已产生的成果/证据引用（未提交改动的位置也写这里） */
  artifacts?: string[];
  /** 工作树的未提交改动说明（恢复时要核对，§5.4） */
  worktree?: { dirty: boolean; changed_files: string[]; head?: string | null } | null;
  /** 外部动作是否在飞行中（有在飞的动作时恢复必须先查效果） */
  effects_in_flight?: string[];
}

/** ④ 检查点：恢复顺序的第一步读它（§5.4「读最后检查点」） */
export async function recordCheckpoint(
  input: CheckpointInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string }>> {
  if (input.note.trim() === "") {
    return reject("INVALID_COMMAND", "检查点必须有 note：空检查点等于没留现场", ["note 为空"]);
  }
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.checkpoint",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.checkpoint:${input.observed_at ?? nowIso()}`,
      payload: runtimePayload(input, {
        observed_at: input.observed_at ?? nowIso(),
        note: input.note,
        artifacts: input.artifacts ?? [],
        worktree: input.worktree ?? null,
        effects_in_flight: input.effects_in_flight ?? [],
        awaiting_input: input.awaiting_input === true,
        site_state: input.awaiting_input === true ? "awaiting_input" : "running",
      }),
    },
    input,
    ctx.workDir,
    "检查点",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId };
}

export interface StopRequestedInput extends ExecutionTarget {
  reason: string;
  /** 请求者怎么打算确认停止（如"kill 后查 PID 是否还在"） */
  confirm_method: string;
}

/** ⑤a 停止请求（运行现场：停止请求中）。**请求 ≠ 已停止** */
export async function recordStopRequested(
  input: StopRequestedInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string }>> {
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.stop_requested",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.stop_requested:${input.reason}`,
      payload: runtimePayload(input, {
        reason: input.reason,
        confirm_method: input.confirm_method,
        site_state: "stop_requested",
        meaning:
          "已请求停止；**请求不等于已停止**——没有确认证据前，同一个可写目录不再派新执行（DESIGN.md §5.4）",
      }),
    },
    input,
    ctx.workDir,
    "停止请求",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId };
}

export interface StoppedInput extends ExecutionTarget {
  /** 确认依据：怎么确认真的停了（**必填**；空 = `STOP_NOT_CONFIRMED`） */
  confirmation: string;
  /** 现场证据（进程查不到的记录、退出码、日志位置等） */
  evidence?: string[];
  exit_code?: number | null;
}

/** ⑤b 停止确认（运行现场：已停止）。没有确认依据一律拒收 */
export async function recordStopped(
  input: StoppedInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string; confirmation: string }>> {
  if (input.confirmation.trim() === "") {
    return reject(
      "STOP_NOT_CONFIRMED",
      `停止没有确认依据：${STOP_UNCONFIRMED_NOTE}（确认依据写进 confirmation，例如「kill 后按 PID 查不到进程 + 工作目录 mtime 不再变化」）`,
      ["confirmation 为空"],
    );
  }
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.stopped",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.stopped`,
      payload: runtimePayload(input, {
        confirmation: input.confirmation,
        evidence: input.evidence ?? [],
        exit_code: input.exit_code ?? null,
        site_state: "stopped",
        meaning: "停止已确认（有确认依据），此后同一可写目录才可以再派新执行",
      }),
    },
    input,
    ctx.workDir,
    "停止确认",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId, confirmation: input.confirmation };
}

export interface FailedInput extends ExecutionTarget {
  phase: "launch" | "run";
  /** 失败现场（**必填**：启动失败须回报失败及现场，不能先把任务标成运行中，§6.5） */
  scene: {
    exit_code?: number | null;
    stderr_tail?: string | null;
    argv_digest?: string | null;
    message: string;
  };
  /** 失败现场证据位置 */
  log_ref?: string | null;
}

/** ⑥ 失败回执（启动失败/运行失败都走这里，带现场） */
export async function recordFailed(
  input: FailedInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string }>> {
  if (input.scene.message.trim() === "") {
    return reject("INVALID_COMMAND", "失败现场必须有 message：只写「失败了」不算现场（DESIGN.md §6.5）", ["现场 message 为空"]);
  }
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.failed",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.failed:${input.phase}`,
      payload: runtimePayload(input, {
        phase: input.phase,
        scene: input.scene,
        log_ref: input.log_ref ?? null,
        site_state: "ended",
        meaning:
          "执行未跑起来或跑砸了，带现场；**没有**把它标成运行中（DESIGN.md §6.5「启动失败须回报失败及现场」）",
      }),
    },
    input,
    ctx.workDir,
    "失败回执",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId };
}

export interface EffectDeclaredInput extends ExecutionTarget {
  /** 稳定效果 id（重试复用同一个 id；外部系统支持幂等键时一并复用原键） */
  effect_id: string;
  /** 动作目标（哪个外部系统/哪个对象） */
  target: string;
  /** 授权依据（谁批的、依据哪条） */
  authorization: string;
  /** 核实方法（动作后怎么查它到底发生没有） */
  verify_method: string;
  /** 外部系统的幂等键（有就复用） */
  external_idempotency_key?: string | null;
}

/**
 * ⑦ 外部动作**前**的声明（§5.4「动作前保存 effect_id、目标、授权与预期检查方式」）。
 * 有在飞的动作时，恢复必须先查它的实际效果。
 */
export async function declareEffect(
  input: EffectDeclaredInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string; effect_id: string }>> {
  if (input.effect_id.trim() === "" || input.target.trim() === "" || input.verify_method.trim() === "") {
    return reject(
      "INVALID_COMMAND",
      "效果声明必须有 effect_id / target / verify_method（动作后要按核实方法对账，缺一不可）",
      ["声明字段不全"],
    );
  }
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.effect_declared",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.effect_declared:${input.effect_id}`,
      payload: runtimePayload(input, {
        effect_id: input.effect_id,
        target: input.target,
        authorization: input.authorization,
        verify_method: input.verify_method,
        external_idempotency_key: input.external_idempotency_key ?? null,
        declared_at: nowIso(),
        meaning: "动作前声明；此时**还不知道**动作发生没有（DESIGN.md §5.4）",
      }),
    },
    input,
    ctx.workDir,
    "效果声明",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId, effect_id: input.effect_id };
}

export interface EffectConfirmedInput extends ExecutionTarget {
  effect_id: string;
  /** 实际结果标识（外部系统给的回执 id / 提交号 / 消息 id） */
  result_ref: string;
  note?: string;
}

/** ⑧ 动作**后**的回执：必须关联实际结果标识，否则不算确认 */
export async function confirmEffect(
  input: EffectConfirmedInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string; effect_id: string }>> {
  if (input.result_ref.trim() === "") {
    return reject(
      "INVALID_COMMAND",
      "确认效果必须带实际结果标识（result_ref）：只说「已经做了」不算回执（DESIGN.md §5.4）",
      ["result_ref 为空"],
    );
  }
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  // 先声明后确认：没有对应 `execution.effect_declared` 的确认一律拒收（§5.4 要求动作前先记核实方法）
  const declared = readExecution(ctx.workDir, executionId)?.effects.some((e) => e.effect_id === input.effect_id) === true;
  if (!declared) {
    return reject(
      "EFFECT_DECLARATION_MISSING",
      `效果 ${input.effect_id} 没有声明过：外部动作必须**先声明**（effect_id/目标/授权/核实方法）再确认结果（DESIGN.md §5.4）`,
      [`effect_id=${input.effect_id} 没有 effect_declared`],
      ctx.executionRevision,
      `读 ${path.join(ctx.workDir, "events.jsonl")} 里实体 ${executionEntityId(executionId)} 的 execution.effect_declared`,
    );
  }
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.effect_confirmed",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.effect_confirmed:${input.effect_id}:${input.result_ref}`,
      payload: runtimePayload(input, {
        effect_id: input.effect_id,
        result_ref: input.result_ref,
        note: input.note ?? null,
        confirmed_at: nowIso(),
      }),
    },
    input,
    ctx.workDir,
    "效果确认",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId, effect_id: input.effect_id };
}

export interface EffectUnverifiedInput extends ExecutionTarget {
  effect_id: string;
  /** 怎么查的、为什么查不清（如实写） */
  check_evidence: string;
}

/** ⑨ 效果待核实：查不清就标出来并**暂停该动作的自动重试**（不盲重放） */
export async function markEffectUnverified(
  input: EffectUnverifiedInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string; effect_id: string }>> {
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.effect_unverified",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.effect_unverified:${input.effect_id}`,
      payload: runtimePayload(input, {
        effect_id: input.effect_id,
        check_evidence: input.check_evidence,
        checked_at: nowIso(),
        retry_blocked: true,
        note: EFFECT_UNVERIFIED_NOTE,
      }),
    },
    input,
    ctx.workDir,
    "效果待核实",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId, effect_id: input.effect_id };
}

export interface DeliveredInput extends ExecutionTarget {
  deliverables: string[];
  evidence_refs: string[];
  verification?: { command: string; exit_code: number; output_ref?: string | null }[];
  untested?: string[];
  known_issues?: string[];
  diff_ref?: string | null;
  result_revision?: string | null;
  exit_code?: number | null;
  client_version?: string | null;
}

/** ⑩ 交付：执行结束的**实际**客户端/model/effort/workspace + 交付物与证据引用一起落回执 */
export async function recordDelivered(
  input: DeliveredInput,
  submitter: ClaimSubmitter,
  dataDir?: string,
): Promise<ExecutionOutcome<{ receipt: WorkReceipt; execution_id: string }>> {
  const ctx = receiptContext(input, dataDir);
  if (!ctx.ok) return ctx;
  const executionId = executionKey(input);
  const result = await submit(
    submitter,
    {
      target: input,
      type: "execution.delivered",
      entityId: executionEntityId(executionId),
      expectedRevision: input.expected_revision ?? ctx.executionRevision,
      idempotencyKey: `${executionId}:execution.delivered`,
      payload: runtimePayload(input, {
        actual_client_version: input.client_version ?? null,
        deliverables: input.deliverables,
        evidence_refs: input.evidence_refs,
        verification: input.verification ?? [],
        untested: input.untested ?? [],
        known_issues: input.known_issues ?? [],
        diff_ref: input.diff_ref ?? null,
        result_revision: input.result_revision ?? null,
        exit_code: input.exit_code ?? null,
        site_state: "ended",
        meaning:
          "执行结束并交了结果；任务结果仍要走 `submit_task_result` 的五查，且都不表示审计通过或人工验收接受（DESIGN.md §5.4）",
      }),
    },
    input,
    ctx.workDir,
    "交付",
  );
  if (!result.ok) return result;
  return { ok: true, receipt: result, execution_id: executionId };
}

// ══════════════════════ 三、读侧投影（把事件折成运行现场） ══════════════════════

export interface EffectRecord {
  effect_id: string;
  target: string;
  authorization: string;
  verify_method: string;
  external_idempotency_key: string | null;
  declared_at: string;
  status: "declared" | "confirmed" | "unverified";
  result_ref: string | null;
  check_evidence: string | null;
  confirmed_at: string | null;
  /** 该动作是否禁止自动重试（效果待核实 = true） */
  retry_blocked: boolean;
}

export interface HeartbeatRecord {
  at: string;
  awaiting_input: boolean;
  note: string | null;
}

export interface CheckpointRecord {
  at: string;
  note: string;
  artifacts: string[];
  worktree: { dirty: boolean; changed_files: string[]; head?: string | null } | null;
  effects_in_flight: string[];
  awaiting_input: boolean;
}

export interface ExecutionRecord {
  execution_id: string;
  task_id: string;
  run_id: string;
  attempt_id: string;
  attempt: number | null;
  claim_token: string;
  owner_id: string;
  /** 持有者角色（协作记录用；角色名不是安全凭证，§6.5） */
  owner_role: string;
  coordinator_id: string;
  client_id: string;
  model: string | null;
  effort: string | null;
  workspace: string;
  /** 项目 id（恢复/回执要按它解析项目目录，不能靠调用方记） */
  project_id: string;
  /** 变更批次 id（同一次变更下的执行归集用） */
  change_id: string;
  parent_execution_id: string | null;
  parent_run_id: string | null;
  /** 运行现场（§5.4 维度）；`unreachable` 由 livenessOf 派生，不在这里 */
  site_state: RunSiteState;
  /** 事件自报的 site_state（派生 field，便于对账） */
  last_submitted_state: RunSiteState;
  requested_at: string;
  started_at: string | null;
  client_version: string | null;
  pid: number | null;
  stopped_at: string | null;
  stop_confirmation: string | null;
  stop_confirmation_evidence: string[];
  failed: { phase: string; message: string; exit_code: number | null; stderr_tail: string | null } | null;
  delivered: {
    at: string;
    deliverables: string[];
    evidence_refs: string[];
    verification: { command: string; exit_code: number; output_ref?: string | null }[];
    untested: string[];
    known_issues: string[];
    diff_ref: string | null;
    result_revision: string | null;
    exit_code: number | null;
  } | null;
  heartbeats: HeartbeatRecord[];
  checkpoints: CheckpointRecord[];
  effects: EffectRecord[];
  event_ids: string[];
  /** 实体当前版本（下一次写的 expected_revision） */
  revision: number;
  updated_at: string;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** 从事件折出执行记录（纯函数；同一 execution_id 的事件按 seq 正序） */
export function foldExecutions(events: readonly WorkEvent[]): ExecutionRecord[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const byId = new Map<string, ExecutionRecord>();
  for (const e of sorted) {
    const executionId = executionIdOfEntity(e.entity_id);
    if (executionId === null) continue;
    if (!(EXECUTION_EVENT_TYPES as readonly string[]).includes(e.type)) continue;
    const p = e.payload;
    const existing = byId.get(executionId);
    const rec: ExecutionRecord =
      existing ??
      {
        execution_id: executionId,
        task_id: String(p.task_id ?? ""),
        run_id: String(p.run_id ?? ""),
        attempt_id: String(p.attempt_id ?? ""),
        attempt: numOrNull(p.attempt),
        claim_token: String(p.claim_token ?? ""),
        owner_id: String(p.owner_id ?? ""),
        owner_role: String(p.owner_role ?? e.role),
        project_id: e.project_id,
        change_id: e.change_id,
        coordinator_id: String(p.coordinator_id ?? ""),
        client_id: String(p.client_id ?? ""),
        model: strOrNull(p.model),
        effort: strOrNull(p.effort),
        workspace: String(p.workspace ?? ""),
        parent_execution_id: strOrNull(p.parent_execution_id),
        parent_run_id: strOrNull(p.parent_run_id),
        site_state: "start_requested",
        last_submitted_state: "start_requested",
        requested_at: e.received_at,
        started_at: null,
        client_version: null,
        pid: null,
        stopped_at: null,
        stop_confirmation: null,
        stop_confirmation_evidence: [],
        failed: null,
        delivered: null,
        heartbeats: [],
        checkpoints: [],
        effects: [],
        event_ids: [],
        revision: e.entity_revision,
        updated_at: e.received_at,
      };
    rec.revision = e.entity_revision;
    rec.updated_at = e.received_at;
    rec.event_ids = [...rec.event_ids, e.event_id];
    // 运行现场只由执行器自报的那几个事件推进（心跳/检查点带 site_state）
    const reported = strOrNull(p.site_state);
    if (reported !== null && (RUN_SITE_STATES as readonly string[]).includes(reported)) {
      rec.last_submitted_state = reported as RunSiteState;
      rec.site_state = reported as RunSiteState;
    }
    if (e.type === "execution.started") {
      const actual = isPlainObject(p.actual) ? p.actual : {};
      rec.started_at = strOrNull(p.started_at) ?? e.received_at;
      rec.client_version = strOrNull(actual.client_version);
      rec.pid = numOrNull(actual.pid);
      if (strOrNull(actual.model) !== null) rec.model = strOrNull(actual.model);
      if (strOrNull(actual.effort) !== null) rec.effort = strOrNull(actual.effort);
      if (strOrNull(actual.workspace) !== null) rec.workspace = strOrNull(actual.workspace) as string;
    } else if (e.type === "execution.heartbeat") {
      rec.heartbeats.push({
        at: strOrNull(p.observed_at) ?? e.received_at,
        awaiting_input: p.awaiting_input === true,
        note: strOrNull(p.note),
      });
    } else if (e.type === "execution.checkpoint") {
      rec.checkpoints.push({
        at: strOrNull(p.observed_at) ?? e.received_at,
        note: String(p.note ?? ""),
        artifacts: strList(p.artifacts),
        worktree: isPlainObject(p.worktree)
          ? {
              dirty: p.worktree.dirty === true,
              changed_files: strList(p.worktree.changed_files),
              head: strOrNull(p.worktree.head),
            }
          : null,
        effects_in_flight: strList(p.effects_in_flight),
        awaiting_input: p.awaiting_input === true,
      });
    } else if (e.type === "execution.stopped") {
      rec.stopped_at = e.received_at;
      rec.stop_confirmation = strOrNull(p.confirmation);
      rec.stop_confirmation_evidence = strList(p.evidence);
    } else if (e.type === "execution.failed") {
      const scene = isPlainObject(p.scene) ? p.scene : {};
      rec.failed = {
        phase: String(p.phase ?? ""),
        message: String(scene.message ?? ""),
        exit_code: numOrNull(scene.exit_code),
        stderr_tail: strOrNull(scene.stderr_tail),
      };
    } else if (e.type === "execution.delivered") {
      rec.delivered = {
        at: e.received_at,
        deliverables: strList(p.deliverables),
        evidence_refs: strList(p.evidence_refs),
        verification: Array.isArray(p.verification)
          ? (p.verification as Record<string, unknown>[]).map((v) => ({
              command: String(v.command ?? ""),
              exit_code: numOrNull(v.exit_code) ?? -1,
              output_ref: strOrNull(v.output_ref),
            }))
          : [],
        untested: strList(p.untested),
        known_issues: strList(p.known_issues),
        diff_ref: strOrNull(p.diff_ref),
        result_revision: strOrNull(p.result_revision),
        exit_code: numOrNull(p.exit_code),
      };
    } else if (e.type === "execution.effect_declared") {
      const effectId = String(p.effect_id ?? "");
      const next: EffectRecord = {
        effect_id: effectId,
        target: String(p.target ?? ""),
        authorization: String(p.authorization ?? ""),
        verify_method: String(p.verify_method ?? ""),
        external_idempotency_key: strOrNull(p.external_idempotency_key),
        declared_at: strOrNull(p.declared_at) ?? e.received_at,
        status: "declared",
        result_ref: null,
        check_evidence: null,
        confirmed_at: null,
        retry_blocked: false,
      };
      // 同一个 effect_id 重复声明（重试前的重新声明）：换成最新那条，不留两条同名效果
      rec.effects = [...rec.effects.filter((x) => x.effect_id !== effectId), next];
    } else if (e.type === "execution.effect_confirmed") {
      const effectId = String(p.effect_id ?? "");
      rec.effects = rec.effects.map((x) =>
        x.effect_id === effectId
          ? { ...x, status: "confirmed", result_ref: strOrNull(p.result_ref), confirmed_at: strOrNull(p.confirmed_at) ?? e.received_at, retry_blocked: false }
          : x,
      );
    } else if (e.type === "execution.effect_unverified") {
      const effectId = String(p.effect_id ?? "");
      rec.effects = rec.effects.map((x) =>
        x.effect_id === effectId
          ? { ...x, status: "unverified", check_evidence: strOrNull(p.check_evidence), retry_blocked: p.retry_blocked !== false }
          : x,
      );
    }
    byId.set(executionId, rec);
  }
  return [...byId.values()].sort(
    (a, b) => compareIsoTime(a.requested_at, b.requested_at) || a.execution_id.localeCompare(b.execution_id),
  );
}

/**
 * 盘上事件里的执行记录（只读；残缺尾行按 V06-01 口径隔离记录，不粘行）。
 * `events` 给定时直接折叠这份**同一 workDir 的**现读快照，不再读盘——来源一致性由调用方保证
 * （见 `statusProjection.EventsSnapshot`／`eventsOfSnapshot`，V09-30）；缺省仍现读，行为不变。
 */
export function readExecutions(workDir: string, events?: WorkEvent[]): ExecutionRecord[] {
  return foldExecutions(events === undefined ? loadEvents(workDir).events : events);
}

export function readExecution(workDir: string, executionId: string): ExecutionRecord | null {
  return readExecutions(workDir).find((r) => r.execution_id === executionId) ?? null;
}

export interface LivenessVerdict {
  state: "confirmed_alive" | "confirmed_stopped" | "unknown";
  /** 最后一次信号时间（心跳/检查点/启动/启动请求） */
  last_signal_at: string;
  /** 距最后信号多少毫秒（解析不了给 null） */
  silent_ms: number | null;
  /** 心跳是否超期（超期也只说明现场未知，**不**等于停止） */
  heartbeat_stale: boolean;
  site_state: RunSiteState;
  note: string;
  /** 确认停止的依据（没有就是 null） */
  confirmation: string | null;
}

/**
 * 取"真实时间最晚"的那条信号，返回**原来那个串**（出参形状与文案口径不变）。
 * 信号串的时区偏移不保证一致：产品自己写本地 `+08:00` 串，外部协调器/调用方可以给 UTC `…Z` 串；
 * 字符串字典序比的是**字面钟点**不是时刻（`2026-09-20T11:41+08:00` 字典序排在 `2026-09-20T10:00Z` 之后，
 * 真实时刻却早了 6 小时），一律解析成毫秒再比。实现在 `../time.latestByTime`（本仓唯一口径，
 * 与 live.ts / projects-summary.ts 同源）：解析不出来的串不参与比较，全都解析不出来 → 返回 null，
 * 由调用方退回 `requested_at`（下游 `Date.parse` 仍给 `silent_ms = null` → `heartbeat_stale = true`
 * → `unknown`：不声称活着、也不声称已停）。
 */
function latestSignalAt(times: readonly string[]): string | null {
  return latestByTime(times, (t) => t);
}

/**
 * 判活（无心跳不当已停止）：只有带确认依据的 `execution.stopped` 才算 `confirmed_stopped`；
 * 其余情况按"有没有近期信号"分成 `confirmed_alive` / `unknown`——`unknown` 一律带 `NO_HEARTBEAT_NOTE`。
 */
export function livenessOf(
  rec: ExecutionRecord,
  now: string = new Date().toISOString(),
  staleMs: number = DEFAULT_HEARTBEAT_STALE_MS,
): LivenessVerdict {
  const signalTimes = [
    rec.requested_at,
    rec.started_at,
    ...rec.heartbeats.map((h) => h.at),
    ...rec.checkpoints.map((c) => c.at),
  ].filter((t): t is string => typeof t === "string" && t !== "");
  const last = latestSignalAt(signalTimes) ?? rec.requested_at;
  const at = Date.parse(last);
  const atNow = Date.parse(now);
  const silent = Number.isNaN(at) || Number.isNaN(atNow) ? null : atNow - at;
  const stale = silent === null ? true : silent > staleMs;
  if (rec.stopped_at !== null && (rec.stop_confirmation ?? "") !== "") {
    return {
      state: "confirmed_stopped",
      last_signal_at: last,
      silent_ms: silent,
      heartbeat_stale: stale,
      site_state: "stopped",
      note: `停止已确认：${rec.stop_confirmation}`,
      confirmation: rec.stop_confirmation,
    };
  }
  if (rec.stopped_at !== null && (rec.stop_confirmation ?? "") === "") {
    return {
      state: "unknown",
      last_signal_at: last,
      silent_ms: silent,
      heartbeat_stale: stale,
      site_state: "stop_requested",
      note: `现场有一条停止事件但**没有确认依据**：按未确认处理。${NO_HEARTBEAT_NOTE}`,
      confirmation: null,
    };
  }
  const ended = rec.delivered !== null || rec.failed !== null;
  return {
    state: stale || ended ? "unknown" : "confirmed_alive",
    last_signal_at: last,
    silent_ms: silent,
    heartbeat_stale: stale,
    site_state: ended ? "ended" : stale ? "unreachable" : rec.site_state,
    note: stale || ended
      ? ended
        ? `执行已结束但**停止未确认**（交付/失败事件都不证明进程没了）：${NO_HEARTBEAT_NOTE}`
        : NO_HEARTBEAT_NOTE
      : `最近有信号（${last}）：运行现场按运行中/等待输入处理`,
    confirmation: null,
  };
}

export interface DispatchGuard {
  allowed: boolean;
  code: "OK" | "STOP_NOT_CONFIRMED_SAME_WORKSPACE" | "WORKSPACE_NOT_ISOLATED";
  message: string;
  /** 建议的新工作目录（隔离；不允许复用旧目录时给这个） */
  suggested_workspace: string;
  /** 复用旧可写目录需要先做什么（逐条） */
  prerequisites: string[];
  liveness: LivenessVerdict;
}

/**
 * 派发闸门（§5.4「没有实际确认不能重派到同一可写目录」）：
 * 要往**同一个可写目录**派新执行，必须有"停止已确认"；否则只允许换隔离目录。
 */
export function dispatchGuard(input: {
  rec: ExecutionRecord;
  target_workspace: string;
  now?: string;
  staleMs?: number;
}): DispatchGuard {
  const live = livenessOf(input.rec, input.now, input.staleMs);
  const sameWorkspace = path.resolve(input.rec.workspace) === path.resolve(input.target_workspace);
  const nextAttempt = (input.rec.attempt ?? 1) + 1;
  const suggested = defaultWorkspace(input.rec.task_id, `att-${input.rec.task_id}-${nextAttempt}-isolated`);
  if (!sameWorkspace) {
    return {
      allowed: true,
      code: "OK",
      message: `目标目录与旧 run 不同（旧 ${input.rec.workspace} → 新 ${input.target_workspace}）：隔离成立，可派`,
      suggested_workspace: input.target_workspace,
      prerequisites: [],
      liveness: live,
    };
  }
  if (live.state === "confirmed_stopped") {
    return {
      allowed: true,
      code: "OK",
      message: `旧 run 停止已确认（${live.confirmation}）：同一可写目录可以再派`,
      suggested_workspace: input.target_workspace,
      prerequisites: [],
      liveness: live,
    };
  }
  return {
    allowed: false,
    code: "STOP_NOT_CONFIRMED_SAME_WORKSPACE",
    message: `${STOP_UNCONFIRMED_NOTE}（旧 run ${input.rec.execution_id} 判活=${live.state}，最后信号 ${live.last_signal_at}）`,
    suggested_workspace: suggested,
    prerequisites: [
      "先核实旧进程是否还在（PID/进程树/文件活动），把结论与依据落成停尸证据",
      `确认已停止后写 execution.stopped（带 confirmation），同一目录才可再派`,
      `否则把新 attempt 落到隔离目录：${suggested}`,
      "未提交改动先保存现场再判断，不清空旧 run 的工作",
    ],
    liveness: live,
  };
}

// ══════════════════════ 四、恢复核对（§5.4 故障恢复顺序 + 先查实际效果） ══════════════════════

export interface ProcessObservation {
  state: "alive" | "gone" | "unknown";
  /** 怎么查的（必填；"查不到"要如实说查法） */
  checked_by: string;
  evidence: string[];
}

export interface WorkspaceObservation {
  exists: boolean;
  dirty: boolean;
  changed_files: string[];
  head: string | null;
  errors: string[];
}

export interface EffectObservation {
  effect_id: string;
  status: "effective" | "not_effective" | "unverifiable";
  result_ref: string | null;
  checked_by: string;
  evidence: string;
}

export interface TaskObservation {
  revision: number | null;
  status: string | null;
  claim_token: string | null;
  owner_id: string | null;
  lease_expires_at: string | null;
}

/**
 * 恢复用的**现场探针**（注入点）：三个都必须是**真查**——
 * 查不清就返回 `unknown`，绝不为了"看起来干净"把未知说成已停止（§5.4）。
 */
export interface ExecutionProbe {
  process(rec: ExecutionRecord): ProcessObservation | Promise<ProcessObservation>;
  workspace(rec: ExecutionRecord): WorkspaceObservation | Promise<WorkspaceObservation>;
  /** 按声明里的核实方法查外部动作的实际效果（**恢复时先查这个**） */
  effect(effect: EffectRecord, rec: ExecutionRecord): EffectObservation | Promise<EffectObservation>;
  task?(rec: ExecutionRecord): TaskObservation | null | Promise<TaskObservation | null>;
}

export interface RecoveryStepNote {
  step: RecoveryStep;
  label: string;
  observed: string;
  decision: string;
}

export interface RecoveryPlan {
  project_id: string;
  execution_id: string;
  task_id: string;
  run_id: string;
  attempt_id: string;
  attempt: number | null;
  workspace: string;
  liveness: LivenessVerdict;
  last_checkpoint: CheckpointRecord | null;
  process: ProcessObservation;
  workspace_state: WorkspaceObservation;
  task_state: TaskObservation;
  effects: {
    effect: EffectRecord;
    observation: EffectObservation;
    decision: string;
  }[];
  /** 故障恢复顺序逐步的现场与结论（§5.4 七步 + 先查实际效果） */
  steps: RecoveryStepNote[];
  /** 旧 run 是否仍有写入可能 */
  old_run_write_possible: "yes" | "no" | "unknown";
  verdict: "resume_same_workspace" | "new_attempt_new_workspace" | "await_effect_verification" | "closed";
  /** 盲重放是否被挡（结果不明 → true） */
  blind_replay_blocked: boolean;
  blind_replay_reasons: string[];
  /** 可继承的成果/证据（旧检查点里点过名、且仍留在工作树现场的） */
  inheritable_artifacts: string[];
  /** 检查点之后又被改过的那部分成果（绑定版本已变，沿用前要重新验证，§5.6） */
  changed_since_checkpoint: string[];
  next_attempt: { attempt: number; workspace: string; workspace_reused: boolean } | null;
  dispatch: DispatchGuard;
  read_again: string;
}

/**
 * 恢复核对：**先读最后检查点，再查外部动作的实际效果**，然后按 §5.4 的顺序逐条核对
 * 旧进程是否仍有写入可能、工作树与基线、成果/证据有效性、旧认领，最后给出新 attempt 与是否允许重放。
 * 结果不明（进程 unknown / 效果 unverifiable）时 `blind_replay_blocked = true`。
 */
export async function planRecovery(input: {
  project_id: string;
  execution_id: string;
  probe: ExecutionProbe;
  /** 打算派到哪个目录（缺省 = 旧目录，用于算派发闸门） */
  target_workspace?: string;
  dataDir?: string;
  now?: string;
  stale_ms?: number;
}): Promise<ExecutionOutcome<{ plan: RecoveryPlan }>> {
  const workDir = workDirOf(input.project_id, input.dataDir);
  const rec = readExecution(workDir, input.execution_id);
  if (rec === null) {
    return reject(
      "EXECUTION_UNKNOWN",
      `事件现场里没有执行 ${input.execution_id}：先确认 execution_id（或它压根没提过启动请求）`,
      [`未知执行 ${input.execution_id}`],
      null,
      `读 ${path.join(workDir, "events.jsonl")} 里 entity_id=execution:${input.execution_id} 的事件`,
    );
  }
  const now = input.now ?? new Date().toISOString();
  const live = livenessOf(rec, now, input.stale_ms);
  const steps: RecoveryStepNote[] = [];

  // ① 读最后检查点
  // 检查点的 `at` 来自调用方 `observed_at`（偏移任意，也可能解析不出来）：按**真实时刻**取最晚的。
  // 全部分辨不出真实时刻时**不指定断点基线**（不把一条时间非法的检查点当成"最后"）。
  const lastCheckpoint = latestByTime(rec.checkpoints, (c) => c.at);
  steps.push({
    step: "read_last_checkpoint",
    label: RECOVERY_STEP_LABELS.read_last_checkpoint,
    observed:
      lastCheckpoint === null
        ? rec.checkpoints.length === 0
          ? "没有检查点：只能按启动/心跳记录与工作树现场判断"
          : `有 ${rec.checkpoints.length} 条检查点，但时间戳都解析不出真实时刻：不以其中任何一条当断点基线，改按启动/心跳记录与工作树现场判断`
        : `${lastCheckpoint.at}：${lastCheckpoint.note}（成果 ${lastCheckpoint.artifacts.length} 项；在飞动作 ${
            lastCheckpoint.effects_in_flight.length
          } 个）`,
    decision: lastCheckpoint === null ? "无检查点可用，后续判断全靠现场核对" : "以这条检查点为断点基线，后续核对不越过它在飞的动作",
  });

  // ② 先查外部动作的实际效果（幂等上报不保证只执行一次）
  const effects: RecoveryPlan["effects"] = [];
  const replayReasons: string[] = [];
  /** 只装"外部效果查不清"这类理由：它决定"先核实效果再动"，与"换隔离目录"是两回事 */
  const effectReasons: string[] = [];
  for (const effect of rec.effects) {
    const observation = await input.probe.effect(effect, rec);
    let decision = "";
    if (observation.status === "effective") {
      decision = `动作已发生（结果标识 ${observation.result_ref ?? "未给"}）：**补交回执**，不重放`;
    } else if (observation.status === "not_effective") {
      decision =
        effect.external_idempotency_key === null
          ? "动作没有发生：可以重试，但外部系统没有幂等键，重试前先确认不会重复产生副作用"
          : `动作没有发生：重试时复用外部幂等键 ${effect.external_idempotency_key}`;
    } else {
      decision = `${EFFECT_UNVERIFIED_NOTE}（核实方法：${effect.verify_method}；实际怎么查的：${observation.checked_by}）`;
      replayReasons.push(`效果 ${effect.effect_id} 待核实（${observation.checked_by}）：结果不明不盲重放`);
      effectReasons.push(`效果 ${effect.effect_id} 待核实（${observation.checked_by}）：结果不明不盲重放`);
    }
    // `retry_blocked` 只在**这次也没查清**时才继续挡：恢复时查清了（已发生/没发生）就该按查得的结论走
    if (effect.retry_blocked && observation.status === "unverifiable") {
      replayReasons.push(`效果 ${effect.effect_id} 曾被标记为待核实且仍查不清：暂停该动作的自动重试`);
      effectReasons.push(`效果 ${effect.effect_id} 曾被标记为待核实且仍查不清：暂停该动作的自动重试`);
    }
    effects.push({ effect, observation, decision });
  }
  const inFlight = lastCheckpoint?.effects_in_flight ?? [];
  for (const id of inFlight) {
    if (!rec.effects.some((e) => e.effect_id === id)) {
      replayReasons.push(`检查点里点名的在飞动作 ${id} 没有对应的效果声明：动作是否发生不明，恢复前先查清`);
      effectReasons.push(`检查点里点名的在飞动作 ${id} 没有对应的效果声明：动作是否发生不明，恢复前先查清`);
    }
  }
  steps.push({
    step: "query_effect",
    label: RECOVERY_STEP_LABELS.query_effect,
    observed:
      rec.effects.length === 0
        ? "这个执行没有任何外部动作声明"
        : rec.effects
            .map((e) => `${e.effect_id}→${effects.find((x) => x.effect.effect_id === e.effect_id)?.observation.status ?? "?"}`)
            .join("；"),
    decision:
      rec.effects.length === 0
        ? "无需查效果，可继续核对进程与工作树"
        : effects.map((e) => e.decision).join(" / "),
  });

  // ③ 旧 run 是否仍有写入可能（进程 + 判活）
  const process = await input.probe.process(rec);
  const writePossible: RecoveryPlan["old_run_write_possible"] =
    process.state === "alive" ? "yes" : process.state === "gone" ? (live.state === "confirmed_stopped" ? "no" : "unknown") : "unknown";
  if (process.state !== "gone") {
    replayReasons.push(
      process.state === "alive"
        ? `旧进程还在（${process.checked_by}）：同一个可写目录不能再派，也不重放旧 run 的动作`
        : `旧进程查不清（${process.checked_by}）：${NO_HEARTBEAT_NOTE}`,
    );
  }
  steps.push({
    step: "old_run_write_possible",
    label: RECOVERY_STEP_LABELS.old_run_write_possible,
    observed: `进程观察=${process.state}（查法：${process.checked_by}）；判活=${live.state}；最后信号 ${live.last_signal_at}`,
    decision:
      writePossible === "yes"
        ? "旧 run 仍可能写入：先终止并取得停止确认，再谈继续"
        : writePossible === "no"
          ? "旧 run 已确认停止：不再有写入可能"
          : `写入可能未知：${NO_HEARTBEAT_NOTE}`,
  });

  // ④ 工作树与基线
  const workspaceState = await input.probe.workspace(rec);
  const dirtyNote = workspaceState.dirty
    ? `有未提交改动（${workspaceState.changed_files.length} 个文件）：先保存现场再判断，不清空`
    : "没有未提交改动";
  steps.push({
    step: "worktree_baseline",
    label: RECOVERY_STEP_LABELS.worktree_baseline,
    observed: workspaceState.exists
      ? `工作目录存在（head=${workspaceState.head ?? "未知"}）：${dirtyNote}${workspaceState.errors.length > 0 ? `；读取问题：${workspaceState.errors.join("；")}` : ""}`
      : "工作目录已经不存在（旧 run 没留下工作树）",
    decision: workspaceState.dirty ? "未提交改动按现场保留，判断沿用还是重做" : "工作树干净，可直接接续或换隔离目录",
  });

  // ⑤ 成果/证据有效性与旧认领
  // 检查点点名的成果只要**还在工作树现场**就算可继承（未提交改动本来就按现场保留）；
  // 检查点之后又被改过的那部分另标出来——绑定版本已变，沿用前要重新验证（§5.6）。
  const declared = lastCheckpoint?.artifacts ?? [];
  const inheritable = workspaceState.exists ? [...declared] : [];
  const changedSinceCheckpoint = declared.filter((a) => workspaceState.changed_files.includes(a));
  const taskState = (await input.probe.task?.(rec)) ?? null;
  steps.push({
    step: "result_evidence_validity",
    label: RECOVERY_STEP_LABELS.result_evidence_validity,
    observed:
      declared.length === 0
        ? "没有点名的成果"
        : `${declared.length} 项点名成果，${inheritable.length} 项仍在工作树现场，其中 ${changedSinceCheckpoint.length} 项在检查点之后又被改过`,
    decision:
      inheritable.length === 0
        ? "没有留在现场的成果：按新 attempt 重做"
        : changedSinceCheckpoint.length > 0
          ? "可继承的成果里有检查点之后又被改过的：绑定版本已变，沿用前要重新验证（§5.6）"
          : "点名成果仍在现场且没被后续改动碰过：可沿用（§5.6 仍以版本有效为前提）",
  });
  const staleClaim = taskState === null
    ? "读不到任务现场"
    : taskState.claim_token === rec.claim_token
      ? `任务仍持本次认领（token ${String(taskState.claim_token).slice(0, 12)}…，租约到 ${taskState.lease_expires_at ?? "未知"}）`
      : `任务当前认领已不是旧 run 的 token（现场 ${taskState.claim_token === null ? "没有有效认领" : `${String(taskState.claim_token).slice(0, 12)}…`}）：旧认领已失效`;
  steps.push({
    step: "stale_claim",
    label: RECOVERY_STEP_LABELS.stale_claim,
    observed: staleClaim,
    decision:
      taskState === null
        ? "任务现场读不到：不派新执行，先把现场读出来"
        : taskState.claim_token === rec.claim_token
          ? "旧认领还在：接手要先处理它（释放或带 takeover_basis 重派）"
          : "旧认领已失效：可直接走重派流程（仍要满足隔离/停止确认）",
  });

  // ⑥ 新 attempt + 派发闸门
  // 闸门先按事件里的停止确认算（`dispatchGuard`），再用**恢复探针的现场**压一道：
  // 现场说进程还在/查不清时，事件里的"停止已确认"不能压过现场——同一个可写目录一律不派（§5.4）。
  const target = input.target_workspace ?? rec.workspace;
  const baseDispatch = dispatchGuard({ rec, target_workspace: target, ...(input.now === undefined ? {} : { now: input.now }), ...(input.stale_ms === undefined ? {} : { staleMs: input.stale_ms }) });
  const sameWorkspace = path.resolve(target) === path.resolve(rec.workspace);
  const probeOverrides = sameWorkspace && process.state !== "gone";
  const dispatch: DispatchGuard = probeOverrides
    ? {
        allowed: false,
        code: baseDispatch.allowed ? "STOP_NOT_CONFIRMED_SAME_WORKSPACE" : baseDispatch.code,
        message: `${STOP_UNCONFIRMED_NOTE}（恢复探针现场：进程观察=${process.state}，查法：${process.checked_by}）`,
        // 现场说进程还在时，事件里的"已确认停止"作废 → 隔离目录重新算，不沿用 baseDispatch 的"可复用"
        suggested_workspace: defaultWorkspace(rec.task_id, `att-${rec.task_id}-${(rec.attempt ?? 1) + 1}-isolated`),
        prerequisites: baseDispatch.prerequisites,
        liveness: baseDispatch.liveness,
      }
    : baseDispatch;
  const nextAttemptNo = (rec.attempt ?? 1) + 1;
  const nextWorkspace = dispatch.allowed ? target : dispatch.suggested_workspace;
  const workspaceReused = path.resolve(nextWorkspace) === path.resolve(rec.workspace);
  steps.push({
    step: "new_attempt",
    label: RECOVERY_STEP_LABELS.new_attempt,
    observed: `第 ${rec.attempt ?? 1} 次尝试 → 第 ${nextAttemptNo} 次；目标目录 ${target}；派发闸门 ${dispatch.code}`,
    decision: dispatch.allowed
      ? `可以在 ${nextWorkspace} 建立新 attempt（${workspaceReused ? "复用旧目录，已确认停止" : "隔离目录"}）`
      : `${dispatch.message}；新 attempt 落到隔离目录 ${nextWorkspace}`,
  });

  const blocked = replayReasons.length > 0;
  // 判定顺序：**效果查不清**先挡住（先核实再动，不盲重放）→ 旧 run 仍可能写入/写入可能未知就换隔离目录 →
  // 已确认停止 + 无在飞动作 + 工作树干净 + 已有交付/失败结果 = 旧 run 收口 → 否则按现场继续。
  const verdict: RecoveryPlan["verdict"] = effectReasons.length > 0
    ? "await_effect_verification"
    : writePossible !== "no" || !dispatch.allowed
      ? "new_attempt_new_workspace"
      : (rec.delivered !== null || rec.failed !== null) && !workspaceState.dirty
        ? "closed"
        : "resume_same_workspace";
  steps.push({
    step: "continue",
    label: RECOVERY_STEP_LABELS.continue,
    observed: `盲重放闸门=${blocked ? "已挡" : "未挡"}；判活=${live.state}；派发=${dispatch.code}`,
    decision:
      verdict === "await_effect_verification"
        ? `${EFFECT_UNVERIFIED_NOTE}`
        : verdict === "new_attempt_new_workspace"
          ? "换隔离目录建新 attempt 继续；旧目录的未提交改动保留现场"
          : verdict === "closed"
            ? "旧 run 已收口（停止确认 + 无在飞动作）：无需重放"
            : "可在现场继续；仍要按新 attempt 复核任务版本与依赖",
  });

  return {
    ok: true,
    plan: {
      project_id: input.project_id,
      execution_id: rec.execution_id,
      task_id: rec.task_id,
      run_id: rec.run_id,
      attempt_id: rec.attempt_id,
      attempt: rec.attempt,
      workspace: rec.workspace,
      liveness: live,
      last_checkpoint: lastCheckpoint,
      process,
      workspace_state: workspaceState,
      task_state: taskState ?? { revision: null, status: null, claim_token: null, owner_id: null, lease_expires_at: null },
      effects,
      steps,
      old_run_write_possible: writePossible,
      verdict,
      blind_replay_blocked: blocked,
      blind_replay_reasons: replayReasons,
      inheritable_artifacts: inheritable,
      changed_since_checkpoint: changedSinceCheckpoint,
      next_attempt: { attempt: nextAttemptNo, workspace: nextWorkspace, workspace_reused: workspaceReused },
      dispatch,
      read_again: `读现场：${path.join(workDir, "events.jsonl")}（execution:${rec.execution_id}）；任务认领 ${path.join(workDir, "state.json")}`,
    },
  };
}
