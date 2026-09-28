// A2：Flash 起名（DESIGN.md §4.1 混合管线第二层，只做翻译不做发现）。
// 读 .工作台/arch/modules.json（A1 产物）→ 对每个模块（path + file_count + loc +
// deps 邻居 + 抽样文件名清单）调 DeepSeek V4.1 Flash 产出 {name（中文人话名）, blurb, kind}，
// 落盘 .工作台/arch/names.json 缓存。
// 缓存口径（§12.2 风险 2 防名字跳变）：signature = sha1(path + file_count + deps)，
// 签名未变直接命中缓存不发请求；签名变了（模块语义变了）才重新起名。
// 失败降级：单模块起名失败 → path 兜底名 + fallback:true 标记，不阻塞整体；
// fallback 条目不参与缓存命中（下次调用会重试）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProject } from "../server/registry";
import { WsError } from "../server/workstation";
import { chat as flashChat, type FlashMessage, type FlashOptions } from "../server/flash";
import { readModules, type ArchModule } from "./parse";
import { MODULE_KINDS, NAME_OPTIONS, buildNameMessages, type ModuleKind } from "./config";

/** 单模块起名结果（names.json entries 一条） */
export interface NameEntry {
  /** 中文人话名（如「架构图引擎」） */
  name: string;
  /** 一句话说明 */
  blurb: string;
  /** 模块分类：code / data / docs / mixed（A3 可据 data/docs 降权展示） */
  kind: ModuleKind;
  /** 起名时间（ISO） */
  named_at: string;
  /** 签名：sha1(path + file_count + deps)，未变即命中缓存 */
  signature: string;
  /** 起名失败降级标记（path 兜底名）；不参与缓存命中，下次重试 */
  fallback?: boolean;
}

/** names.json 文件结构 */
export interface ArchNamesFile {
  version: 1;
  entries: Record<string, NameEntry>;
}

export interface NameModulesResult {
  /** 落盘绝对路径 */
  source: string;
  /** 本次真发请求起名的模块数 */
  named: number;
  /** 本次签名命中缓存（0 请求）的模块数 */
  cache_hits: number;
  /** 本次失败降级的模块数 */
  fallbacks: number;
  /** V08-01：本次剪掉的**已不存在模块**的人话名缓存条目数（只清孤儿，不动活着的） */
  pruned: number;
  file: ArchNamesFile;
}

/** 可调项：dataDir 走注册表口径；chat 可注入（验证脚本 mock 失败/计数请求） */
export interface NameModulesOptions {
  dataDir?: string;
  chat?: (messages: FlashMessage[], opts?: FlashOptions) => Promise<string>;
  /** 强制重起名（§4.4 手动「重命名刷新」按钮用），忽略缓存签名 */
  force?: boolean;
}

const namesJsonPath = (root: string) => path.join(root, ".工作台", "arch", "names.json");

/** 原子写 JSON：先写临时文件再 rename，防半截文件（与 workstation.writeJsonAtomic 同一惯例） */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** 模块签名：path + file_count + deps（to/weight 排序后）的 sha1 前 16 位 */
export function moduleSignature(m: ArchModule): string {
  const deps = [...m.deps].sort((a, b) => a.to.localeCompare(b.to)).map((d) => `${d.to}:${d.weight}`);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({ path: m.path, file_count: m.file_count, deps }))
    .digest("hex")
    .slice(0, 16);
}

/** 抽样文件名：沿模块路径（「其他」桶为多前缀清单）迭代遍历，收满 limit 条即停 */
function sampleFileNames(root: string, m: ArchModule, limit: number): string[] {
  const out: string[] = [];
  const prefixes = m.path === "." ? [""] : m.path.split(",");
  for (const prefix of prefixes) {
    const base = prefix === "" ? root : path.join(root, ...prefix.split("/"));
    const stack: string[] = [base];
    while (stack.length > 0 && out.length < limit) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (out.length >= limit) break;
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
          stack.push(path.join(dir, e.name));
        } else if (e.isFile()) {
          out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
        }
      }
    }
  }
  return out;
}

/** 从 Flash 回复里抠 JSON（容忍前后多余文字），解析并规整字段 */
function parseNameReply(reply: string): { name: string; blurb: string; kind: ModuleKind } {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Flash 回复不含 JSON: ${reply.slice(0, 120)}`);
  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "") throw new Error(`Flash 回复缺 name: ${match[0].slice(0, 120)}`);
  const blurb = typeof raw.blurb === "string" ? raw.blurb.trim() : "";
  const kind = (MODULE_KINDS as readonly string[]).includes(raw.kind as string)
    ? (raw.kind as ModuleKind)
    : "mixed";
  return { name, blurb, kind };
}

/** path 兜底名（失败降级用）：取最后一段路径；「其他」桶与根散文件给固定名 */
function fallbackName(m: ArchModule): string {
  if (m.id === "other") return "其他模块";
  if (m.path === ".") return "根目录散文件";
  const seg = m.path.split("/").filter(Boolean).pop();
  return seg ?? m.id;
}

/** 读已落盘 names.json；不存在/损坏返回空 entries（损坏不炸，重新起名即可重建） */
export function readNames(root: string): ArchNamesFile {
  const source = namesJsonPath(root);
  if (!fs.existsSync(source)) return { version: 1, entries: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(source, "utf8")) as ArchNamesFile;
    if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
      return { version: 1, entries: raw.entries };
    }
  } catch {
    // 损坏按空处理
  }
  return { version: 1, entries: {} };
}

/**
 * 对项目全部模块起名并落盘缓存。
 * 逐模块调 Flash（每模块一次请求）：签名命中缓存的模块零请求（§12.2 风险 2）；
 * 单模块失败只降级自己，不阻塞其他模块；
 * 每起出一个模块就原子落盘一次（中途中断不丢已完成的结果，下次命中缓存断点续起）。
 */
export async function nameModules(
  projectId: string,
  opts: NameModulesOptions = {},
): Promise<NameModulesResult> {
  const project = getProject(projectId, opts.dataDir);
  if (!project) throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  const { exists, arch } = readModules(projectId, opts.dataDir);
  if (!exists || !arch) {
    throw new WsError("INVALID_INPUT", `尚未解析模块骨架，请先 POST arch/parse: ${projectId}`);
  }
  const doChat = opts.chat ?? flashChat;
  const names = readNames(project.path);
  const byId = new Map(arch.modules.map((m) => [m.id, m]));
  const source = namesJsonPath(project.path);
  // 增量落盘（每起出一个模块落一次）：单模块 60s 超时 × 串行，大项目整轮到分钟级——
  // 关窗/掉电把进程带走时，只算到一半的轮次不能把已花钱的结果全丢（本轮已完成的模块下次直接命中缓存）。
  const persist = () => writeJsonAtomic(source, names);

  let named = 0;
  let cacheHits = 0;
  let fallbacks = 0;
  // V08-01（欠账④）：剪掉**已不存在模块**的人话名缓存条目（材料/骨架变化留下的孤儿），
  // 只清孤儿、不动活着的模块（活着的按签名命中缓存，零请求）。缓存是派生数据，剪枝不丢事实。
  const liveIds = new Set(arch.modules.map((m) => m.id));
  let pruned = 0;
  for (const id of Object.keys(names.entries)) {
    if (liveIds.has(id)) continue;
    delete names.entries[id];
    pruned++;
  }
  for (const m of arch.modules) {
    const signature = moduleSignature(m);
    const cached = names.entries[m.id];
    if (!opts.force && cached && cached.signature === signature && !cached.fallback) {
      cacheHits++;
      continue; // 签名未变：命中缓存零请求（DoD②）
    }
    const messages = buildNameMessages({
      path: m.path,
      file_count: m.file_count,
      loc: m.loc,
      deps: m.deps.map((d) => byId.get(d.to)?.path ?? d.to),
      sample_files: sampleFileNames(project.path, m, NAME_OPTIONS.SAMPLE_FILES),
    });
    try {
      const reply = await doChat(messages, {
        temperature: NAME_OPTIONS.temperature,
        timeoutMs: NAME_OPTIONS.timeoutMs,
      });
      const parsed = parseNameReply(reply);
      names.entries[m.id] = { ...parsed, named_at: new Date().toISOString(), signature };
      named++;
    } catch {
      // 失败降级：path 兜底名 + fallback 标记，不阻塞整体（fallback 不进缓存命中，下次重试）
      names.entries[m.id] = {
        name: fallbackName(m),
        blurb: "",
        kind: "mixed",
        named_at: new Date().toISOString(),
        signature,
        fallback: true,
      };
      fallbacks++;
    }
    persist();
  }

  return { source, named, cache_hits: cacheHits, fallbacks, pruned, file: names };
}
