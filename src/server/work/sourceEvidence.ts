// 源文件清单（source_manifest）：把「这条检查到底核了哪些源码」写成**有界、项目内**的
// 文件集合 + 内容哈希，登记时由唯一写服务宿主**现读核实**，读侧再**现读复核**。
//
// 为什么需要（DESIGN.md §5.6；docs/forward-progress-contract.md F4；PLAN V09-29）：
//   · `task.result_submitted` 只是交付记录，存在不等于验证通过；
//   · 可用于「已验证」的检查必须绑定**当前可核对**的来源——不能拿账本里上次自报的 code revision
//     反过来当"当前代码版本"（`latestCodeBindingRevision` 是自报，不是当前盘上内容）；
//   · 源码一变，覆盖它的旧检查必须失效/待复核；**没被覆盖的无关文件变化不得让一切全失效**。
//
// 判据边界（严格、有界、只读）：
//   · 路径必须是项目根内**相对路径**，归一化后不许 `..`/绝对路径/盘符/UNC——越界直接拒；
//   · 明确拒绝符号链接（含指回项目内的软链）与中间目录软链逃逸（realpath 必须仍落在项目根内）；
//   · 不碰私密/忽略目录（`.工作台`、`node_modules`、`.git`、`dist`、`target`、`__pycache__` 等）；
//   · 条目数、单文件、总量都有上限——超限如实拒，**不做全盘散列**；
//   · 登记时由服务端**读当前盘上内容**算哈希（客户端给的哈希只作核对，对不上即拒——不许编造当前哈希）。
//
// 未知历史（清单读不回/注册时取了清单外的东西）一律走 `unreadable`，读侧按「待复核」表达，
// 不静默当通过，也不删除/改写任何历史事件（§2.6：历史对象不接受编辑）。
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WorkError } from "./types";
import { memoizedForDerivation } from "./derivationScope";

/** 清单口径标签：改这里就是改"什么算同一份源清单"，指纹随版本变化 */
export const SOURCE_MANIFEST_VERSION = "source-manifest-v1";

/** 清单能声明的文件数上限（有界：不是全盘清单） */
export const MAX_SOURCE_MANIFEST_FILES = 512;
/** 单条路径进清单的内容上限（超了如实拒，不假装读到了） */
export const MAX_SOURCE_MANIFEST_FILE_BYTES = 8 * 1024 * 1024;
/** 一次清单的内容总量上限（同上） */
export const MAX_SOURCE_MANIFEST_TOTAL_BYTES = 64 * 1024 * 1024;
/**
 * 读侧解析"清单载体证据正文"的字节上限：清单本体很小，超过这个大小的证据正文**不当清单载体**
 * （既不解析、也不据此判通过），避免把 8MB 的日志当清单读。
 */
export const MAX_SOURCE_MANIFEST_BLOB_BYTES = 1024 * 1024;

/**
 * 不进清单的目录名（任一路径段命中即拒）。与 `scripts/lib/sourceFingerprint.ts` 的 `SKIP_DIRS`
 * 同一口径：私密状态、依赖、产物、版本控制与被忽略的缓存。
 * 比较是 **Windows 大小写不敏感** 的（`.GIT`/`Node_Modules` 同样命中）。
 * 注意：**不**把普通业务目录（如 `audit/`）当秘密——那不是项目私有状态，挡掉会误伤正常源码。
 */
export const SOURCE_MANIFEST_IGNORED_SEGMENTS: readonly string[] = [
  ".工作台",
  "node_modules",
  ".git",
  "dist",
  "target",
  "__pycache__",
  ".vite-cache",
  ".vite-cache-red",
];

/**
 * 真正的私密文件（按**文件名**判定）：密钥、凭据、本地环境变量。这类内容不进清单、不读、不算哈希。
 * 只列确定性的私密名（宁可漏一点，也不误伤普通源码文件）。
 */
const PRIVATE_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i, // .env / .env.local / .env.production …
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.pypirc$/i,
  /^\.htpasswd$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials(\..+)?$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
];

export interface SourceManifestEntry {
  /** 项目根内相对路径（`/` 分隔、归一化、无 `..`） */
  path: string;
  /** 登记时由服务端现读的 sha256（严格 64 位小写十六进制） */
  sha256: string;
  bytes: number;
}

/** 一份已核实、不可变的源文件清单（存进证据正文，内容寻址） */
export interface SourceManifest {
  version: typeof SOURCE_MANIFEST_VERSION;
  files: SourceManifestEntry[];
  /** 清单指纹：路径 + 内容哈希 + 体积 的确定性 sha256（现读复核比它） */
  fingerprint: string;
}

/** 登记入参：文件路径串，或 `{path, sha256?}`（给了哈希即须与现读一致，否则拒） */
export type SourceManifestRequest = readonly (string | { path?: unknown; sha256?: unknown })[];
/** 结构化数组入参（server 侧 HTTP 可能收到对象形态） */
export type SourceManifestRequestObject = { files?: unknown } | readonly unknown[];

const SHA256_HEX = /^[0-9a-f]{64}$/;

function manifestError(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("EVIDENCE_INVALID", message, detail);
}

export const isSha256Hex = (v: unknown): v is string => typeof v === "string" && SHA256_HEX.test(v);

/** `<项目根>/.工作台/work` → `<项目根>`（清单路径只相对项目根，不相对 `.工作台`） */
export function projectRootOfWorkDir(workDir: string): string {
  return path.dirname(path.dirname(path.resolve(workDir)));
}

/**
 * 声明路径归一化：反斜杠统一成 `/`，去掉空段与 `.`；遇到 `..`、绝对路径、盘符、UNC 一律拒。
 * 返回归一化后的相对路径（不读盘、不解析软链——那是 `resolveInsideProject` 的事）。
 */
export function normalizeManifestPath(raw: unknown): string {
  if (typeof raw !== "string") manifestError(`源清单的路径必须是字符串（收到 ${JSON.stringify(raw)}）`, { path: raw });
  const text = raw.trim();
  if (text === "") manifestError("源清单里有空路径");
  const unified = text.replace(/\\/g, "/");
  if (unified.startsWith("/")) manifestError(`源清单路径必须是项目内相对路径，不能是绝对路径：${raw}`, { path: raw });
  if (/^[a-zA-Z]:/.test(unified)) manifestError(`源清单路径不能带盘符：${raw}`, { path: raw });
  if (unified.startsWith("//")) manifestError(`源清单路径不能是 UNC 路径：${raw}`, { path: raw });
  const parts = unified.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) manifestError(`源清单路径归一化后为空：${raw}`, { path: raw });
  for (const p of parts) {
    if (p === "..") manifestError(`源清单路径含 .. 上跳（越界一律拒）：${raw}`, { path: raw });
    if (p.includes("\0")) manifestError(`源清单路径含 NUL：${raw}`, { path: raw });
  }
  return parts.join("/");
}

const IGNORED_SEGMENTS_LC: ReadonlySet<string> = new Set(
  SOURCE_MANIFEST_IGNORED_SEGMENTS.map((s) => s.toLowerCase()),
);

/** 私密/忽略目录（任一路径段命中，大小写不敏感）不进清单——不扫描、不登记 */
export function isIgnoredManifestPath(rel: string): boolean {
  return rel.split("/").some((seg) => IGNORED_SEGMENTS_LC.has(seg.toLowerCase()));
}

/** 真正的私密文件（.env/凭据/私钥等）不进清单——不读、不算哈希、不登记 */
export function isPrivateManifestPath(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return PRIVATE_FILE_PATTERNS.some((re) => re.test(base));
}

/** 清单禁入判据（忽略目录 ∪ 私密文件）——登记与读侧共用同一份，不两处各写一套 */
export function isForbiddenManifestPath(rel: string): boolean {
  return isIgnoredManifestPath(rel) || isPrivateManifestPath(rel);
}

/** `git check-ignore` 探针结论：明确区分「不是仓库（不适用）」「探到了命中」「探针失败（未知）」 */
export interface GitIgnoreProbe {
  /** 项目根是不是 Git 仓库（有 `.git`）。false = 非仓库：这一层明确**不适用**（不是"没忽略"）。 */
  is_repo: boolean;
  /** 真实命中忽略规则的**归一化相对路径**集合（有界：只核已声明路径，不做目录遍历） */
  ignored: Set<string>;
  /** 探针失败原因（有 `.git` 但 git 调用失败/超时/不可用）；非 null ⇒ **不能**据此判"未忽略" */
  failure: string | null;
}

/**
 * 用**有界** `git check-ignore` 剔出**真实被 git 忽略**的路径（覆盖仓库自己的 .gitignore 规则，
 * 不只是上面那张固定段表）。判据边界（**绝不**全盘扫描；`fail-closed`）：
 *   · 只检查**调用方已经声明的**这些路径（个数同清单上限，不做目录遍历）；
 *   · 项目根没有 `.git`（不是仓库）→ `is_repo: false`（这一层明确不适用，**不是**"没忽略"）；
 *   · 有 `.git` 但 git 不存在 / 调用出错 / 超时 / 非预期退出码 → `failure` 非 null——
 *     **未知不能当未忽略**（否则无法保证不读取忽略目录，却仍判登记通过）；由调用方拒收；
 *   · 探针成功 → `ignored` 给命中集合（exit 0 = 有命中；exit 1 = 一个都没命中）。
 */
export function gitIgnoredPaths(projectRoot: string, rels: readonly string[]): GitIgnoreProbe {
  // git check-ignore 是**同步子进程**（阻塞事件循环）：一次派生里同样的（根 + 路径集）只跑一次。
  // 键按排序后的路径集算，与入参顺序无关（同一集合复用同一结论）。
  const key = `${path.resolve(projectRoot)}\u0000${[...rels].sort().join("\u0000")}`;
  const probe = memoizedForDerivation("source:git-ignored", key, () => computeGitIgnoredPaths(projectRoot, rels));
  return { is_repo: probe.is_repo, ignored: new Set(probe.ignored), failure: probe.failure };
}

function computeGitIgnoredPaths(projectRoot: string, rels: readonly string[]): GitIgnoreProbe {
  const out = new Set<string>();
  const rootAbs = path.resolve(projectRoot);
  const isRepo = fs.existsSync(path.join(rootAbs, ".git"));
  if (rels.length === 0) return { is_repo: isRepo, ignored: out, failure: null };
  if (!isRepo) return { is_repo: false, ignored: out, failure: null };
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("git", ["-C", rootAbs, "check-ignore", "--stdin", "-z"], {
      input: rels.join("\0"),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 8000,
      windowsHide: true,
    });
  } catch (e) {
    return { is_repo: true, ignored: out, failure: `git check-ignore 调用抛错：${(e as Error).message}` };
  }
  if (res.error !== undefined && res.error !== null) {
    return { is_repo: true, ignored: out, failure: `git 不可用/调用出错：${res.error.message}` };
  }
  // exit 0 = 有命中；exit 1 = 一个都没命中；其它（含超时被杀 / git 不在 / 坏 .git）→ 探针失败（未知，不当未忽略）
  if (res.status !== 0 && res.status !== 1) {
    const why = res.status === null ? "被信号终止（可能超时）" : `退出码 ${res.status}`;
    return { is_repo: true, ignored: out, failure: `git check-ignore ${why}：无法核实这些路径是否被忽略` };
  }
  for (const p of String(res.stdout ?? "").split("\0")) {
    const t = p.trim();
    if (t !== "") out.add(t.replace(/\\/g, "/"));
  }
  return { is_repo: true, ignored: out, failure: null };
}

/**
 * 把相对路径解析成项目根内的绝对路径；越界、软链（本体或中间目录逃逸）一律拒。
 * 返回绝对路径（已确认落在项目根内）。
 */
export function resolveInsideProject(projectRoot: string, rel: string): string {
  const rootAbs = path.resolve(projectRoot);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    manifestError(`源清单路径越出项目根：${rel}`, { path: rel, project_root: rootAbs });
  }
  const rootReal = safeRealpath(rootAbs);
  const targetReal = safeRealpath(abs);
  if (targetReal === null) manifestError(`源清单路径解析不到真实路径（可能是坏软链）：${rel}`, { path: rel });
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    manifestError(`源清单路径经符号链接逃出项目根：${rel}`, { path: rel, real: targetReal });
  }
  return abs;
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** 逐段拒绝软链：路径本体与每一级祖先目录都不能是符号链接（软链逃逸的显式防线） */
function assertNoSymlink(projectRoot: string, rel: string): void {
  const rootAbs = path.resolve(projectRoot);
  const parts = rel.split("/");
  let cur = rootAbs;
  for (let i = 0; i < parts.length; i += 1) {
    cur = path.join(cur, parts[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      // 后面的 readManifestFile 会给出"不存在"的更准确错误
      return;
    }
    if (st.isSymbolicLink()) {
      manifestError(`源清单路径含符号链接（越界防线）：${parts.slice(0, i + 1).join("/")}`, { path: rel });
    }
  }
}

export interface SourceManifestReadBudget {
  /** 已计入的总字节（跨文件累计；调用方在循环里递减/累加） */
  used: number;
}

/**
 * 读一条清单文件的当前内容与哈希（有界：单文件与累计总量都设上限）。
 * 越界/软链/非普通文件/超限/读失败一律抛 `EVIDENCE_INVALID`（登记阶段宁严不松）。
 */
export function readManifestFile(
  projectRoot: string,
  rel: string,
  budget: SourceManifestReadBudget = { used: 0 },
): SourceManifestEntry {
  assertNoSymlink(projectRoot, rel);
  const abs = resolveInsideProject(projectRoot, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    manifestError(`源清单声明的文件不存在：${rel}`, { path: rel });
  }
  if (!st.isFile()) manifestError(`源清单声明的路径不是普通文件：${rel}`, { path: rel });
  if (st.size > MAX_SOURCE_MANIFEST_FILE_BYTES) {
    manifestError(`源清单文件超过单文件上限（${MAX_SOURCE_MANIFEST_FILE_BYTES} 字节，实际 ${st.size}）：${rel}`, { path: rel, bytes: st.size });
  }
  if (budget.used + st.size > MAX_SOURCE_MANIFEST_TOTAL_BYTES) {
    manifestError(`源清单内容总量超过上限（${MAX_SOURCE_MANIFEST_TOTAL_BYTES} 字节）：${rel}`, { path: rel });
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    manifestError(`源清单文件读不出来：${rel}（${(e as Error).message}）`, { path: rel });
  }
  budget.used += buf.length;
  return { path: rel, sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

/** 清单指纹：路径 + 内容哈希 + 体积 的确定性 sha256（两侧同一实现） */
export function manifestFingerprintOf(files: readonly SourceManifestEntry[]): string {
  const canon = [...files]
    .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const h = crypto.createHash("sha256");
  h.update(`${SOURCE_MANIFEST_VERSION}\n`, "utf8");
  for (const f of canon) h.update(`${f.path}\n${f.sha256}\n${f.bytes}\n`, "utf8");
  return h.digest("hex");
}

function requestEntries(request: unknown): readonly unknown[] {
  if (Array.isArray(request)) return request;
  if (typeof request === "object" && request !== null) {
    const files = (request as { files?: unknown }).files;
    if (Array.isArray(files)) return files;
  }
  manifestError(
    "source_manifest 必须是文件数组，或 {files:[...]}：每项是项目内相对路径串，或 {path, sha256?}",
    { received: Array.isArray(request) ? "array" : typeof request },
  );
}

/**
 * 登记一份源清单：**服务端现读当前盘上内容**算哈希（客户端给了 sha256 就核对，对不上即拒），
 * 去重、排序、定指纹。返回已核实的不可变清单（进证据正文）。
 */
export function buildSourceManifest(projectRoot: string, request: unknown): SourceManifest {
  const raw = requestEntries(request);
  if (raw.length === 0) manifestError("source_manifest 不能是空清单：不声明覆盖范围就没有可核对的来源");
  if (raw.length > MAX_SOURCE_MANIFEST_FILES) {
    manifestError(`source_manifest 条目过多（上限 ${MAX_SOURCE_MANIFEST_FILES}，收到 ${raw.length}）：不当全盘清单用`, { count: raw.length });
  }
  const seen = new Map<string, string | null>(); // rel → 声明的 sha256（null = 未声明）
  for (const item of raw) {
    if (typeof item === "string") {
      const rel = normalizeManifestPath(item);
      if (isForbiddenManifestPath(rel)) manifestError(`源清单不收私密/忽略目录下的路径：${rel}`, { path: rel });
      if (!seen.has(rel)) seen.set(rel, null);
      continue;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      manifestError(`source_manifest 每项必须是字符串或 {path, sha256?}（收到 ${JSON.stringify(item)}）`);
    }
    const rel = normalizeManifestPath((item as { path?: unknown }).path);
    if (isForbiddenManifestPath(rel)) manifestError(`源清单不收私密/忽略目录下的路径：${rel}`, { path: rel });
    const declared = (item as { sha256?: unknown }).sha256;
    if (declared !== undefined && declared !== null && declared !== "") {
      if (!isSha256Hex(declared)) manifestError(`source_manifest 里声明的 sha256 必须是 64 位小写十六进制：${rel}`, { path: rel, sha256: declared });
      const prev = seen.get(rel);
      if (prev !== undefined && prev !== declared) manifestError(`source_manifest 里同一路径给了两个不同哈希：${rel}`, { path: rel });
      seen.set(rel, declared);
    } else if (!seen.has(rel)) {
      seen.set(rel, null);
    }
  }
  // 真实被 git 忽略的路径（覆盖仓库自己的 .gitignore）：有界批量核，不全盘扫描。
  // 非 Git 项目这一层明确不适用（is_repo=false）；**探针失败必须拒收**——探不到就不能保证不读取
  // 忽略目录，"未知"绝不等于"没忽略"（否则登记照过、读侧却靠不住）。
  const gitProbe = gitIgnoredPaths(projectRoot, [...seen.keys()]);
  if (gitProbe.failure !== null) {
    manifestError(
      `无法用 git 核实这些路径是否被忽略（${gitProbe.failure}）：不能保证不读取忽略目录，拒绝登记` +
        "（非 Git 项目不受此限；Git 探针失败时未知不当未忽略）",
      { reason: gitProbe.failure },
    );
  }
  if (gitProbe.ignored.size > 0) {
    const first = [...gitProbe.ignored][0];
    manifestError(
      `源清单不收**已被 git 忽略**的路径（本地私有/被排除内容不当验证来源）：${first}` +
        (gitProbe.ignored.size > 1 ? ` 等 ${gitProbe.ignored.size} 条` : ""),
      { path: first, git_ignored: [...gitProbe.ignored].slice(0, 8) },
    );
  }
  const budget: SourceManifestReadBudget = { used: 0 };
  const files: SourceManifestEntry[] = [];
  for (const rel of [...seen.keys()].sort()) {
    const entry = readManifestFile(projectRoot, rel, budget);
    const declared = seen.get(rel) ?? null;
    if (declared !== null && declared !== entry.sha256) {
      manifestError(
        `source_manifest 声明的哈希与当前文件内容不符（不许编造当前哈希）：${rel}（声明 ${declared.slice(0, 12)}…，实读 ${entry.sha256.slice(0, 12)}…）`,
        { path: rel, declared_sha256: declared, actual_sha256: entry.sha256 },
      );
    }
    files.push(entry);
  }
  return { version: SOURCE_MANIFEST_VERSION, files, fingerprint: manifestFingerprintOf(files) };
}

/** 从证据正文里的值解析出一份清单（严格：版本/形状/路径/哈希都要对，否则当它不是清单） */
export function parseSourceManifest(value: unknown): SourceManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as { version?: unknown; files?: unknown; fingerprint?: unknown };
  if (v.version !== SOURCE_MANIFEST_VERSION) return null;
  if (!Array.isArray(v.files) || v.files.length === 0) return null;
  if (!isSha256Hex(v.fingerprint)) return null;
  const files: SourceManifestEntry[] = [];
  for (const f of v.files) {
    if (typeof f !== "object" || f === null) return null;
    const e = f as { path?: unknown; sha256?: unknown; bytes?: unknown };
    if (typeof e.path !== "string" || !isSha256Hex(e.sha256) || typeof e.bytes !== "number" || !Number.isFinite(e.bytes)) return null;
    files.push({ path: e.path, sha256: e.sha256, bytes: e.bytes });
  }
  return { version: SOURCE_MANIFEST_VERSION, files, fingerprint: v.fingerprint };
}

/** 读侧现读复核结论 */
export interface SourceManifestVerdict {
  status: "valid" | "invalidated" | "unreadable";
  declared_count: number;
  /** 内容与登记时不同（现读哈希对不上） */
  changed: string[];
  /** 现在不在盘上（删了/移走了） */
  missing: string[];
  /** 取不到内容（越界/软链/超限/非普通文件/读失败）→ 不能据此判通过 */
  unreadable: string[];
  /** 现算的清单指纹（`valid` 时等于登记指纹；算不出为 null） */
  current_fingerprint: string | null;
  reason: string;
}

/**
 * 读侧现读复核：拿登记时的清单去比**当前盘上内容**。
 *   · 全部一致 → `valid`（覆盖范围没变，旧结论仍可采信）；
 *   · 有路径内容变了/被删 → `invalidated`（覆盖的源变了 → 旧绿转待验证）；
 *   · 有路径取不到内容（越界/软链/超限/非普通文件）→ `unreadable`（**未知，待复核**，不当通过）；
 *   · 只比清单里声明的路径——**没被覆盖的无关文件变化不让它失效**（这是"有限范围"的本义）。
 */
export function verifySourceManifest(projectRoot: string, manifest: SourceManifest): SourceManifestVerdict {
  // 一次派生里同一份（项目根 + 清单指纹）只核一次：条目最多 512，逐条 lstat/realpath/读字节/算 sha256
  // 在**一次派生**内被多个子派生重复调用（现场实测每个源文件被读+哈希约 30 次、并伴随多次 git 探针）。
  // 键含清单指纹，清单不同即另算；作用域只在一次同步派生里有效（下一个请求照旧现核）。
  const key = `${path.resolve(projectRoot)}\u0000${manifest.fingerprint}\u0000${manifestFingerprintOf(manifest.files)}`;
  const verdict = memoizedForDerivation("source:verify-manifest", key, () =>
    computeSourceManifestVerdict(projectRoot, manifest),
  );
  // 返回独立副本：登记结论里的三个数组（changed/missing/unreadable）在调用方之间不共享；数组元素是
  // 路径字符串（原始值），浅拷贝即**完整**独立副本（本返回对象没有嵌套的结构化条目）。
  return {
    ...verdict,
    changed: [...verdict.changed],
    missing: [...verdict.missing],
    unreadable: [...verdict.unreadable],
  };
}

function computeSourceManifestVerdict(projectRoot: string, manifest: SourceManifest): SourceManifestVerdict {
  const declaredCount = manifest.files.length;
  const changed: string[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  const current: SourceManifestEntry[] = [];
  // 清单自洽性：文件集合算出的指纹必须等于清单记录的指纹，否则这份清单被动过 → 未知待复核
  if (manifestFingerprintOf(manifest.files) !== manifest.fingerprint) {
    return {
      status: "unreadable",
      declared_count: declaredCount,
      changed,
      missing,
      unreadable,
      current_fingerprint: null,
      reason: "源清单自身不自洽（文件集合算出的指纹与清单记录的指纹对不上）：不采信，按未知待复核",
    };
  }
  // 登记之后忽略规则也可能变化；复核前重查，避免继续读取已转为忽略的文件。
  const gitProbe = gitIgnoredPaths(projectRoot, manifest.files.map((file) => file.path));
  if (gitProbe.failure !== null || gitProbe.ignored.size > 0) {
    return {
      status: "unreadable", declared_count: declaredCount, changed, missing,
      unreadable: [...gitProbe.ignored], current_fingerprint: null,
      reason: gitProbe.failure !== null
        ? `无法核实源文件的忽略规则：${gitProbe.failure}；未读取源码，待复核`
        : `清单路径目前已被忽略：${[...gitProbe.ignored].join("、")}；未读取源码，待复核`,
    };
  }
  const budget: SourceManifestReadBudget = { used: 0 };
  for (const f of manifest.files) {
    let rel: string;
    try {
      rel = normalizeManifestPath(f.path);
    } catch {
      unreadable.push(f.path);
      continue;
    }
    if (isForbiddenManifestPath(rel)) {
      unreadable.push(f.path);
      continue;
    }
    // 先按**纯路径**判存在性：被删/被移走的路径是 `missing`（覆盖源变了 → invalidated），
    // **不是** unreadable——realpath 对不存在的路径必然失败，若先解析就会把「删了」误判成「读不动/未知」。
    const rawAbs = path.resolve(path.resolve(projectRoot), rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(rawAbs);
    } catch {
      missing.push(f.path);
      continue;
    }
    // 存在：再挡软链/越界（realpath 逃出项目根、本体或中间目录是软链）——这类是 unreadable（未知待复核）
    let abs: string;
    try {
      abs = resolveInsideProject(projectRoot, rel);
      assertNoSymlink(projectRoot, rel);
    } catch {
      unreadable.push(f.path);
      continue;
    }
    if (!st.isFile()) {
      unreadable.push(f.path);
      continue;
    }
    if (st.size > MAX_SOURCE_MANIFEST_FILE_BYTES || budget.used + st.size > MAX_SOURCE_MANIFEST_TOTAL_BYTES) {
      unreadable.push(f.path);
      continue;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      unreadable.push(f.path);
      continue;
    }
    budget.used += buf.length;
    const now = crypto.createHash("sha256").update(buf).digest("hex");
    current.push({ path: f.path, sha256: now, bytes: buf.length });
    if (now !== f.sha256) changed.push(f.path);
  }
  if (unreadable.length > 0) {
    return {
      status: "unreadable",
      declared_count: declaredCount,
      changed,
      missing,
      unreadable,
      current_fingerprint: null,
      reason:
        `源清单里有 ${unreadable.length} 条路径的内容取不到（越界/软链/超限/非普通文件/读失败）：` +
        "不能据此判通过，按未知待复核处理（不编造当前哈希、不全盘扫描）",
    };
  }
  if (changed.length > 0 || missing.length > 0) {
    const bits: string[] = [];
    if (changed.length > 0) bits.push(`${changed.length} 条内容已变（${changed.slice(0, 3).join("、")}${changed.length > 3 ? " 等" : ""}）`);
    if (missing.length > 0) bits.push(`${missing.length} 条已不在盘上（${missing.slice(0, 3).join("、")}${missing.length > 3 ? " 等" : ""}）`);
    return {
      status: "invalidated",
      declared_count: declaredCount,
      changed,
      missing,
      unreadable,
      current_fingerprint: manifestFingerprintOf(current),
      reason: `源清单覆盖的源码变了（${bits.join("；")}）：绑定的检查失效，旧绿转待验证（没被覆盖的无关文件变化不影响本清单）`,
    };
  }
  return {
    status: "valid",
    declared_count: declaredCount,
    changed,
    missing,
    unreadable,
    current_fingerprint: manifestFingerprintOf(current),
    reason: `源清单覆盖的 ${declaredCount} 条路径内容与登记时一致：绑定的检查仍对得上当前来源`,
  };
}

/** 一份"清单载体"证据正文里读出的东西：清单本体 + 这份证据**自己声明的源修订** + 载体完整性 */
export interface SourceManifestCarrier {
  manifest: SourceManifest;
  /** 载体证据声明的绑定（读侧要求它与引用它的检查绑定相符，否则不拿这份清单给该检查背书） */
  binding: { revision_kind: string; revision: string } | null;
  /**
   * 载体完整性：正文内容地址（`sha256(content)` == 文件名地址）、bytes、kind 三者都对得上才为 true。
   * false = 现场被改过/截损——证据不可变、正文必须可取回，**不采信**（读侧按未知待复核）。
   */
  intact: boolean;
  /** 不完整的原因（`intact === false` 时非空） */
  defect: string | null;
}

/** 证据正文的内容哈希：与 `evidence.ts` 的内容寻址**同一口径**（只 hash `content` 本身，不 hash 整份 JSON） */
const sha256OfContent = (content: string): string =>
  crypto.createHash("sha256").update(content, "utf8").digest("hex");

/**
 * 读一份"清单载体"证据正文里的清单（有界：只解析小体积正文；读不到/不是清单 → null，绝不当通过）。
 * 同时把载体自己声明的 `binding` 带出来——读侧据此核对「这份清单定义的修订 == 检查声称的修订」，
 * 不允许多附一份无关清单就让旧检查通行。供读侧装配 `checksWithSourceManifests` 使用。
 *
 * **完整性**：读时独立核「正文内容地址 == 文件名地址（只 hash `content`）、`bytes` 一致、`kind` 是
 * source_manifest」——正文被改过/截损但 `source_manifest`/`binding` 字段还完整时，载体判 `intact:false`
 * （不采信、按未知待复核），**不**去核整份 JSON 的哈希（现有 evidence 地址只 hash `content`）。
 *
 * 2026-10-07 运行时负载修复：一次派生里同一份载体只读一次（键=解析后的绝对路径）。证据正文不可变、
 * 内容寻址，同一次派生内重读字节必同；作用域只在一次同步派生内有效，**跨请求不缓存**（下一个请求照旧现读）。
 * 实测：一次只读入口 1440 次载体读（40.3 MB）里绝大多数是同一批载体的重复现读。
 *
 * 2026-10-07 回归修复：记忆**只**为省重复现读/解析，返回值一律是**深独立副本**——同一次派生里各检查
 * 各拿一份，互不共享可变结构（此前直接返回记忆对象，一处就地深改会污染同次派生的其他检查）。
 */
export function readManifestCarrier(filePath: string): SourceManifestCarrier | null {
  const carrier = memoizedForDerivation("source:manifest-carrier", path.resolve(filePath), () =>
    computeManifestCarrier(filePath),
  );
  // 返回**深独立副本**（null 保持 null）：记忆里存的是同一次派生内**共享**的解析结果；直接把它交出去，
  // 调用方对返回对象就地深改（`binding.revision` / `manifest.files[*]` / `intact`）会**泄露给同次派生
  // 里的其他检查**——同一份载体被多个检查各读一次（`checksWithSourceManifests` 装配检查输入、`submitChecks`
  // 复核证据来源），前一处的就地改动污染后一处。这里逐字段重建（含嵌套对象/数组）：记忆只用来省重复
  // 现读+解析，不共享任何可变结构。
  if (carrier === null) return null;
  return {
    manifest: {
      version: carrier.manifest.version,
      fingerprint: carrier.manifest.fingerprint,
      files: carrier.manifest.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
    },
    binding:
      carrier.binding === null
        ? null
        : { revision_kind: carrier.binding.revision_kind, revision: carrier.binding.revision },
    intact: carrier.intact,
    defect: carrier.defect,
  };
}

function computeManifestCarrier(filePath: string): SourceManifestCarrier | null {
  try {
    const expected = path.basename(filePath).replace(/\.json$/i, "").toLowerCase();
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_SOURCE_MANIFEST_BLOB_BYTES) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const manifest = parseSourceManifest(raw.source_manifest);
    if (manifest === null) return null;
    const b = raw.binding;
    const binding =
      typeof b === "object" && b !== null &&
      typeof (b as { revision_kind?: unknown }).revision_kind === "string" &&
      typeof (b as { revision?: unknown }).revision === "string"
        ? { revision_kind: (b as { revision_kind: string }).revision_kind, revision: (b as { revision: string }).revision }
        : null;
    const content = raw.content;
    let defect: string | null;
    if (!isSha256Hex(expected)) {
      defect = "证据文件名不是 64 位小写十六进制内容地址";
    } else if (typeof content !== "string") {
      defect = "证据文件缺正文 content（不可回读）";
    } else if (sha256OfContent(content) !== expected) {
      defect = `证据正文与内容地址不符（文件 ${expected.slice(0, 12)}…，正文 ${sha256OfContent(content).slice(0, 12)}…）：现场被改过/截损`;
    } else if (typeof raw.content_sha256 === "string" && raw.content_sha256 !== expected) {
      defect = "content_sha256 与文件名内容地址不符";
    } else if (typeof raw.bytes !== "number" || raw.bytes !== Buffer.byteLength(content, "utf8")) {
      defect = "证据记录的 bytes 与正文实际长度不符（截损）";
    } else if (raw.kind !== "source_manifest") {
      defect = `证据 kind 不是 source_manifest（收到 ${JSON.stringify(raw.kind)}）`;
    } else {
      defect = null;
    }
    return { manifest, binding, intact: defect === null, defect };
  } catch {
    return null;
  }
}

/** 清单的人话正文（`store` 没给 content 时用它当证据正文；也让读回的证据自带文件清单） */
export function renderSourceManifestText(manifest: SourceManifest): string {
  const lines = [
    `# 源文件清单（${SOURCE_MANIFEST_VERSION}）`,
    "",
    `指纹：${manifest.fingerprint}`,
    `文件数：${manifest.files.length}`,
    "",
    ...manifest.files.map((f) => `${f.sha256}  ${f.bytes.toString().padStart(9, " ")}  ${f.path}`),
    "",
  ];
  return lines.join("\n");
}
