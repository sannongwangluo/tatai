// 同步契约的解析与冻结（PLAN V09-23；DESIGN.md §2.10；docs/sync-evidence-contract.md「契约与证据包」）。
//
// 单一职责：把一份「应同步清单」从外部 JSON **严格**读成 `SyncContract`，并算出确定性的内容地址。
// 判据（与 stageReads.ts 同款强度——同一仓库不写第二套）：闭键、重复键（含转义同名）、
// 稳定 item_id 不重复、至少一必需项、非法/超限内容、相对路径逃逸及软链/junction 逃逸、来源哈希实核。
//
// 这里**不**碰事件、不碰服务：写边界的折叠校验在 sync.ts，检查求值在 syncChecks.ts。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WorkError } from "./types";
import { resolveProjectRelative } from "./documents";
import { findDuplicateKey } from "./stageReads";
import { sectionSelectorProblem } from "../../shared/materialSection";
import { stableStringify } from "../../shared/stableJson";
import {
  SYNC_BATCH_ID_RE,
  SYNC_CHECK_TYPES,
  SYNC_INBOX_REL,
  SYNC_ITEM_LABEL_MAX,
  SYNC_SCHEMA_VERSION,
  SYNC_TASK_STATES_SCOPE_MODES,
  SYNC_TITLE_MAX,
  type SyncCheck,
  type SyncContract,
  type SyncContractItem,
  type SyncContractSource,
} from "../../shared/syncEvidence";

const SHA256_RE = /^[0-9a-f]{64}$/;
const TOP_KEYS = ["schema_version", "batch_id", "project_id", "title", "sources", "items", "blocks_entry", "supersedes"];
const SOURCE_KEYS = ["path", "sha256"];
const ITEM_KEYS = ["id", "label", "required", "check"];
const CHECK_KEYS: Readonly<Record<string, readonly string[]>> = {
  file_hash: ["type", "path", "sha256"],
  json_value: ["type", "path", "pointer", "expected"],
  task_definitions: ["type", "source_plan", "source_sha256", "compare", "expected_task_ids"],
  task_states: ["type", "scope_mode", "expected"],
  graph_full: ["type", "expected_baseline_id"],
  required_reads: ["type", "expected"],
  markdown_section: ["type", "path", "section", "sha256"],
};
const COMPARE_KEYS = ["owner_role", "dependency_ids"];
/** 标识/内容的界（防一条命令把事件文件或读口撑爆） */
export const SYNC_ITEM_ID_MAX = 128;
export const SYNC_MAX_ITEMS = 512;
export const SYNC_MAX_SOURCES = 256;
/** 契约正文（序列化后）字节上限 */
export const SYNC_CONTRACT_MAX_BYTES = 256 * 1024;
/** 单个来源文件的读取上限（来源实核读前核常规文件与大小） */
export const SYNC_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * 锁内有界复核的读取总字节预算：**契约来源**与目标文件的读取共用同一份
 * （设计见 docs/sync-evidence-contract.md「目标指纹（两段式）」）。
 * 读前按 `stat` 判定——超出就不读、明确失败，绝不静默截断后当通过。
 * 来源实核在**登记写口也在锁内**，故没有显式预算时也按此默认有界：否则 256 个来源 × 8MB
 * 单文件上限能在锁内造成约 2GB 的无界读取（Codex 反例 `codex-lock-budget.mts`）。
 */
export const SYNC_LOCK_REVIEW_MAX_BYTES = 16 * 1024 * 1024;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function bad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", message, detail);
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

/** 确定性 JSON 的**实现已统一**到 `src/shared/stableJson.ts`（单一来源）；此处只再导出同名函数，
 *  旧的 `export function stableStringify` 调用点（`sync.ts`／`syncChecks.ts`）与输出逐字节不变。
 *  （P0/V09-45 要求构建层复用同一原语而不引入 `server/work` 依赖环，故实现落在纯模块。） */
export { stableStringify };

/**
 * 该相对路径是否落在同步收件目录内（**自引用**判据：收件目录里的东西不能当独立目标）。
 * 先按 POSIX 规范化（折叠 `./`、重复分隔符等）再判前缀——否则
 * `.工作台/work/./sync-inbox/x`（Codex 反例）能绕过自引用检查。
 */
export function isSyncInboxRelativePath(rel: string): boolean {
  const unix = rel.replace(/\\/g, "/");
  const norm = path.posix.normalize(unix);
  const n = norm.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return n === SYNC_INBOX_REL || n.startsWith(`${SYNC_INBOX_REL}/`);
}

const PROTO_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * JSON Pointer 的合法性与原型段校验：只允许 `~0`/`~1` 转义（拒 `~2`、裸 `~` 等），
 * 且任一段解码后不许是原型路径。返回问题文案或 `null`（通过）。**登记与求值同一份判据**。
 */
export function jsonPointerProblem(pointer: string): string | null {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return "必须是 JSON Pointer（以 / 开头）";
  for (const raw of pointer.split("/").slice(1)) {
    if (/~(?![01])/.test(raw)) return `非法转义（JSON Pointer 只允许 ~0/~1）：${raw}`;
    const decoded = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (PROTO_SEGMENTS.has(decoded)) return `不许原型段：${decoded}`;
  }
  return null;
}

function validateCheck(raw: unknown, itemId: string): SyncCheck {
  if (!isPlainObject(raw)) bad(`item ${itemId} 的 check 必须是对象`, { item_id: itemId });
  const type = raw.type;
  if (typeof type !== "string" || !(SYNC_CHECK_TYPES as readonly string[]).includes(type)) {
    bad(`item ${itemId} 的 check.type 必须是 ${SYNC_CHECK_TYPES.join("/")} 之一，收到 ${JSON.stringify(type)}`, {
      item_id: itemId,
    });
  }
  const allowed = CHECK_KEYS[type] as readonly string[];
  const extra = unknownKeys(raw, allowed);
  if (extra.length > 0) bad(`item ${itemId} 的 ${type} check 有未知字段：${extra.join("、")}（只认 ${allowed.join("/")}）`, { item_id: itemId });
  const str = (k: string, max = 4096): string => {
    const v = raw[k];
    if (typeof v !== "string" || v.trim() === "") bad(`item ${itemId} 的 ${type}.${k} 必须是非空字符串`, { item_id: itemId, field: k });
    if ((v as string).length > max) bad(`item ${itemId} 的 ${type}.${k} 超长`, { item_id: itemId, field: k });
    return (v as string).trim();
  };
  const rel = (k: string): string => {
    const v = str(k);
    if (path_isAbsoluteOrEscape(v)) bad(`item ${itemId} 的 ${type}.${k} 必须是项目根内相对路径（不许绝对路径 / .. 穿越）：${v}`, { item_id: itemId });
    if (isSyncInboxRelativePath(v)) bad(`item ${itemId} 的 ${type}.${k} 落在同步收件目录内——收件目录里的东西不能当独立目标（禁止自引用）`, { item_id: itemId });
    return v;
  };
  const sha = (k: string): string => {
    const v = str(k, 64);
    if (!SHA256_RE.test(v)) bad(`item ${itemId} 的 ${type}.${k} 必须是 64 位小写十六进制`, { item_id: itemId, field: k });
    return v;
  };
  switch (type) {
    case "file_hash":
      return { type, path: rel("path"), sha256: sha("sha256") };
    case "json_value": {
      const pointer = str("pointer", 512);
      const pp = jsonPointerProblem(pointer);
      if (pp !== null) bad(`item ${itemId} 的 json_value.pointer 不合法：${pp}（收到 ${pointer}）`, { item_id: itemId });
      if (raw.expected === undefined) bad(`item ${itemId} 的 json_value 必须给 expected`, { item_id: itemId });
      return { type, path: rel("path"), pointer, expected: raw.expected };
    }
    case "task_definitions": {
      const compareRaw = raw.compare;
      if (!isPlainObject(compareRaw)) bad(`item ${itemId} 的 task_definitions.compare 必须是对象 {owner_role,dependency_ids}`, { item_id: itemId });
      const ce = unknownKeys(compareRaw, COMPARE_KEYS);
      if (ce.length > 0) bad(`item ${itemId} 的 task_definitions.compare 有未知字段：${ce.join("、")}`, { item_id: itemId });
      // **必须给明确布尔**（不许缺字段或非布尔）：不能用 false / 缺字段把定义完整性比对关掉。
      if (typeof compareRaw.owner_role !== "boolean" || typeof compareRaw.dependency_ids !== "boolean") {
        bad(`item ${itemId} 的 task_definitions.compare.owner_role/dependency_ids 必须是明确布尔（缺字段或非布尔都拒——定义哈希始终完整核对，不靠 compare 关掉）`, { item_id: itemId });
      }
      const compare = { owner_role: compareRaw.owner_role, dependency_ids: compareRaw.dependency_ids };
      const out: SyncCheck = { type, source_plan: rel("source_plan"), source_sha256: sha("source_sha256"), compare };
      if (raw.expected_task_ids !== undefined) {
        if (!Array.isArray(raw.expected_task_ids) || raw.expected_task_ids.some((x) => typeof x !== "string" || x.trim() === "")) {
          bad(`item ${itemId} 的 expected_task_ids 必须是非空字符串数组`, { item_id: itemId });
        }
        out.expected_task_ids = (raw.expected_task_ids as string[]).map((s) => s.trim());
      }
      return out;
    }
    case "task_states": {
      const mode = raw.scope_mode;
      if (typeof mode !== "string" || !(SYNC_TASK_STATES_SCOPE_MODES as readonly string[]).includes(mode)) {
        bad(`item ${itemId} 的 task_states.scope_mode 必须是 ${SYNC_TASK_STATES_SCOPE_MODES.join("|")}（收到 ${JSON.stringify(mode)}）`, { item_id: itemId });
      }
      if (!isPlainObject(raw.expected)) bad(`item ${itemId} 的 task_states.expected 必须是 {task_id: status} 对象`, { item_id: itemId });
      const expected: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.expected)) {
        if (typeof v !== "string" || v.trim() === "") bad(`item ${itemId} 的 task_states.expected[${k}] 必须是非空字符串`, { item_id: itemId });
        expected[k] = v;
      }
      if (Object.keys(expected).length === 0) bad(`item ${itemId} 的 task_states.expected 不能为空（空范围＝无分母，不许假通过）`, { item_id: itemId });
      return { type, scope_mode: mode as "current" | "at_registration", expected };
    }
    case "graph_full":
      return { type, expected_baseline_id: str("expected_baseline_id", 200) };
    case "required_reads": {
      if (!Array.isArray(raw.expected) || raw.expected.length === 0) bad(`item ${itemId} 的 required_reads.expected 必须是非空数组`, { item_id: itemId });
      const expected = raw.expected.map((e) => {
        if (!isPlainObject(e)) bad(`item ${itemId} 的 required_reads.expected 每项必须是对象`, { item_id: itemId });
        const ee = unknownKeys(e, ["path", "section", "sha256"]);
        if (ee.length > 0) bad(`item ${itemId} 的 required_reads.expected 条目有未知字段：${ee.join("、")}`, { item_id: itemId });
        const p = typeof e.path === "string" ? e.path.trim() : "";
        if (p === "" || path_isAbsoluteOrEscape(p)) bad(`item ${itemId} 的 required_reads.expected.path 不合法：${JSON.stringify(e.path)}`, { item_id: itemId });
        if (isSyncInboxRelativePath(p)) bad(`item ${itemId} 的 required_reads.expected.path 落在收件目录内——自引用不许当目标`, { item_id: itemId });
        const out: { path: string; section?: string; sha256?: string } = { path: p };
        if (e.section !== undefined) {
          // 与 markdown_section 同一判据：完整标题路径，非空、无控制字符、有长度上限。
          const sp = sectionSelectorProblem(e.section);
          if (sp !== null) bad(`item ${itemId} 的 required_reads.expected.section 不合法：${sp}`, { item_id: itemId });
          out.section = (e.section as string).trim();
        }
        if (e.sha256 !== undefined) {
          if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) bad(`item ${itemId} 的 required_reads.expected.sha256 必须是 64 位小写十六进制`, { item_id: itemId });
          out.sha256 = e.sha256;
        }
        return out;
      });
      return { type, expected };
    }
    case "markdown_section": {
      const section = str("section", 2048);
      const sp = sectionSelectorProblem(section);
      if (sp !== null) bad(`item ${itemId} 的 markdown_section.section 不合法：${sp}`, { item_id: itemId });
      // path 与其余 check 同款：项目根内相对路径、不许绝对路径/`..` 穿越/落同步收件目录（自引用）
      return { type, path: rel("path"), section, sha256: sha("sha256") };
    }
    default:
      bad(`未支持的 check.type：${String(type)}`, { item_id: itemId });
  }
}

function path_isAbsoluteOrEscape(rel: string): boolean {
  const v = rel.trim();
  if (v === "" || path.isAbsolute(v)) return true;
  const unix = v.replace(/\\/g, "/");
  return unix.split("/").some((seg) => seg === "..");
}

/**
 * 严格解析一份同步契约。`rawText` 给了（工具以 JSON 文本登记时）就加**重复键**检查
 * （同一对象的键写两次、含 `"\u0073chema_version"` 这类转义同名，按 JSON 字符串语义解码后再比）。
 * 任何不合法一律 `INVALID_COMMAND`（写口在动磁盘之前抛——非法登记不留痕）。
 */
export function validateSyncContract(raw: unknown, rawText?: string): SyncContract {
  if (rawText !== undefined) {
    const dup = findDuplicateKey(rawText);
    if (dup !== null) bad(`契约有重复字段「${dup}」：同一对象的键不许写两次（含转义同名写法）`, { field: dup });
  }
  if (!isPlainObject(raw)) bad("契约必须是 JSON 对象");
  const extraTop = unknownKeys(raw, TOP_KEYS);
  if (extraTop.length > 0) bad(`契约有未知字段：${extraTop.join("、")}（只认 ${TOP_KEYS.join("/")}）`);
  if (raw.schema_version !== SYNC_SCHEMA_VERSION) bad(`契约 schema_version 必须是 ${SYNC_SCHEMA_VERSION}，收到 ${JSON.stringify(raw.schema_version)}`);
  const batchId = typeof raw.batch_id === "string" ? raw.batch_id.trim() : "";
  if (!SYNC_BATCH_ID_RE.test(batchId)) bad(`batch_id 必须是安全 ASCII 标识（字母/数字开头，字母数字与 ._-，≤64）：${JSON.stringify(raw.batch_id)}`, { field: "batch_id" });
  const projectId = typeof raw.project_id === "string" ? raw.project_id.trim() : "";
  if (projectId === "") bad("契约缺 project_id", { field: "project_id" });
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title === "" || title.length > SYNC_TITLE_MAX) bad(`title 必须是非空且 ≤${SYNC_TITLE_MAX} 字符的字符串`, { field: "title" });

  if (!Array.isArray(raw.sources) || raw.sources.length === 0) bad("sources 必须是非空数组（本批次所依据的原始工作范围/设计/交接说明）", { field: "sources" });
  if (raw.sources.length > SYNC_MAX_SOURCES) bad(`sources 超过上限 ${SYNC_MAX_SOURCES}`, { field: "sources" });
  const sources: SyncContractSource[] = [];
  const seenSrc = new Set<string>();
  for (const s of raw.sources) {
    if (!isPlainObject(s)) bad("sources 的每一项必须是对象");
    const se = unknownKeys(s, SOURCE_KEYS);
    if (se.length > 0) bad(`sources 条目有未知字段：${se.join("、")}`);
    const p = typeof s.path === "string" ? s.path.trim() : "";
    if (p === "" || path_isAbsoluteOrEscape(p)) bad(`sources.path 必须是项目根内相对路径：${JSON.stringify(s.path)}`);
    if (typeof s.sha256 !== "string" || !SHA256_RE.test(s.sha256)) bad(`sources.sha256 必须是 64 位小写十六进制，收到 ${JSON.stringify(s.sha256)}`);
    if (seenSrc.has(p)) bad(`sources 里 ${p} 出现了两次（重复来源）`);
    seenSrc.add(p);
    sources.push({ path: p, sha256: s.sha256 });
  }

  if (!Array.isArray(raw.items) || raw.items.length === 0) bad("items 必须是非空数组", { field: "items" });
  if (raw.items.length > SYNC_MAX_ITEMS) bad(`items 超过上限 ${SYNC_MAX_ITEMS}`, { field: "items" });
  const items: SyncContractItem[] = [];
  const seenId = new Set<string>();
  for (const it of raw.items) {
    if (!isPlainObject(it)) bad("items 的每一项必须是对象");
    const ie = unknownKeys(it, ITEM_KEYS);
    if (ie.length > 0) bad(`items 条目有未知字段：${ie.join("、")}`);
    const id = typeof it.id === "string" ? it.id.trim() : "";
    if (id === "" || id.length > SYNC_ITEM_ID_MAX) bad(`item.id 必须是 1..${SYNC_ITEM_ID_MAX} 的非空字符串，收到 ${JSON.stringify(it.id)}`);
    if (seenId.has(id)) bad(`item.id 重复：${id}（稳定 item_id 不许重复）`);
    seenId.add(id);
    const label = typeof it.label === "string" ? it.label.trim() : "";
    if (label === "" || label.length > SYNC_ITEM_LABEL_MAX) bad(`item ${id} 的 label 必须是 1..${SYNC_ITEM_LABEL_MAX} 的非空字符串`);
    if (typeof it.required !== "boolean") bad(`item ${id} 的 required 必须是布尔`);
    items.push({ id, label, required: it.required, check: validateCheck(it.check, id) });
  }
  if (!items.some((i) => i.required)) bad("items 至少要有 **一条 required=true**（必需项决定 blocks_entry 是否阻断）");
  if (typeof raw.blocks_entry !== "boolean") bad("blocks_entry 必须是布尔", { field: "blocks_entry" });
  let supersedes: string | undefined;
  if (raw.supersedes !== undefined) {
    if (typeof raw.supersedes !== "string" || raw.supersedes.trim() === "") bad("supersedes 给了就必须是旧 batch_id（非空字符串）");
    supersedes = raw.supersedes.trim();
    if (supersedes === batchId) bad("supersedes 不能指向自己（会成环）");
  }
  const contract: SyncContract = {
    schema_version: SYNC_SCHEMA_VERSION,
    batch_id: batchId,
    project_id: projectId,
    title,
    sources,
    items,
    blocks_entry: raw.blocks_entry,
  };
  if (supersedes !== undefined) contract.supersedes = supersedes;
  const bytes = Buffer.byteLength(JSON.stringify(contract), "utf8");
  if (bytes > SYNC_CONTRACT_MAX_BYTES) bad(`契约正文超过 ${SYNC_CONTRACT_MAX_BYTES} 字节上限（本次 ${bytes}）`);
  return contract;
}

/** 契约的确定性内容地址（同一契约任何进程算出同一个；不含时间/序号） */
export function syncContractSha256(contract: SyncContract): string {
  const canonical = {
    schema_version: contract.schema_version,
    batch_id: contract.batch_id,
    project_id: contract.project_id,
    title: contract.title,
    sources: [...contract.sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    items: [...contract.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    blocks_entry: contract.blocks_entry,
    ...(contract.supersedes === undefined ? {} : { supersedes: contract.supersedes }),
  };
  return crypto.createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

/**
 * 逐条实核来源：路径在项目根内、不过软链/junction 逃逸、**读前核常规文件与字节上限**、文件存在、
 * **当前字节 sha256 == 登记值**。返回快照（供稳定目标指纹用）与问题清单（空 = 通过）；不抛——
 * 调用方按 INVALID_COMMAND 拒并点名。`allowMissing` 只在登记前预检用（缺文件不阻塞预览）。
 */
export interface SyncSourceSnapshot {
  path: string;
  /** 实际读到的 sha256；缺失/不可读/非文件/超限/超预算为 null */
  sha256: string | null;
  problem: string | null;
}

/** 读取字节预算（锁内复核用；来源与目标共用同一份对象，超界即明确失败，不静默截断） */
export interface SourceReadBudget {
  limit: number;
  used: number;
}

export function contractSourceSnapshot(
  contract: SyncContract,
  projectRoot: string,
  opts: { allowMissing?: boolean; byteBudget?: SourceReadBudget } = {},
): { problems: string[]; snapshots: SyncSourceSnapshot[]; used: number } {
  // 没有显式预算时也**默认有界**（= 锁内总预算口径）：来源实核在登记写口也在锁内，
  // 不能靠「每条 stat 只核 8MB」把 256 条来源拼成 2GB 的无界锁内读取。
  const budget: SourceReadBudget = opts.byteBudget ?? { limit: SYNC_LOCK_REVIEW_MAX_BYTES, used: 0 };
  const problems: string[] = [];
  const snapshots: SyncSourceSnapshot[] = [];
  for (const s of contract.sources) {
    const fail = (problem: string, sha256: string | null = null): void => {
      problems.push(problem);
      snapshots.push({ path: s.path, sha256, problem });
    };
    if (isSyncInboxRelativePath(s.path)) {
      fail(`来源 ${s.path} 落在同步收件目录内——证据收件目录不能当本批次的原始来源（自引用）`);
      continue;
    }
    const guard = resolveProjectRelative(projectRoot, s.path);
    if (!guard.ok) {
      fail(`来源 ${s.path} 路径不合法（${guard.reason}：必须在项目根内且不经软链逃逸）`);
      continue;
    }
    if (!fs.existsSync(guard.abs)) {
      if (opts.allowMissing === true) {
        snapshots.push({ path: s.path, sha256: null, problem: null });
        continue;
      }
      fail(`来源 ${s.path} 不存在：来源缺失就拒发`);
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(guard.abs);
    } catch (e) {
      fail(`来源 ${s.path} 读不到（${e instanceof Error ? e.message : String(e)}）`);
      continue;
    }
    if (!st.isFile()) {
      fail(`来源 ${s.path} 不是常规文件（来源必须是项目内可读常规文件）`);
      continue;
    }
    if (st.size > SYNC_SOURCE_MAX_BYTES) {
      fail(`来源 ${s.path} 超过 ${SYNC_SOURCE_MAX_BYTES} 字节读取上限`);
      continue;
    }
    // **读前**按 stat 明确判定：这一条会超总预算就不读——不静默截断后当通过，也不无界读。
    if (budget.used + st.size > budget.limit) {
      fail(`来源 ${s.path} 超过锁内读取预算 ${budget.limit} 字节（本次已累计 ${budget.used}，本条 ${st.size}）：读前按 stat 明确超界就不读，也不当通过`);
      continue;
    }
    budget.used += st.size;
    let actual: string;
    try {
      actual = crypto.createHash("sha256").update(fs.readFileSync(guard.abs)).digest("hex");
    } catch (e) {
      fail(`来源 ${s.path} 读不到（${e instanceof Error ? e.message : String(e)}）`);
      continue;
    }
    if (actual !== s.sha256) {
      const problem = `来源 ${s.path} 已漂移：登记 ${s.sha256.slice(0, 12)}…，当前 ${actual.slice(0, 12)}…`;
      problems.push(problem);
      snapshots.push({ path: s.path, sha256: actual, problem });
    } else {
      snapshots.push({ path: s.path, sha256: actual, problem: null });
    }
  }
  return { problems, snapshots, used: budget.used };
}

/** 来源实核的问题清单（contractSourceSnapshot 的薄封装；判据只此一处）。 */
export function contractSourceProblems(contract: SyncContract, projectRoot: string, opts: { allowMissing?: boolean; byteBudget?: SourceReadBudget } = {}): string[] {
  return contractSourceSnapshot(contract, projectRoot, opts).problems;
}

/**
 * supersedes 的兼容判据（docs/sync-evidence-contract.md 复核定版）：
 * 新契约必须保留旧契约**所有必需 item_id 且仍 required=true**；旧 blocks_entry=true 不能改成 false。
 * 返回问题清单（空 = 兼容）；拒绝时点名被删项。**不**在这里做授权收缩（v1 不支持削减必需范围）。
 */
export function supersedeProblems(next: SyncContract, prev: SyncContract): string[] {
  const problems: string[] = [];
  const nextById = new Map(next.items.map((i) => [i.id, i]));
  const missing: string[] = [];
  const downgraded: string[] = [];
  for (const old of prev.items) {
    if (!old.required) continue;
    const now = nextById.get(old.id);
    if (now === undefined) missing.push(old.id);
    else if (!now.required) downgraded.push(old.id);
  }
  if (missing.length > 0) problems.push(`新契约删除了旧契约的必需 item_id：${missing.join("、")}（v1 不支持削减必需范围；真要收缩属后续明确变更，不由扫描器实施）`);
  if (downgraded.length > 0) problems.push(`新契约把旧必需项改成非必需：${downgraded.join("、")}`);
  if (prev.blocks_entry && !next.blocks_entry) problems.push("旧契约 blocks_entry=true，新契约不能把它改成 false（不能靠换契约解除接续阻断）");
  return problems;
}
