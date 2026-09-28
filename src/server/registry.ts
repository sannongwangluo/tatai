import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./fileLock";
import { nowIso } from "./time";

/** 项目类型（DESIGN.md §2.3.1，决定是否出现"页面预览 Tab"） */
export type ProjectKind = "backend" | "frontend" | "fullstack" | "static";

export const PROJECT_KINDS: readonly ProjectKind[] = [
  "backend",
  "frontend",
  "fullstack",
  "static",
];

/** 注册表项目记录（DESIGN.md §2.3.1） */
export interface ProjectRecord {
  /** 稳定标识，目录改名不变，用于内部引用 */
  id: string;
  /** 显示名，与目录名解耦，可手工改 */
  name: string;
  /** 绝对路径，唯一真实指向 */
  path: string;
  kind: ProjectKind;
  registered_at: string;
  last_opened_at: string;
  /** 是否自举项目（塔台自身标记为 true） */
  self_managed?: boolean;
  /**
   * 设计书源路径（PLAN.md V06-02，DESIGN.md §2.9）：**项目根内相对路径**。
   * 缺省/留空 = 走默认口径（塔台自身 = 根 `DESIGN.md`；其他项目 = `.工作台/design.md`）。
   * 向后兼容：老 registry.json 没有这个字段照样读（`undefined` 即缺省）。
   */
  design_path?: string;
  /** 施工图源路径（同一口径；缺省 = 塔台根 `PLAN.md` / 其他项目 `.工作台/plan.md`） */
  plan_path?: string;
}

/** 全局注册表（DESIGN.md §2.3.1） */
export interface Registry {
  version: 1;
  projects: ProjectRecord[];
}

export type NewProject = Pick<ProjectRecord, "id" | "name" | "path" | "kind"> &
  Partial<Pick<ProjectRecord, "self_managed" | "design_path" | "plan_path">>;

const REGISTRY_FILE = "registry.json";

/**
 * 首次成功建表时落下的**初始化标记**（补修 A，2026-09-20）。
 *
 * 为什么需要它："目录里有没有别的文件"判不出历史——塔台进程自己启动时就会往数据目录写运行骨架
 * （`work-service.json` / `logs/`），一个从没登记过项目的全新安装也有这些文件。有了这个标记，
 * "注册表不见了"才能和"从来没初始化过"分开：标记在 = 这个目录被塔台初始化过，此刻注册表读不到
 * 就是**已有运行状态丢失**，不是新装（否则一次删文件就把已登记项目的历史洗成"从没登记过"）。
 */
export const REGISTRY_INIT_MARKER = ".tatai-initialized";

/**
 * 塔台进程**启动期自建**的运行骨架条目（判"全新安装"时不算"已有运行状态痕迹"）：
 *   · `work-service.json` —— 写入服务描述符，每次 listen 都会重写（work/service.ts）；
 *   · `logs/`             —— 服务生命周期日志目录（work/service.ts#logServiceLifecycle）；
 *   · `remote/`           —— 远程鉴权口令与审计（开了远程才有，同样启动期自建）。
 * 这三个都不含项目事实，且"第一次启动就会自己造出来"——只凭它们判不出历史，故排除在痕迹之外。
 * **边界**：其余任何条目（`agents.json`、`config.json`、`registry.json.corrupt.*`、用户自己放的
 * 文件…）一律算痕迹。多认一个"看起来奇怪但不是骨架"的条目只会让全新安装被误判成已有状态；
 * 两种偏差都取保守侧——**只把启动期必定自建、且不含项目事实的这三个算骨架**。
 */
const BOOT_SKELETON_ENTRIES: ReadonlySet<string> = new Set([
  "work-service.json",
  "logs",
  "remote",
]);

/** 原子写 / 跨进程锁的瞬时残留（进程被 kill 时留下，由 tmpSweep 清；不算状态痕迹） */
function isTransientResidue(name: string): boolean {
  return name.endsWith(".lock") || /\.\d+\.\d+\.tmp$/.test(name);
}

/** 全局数据目录：TATAI_HOME 环境变量 > 默认 os.homedir()/.tatai（DESIGN.md §8.1） */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TATAI_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".tatai");
}

export function registryPath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, REGISTRY_FILE);
}

function emptyRegistry(): Registry {
  return { version: 1, projects: [] };
}

function assertKind(kind: string): asserts kind is ProjectKind {
  if (!PROJECT_KINDS.includes(kind as ProjectKind)) {
    throw new Error(
      `非法 kind: ${JSON.stringify(kind)}，只接受 ${PROJECT_KINDS.join("/")}`,
    );
  }
}

function validateRegistry(raw: unknown): Registry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("registry.json 顶层必须是对象");
  }
  const reg = raw as Registry;
  if (reg.version !== 1) throw new Error(`不支持的 version: ${reg.version}`);
  if (!Array.isArray(reg.projects)) throw new Error("projects 必须是数组");
  for (const p of reg.projects) {
    assertKind(p.kind);
  }
  return reg;
}

/**
 * registry.json 读不出来时的**现场性质**（补修 A，2026-09-20）：
 *   · `missing`    —— 文件不在，而现场像**已有运行状态**（初始化标记/agents.json/…）；
 *   · `corrupt`    —— 文件在，但坏 JSON / 结构不符 / 半截；
 *   · `unreadable` —— 文件在，但读失败（权限、被占用、路径指向目录…）；
 *   · `unknown`    —— 连现场性质都判不出（数据目录列不出来）。
 * 四者**都不是**"空项目列表"：谁都不许把读不到说成"没有登记过项目"。
 */
export type RegistryBrokenState = "missing" | "corrupt" | "unreadable" | "unknown";

export type RegistryStateCode =
  | "REGISTRY_MISSING"
  | "REGISTRY_JSON_CORRUPT"
  | "REGISTRY_UNREADABLE"
  | "REGISTRY_STATE_UNKNOWN";

/** 恢复入口的说明（写进错误文案，人照着做就能出来；原文只在下面这一处） */
const RECOVERY_HINT =
  "恢复入口（显式触发，塔台不在读写路径上替你自动重建）：" +
  "POST /api/registry/recover —— 空 body `{}` 把现场留档后重建空表；" +
  "带 `{\"from\":\"<数据目录内的留档/备份文件名>\"}`（例如 `registry.json.corrupt.<时间戳>`）从那一份恢复。" +
  "两种都会先留档、再原子换表";

export interface RegistryStateErrorInit {
  code: RegistryStateCode;
  state: RegistryBrokenState;
  file: string;
  reason: string;
  /** `missing` 时被当成"已有运行状态痕迹"的条目名（basename） */
  traces?: string[];
}

/**
 * 注册表读到"不是一份能用的表"时抛它（Q129 起点，补修 A 收口）。
 *
 * 为什么单独立一个错误类而不是复用 `workstation.ts` 的 `WsError`：`workstation.ts` 反过来 import
 * 本模块（项目解析），互相 import 会成环——与 `fileLock.ts` 不引 WsError 是同一个理由。
 * 状态码与响应形状由 HTTP 层（index.ts）按 `code` 映射：**这是服务端数据问题，不是用户入参错**。
 *
 * 口径（补修 A）：**读路径不为修文件写盘**；写路径也不再"遇到坏表就静默清零"——一次普通登记
 * 不许把历史缺失掩盖掉。要重建/恢复必须走显式入口 `recoverRegistry`。
 */
export class RegistryStateError extends Error {
  readonly code: RegistryStateCode;
  readonly state: RegistryBrokenState;
  readonly file: string;
  readonly reason: string;
  readonly traces: string[];
  readonly recovery = RECOVERY_HINT;
  constructor(init: RegistryStateErrorInit) {
    super(registryStateMessage(init));
    this.name = "RegistryStateError";
    this.code = init.code;
    this.state = init.state;
    this.file = init.file;
    this.reason = init.reason;
    this.traces = init.traces ?? [];
  }
  /** HTTP/MCP 层直接回这一份（`file` 只给 basename：远程客户端不该收到本机目录结构） */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      state: this.state,
      reason: this.reason,
      ...(this.traces.length > 0 ? { traces: this.traces } : {}),
      recovery: this.recovery,
      file: path.basename(this.file),
    };
  }
}

function registryStateMessage(init: RegistryStateErrorInit): string {
  const file = `${path.basename(init.file)}（${init.file}）`;
  switch (init.state) {
    case "missing":
      return (
        `全局数据目录里的 registry.json 不见了，而这个目录有塔台运行痕迹（${init.reason}）：${file}` +
        "——**不当作空项目列表**：那会把已经登记过的项目伪装成「从没登记过」，把历史缺失掩盖掉。" +
        RECOVERY_HINT
      );
    case "corrupt":
      return (
        `全局数据目录里的 registry.json 读不出来（${init.reason}）：${file}` +
        "——塔台不猜、不改坏文件，**读写路径都不自动重建**（原文件一个字没动）。" +
        "修好它、或按恢复入口处理。" +
        RECOVERY_HINT
      );
    case "unreadable":
      return (
        `全局数据目录里的 registry.json 存在但读不出来（${init.reason}）：${file}` +
        "——权限/占用导致的读失败**不等于**没有登记过项目，先修权限或等占用释放再重读；" +
        "确认这份文件已不可救才走恢复入口（会先留档）。" +
        RECOVERY_HINT
      );
    case "unknown":
      return (
        `判不出全局数据目录里注册表现场的性质（${init.reason}）：${file}` +
        "——塔台保持**未知**，不猜为空项目列表。先让这个目录可读（权限/盘符/被占用）再重试。" +
        RECOVERY_HINT
      );
  }
}

/** 文件在但内容坏（Q129 沿用这个类名与 code，行为按补修 A 收口：不再自动重建） */
export class RegistryCorruptError extends RegistryStateError {
  constructor(file: string, reason: string) {
    super({ code: "REGISTRY_JSON_CORRUPT", state: "corrupt", file, reason });
    this.name = "RegistryCorruptError";
  }
}

export interface RegistrySiteProbe {
  kind: "fresh" | "present" | RegistryBrokenState;
  /** 被当成"已有运行状态痕迹"的条目名（basename，最多 20 条） */
  traces: string[];
  reason: string;
}

/**
 * 判"registry.json 不在"时这一份现场是什么性质（**补修 A 判据的唯一出处**）。
 *
 * 判据（按顺序）：
 *   ① 数据目录不存在（readdir 报 ENOENT） → `fresh`：从没装过，首次初始化。
 *   ② 目录列不出来（EACCES/EPERM/占用…） → `unknown`：看不清现场就不猜。
 *   ③ 目录列表里有 registry.json（`existsSync` 却说不存在：Windows 上权限/占用会让它这么答）
 *      → `present`：这一份本来就在，不判现场——交给正常读路径（读得到就是好表，读不到报
 *      `REGISTRY_UNREADABLE`）。
 *   ④ 目录里有初始化标记 `REGISTRY_INIT_MARKER` → `missing`：这个目录被塔台初始化过，
 *      此刻注册表读不到 = 已有运行状态丢失。
 *   ⑤ 除"启动骨架"（work-service.json / logs / remote）与锁/原子写的瞬时残留之外还有任何条目
 *      （agents.json / config.json / registry.json.corrupt.* / 未知文件…） → `missing`。
 *   ⑥ 只有启动骨架（含空目录） → `fresh`。
 *
 * 边界与反例（改动前先读）：
 *   · **全新安装**：第一次起服务，数据目录已被自己写上 `work-service.json` + `logs/`；没有注册表就
 *     没有项目事实可丢，判 `fresh` 是对的（③ 首次初始化保留合法流程）。
 *   · **本补修之前留下的数据目录**：没有初始化标记，只能靠痕迹判；有 `agents.json`（MCP 用过）或
 *     `config.json`（配过密钥）或任何别的条目 → 判 `missing`，方向保守。
 *   · **人手清空的数据目录**：目录里被清得只剩骨架 → 判 `fresh`。这是**故意**的：现场已经没有任何
 *     可恢复资料，此时报"丢失"只会挡住唯一的出路（重新登记）。
 *   · **反例（判据失灵的方向）**：把某个"其实是骨架"的条目漏掉，会让全新安装被误判成 `missing`
 *     （误报）；把某个"其实是状态"的条目算成骨架，会把丢失洗成新装（漏报，本补修要修的就是它）。
 *     两侧都取保守：骨架清单只放**启动期必定自建、且不含项目事实**的三个。
 */
export function probeRegistrySite(
  dataDir: string = resolveDataDir(),
): RegistrySiteProbe {
  let entries: string[];
  try {
    entries = fs.readdirSync(dataDir);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      return { kind: "fresh", traces: [], reason: "数据目录还不存在（全新安装）" };
    }
    return {
      kind: "unknown",
      traces: [],
      reason: `数据目录列不出来（${errno ?? (e as Error).message}）`,
    };
  }
  if (entries.includes(REGISTRY_FILE)) {
    return {
      kind: "present",
      traces: [],
      reason: "目录列表里有 registry.json（existsSync 说不存在是权限/占用那一类误报）",
    };
  }
  const others = entries.filter(
    (n) =>
      n !== REGISTRY_INIT_MARKER &&
      !BOOT_SKELETON_ENTRIES.has(n) &&
      !isTransientResidue(n),
  );
  const otherNote =
    others.length > 0
      ? `，另有 ${others.length} 项运行痕迹（${others.slice(0, 5).join("、")}${
          others.length > 5 ? "…" : ""
        }）`
      : "";
  if (entries.includes(REGISTRY_INIT_MARKER)) {
    return {
      kind: "missing",
      traces: [REGISTRY_INIT_MARKER, ...others].slice(0, 20),
      reason:
        `目录里有首次初始化标记 ${REGISTRY_INIT_MARKER}（这个目录被塔台初始化过）` + otherNote,
    };
  }
  if (others.length > 0) {
    return {
      kind: "missing",
      traces: others.slice(0, 20),
      reason:
        `目录里有塔台运行痕迹（${others.slice(0, 5).join("、")}` +
        `${others.length > 5 ? `… 共 ${others.length} 项` : ""}）`,
    };
  }
  return {
    kind: "fresh",
    traces: [],
    reason: `数据目录只有塔台启动骨架（${entries.length > 0 ? entries.join("、") : "空目录"}）`,
  };
}

/**
 * 首次初始化：建空表 + 落初始化标记（补修 A ③）。
 *
 * 为什么不取 `withFileLock`：本函数由 `readRegistry` 在"首次读"时调到，而 `readRegistry` 又会被
 * `addProject` 一类**已经持锁**的写路径调到——`fileLock.ts` 明说锁不可重入，这里再取一次必然超时抛错。
 * 安全性由两点保证：内容恒为同一份空表（并发建表等价）、落盘一律 tmp + rename（原子、不留半截）。
 * 真正的"恢复/重建"（有现场要留档的那种）走 `recoverRegistry`，那一条**在锁里**做。
 */
function createInitialRegistry(reg: Registry, dataDir: string): void {
  writeRegistry(reg, dataDir);
  try {
    writeInitMarker(dataDir);
  } catch (e) {
    // 标记写不上不影响注册表可用（下次判现场会退回按痕迹判），但要如实说一声
    console.warn(
      `[registry] 首次初始化标记写不上（不影响注册表可用）：${(e as Error).message}`,
    );
  }
}

/** 落初始化标记（原子写：tmp + rename，与注册表同一惯例） */
function writeInitMarker(dataDir: string): void {
  const file = path.join(dataDir, REGISTRY_INIT_MARKER);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, initialized_at: nowIso(), file: REGISTRY_FILE }, null, 2) +
      "\n",
    "utf8",
  );
  fs.renameSync(tmp, file);
}

/**
 * readRegistry 的读缓存（Q43，2026-09-18 审计）。
 *
 * 为什么要：`readRegistry` 每次调用都 readFileSync + JSON.parse，而 `getProject` / `listProjects`
 * 完全没有缓存——热路径（实况 getLive 每项目一次、summary 逐项目约 4 次 getProject、每次 HTTP 请求
 * 若干次）反复读同一份个位数项目的小文件。
 *
 * 缓存键 = 文件身份三元组（size / mtimeMs / ino）：写入一律走 tmp+rename（整份换掉），
 * 任一项变化即失效，故"自己写完读到旧值"不会发生；跨进程写入同理（rename 落地即换 mtime/ino，
 * 且进程内写入都在 withFileLock 里）。
 *
 * 口径红线：**返回值是共享对象，调用方只读**。写路径（addProject / removeProject / touchLastOpened）
 * 一律先 `structuredClone` 拿到私有副本再改，改完由 writeRegistry 落盘并把缓存置空——
 * 所以缓存里永远是"磁盘上那一份"，不会掺进任何没落盘成功的内存改动。
 */
interface RegistryCacheEntry {
  file: string;
  size: number;
  mtimeMs: number;
  ino: number;
  registry: Registry;
}
let registryCache: RegistryCacheEntry | null = null;

/** 文件身份；读不到（不存在/无权限）返回 null */
function fileIdentity(
  file: string,
): { size: number; mtimeMs: number; ino: number } | null {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * 读注册表。
 *
 * Q43：命中缓存则直接返回同一对象（省掉读盘 + parse）；返回值只读，见 RegistryCacheEntry 注释。
 *
 * ── 补修 A（2026-09-20，PLAN「补修分包」A / V06-14）──
 * 这里**只**在判定为"首次初始化"（`probeRegistrySite` → `fresh`）时才建空表；"看起来像已有运行状态
 * 却读不到"一律结构化报错，绝不返回空项目列表冒充正常：
 *   · 文件在、内容坏/结构不符 → `REGISTRY_JSON_CORRUPT`（RegistryCorruptError）；
 *   · 文件在、读失败（权限/占用/目录） → `REGISTRY_UNREADABLE`；
 *   · 文件不在、现场像已有运行状态 → `REGISTRY_MISSING`；
 *   · 连数据目录都列不出来（判不出性质） → `REGISTRY_STATE_UNKNOWN`。
 * 判据、边界与反例的唯一出处 = `probeRegistrySite`。
 */
export function readRegistry(dataDir: string = resolveDataDir()): Registry {
  const file = registryPath(dataDir);
  if (!fs.existsSync(file)) {
    const probe = probeRegistrySite(dataDir);
    if (probe.kind === "fresh") {
      // ③ 首次初始化保留合法流程：全新数据目录（不存在/只有启动骨架）首次读 → 建空表并可用
      const reg = emptyRegistry();
      createInitialRegistry(reg, dataDir);
      return reg;
    }
    if (probe.kind !== "present") {
      throw new RegistryStateError({
        code: registryCodeOf(probe.kind),
        state: probe.kind,
        file,
        reason: probe.reason,
        traces: probe.traces,
      });
    }
    // kind === "present"：目录列表里有它，只是 existsSync 没认出来（权限/占用那一类）——
    // 照常往下读：读得到就是好表，读不到由下面的 try 报 REGISTRY_UNREADABLE。
  }
  const id = fileIdentity(file);
  if (
    id &&
    registryCache &&
    registryCache.file === file &&
    registryCache.size === id.size &&
    registryCache.mtimeMs === id.mtimeMs &&
    registryCache.ino === id.ino
  ) {
    return registryCache.registry;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    // 补修 A：权限/占用导致的读失败原先裸抛（顶层兜底报成含糊的 500 INTERNAL）——
    // 现在与"文件根本不在"分开报，且**都不**当作空项目列表。
    throw new RegistryStateError({
      code: "REGISTRY_UNREADABLE",
      state: "unreadable",
      file,
      reason: (e as NodeJS.ErrnoException).code ?? (e as Error).message,
    });
  }
  let registry: Registry;
  try {
    registry = validateRegistry(JSON.parse(text));
  } catch (e) {
    // Q129（2026-09-19 审计）：`JSON.parse` + `validateRegistry` 此前裸跑——坏/半截注册表让
    // **几乎所有路由**（每个都要 listProjects/getProject）落 500 INTERNAL，错误码含糊、没有可操作提示。
    throw new RegistryCorruptError(file, (e as Error).message);
  }
  if (id) registryCache = { file, ...id, registry };
  return registry;
}

function registryCodeOf(kind: RegistryBrokenState): RegistryStateCode {
  switch (kind) {
    case "missing":
      return "REGISTRY_MISSING";
    case "corrupt":
      return "REGISTRY_JSON_CORRUPT";
    case "unreadable":
      return "REGISTRY_UNREADABLE";
    case "unknown":
      return "REGISTRY_STATE_UNKNOWN";
  }
}

/**
 * 恢复入口（补修 A ④）：**显式触发**、**先留档现场**、**在锁里**、**原子换表**。
 *
 * 两种用法：
 *   · `recoverRegistry(dataDir)` —— 把读不出来的现场留档后**重建空表**（人确认"这一份已经救不回来"）；
 *   · `recoverRegistry(dataDir, { from: "registry.json.corrupt.<时间戳>" })` —— 从数据目录内的留档/
 *     备份**恢复**（来源必须能过 `validateRegistry`，原文一字不改地写回）。
 *
 * 现场怎么留（一律改名/另写，不覆盖、不删）：
 *   · 文件在（corrupt/unreadable） → 改名 `registry.json.corrupt.<毫秒时间戳>`（沿用既有留档口径）；
 *   · 文件不在（missing）        → 没有文件可改，写一份 `registry.json.lost.<时间戳>.json` 记录
 *     当时判定的性质、原因与目录痕迹清单（现场事实留证，项目事实本身在项目自己的 `.工作台/` 里）；
 *   · 表现场可读但要 `from` 恢复  → 先把它改名 `registry.json.bak.<时间戳>`，别把当前这份冲掉。
 *
 * 不做什么：**不**在读写路径上被自动调用；**不**接受数据目录之外的路径；**不**覆盖没留过档的现场。
 */
export function recoverRegistry(
  dataDir: string = resolveDataDir(),
  opts: { from?: string } = {},
): RegistryRecoveryResult {
  const file = registryPath(dataDir);
  // ⓪ 取锁前先做一次**只读**探测：判不出性质时先于"建锁文件"就报结构化错误——数据目录压根不是
  // 一个可用目录时，withFileLock 里那句 mkdirSync 会先抛一个含糊的 fs 错（EEXIST/ENOTDIR），
  // 把排查方向指歪，还会让人以为"恢复失败是写入问题"。
  refuseUnknownSite(detectBrokenSite(file, dataDir), file);
  return withFileLock(file, () => {
    const stamp = Date.now();
    const broken = detectBrokenSite(file, dataDir);
    refuseUnknownSite(broken, file);
    const source =
      opts.from === undefined ? null : loadRecoverySource(dataDir, opts.from);

    if (broken === null && source === null) {
      return {
        action: "noop" as const,
        registry_file: REGISTRY_FILE,
        quarantined: null,
        from: null,
        projects: readRegistry(dataDir).projects.length,
        note: "注册表当前可正常读取、且没有指定恢复来源——未做任何改动（要重建空表请先修/移走这一份，或显式给出 from）",
      };
    }

    let quarantined: string | null = null;
    if (broken === null) {
      const name = `registry.json.bak.${stamp}`;
      fs.renameSync(file, path.join(dataDir, name));
      quarantined = name;
    } else if (broken.state === "missing") {
      const name = `registry.json.lost.${stamp}.json`;
      fs.writeFileSync(
        path.join(dataDir, name),
        JSON.stringify(
          {
            detected_at: nowIso(),
            state: broken.state,
            code: broken.code,
            reason: broken.reason,
            traces: broken.traces,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      quarantined = name;
    } else {
      const name = `registry.json.corrupt.${stamp}`;
      try {
        fs.renameSync(file, path.join(dataDir, name));
        quarantined = name;
      } catch (e) {
        // 现场在判定与改名之间被别的进程/人移走了：不拦恢复（下面照样重建），但要如实说明
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }

    writeRegistryText(
      source === null ? JSON.stringify(emptyRegistry(), null, 2) + "\n" : source.text,
      dataDir,
    );
    try {
      writeInitMarker(dataDir);
    } catch {
      // 与首次初始化同一口径：标记写不上不影响注册表可用
    }
    const projects = readRegistry(dataDir).projects.length;
    return {
      action: source === null ? ("rebuilt_empty" as const) : ("restored_from" as const),
      registry_file: REGISTRY_FILE,
      quarantined,
      from: source === null ? null : source.name,
      projects,
      note:
        source === null
          ? `现场已留档（${quarantined ?? "无可留档文件"}），注册表重建为空表（${projects} 个项目）——登记过的项目记录没有恢复，要去项目里重新登记`
          : `已从 ${source.name} 恢复（现场留档 ${quarantined ?? "无可留档文件"}，${projects} 个项目）`,
    };
  });
}

export interface RegistryRecoveryResult {
  action: "rebuilt_empty" | "restored_from" | "noop";
  registry_file: string;
  /** 现场留档文件名（null = 现场本来就没有可留档的文件） */
  quarantined: string | null;
  /** 恢复来源（数据目录内的文件名；action=restored_from 时非空） */
  from: string | null;
  /** 恢复后的项目条数 */
  projects: number;
  note: string;
}

/** 恢复入口的入参错（来源不是数据目录内的文件名 / 不是合法注册表）→ HTTP 400 */
export class RegistryRecoveryInputError extends Error {
  readonly code = "INVALID_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "RegistryRecoveryInputError";
  }
}

/** 现场探测结果（`detectBrokenSite` 的返回；null = 当前可正常读） */
interface BrokenSite {
  state: RegistryBrokenState;
  code: RegistryStateCode;
  reason: string;
  traces: string[];
}

/**
 * ⑥ 判不出现场性质时保持**受阻**：连"这个目录里有什么"都看不清，重建就等于把一份可能存在的注册表
 * 悄悄换掉（EACCES 下 `existsSync` 会说"不存在"）。恢复入口要先把现场弄可读，别猜。
 */
function refuseUnknownSite(broken: BrokenSite | null, file: string): void {
  if (broken === null || broken.state !== "unknown") return;
  throw new RegistryStateError({
    code: "REGISTRY_STATE_UNKNOWN",
    state: "unknown",
    file,
    reason: `${broken.reason}（恢复入口要求先看清现场，不覆盖可能存在的注册表）`,
    traces: broken.traces,
  });
}

/** 现场性质探测（**无副作用**：只读，不建表）：null = 当前可正常读 */
function detectBrokenSite(file: string, dataDir: string): BrokenSite | null {
  if (!fs.existsSync(file)) {
    const probe = probeRegistrySite(dataDir);
    if (probe.kind === "fresh") return null; // 全新目录：没有现场可恢复，也没有丢失
    if (probe.kind !== "present") {
      return {
        state: probe.kind,
        code: registryCodeOf(probe.kind),
        reason: probe.reason,
        traces: probe.traces,
      };
    }
    // kind === "present"：文件其实在（existsSync 误报）→ 交给下面的读路径判
  }
  try {
    readRegistry(dataDir);
    return null;
  } catch (e) {
    if (!(e instanceof RegistryStateError)) throw e;
    return { state: e.state, code: e.code, reason: e.reason, traces: e.traces };
  }
}

/** 读恢复来源：只接受**数据目录内**的文件名（不带路径），且必须是一份合法注册表 */
function loadRecoverySource(
  dataDir: string,
  from: string,
): { name: string; text: string } {
  const name = from.trim();
  if (name === "") {
    throw new RegistryRecoveryInputError(
      "恢复来源不能是空串（不给 from 就是「重建空表」这条用法）",
    );
  }
  if (name !== path.basename(name) || name === "." || name === "..") {
    throw new RegistryRecoveryInputError(
      `恢复来源只接受数据目录内的文件名（不要带路径、不要 ..）：${name}`,
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataDir, name), "utf8");
  } catch (e) {
    throw new RegistryRecoveryInputError(
      `恢复来源读不出来：${name}（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）——没动现有文件`,
    );
  }
  try {
    validateRegistry(JSON.parse(text));
  } catch (e) {
    throw new RegistryRecoveryInputError(
      `恢复来源不是一份合法注册表：${name}（${(e as Error).message}）——没动现有文件`,
    );
  }
  return { name, text };
}

/**
 * 原子写注册表：先写临时文件再 rename，防半截文件。
 * Q43：落盘后把读缓存置空（下次读重新读盘）——不缓存刚写进去的那个对象，
 * 免得调用方手里那份引用后续被改动时把缓存带歪。
 */
export function writeRegistry(
  registry: Registry,
  dataDir: string = resolveDataDir(),
): void {
  writeRegistryText(JSON.stringify(registry, null, 2) + "\n", dataDir);
}

/** 与 `writeRegistry` 同一原子口径，但写**原文**（从留档/备份恢复时不重新序列化，保持原始字节） */
function writeRegistryText(text: string, dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = registryPath(dataDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  registryCache = null;
}

/** 本地时间 ISO 串（带时区偏移）已抽到 ./time，此处 re-export 保持既有调用方不破 */
export { nowIso } from "./time";

export function listProjects(dataDir?: string): ProjectRecord[] {
  return readRegistry(dataDir).projects;
}

export function getProject(
  id: string,
  dataDir?: string,
): ProjectRecord | undefined {
  return readRegistry(dataDir).projects.find((p) => p.id === id);
}

/**
 * 新增项目；id 已存在时报错。
 * Q23（2026-09-18 审计）：读—改—写整段进跨进程锁——HTTP 后端与 MCP 进程都会增删注册表，
 * 无锁时"读到的旧表"会把对方刚推进去的项目整份覆盖掉（丢更新）。
 */
export function addProject(
  input: NewProject,
  dataDir?: string,
): ProjectRecord {
  assertKind(input.kind);
  return withFileLock(registryPath(dataDir), () => {
    // 补修 A：写路径**不再**"遇到读不出来的注册表就留档+清空重建"——一次普通登记不许把历史
    // 缺失掩盖掉。读不出来就照 `readRegistry` 的口径报结构化错误（含恢复入口）。
    const reg = structuredClone(readRegistry(dataDir)); // Q43：缓存返回的是共享对象，改动前先取私有副本
    if (reg.projects.some((p) => p.id === input.id)) {
      throw new Error(`项目 id 已存在: ${input.id}`);
    }
    const now = nowIso();
    const record: ProjectRecord = {
      id: input.id,
      name: input.name,
      path: path.resolve(input.path),
      kind: input.kind,
      registered_at: now,
      last_opened_at: now,
      ...(input.self_managed ? { self_managed: true } : {}),
      ...(input.design_path ? { design_path: input.design_path } : {}),
      ...(input.plan_path ? { plan_path: input.plan_path } : {}),
    };
    reg.projects.push(record);
    writeRegistry(reg, dataDir);
    return record;
  });
}

/** 按 id 移除；不存在返回 false（Q23：同 addProject，读—改—写进跨进程锁） */
export function removeProject(id: string, dataDir?: string): boolean {
  return withFileLock(registryPath(dataDir), () => {
    const reg = structuredClone(readRegistry(dataDir)); // Q43：同上，改动前先取私有副本；补修 A：坏表不自动重建
    const before = reg.projects.length;
    reg.projects = reg.projects.filter((p) => p.id !== id);
    if (reg.projects.length === before) return false;
    writeRegistry(reg, dataDir);
    return true;
  });
}

/** 刷新 last_opened_at；不存在返回 false（Q23：同 addProject，读—改—写进跨进程锁） */
export function touchLastOpened(id: string, dataDir?: string): boolean {
  return withFileLock(registryPath(dataDir), () => {
    const reg = structuredClone(readRegistry(dataDir)); // Q43：同上，改动前先取私有副本；补修 A：坏表不自动重建
    const p = reg.projects.find((p) => p.id === id);
    if (!p) return false;
    p.last_opened_at = nowIso();
    writeRegistry(reg, dataDir);
    return true;
  });
}

/**
 * 登记 / 清除两份图纸的源路径（PLAN.md V06-02，DESIGN.md §2.9）。
 *
 * 口径：**项目根内相对路径**。这里只做与项目根无关的形态校验（非空、非绝对路径、无 `..` 段）——
 * 软链逃逸要拿到项目根的真实路径才判得了，那一步在 `work/documents.ts` 的源解析里做
 * （登记时先拦掉最明显的写法错误，解析时再拦真实越界）。
 * `null` / `undefined` / 空串 = 清掉该字段，回到缺省口径（塔台根图纸 / `.工作台/design.md|plan.md`）。
 * 不存在返回 false（Q23：同 addProject，读—改—写进跨进程锁）。
 */
export function setProjectDocumentPaths(
  id: string,
  paths: { design_path?: string | null; plan_path?: string | null },
  dataDir?: string,
): boolean {
  const cleaned: { design_path?: string | null; plan_path?: string | null } = {};
  for (const key of ["design_path", "plan_path"] as const) {
    const raw = paths[key];
    if (raw === undefined || raw === null || raw.trim() === "") {
      cleaned[key] = null;
      continue;
    }
    const value = raw.trim();
    if (/^[A-Za-z]:[\\/]|^\\\\|^\//.test(value) || path.isAbsolute(value)) {
      throw new Error(`图纸源路径必须是项目根内相对路径，收到绝对路径: ${value}`);
    }
    if (value.replace(/\\/g, "/").split("/").some((seg) => seg === "..")) {
      throw new Error(`图纸源路径不允许 \`..\` 段（不越出项目根）: ${value}`);
    }
    cleaned[key] = value;
  }
  return withFileLock(registryPath(dataDir), () => {
    const reg = structuredClone(readRegistry(dataDir)); // Q43：同 addProject；补修 A：坏表不自动重建
    const p = reg.projects.find((p) => p.id === id);
    if (!p) return false;
    for (const key of ["design_path", "plan_path"] as const) {
      const value = cleaned[key];
      if (typeof value === "string") p[key] = value;
      else delete p[key];
    }
    writeRegistry(reg, dataDir);
    return true;
  });
}
