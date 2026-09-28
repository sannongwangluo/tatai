// 意图原文文件（DESIGN.md §2.5「单源分工」／§2.6 权威数据表；数据流图 `df-art-intent` 行缺失的读点）。
//
// 三条硬口径（每条在代码里都有落点，别混）：
//   ① **这是人直接编写的原文，不是产品生成的对象**。`.工作台/intent.json` 与根 `DESIGN.md` 同族：
//      谁想要什么由人写下来，产品**只读**——本模块没有写口、没有 append、没有"造一条意图"的 API。
//      §2.5 明写「`intent.json` 是人的意图记录，可作为 requirement 的来源被引用，不另建一份可独立
//      编辑的需求库」；产品侧的必需能力因此是**读／解析／引用校验**，不是替人造一个写工具。
//   ② **引用校验 fail-closed**（§2.5「引用有效性、原子拒绝」同族）：`requirement` 的
//      `source{kind:"intent", ref:"intent.json#<条目 id>"}` 在**登记/更新时**对**该项目的**这份原文
//      做实解析（点见 `requirements.ts` 的 `assertIntentSourceResolvable`）；悬空（文件不在／条目不在／
//      ref 形态不对）点名拒，文件在场但不合法则抛错——绝不静默当空文件，也绝不"先写后补"。
//   ③ **"没写"与"写坏了"分开**：`readIntentFile` 对"这份文件不存在"如实返回 `null`（正常空态：
//      还没有人写过意图原文）；只有"文件在场但不是合法意图原文"才抛。混为一谈会让没写过的项目
//      看起来像写坏的，也会让写坏的看起来像没写过——两者要处理的动作完全不同（去写／去修）。
//
// 形状口径：`{ version: 1, items: [{ id, text }] }`。DESIGN 只声明"这里放人的意图记录"，没有固定
// 内部字段；本模块采**仓库既有的那份夹具口径**（`scripts/verify-requirements.ts` 的
// `{version:1, items:[{id,text}]}` 与 `intent.json#r-1` 引用），不另造第二种形状。
import fs from "node:fs";
import path from "node:path";
import { WorkError } from "./types";

/** 意图原文文件（项目 `.工作台/` 内相对路径；§2.6 与 decisions.jsonl / baselines.jsonl 并列） */
export const INTENT_FILE = "intent.json";

/** 本模块认的形状版本：只认 1；不认的版本拒，不"尽力解析"另一个版本的字段 */
export const INTENT_SCHEMA_VERSION = 1;

/** 一条意图条目：`id` 是引用用的稳定锚（`intent.json#<id>`），`text` 是人写的原文 */
export interface IntentEntry {
  id: string;
  text: string;
}

/** 解析成功的意图原文（逐字来自那份文件，界面/调用方只渲染不重写） */
export interface IntentFile {
  version: number;
  items: IntentEntry[];
}

/**
 * 引用落空的三种**可区分**形态（各自带一句点名的原因，不混成一句"没找到"）：
 *   · `file_missing`＝这份原文文件不存在（还没人写过）；`ref_invalid`＝ref 形态/指向不对（不是这份文件、缺 id）；
 *   · `not_found`＝文件在、条目不在（真悬空）。文件在场但**不合法**不走这里——`readIntentFile` 直接抛（fail-closed）。
 */
export interface IntentRefMiss {
  status: "file_missing" | "ref_invalid" | "not_found";
  /** 引用定位（`intent.json#<id>` 形态；`file_missing` 时给的是该文件位置） */
  locator: string;
  /** 落空原因（点名缺的是什么，供上层直接拼进错误消息） */
  problem: string;
  /** 现场有哪些条目 id（`file_missing` 时为空数组——文件都不在，没有"现有条目"可报） */
  known_ids: string[];
}

/** `resolveIntentRef` 的结果：命中给条目本体，落空给上面那三种可区分形态 */
export type IntentRefLookup = { status: "found"; locator: string; entry: IntentEntry } | IntentRefMiss;

/** 非「文件不在」的现场问题一律按 `INVALID_COMMAND` 抛（与 `decisions.ts`／`documents.ts` 对原始文件的坏态同族） */
function badIntent(intentFile: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", `意图原文文件不合法（${intentFile}）：${message}`, {
    intent_file: intentFile,
    reason: "intent_file_invalid",
    ...detail,
  });
}

/** 形状不合法就点名拒（多一个字段不算错——人写的东西可能有备注；认不出的字段只是不参与解析） */
function parseIntentItems(intentFile: string, parsed: unknown): IntentEntry[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    badIntent(intentFile, "顶层必须是对象 `{ version, items }`", { got: Array.isArray(parsed) ? "array" : typeof parsed });
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== INTENT_SCHEMA_VERSION) {
    badIntent(intentFile, `version 必须是 ${INTENT_SCHEMA_VERSION}（收到 ${JSON.stringify(raw.version)}）——不认的版本不尽力解析`, {
      version: raw.version,
    });
  }
  if (!Array.isArray(raw.items)) {
    badIntent(intentFile, `items 必须是数组（收到 ${JSON.stringify(raw.items)}）`, { items: raw.items });
  }
  const items: IntentEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (raw.items as unknown[]).entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      badIntent(intentFile, `items[${index}] 必须是对象 \`{ id, text }\``, { index, item });
    }
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "") {
      badIntent(intentFile, `items[${index}].id 必须是非空字符串（引用 intent.json#<id> 靠它定位）`, {
        index,
        id: entry.id,
      });
    }
    if (typeof entry.text !== "string" || entry.text.trim() === "") {
      badIntent(intentFile, `items[${index}].text 必须是非空字符串（id=${id}：空正文的条目引用起来等于引用空）`, {
        index,
        id,
      });
    }
    if (seen.has(id)) {
      badIntent(intentFile, `条目 id 重复：${id}——同一 id 指向两条意图，引用就有歧义（要么改 id，要么合并）`, { id });
    }
    seen.add(id);
    items.push({ id, text: entry.text });
  }
  return items;
}

/**
 * 读意图原文（**只读**；本模块没有写口）。
 *   · 文件不存在 → `null`（如实"还没有人写过意图原文"，是正常空态，不是错误）；
 *   · 文件在场但不是合法意图原文（非 JSON／形状不合法／id 重复）→ 抛带原因的 `WorkError`，不吞；
 *   · 其它读失败（权限、目录同名等）→ 同样抛（读不到 ≠ 没有，不能当空态糊过去）。
 */
export function readIntentFile(workbenchDir: string): IntentFile | null {
  const file = path.join(workbenchDir, INTENT_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return badIntent(file, `读不到（${code ?? (e as Error).message}）`, { read_error: code ?? (e as Error).message });
  }
  let parsed: unknown;
  try {
    // 人可能在 Windows 上用记事本写（带 BOM）：剥掉 BOM 再解析，这不算坏文件
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e) {
    return badIntent(file, `不是合法 JSON（${(e as Error).message}）`, { parse_error: (e as Error).message });
  }
  return { version: INTENT_SCHEMA_VERSION, items: parseIntentItems(file, parsed) };
}

/**
 * 解析一条意图引用（`intent.json#<id>` 或裸 `<id>` 两种写法都收），返回命中的条目或落空原因。
 * 上层（需求登记/更新校验）拿它做"引用有效性"的实解析；落空形态见 `IntentRefMiss`。
 */
export function resolveIntentRef(workbenchDir: string, ref: string): IntentRefLookup {
  const raw = typeof ref === "string" ? ref.trim() : "";
  if (raw === "") {
    return { status: "ref_invalid", locator: INTENT_FILE, problem: "引用是空字符串（要给 `intent.json#<id>` 或裸 `<id>`）", known_ids: [] };
  }
  const hash = raw.indexOf("#");
  const sourcePart = hash < 0 ? "" : raw.slice(0, hash).trim();
  const entryId = (hash < 0 ? raw : raw.slice(hash + 1)).trim();
  if (hash >= 0 && entryId.includes("#")) {
    return { status: "ref_invalid", locator: raw, problem: `引用里有多个 \`#\`（${raw}）：一条引用只定位一个条目`, known_ids: [] };
  }
  if (sourcePart !== "" && sourcePart !== INTENT_FILE) {
    return {
      status: "ref_invalid",
      locator: raw,
      problem: `引用指向的不是意图原文文件（${sourcePart}）：kind=intent 的 ref 只能是 \`${INTENT_FILE}#<id>\` 或裸 \`<id>\``,
      known_ids: [],
    };
  }
  if (entryId === "") {
    return { status: "ref_invalid", locator: raw, problem: `引用没给条目 id（${raw}）：\`#\` 后面要有条目 id`, known_ids: [] };
  }
  const locator = `${INTENT_FILE}#${entryId}`;
  // 文件在场但不合法时 readIntentFile 抛（fail-closed）——这里不 catch，坏态不许降级成"悬空"或"空文件"
  const intentFile = readIntentFile(workbenchDir);
  if (intentFile === null) {
    return {
      status: "file_missing",
      locator,
      problem: `意图原文文件不存在（${path.join(workbenchDir, INTENT_FILE)}）：没有这份文件就没有可引用的意图条目`,
      known_ids: [],
    };
  }
  const knownIds = intentFile.items.map((i) => i.id);
  const hit = intentFile.items.find((i) => i.id === entryId);
  if (hit === undefined) {
    return {
      status: "not_found",
      locator,
      problem: `意图条目不存在（${entryId}）；该文件现有条目：${knownIds.length === 0 ? "（一条都没有）" : knownIds.join("、")}`,
      known_ids: knownIds,
    };
  }
  return { status: "found", locator, entry: { id: hit.id, text: hit.text } };
}
