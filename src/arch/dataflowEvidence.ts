// 数据流向图「可复跑实测」档的**只读运行证据适配器**（V09-61；finding f-4c71d59ab5552d36）。
//
// 为什么需要（根因）：
//   修复前，`src/arch/dataflow.ts#resolveMeasured` 只要「脚本文件在 + 登记在 package.json + 脚本正文含定位片段」
//   就给出 `tier: "code_measured"`，于是任何脚本——哪怕它跑起来 exit 1、哪怕它从没被真跑过、哪怕它覆盖的源码
//   已经变了——都会被判「可复跑实测 / 已验证」。这是**假绿**：脚本存在是"能复跑"的线索，不是"真的跑过且通过"的证据。
//
// 2026-10-08 复审返工（本文件第二轮）：第一版只扫 `evidence/` 目录里任意 `kind=self_check/independent_audit`
// 的小正文、看 `exit_code=0` 就采信——但 **`store` 能把任意正文落成证据**，它**不核**有没有一条**正式审计记录
//   真的引用并采信**这条运行事实。于是"孤立自报的 blob"也能造绿：那不等于真实运行事实。第二轮把采信起点改成
//   **既有正式 `self_check` / `independent_audit`（审计/复测）记录的引用**，并按既有**唯一证据规则**核有效性。
//
// 2026-10-08 复审返工（本文件第三轮，本文件）——修「先筛载体再选记录，真失败被绕过」的假绿：
//   第二轮的实现**先把"证据正文不是 measured_run 载体"的检查整条剔除，才拿剩下的成功子集去 `pickCheckRecords`**。
//   于是「正式自检 pass（被引用的是真载体）+ 同一 check 的正式独审 failed（引用的只是**普通原始日志**，
//   不是 measured_run 载体）」时，失败那条在选记录之前就被删掉，独立失败否决位根本不存在 → 图仍 `verified`。
//   实证现场：`.工作台/project-completion-20261008/probe-measured-plain-failure.ts` → `measured-plain-failure-probe.json`。
//   本轮把顺序倒过来，改为**先对所有相关 spec 的正式检查记录做唯一判据挑选/否决，再验证最终成功 winner 的载体**：
//     · 失败与 unknown **不因"载体不是 measured_run"或"缺 evidence 字段"被删除**——它们照样进 `pickCheckRecords`
//       参与独立失败否决；只有**通过了**的 winner 才需要去核载体；
//     · 分组键是 **`object_id + check_id`**（`check_id` 在项目里不是全局唯一）：作者集合与复测解除都只在
//       同一被审对象内生效，不同对象的同名检查**不互相串**；
//     · 选出的 winner **本体**（可能是 `pickCheckRecords` 返回的 `resolution_note` 克隆）直接用来判有效性，
//       不再 `list.find(...) ?? list[0]` 把"找不到"悄悄回退成第一条；
//     · 作者集合**按同一被审对象取**（某对象上的自检者才是该对象的作者），不拿"全项目任一做过 selfcheck 的人"
//       降级——否则别人在**别的任务**做过自检，会把本任务真非作者的独立审计错误降级、独立失败否决被撤销。
//
// 本模块只做一件事：把「当前项目里**被正式记录引用、内容未被篡改、绑定的源码与声明定义当前未变、且没有未解除的
//   独立失败压过它**的成功运行记录」读成一张只读索引（`MeasuredRunIndex`），交给 `dataflow.ts` 判 `code_measured`。
//   它**不跑任何测试**、**不写盘**、**不新增第二账本**、**不做跨请求有状态缓存**（只在一次同步派生内复用，
//   见 derivationScope）。
//
// ═══════════════════════ 真实成功闭环（唯一写服务的正式协议） ═══════════════════════
// 判「可复跑实测」必须**同时**成立（缺一即降为 `code_static` 可复跑线索，绝不标「已验证」）：
//   ① **正式引用**：存在一条**正式的** `audit.self_check_recorded`（作者自检）或
//      `audit.independent_audit_recorded`（非作者审计）记录，其 `checks[]` 条目：
//        · `check_id` = 数据流声明里的 measured 条目 id（`df-measured-…`；**显式映射**，不按脚本名字猜）；
//        · `evidence_sha256` 指向**本次运行记录载体**（见 ②）；
//        · `verifies = "code"`、`binding = { revision_kind:"code", revision:<源清单指纹> }`。
//      **`store` 单独落一份正文不算数**——没有正式记录引用它，本适配器根本不会读到它（孤立自报 blob 不造绿）。
//   ② **运行记录载体**（一份 `kind: "source_manifest"` 不可变证据，内容寻址 `<workDir>/evidence/<sha256>.json`）：
//      其 `content` 是一个 JSON 对象（`sha256(content) == 文件名`，读时复核），形状：
//        { "kind":"measured_run", "version":1,
//          "run_id":"<本次运行唯一标识>",        // 必需：同源重跑也有新 id，避免内容寻址与旧记录相撞
//          "spec_ids":["df-measured-…"],        // 必需：本次运行**显式**证明哪些 measured 条目
//          "script":"scripts/verify-….ts",      // 必需：真跑的脚本（项目根内相对路径）
//          "declaration_sha256":"<纯声明定义哈希>", // 必需：本次运行证明的**声明定义**（见 ⑤）
//          "command":"pnpm verify:…",           // 可选：人可核到的复跑命令
//          "exit_code":0,                       // 必需：退出码；只有 0 才算成功
//          "output_summary":"…" }               // 可选：原始输出摘要（人话）
//      同一份载体还带 `source_manifest`（**有限**源码集合 + 内容哈希，由唯一写服务**登记时现读**算出）。
//   ③ 该正式检查**当前有效通过**（复用 `statusProjection.checkEffectiveness`：源清单现读 `valid` 且绑定一致、
//      带 `command` 的机械检查退出码 0、有证据或有方法说明；**没有**可采信来源的旧检查一律 `unknown` 待复核）。
//   ④ **没有未解除的独立失败**压过它（复用 `statusProjection.pickCheckRecords`：同 `object_id`+`check_id` 的
//      有效独立失败永远压住旧的通过；失败要解除必须有合法修复 + 非作者复测闭环；作者换个写法冒充独立审计会被
//      按写法归一降级）。同一条目有多份记录时，取**正式记录次序**（账本 seq）与有效性选出的那份，不按哈希大小
//      或任意旧 pass 选绿。
//   ⑤ **声明定义绑定**：运行记录声明的 `declaration_sha256` 必须等于**当前解析出的数据流声明的纯声明定义哈希**
//      （`dataflow.ts#dataFlowDefinitionSha256`——只覆盖声明内容，**不含运行证据指纹**，故不形成 identity 循环）。
//      声明改了 spec 证明范围/关系语义而源码与脚本没变时，旧记录 **不得**继续冒充"证的是新定义"。
//   ⑥ 运行记录声明的 `script` 与条目一致、`exit_code === 0`、条目 `spec_id` 真在 `spec_ids` 里；覆盖面由
//      `dataflow.ts` 按「被测节点/边的代码 claims + 明确声明的真实依赖 + package 绑定」逐条核（见那里 `requiredSourcesOf`）。
//
// 发现方式与代价边界（如实交代，不藏）：
//   · **不遍历证据目录**：候选来自正式记录 `checks[].evidence_sha256` 指向的**内容地址精读**；且只在
//     `check_id` 形如 `df-measured-…` 时读那份正文（其余检查零额外 I/O）。
//   · 事件账本读不出来 / 证据正文被改过/截损 / 载体不是 source_manifest / 正文不是运行记录——一律如实记进
//     `notes` 与对应条目的 `rejected`，**不伪造任何"通过"**；被拒事实进 `fingerprint`（无有效候选时也是），
//     无关证据增删**不 churn**。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { memoizedForDerivation } from "../server/work/derivationScope";
import { readAuditRecords, type AuditRecords, type SelfCheckRecord, type IndependentAuditRecord } from "../server/work/audit";
import {
  checkEffectiveness,
  checksWithSourceManifests,
  pickCheckRecords,
  type CheckInput,
  type SourceRevisions,
} from "../server/work/statusProjection";
import { MAX_SOURCE_MANIFEST_BLOB_BYTES, readManifestCarrier } from "../server/work/sourceEvidence";

/** 运行记录标记（载体正文 `content` 里的 `kind`） */
export const MEASURED_RUN_KIND = "measured_run";
/** 协议版本（改这里就是改"什么算同一条运行记录"） */
export const MEASURED_RUN_VERSION = 1;
/** 受检的正式检查 id 前缀：`<前缀><measured 条目 id>`——**显式映射**，不按脚本名字猜 */
export const DF_MEASURED_CHECK_PREFIX = "df-measured-";
/** 运行记录载体正文的体积上限（与源清单载体同口径；超过它的不是运行记录，不解析） */
export const MAX_MEASURED_RUN_BLOB_BYTES = MAX_SOURCE_MANIFEST_BLOB_BYTES;

/** 证据/账本相对项目根的约定位置（与 `src/server/work/` 同一布局；本模块只读，不 import 写侧依赖链） */
export const WORK_REL = [".工作台", "work"].join("/");

const SHA256_HEX = /^[0-9a-f]{64}$/;
const NO_ACTORS: ReadonlySet<string> = new Set<string>();

/** 一条运行记录引用的源清单**现读**结论（`valid` 才可用于判实测） */
export interface MeasuredRunManifestState {
  /** 载体证据的内容地址（与运行记录同一份） */
  evidence_id: string;
  fingerprint: string;
  status: "valid" | "invalidated" | "unreadable";
  reason: string;
  /** `valid` 时 = 载体登记的文件集合（路径 + 内容哈希）；非 valid 时为空数组（不采信） */
  files: { path: string; sha256: string }[];
}

/** 一条 measured 条目的判决（只读；不改任何状态） */
export interface MeasuredRunVerdict {
  spec_id: string;
  /** 生效记录的被审对象（`checks[].object_id`＝记录 `task_id`）——同 check_id 不同对象不互相串 */
  object_id: string;
  /** 生效的正式检查记录实体 id（`check:<id>` / `audit:<id>`）——供追溯"依据来自哪条记录" */
  record_ref: string;
  /** 运行记录载体的内容地址（证据 id） */
  evidence_id: string;
  script: string;
  command: string | null;
  exit_code: number;
  run_id: string | null;
  /** 运行记录绑定的纯声明定义哈希（无它 = 没绑定定义，**不得**判实测） */
  declaration_sha256: string | null;
  /** 该正式检查当前是否有效（`checkEffectiveness` 的 `effective`） */
  effective: "passed" | "failed" | "stale" | "unknown" | "not_checked";
  /** 被验的源清单现读结论（没引用/载体不可用 = null） */
  manifest: MeasuredRunManifestState | null;
  /** 是否可据此判「可复跑实测」：正式检查有效通过 + 清单现读 valid + 运行 exit 0 + 声明定义一致 + spec 命中 + 无未解除独立失败 */
  verdict_ok: boolean;
  /** 不成立的原因（`verdict_ok === false` 时非空） */
  reasons: string[];
  /** 同一 `spec_id` 下**未生效**候选的显式披露（被独立失败压过 / 被拒 / 未知） */
  rejected: string[];
}

export interface MeasuredRunIndex {
  /** 内容驱动的稳定指纹（无相关运行记录 = 恒定常量；任何生效判决/其清单/覆盖源/**被拒事实**变化都会换指纹） */
  fingerprint: string;
  /** spec_id → 该条目的判决（同一条目有多份记录时取正式次序与有效性选出的那份） */
  verdicts: ReadonlyMap<string, MeasuredRunVerdict>;
  /** 发现过程中的如实说明（账本缺失 / 被拒候选 / 未采信），逐条可读 */
  notes: string[];
}

/** 读运行证据索引的只读选项 */
export interface ReadMeasuredRunIndexOptions {
  /**
   * 当前解析出的数据流声明的**纯声明定义哈希**（`dataflow.ts#dataFlowDefinitionSha256`）。
   * 给了它就要求运行记录声明的 `declaration_sha256` 与之一致；**缺省（undefined）= fail-closed**：
   * 没有可对照的当前定义 ⇒ 不判实测（防止"证的是旧定义"的记录继续冒充）。声明本身不含运行证据指纹，故无循环。
   */
  declarationDefinitionSha?: string;
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 空索引（无正式运行记录 / 无法读取）——指纹恒定，保证同输入下快照身份稳定 */
export function emptyMeasuredRunIndex(note?: string): MeasuredRunIndex {
  return {
    fingerprint: sha256Hex("df-measured-runs:none").slice(0, 32),
    verdicts: new Map(),
    notes: note === undefined ? [] : [note],
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 运行记录正文解析结果 */
interface ParsedRunRecord {
  run_id: string;
  spec_ids: string[];
  script: string;
  declaration_sha256: string;
  command: string | null;
  exit_code: number;
  output_summary: string | null;
}

/** 解析运行记录正文（严格：形状/类型不合格返回 error；不静默丢弃、不当通过） */
function parseRunRecord(content: string): { record: ParsedRunRecord } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { error: "正文不是合法 JSON" };
  }
  if (!isPlainObject(raw)) return { error: "正文不是 JSON 对象" };
  if (raw.kind !== MEASURED_RUN_KIND) return { error: `正文 kind 不是 ${MEASURED_RUN_KIND}（收到 ${JSON.stringify(raw.kind)}）` };
  if (raw.version !== undefined && raw.version !== MEASURED_RUN_VERSION) {
    return { error: `协议版本不支持：${JSON.stringify(raw.version)}（只支持 ${MEASURED_RUN_VERSION}）` };
  }
  if (typeof raw.run_id !== "string" || raw.run_id.trim() === "") return { error: "run_id 必须是非空字符串（同源重跑也要有新 id）" };
  if (!Array.isArray(raw.spec_ids) || raw.spec_ids.length === 0 || !raw.spec_ids.every((s) => typeof s === "string" && s.trim() !== "")) {
    return { error: "spec_ids 必须是非空字符串数组（显式映射，不能靠脚本名字猜）" };
  }
  if (typeof raw.script !== "string" || raw.script.trim() === "") return { error: "script 必须是非空字符串" };
  if (typeof raw.declaration_sha256 !== "string" || raw.declaration_sha256.trim() === "") {
    return { error: "declaration_sha256 必须是非空字符串（运行记录必须绑定它证明的声明定义；无绑定 = 不得判实测）" };
  }
  if (typeof raw.exit_code !== "number" || !Number.isFinite(raw.exit_code)) return { error: "exit_code 必须是数字" };
  return {
    record: {
      run_id: raw.run_id,
      spec_ids: raw.spec_ids as string[],
      script: raw.script,
      declaration_sha256: raw.declaration_sha256,
      command: typeof raw.command === "string" && raw.command !== "" ? raw.command : null,
      exit_code: raw.exit_code,
      output_summary: typeof raw.output_summary === "string" && raw.output_summary !== "" ? raw.output_summary : null,
    },
  };
}

/** 读一份运行记录载体（内容寻址；读时复核地址/字节，parse 出 measured_run）。任何一步不过 → `error`（不采信）。 */
function readMeasuredRunBlob(workDir: string, evidenceId: string): { record: ParsedRunRecord } | { error: string } {
  if (!SHA256_HEX.test(evidenceId)) return { error: "证据内容地址不是 64 位小写十六进制" };
  const file = path.join(workDir, "evidence", `${evidenceId}.json`);
  let raw: Record<string, unknown>;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: "证据路径不是普通文件" };
    if (st.size > MAX_MEASURED_RUN_BLOB_BYTES) return { error: `证据体积 ${st.size} 超过运行记录上限 ${MAX_MEASURED_RUN_BLOB_BYTES}` };
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return { error: `证据读不到：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isPlainObject(raw)) return { error: "证据不是 JSON 对象" };
  if (raw.kind !== "source_manifest") {
    return { error: `证据 kind 不是 source_manifest（收到 ${JSON.stringify(raw.kind)}）：运行记录载体必须是可现读复核的源清单` };
  }
  const content = raw.content;
  if (typeof content !== "string") return { error: "证据缺正文 content（不可回读）" };
  const actual = sha256Hex(content);
  if (actual !== evidenceId) {
    return { error: `证据正文与内容地址不符（文件 ${evidenceId.slice(0, 12)}…，正文 ${actual.slice(0, 12)}…）：现场被改过/截损` };
  }
  if (typeof raw.content_sha256 === "string" && raw.content_sha256 !== evidenceId) return { error: "content_sha256 与内容地址不符" };
  if (typeof raw.bytes !== "number" || raw.bytes !== Buffer.byteLength(content, "utf8")) return { error: "证据记录的 bytes 与正文实际长度不符（截损）" };
  return parseRunRecord(content);
}

/**
 * 只保留"含 `df-measured-` 前缀正式检查"的记录：**先廉价筛选**，避免为全部 code 检查现读源清单载体
 * （真实项目上千条检查，逐条现读是六图成本灾难）。fixes/acceptances 原样带上，供复测闭环与人工门复核。
 *
 * **不要求该检查带 `evidence_sha256`**：缺证据的**失败**检查照样要在 `pickCheckRecords` 里参与独立失败否决——
 * 若这里按"没证据字段"把它整条扔掉，就又是一条"载体格式先筛掉真失败"的假绿（本轮返工点）。
 */
function filterMeasuredRecords(records: AuditRecords): AuditRecords {
  const selfChecks: Record<string, SelfCheckRecord> = {};
  for (const [id, sc] of Object.entries(records.self_checks)) if (hasMeasuredCheckId(sc)) selfChecks[id] = sc;
  const audits: Record<string, IndependentAuditRecord> = {};
  for (const [id, au] of Object.entries(records.independent_audits)) if (hasMeasuredCheckId(au)) audits[id] = au;
  return {
    submissions: {},
    self_checks: selfChecks,
    independent_audits: audits,
    fixes: records.fixes,
    retests: records.retests,
    acceptances: records.acceptances,
    ignored_entities: [],
  };
}

function hasMeasuredCheckId(sc: SelfCheckRecord | IndependentAuditRecord): boolean {
  return sc.checks.some((c) => c.check_id.startsWith(DF_MEASURED_CHECK_PREFIX));
}

function manifestStateOf(workDir: string, check: CheckInput, evidenceId: string): MeasuredRunManifestState | null {
  const v = check.source_manifest;
  if (v === undefined || v === null) return null;
  let files: { path: string; sha256: string }[] = [];
  if (v.status === "valid") {
    const carrier = readManifestCarrier(path.join(workDir, "evidence", `${evidenceId}.json`));
    files = carrier === null ? [] : carrier.manifest.files.map((f) => ({ path: f.path, sha256: f.sha256 }));
  }
  return {
    evidence_id: evidenceId,
    fingerprint: v.status === "valid" ? check.binding.revision : "",
    status: v.status === "valid" ? "valid" : v.status === "invalidated" ? "invalidated" : "unreadable",
    reason: v.reason,
    files,
  };
}

/**
 * 一个「被审对象 × 条目」分组的判决（内部）。
 * 为什么按 `object_id` 分组：`check_id` 在项目里**不是全局唯一**——同一 measured 条目 id 可能被不同任务对象
 * （`task_id`）分别登记。分组后，作者集合与复测解除都只在本对象内生效（`pickCheckRecords` 的
 * `resolutionKey` 亦以 object_id 为准），不同对象的同名检查**不互相串**。
 */
interface GroupOutcome {
  object_id: string;
  winner: CheckInput;
  run: ParsedRunRecord | null;
  effective: "passed" | "failed" | "stale" | "unknown" | "not_checked";
  manifest: MeasuredRunManifestState | null;
  reasons: string[];
  ok: boolean;
  /** 未解除的有效独立失败：压过本条目（不因载体格式被删除） */
  veto: boolean;
}

/** 逐份正式检查读运行记录判决（内部实现；`readMeasuredRunIndex` 只在一次派生里调它一次） */
function computeMeasuredRunIndex(
  projectRoot: string,
  specScripts?: ReadonlyMap<string, string>,
  declarationDefinitionSha?: string,
): MeasuredRunIndex {
  const root = path.resolve(projectRoot);
  const workDir = path.join(root, ...WORK_REL.split("/"));
  const notes: string[] = [];

  let records: AuditRecords;
  try {
    records = readAuditRecords(workDir);
  } catch (e) {
    return emptyMeasuredRunIndex(`正式记录读不出来（${WORK_REL}/events.jsonl）：${e instanceof Error ? e.message : String(e)}——没有可核对的运行事实，实测档不成立`);
  }

  const filtered = filterMeasuredRecords(records);
  const measuredRecordCount = Object.keys(filtered.self_checks).length + Object.keys(filtered.independent_audits).length;
  if (measuredRecordCount === 0) {
    return emptyMeasuredRunIndex(
      "当前正式记录里没有引用 df-measured-… 条目的 self_check/independent_audit 运行记录：没有可核对的运行事实，实测档不成立" +
        "（孤立落库的证据正文不构成正式引用；须先经唯一写服务登记正式检查）",
    );
  }

  // 复用既有纯派生装配：checksWithSourceManifests 给 code 绑定检查附上**源清单现读结论**
  // （只对我们筛出的这些正式记录现读，避免全量现读）。
  const checks = checksWithSourceManifests(filtered, { projectRoot: root, workDir });

  // 作者集合**按同一被审对象取**：某对象上的自检者才是该对象的作者。不拿"全项目任一做过 selfcheck 的人"
  // 降级——否则别人在**别的任务**做过自检，会把本任务真非作者的独立审计错误降级成作者自检，独立失败否决被撤。
  const authorsByObject = new Map<string, Set<string>>();
  for (const sc of Object.values(records.self_checks)) {
    const by = sc.checked_by.trim();
    if (by === "") continue;
    const key = sc.task_id ?? "";
    let set = authorsByObject.get(key);
    if (set === undefined) authorsByObject.set(key, (set = new Set()));
    set.add(by);
  }
  const revisions: SourceRevisions = {};
  const expectedDecl = declarationDefinitionSha ?? null;

  const rejectedBySpec = new Map<string, string[]>();
  const pushRejected = (specId: string, why: string): void => {
    rejectedBySpec.set(specId, [...(rejectedBySpec.get(specId) ?? []), why]);
  };

  // 分组：object_id × check_id（明确对象绑定）
  const groups = new Map<string, { object_id: string; check_id: string; checks: CheckInput[] }>();
  for (const c of checks) {
    if (!c.check_id.startsWith(DF_MEASURED_CHECK_PREFIX)) continue;
    const declared = specScripts === undefined ? undefined : specScripts.get(c.check_id);
    if (specScripts !== undefined && declared === undefined) {
      pushRejected(c.check_id, `正式检查 ${c.record_ref ?? "?"} 的 check_id 不在当前声明的 measured 表里：不作为候选`);
      continue;
    }
    // 脚本身份预筛：**只对「通过」记录**按脚本一致排除（避免脚本对不上的新记录遮挡对应的那份）。
    // 失败/未知记录**一律保留**——它们要在 pickCheckRecords 里参与独立失败否决，不因"载体不是 measured_run /
    // 没有 evidence 字段"被先删掉（那正是本轮要修的假绿根因：先筛载体再选记录，真失败在选之前就没了）。
    if (declared !== undefined && c.result === "passed") {
      const parsed = readMeasuredRunBlob(workDir, c.evidence_sha256 ?? "");
      if ("record" in parsed && parsed.record.script !== declared) {
        pushRejected(
          c.check_id,
          `正式检查 ${c.record_ref ?? "?"} 的运行记录 script（${parsed.record.script}）与条目声明的脚本（${declared}）不一致：不作为该条目候选`,
        );
        continue;
      }
    }
    const gkey = `${c.object_id}\u0000${c.check_id}`;
    let g = groups.get(gkey);
    if (g === undefined) groups.set(gkey, (g = { object_id: c.object_id, check_id: c.check_id, checks: [] }));
    g.checks.push(c);
  }

  const bySpec = new Map<string, GroupOutcome[]>();
  for (const g of groups.values()) {
    const authorIds = authorsByObject.get(g.object_id) ?? NO_ACTORS;
    // 复用既有唯一挑选：正式次序（账本 seq）+ 独立失败否决 + 有效复测闭环 + 人验未被覆盖。
    // **先挑/否决，再核载体**：只在同一对象分组内挑，不同对象的同名检查不互相串。
    const winner = pickCheckRecords(g.checks, authorIds, revisions).get(g.check_id);
    if (winner === undefined) {
      pushRejected(g.check_id, `对象 ${g.object_id || "（无）"} 的正式检查挑不出生效记录`);
      continue;
    }
    // 用 winner **本体**判有效性（可能是 pickCheckRecords 返回的 resolution_note 克隆）——不回退 list[0]。
    const effective = checkEffectiveness(winner, revisions, authorIds).effective;
    const parsed =
      winner.evidence_sha256 === null || winner.evidence_sha256 === ""
        ? ({ error: "正式检查没给证据哈希（checks[].evidence_sha256 为空）：没有可核对的运行事实" } as const)
        : readMeasuredRunBlob(workDir, winner.evidence_sha256);
    const run = "record" in parsed ? parsed.record : null;
    const carrierError = "error" in parsed ? parsed.error : null;
    const manifest = manifestStateOf(workDir, winner, winner.evidence_sha256 ?? "");
    const reasons: string[] = [];
    const veto = winner.result === "failed" && effective === "failed";
    if (winner.result !== "passed") {
      reasons.push(
        winner.result === "failed"
          ? `生效的正式记录 ${winner.record_ref ?? "?"} 判为失败：失败不随源漂移失效，正式失败不被任意旧通过绕过`
          : `生效的正式记录 ${winner.record_ref ?? "?"} 结果不是通过（${winner.result}）`,
      );
    } else {
      if (effective !== "passed") reasons.push(`正式检查当前不成立（effective=${effective}）：${checkWhyText(winner, revisions, authorIds)}`);
      if (carrierError !== null) {
        reasons.push(`运行记录载体不可核（${carrierError}）`);
      } else if (run !== null) {
        if (manifest === null) reasons.push("正式检查没有可现读复核的源清单（证据不是 source_manifest 载体）：无法核覆盖范围与当前来源");
        else if (manifest.status !== "valid") reasons.push(`源清单现读复核 ${manifest.status}：${manifest.reason}`);
        if (run.exit_code !== 0) reasons.push(`运行退出码 ${run.exit_code}（只有 0 才算成功运行）`);
        if (!run.spec_ids.includes(g.check_id)) reasons.push(`运行记录 spec_ids 没包含本条目（${run.spec_ids.join("、")}）：不拿别的条目给它背书`);
        if (expectedDecl === null) {
          reasons.push("没有当前声明定义哈希可核对运行记录绑定的定义：缺省 fail-closed，不判实测");
        } else if (run.declaration_sha256 !== expectedDecl) {
          reasons.push(
            `运行记录绑定的声明定义（${run.declaration_sha256.slice(0, 12)}…）与当前解析声明（${expectedDecl.slice(0, 12)}…）不一致：` +
              "旧记录不继续冒充新定义被验证（声明改了证明范围/关系语义，源码与脚本没变也不能绿）",
          );
        }
      }
    }
    const outcome: GroupOutcome = {
      object_id: g.object_id,
      winner,
      run,
      effective,
      manifest,
      reasons,
      ok: reasons.length === 0,
      veto,
    };
    bySpec.set(g.check_id, [...(bySpec.get(g.check_id) ?? []), outcome]);
    if (!outcome.ok && !veto) {
      pushRejected(g.check_id, `未采信候选（对象 ${g.object_id || "（无）"}，${winner.record_ref ?? "?"}）：${reasons.join("；")}`);
    }
  }

  if (bySpec.size === 0) {
    // 有正式记录但归并不出条目判决（全部被拒/挑不出）：指纹仍**覆盖被拒事实**——不能把所有被拒
    // 都返回同一 empty 指纹（否则同一图正文变化而快照身份不变；无关证据仍不 churn）。
    return {
      fingerprint: fingerprintOf(new Map(), rejectedBySpec),
      verdicts: new Map(),
      notes: [
        `正式引用 df-measured-… 的记录 ${measuredRecordCount} 条，但没有一条能归并出条目判决（全部被拒/挑不出）——实测档不成立。`,
        ...rejectedNotes(rejectedBySpec),
      ],
    };
  }

  const verdicts = new Map<string, MeasuredRunVerdict>();
  for (const [specId, outs] of bySpec) {
    const okOut = outs.filter((o) => o.ok);
    const vetoOut = outs.filter((o) => o.veto);
    const rep = okOut[0] ?? vetoOut[0] ?? outs[0]!;
    // 一个条目要判绿：至少一个对象分组是干净通过，且**没有任何**对象分组带未解除的独立失败（fail-closed）。
    const verdictOk = okOut.length > 0 && vetoOut.length === 0;
    const reasons = verdictOk ? [] : vetoOut.length > 0 ? vetoOut.flatMap((o) => o.reasons) : rep.reasons;
    const rejected = [...(rejectedBySpec.get(specId) ?? [])];
    for (const o of outs) {
      if (o === rep) continue;
      rejected.push(
        `未生效候选（对象 ${o.object_id || "（无）"}，${o.winner.record_ref ?? "?"}）：result=${o.winner.result}，effective=${o.effective}，` +
          `exit ${o.run?.exit_code ?? "?"}${o.veto ? "（未解除的独立失败，压过本条）" : ""}`,
      );
    }
    verdicts.set(specId, {
      spec_id: specId,
      object_id: rep.object_id,
      record_ref: rep.winner.record_ref ?? "",
      evidence_id: rep.winner.evidence_sha256 ?? "",
      script: rep.run?.script ?? "",
      command: rep.run?.command ?? rep.winner.command ?? null,
      exit_code: rep.run?.exit_code ?? 0,
      run_id: rep.run?.run_id ?? null,
      declaration_sha256: rep.run?.declaration_sha256 ?? null,
      effective: rep.effective,
      manifest: rep.manifest,
      verdict_ok: verdictOk,
      reasons,
      rejected,
    });
  }

  const okCount = [...verdicts.values()].filter((v) => v.verdict_ok).length;
  notes.push(
    `正式引用 df-measured-… 的记录 ${measuredRecordCount} 条，命中可核运行记录并归并出条目判决 ${verdicts.size} 条，其中当前可成立的 ${okCount} 条。`,
    "判据（同时成立）：① 有正式 self_check/independent_audit 记录的引用；② 运行记录载体内容地址复核通过且 kind=source_manifest；" +
      "③ 正式检查当前有效通过（源清单现读 valid；无来源即待复核）；④ 无未解除的独立失败压过它（同 object_id+check_id 内选，不同对象不串）；" +
      "⑤ 运行记录绑定的纯声明定义哈希与当前解析声明一致；⑥ exit_code=0、script/spec 身份一致；" +
      "脚本存在只是「可复跑线索」，不是「跑过且通过」的证据。",
  );
  for (const line of rejectedNotes(rejectedBySpec)) notes.push(line);
  for (const v of verdicts.values()) if (v.rejected.length > 0) notes.push(`未生效候选 ${v.spec_id}：${v.rejected.join("；")}`);

  const fingerprint = fingerprintOf(verdicts, rejectedBySpec);
  return { fingerprint, verdicts, notes };
}

function rejectedNotes(rejectedBySpec: ReadonlyMap<string, readonly string[]>): string[] {
  return [...rejectedBySpec.entries()].map(([s, ws]) => `被拒候选 ${s}：${ws.join("；")}`);
}

/** 一条检查当前 why 文本（复用既有有效性说明，不另造口径） */
function checkWhyText(check: CheckInput, revisions: SourceRevisions, authorIds: ReadonlySet<string>): string {
  try {
    return checkEffectiveness(check, revisions, authorIds).why || "（无说明）";
  } catch {
    return "（有效性复核抛错）";
  }
}

/**
 * 指纹：只覆盖"与本判定相关"的内容（生效判决 + 覆盖源哈希 + 被拒事实）。无关证据增删不变。
 * **无有效候选时也必须覆盖被拒相关事实**——否则同一图正文（被拒原因）变了而快照身份不变。
 */
function fingerprintOf(
  verdicts: ReadonlyMap<string, MeasuredRunVerdict>,
  rejectedBySpec: ReadonlyMap<string, readonly string[]>,
): string {
  const verdictCanon = [...verdicts.values()]
    .map((v) => ({
      spec_id: v.spec_id,
      object_id: v.object_id,
      record_ref: v.record_ref,
      evidence_id: v.evidence_id,
      script: v.script,
      exit_code: v.exit_code,
      declaration_sha256: v.declaration_sha256,
      effective: v.effective,
      manifest:
        v.manifest === null
          ? null
          : { evidence_id: v.manifest.evidence_id, fingerprint: v.manifest.fingerprint, status: v.manifest.status, files: v.manifest.files.map((f) => `${f.path}:${f.sha256}`).sort() },
      ok: v.verdict_ok,
      reasons: v.reasons,
      rejected: v.rejected,
    }))
    .sort((a, b) => a.spec_id.localeCompare(b.spec_id));
  const rejectedCanon = [...rejectedBySpec.entries()]
    .map(([s, ws]) => [s, [...ws].sort()] as [string, string[]])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (verdictCanon.length === 0 && rejectedCanon.length === 0) return emptyMeasuredRunIndex().fingerprint;
  return sha256Hex(JSON.stringify({ verdicts: verdictCanon, rejected: rejectedCanon })).slice(0, 32);
}

/**
 * 读一个项目的运行证据索引（只读）。**一次同步派生内**同一项目根 + 同一「条目→脚本」表 + 同一当前声明定义
 * 只算一次（`derivationScope`）；无活跃作用域时每次现算——**跨请求不缓存**（源一变下一个请求立刻看见，没有陈旧窗口）。
 *
 * `specScripts`（可选）：当前声明里 `measured` 条目的「id → 脚本」表。给了它，就按**身份对应**过滤候选
 * （通过记录的运行 `script` 必须等于该条目声明的脚本）——不这样做，一份脚本对不上的新记录会遮挡真正对应的那份。
 *
 * `opts.declarationDefinitionSha`（可选）：当前解析声明的纯声明定义哈希。给了它就要求运行记录绑定的一致；
 * 缺省 = fail-closed（无当前定义可对照 ⇒ 不判实测）。
 */
export function readMeasuredRunIndex(
  projectRoot: string,
  specScripts?: ReadonlyMap<string, string>,
  opts: ReadMeasuredRunIndexOptions = {},
): MeasuredRunIndex {
  const root = path.resolve(projectRoot);
  const specKey =
    specScripts === undefined
      ? "none"
      : sha256Hex(JSON.stringify([...specScripts.entries()].sort((a, b) => a[0].localeCompare(b[0])))).slice(0, 16);
  const memoKey = `${root}\u0000${specKey}\u0000${opts.declarationDefinitionSha ?? "nodecl"}`;
  return memoizedForDerivation("dataflow:measured-runs", memoKey, () =>
    computeMeasuredRunIndex(root, specScripts, opts.declarationDefinitionSha),
  );
}
