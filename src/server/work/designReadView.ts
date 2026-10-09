// 选定设计文档的**只读**读取 helper（B6/V09-56，DESIGN.md §3.5 版本切换 / §2.9 不混版 / §6.12）。
//
// 为什么单开一层而不复用 `readDesign`：设计页要能显示「当前草稿／已审定基线／历史已替代」三档，
// 并让功能清单与正文读**同一份所选版本**。`readDesign` 只读现行编辑源，不够；本 helper 在此基础上
// **复用既有只读材料**（`documents.ts`）核选定 hash：
//   · `readDesign`        —— 现行编辑源（mode=current；旧 `getDesign` shape 逐字保留）
//   · `readBaselineLog`   —— 完整基线流水（历史材料真实存在，见其导出注释）
//   · `readRevisionSnapshotText` / `revisionSnapshotExists` —— 按 hash 取不可变历史快照
//   · `buildSectionIndex` —— 正文标题索引（标题／行号／章节 hash），供锚点双向定位
//
// ██ 红线 ██
//   · **只读**：不写盘、不存证、不认领、不自愈、不调模型；没有状态 cache，每次现读现算。
//   · **不混版**：所选版本读不回 ⇒ 如实报未知（`selection.unreadable`），**不套用当前通过结论**。
//   · **不猜**：history 里同一设计修订被多条基线引用时按流水原样逐条列，不替用户挑一条。
//   · 本模块有 fs 依赖，**只允许服务端 import**；界面侧只吃 HTTP 读口返回的 JSON。
import path from "node:path";
import {
  buildSectionIndex,
  readBaselineLog,
  readRevisionSnapshotText,
  resolveDocumentSource,
  revisionObjectRel,
  revisionSnapshotExists,
  sha256Hex,
  type DocumentSection,
  type ProjectBaseline,
} from "./documents";
import { readDesign } from "../workstation";
import { WorkError } from "./types";

/** 可选版本选择器：现行草稿 / 已审定基线 / 某个不可变历史修订（64 位小写十六进制 sha256） */
export type DesignSelector = "current" | "active" | string;
/** 实际读到的来源档位 */
export type DesignViewMode = "current" | "active" | "revision";

export interface DesignSelectorParse {
  selector: DesignSelector;
  mode: DesignViewMode;
  /** mode=revision 时的内容哈希 */
  revision: string | null;
}

/**
 * 解析 `document` query：`current` | `active` | `<64 位小写十六进制>`。
 * 缺省（空/undefined）= `current`——**旧 getDesign 的默认口径不变**（只读现行草稿）。
 * 其余形态一律拒绝（不猜近似历史、不接受大小写混写的 sha）。
 */
export function parseDesignSelector(raw: string | null | undefined): DesignSelectorParse {
  const v = (raw ?? "").trim();
  if (v === "" || v === "current") return { selector: "current", mode: "current", revision: null };
  if (v === "active") return { selector: "active", mode: "active", revision: null };
  if (/^[0-9a-f]{64}$/.test(v)) return { selector: v, mode: "revision", revision: v };
  throw new WorkError(
    "INVALID_COMMAND",
    `document 只接受 current / active / 64 位小写十六进制 sha256（收到 ${JSON.stringify(raw)}）；` +
      "历史版本用不可变快照的内容哈希定位，不猜近似标题或前缀",
    { document: raw },
  );
}

/** 基线历史只读元数据（逐条来自基线流水；不改判据、不挑一条） */
export interface DesignBaselineHistoryEntry {
  baseline_id: string;
  approved_by: string;
  approval_kind: ProjectBaseline["approval_kind"];
  active_at: string;
  supersedes: string | null;
  design_revision: { content_sha256: string; definition_sha256: string; source_path: string };
  /** 该历史设计快照现在能不能按 hash 重建（不重建 = 只报元数据，不假装能读回正文） */
  available: boolean;
  /** 这条是不是当前生效基线（流水最后一条） */
  current: boolean;
}

export interface DesignViewSelection {
  requested: string;
  mode: DesignViewMode;
  design_revision: string | null;
  baseline_id: string | null;
  approved_by: string | null;
  approval_kind: ProjectBaseline["approval_kind"] | null;
  active_at: string | null;
  /** 现行源相对所选版本已漂移的人话说明（null = 没漂移 / 不适用） */
  drift: string | null;
  /** 所选版本读不回的原因（null = 读到了）；**读不回 ≠ 空项目、≠ 已通过** */
  unreadable: string | null;
}

export interface DesignReadView {
  /** 所选版本正文是否存在/可读（旧 getDesign shape：false = 这个版本没有正文） */
  exists: boolean;
  content: string | null;
  /** 正文来源（本机绝对路径；HTTP 远程态由 withoutLocalPaths 裁掉）——旧 getDesign shape 原样保留 */
  source: string | null;
  /** 项目根内相对来源路径（对外展示用它，不依赖远程裁剪） */
  source_rel: string | null;
  /** 所选版本实际读到的形态（§2.9：不许混版——不是只 echo 请求参数） */
  selection: DesignViewSelection;
  /** 正文标题索引（标题／行号／章节 hash），供锚点双向定位 */
  sections: DocumentSection[];
  /** 完整基线历史只读元数据（当前草稿/已审定基线/历史已替代三档的材料） */
  baseline_history: DesignBaselineHistoryEntry[];
}

const short = (h: string | null): string => (h === null ? "—" : `${h.slice(0, 12)}…`);

/** 读一条设计修订的不可变快照；核 sha256，对不上/读不到一律 null（不拿近似顶替） */
function readVerifiedDesignSnapshot(
  projectId: string,
  dataDir: string | undefined,
  hash: string,
): string | null {
  const text = readRevisionSnapshotText(projectId, "design", hash, dataDir);
  if (text === null) return null;
  return sha256Hex(text) === hash ? text : null;
}

/** 项目根内相对路径（快照/现行源通用；找不到项目时返回 null，不抛） */
function designRelPath(projectId: string, dataDir?: string): string | null {
  try {
    return resolveDocumentSource(projectId, "design", dataDir).rel_path;
  } catch {
    return null;
  }
}

function snapshotAbsPath(projectId: string, dataDir: string | undefined, hash: string): string | null {
  try {
    const root = resolveDocumentSource(projectId, "design", dataDir).project_root;
    return path.join(root, revisionObjectRel("design", hash));
  } catch {
    return null;
  }
}

function baselineHistoryOf(
  projectId: string,
  dataDir: string | undefined,
  active: ProjectBaseline | null,
): DesignBaselineHistoryEntry[] {
  let log: ReturnType<typeof readBaselineLog>;
  try {
    log = readBaselineLog(projectId, dataDir);
  } catch {
    return [];
  }
  return log.baselines.map((b) => ({
    baseline_id: b.baseline_id,
    approved_by: b.approved_by,
    approval_kind: b.approval_kind,
    active_at: b.active_at,
    supersedes: b.supersedes,
    design_revision: {
      content_sha256: b.design_revision.content_sha256,
      definition_sha256: b.design_revision.definition_sha256,
      source_path: b.design_revision.source_path,
    },
    available: revisionSnapshotExists(projectId, "design", b.design_revision.content_sha256, dataDir),
    current: active !== null && active.baseline_id === b.baseline_id,
  }));
}

/**
 * 读选定设计文档（只读）。缺省 = current（旧 getDesign 口径）。
 * 项目不存在 / selector 非法时抛 `WorkError`（路由据此回 404 / 400）；读不回历史**不抛**——
 * 如实回 `exists:false` + `selection.unreadable`。
 */
export function readDesignView(
  projectId: string,
  dataDir: string | undefined,
  selector: DesignSelector,
): DesignReadView {
  const parsed = parseDesignSelector(selector);
  let active: ProjectBaseline | null = null;
  try {
    const log = readBaselineLog(projectId, dataDir);
    active = log.baselines.length === 0 ? null : log.baselines[log.baselines.length - 1];
  } catch {
    active = null;
  }
  const history = baselineHistoryOf(projectId, dataDir, active);
  const relPath = designRelPath(projectId, dataDir);

  if (parsed.mode === "current") {
    // 现行编辑源：**逐字复用 readDesign**（旧 getDesign shape 与语义不变）
    const doc = readDesign(projectId, dataDir);
    const rev = doc.exists && doc.content !== null ? sha256Hex(doc.content) : null;
    const drift =
      active === null
        ? "没有生效基线：现行草稿未获批准，设计覆盖结论一律不超过「待审」"
        : rev !== null && active.design_revision.content_sha256 === rev
          ? null
          : `现行设计（${short(rev)}）与已批准基线（${short(active.design_revision.content_sha256)}）不一致：` +
            "正在读现行草稿，不假装它是已批准基线";
    return {
      exists: doc.exists,
      content: doc.exists ? doc.content : null,
      source: doc.exists ? (doc.source ?? null) : null,
      source_rel: relPath,
      selection: {
        requested: parsed.selector,
        mode: "current",
        design_revision: rev,
        baseline_id: active?.baseline_id ?? null,
        approved_by: active?.approved_by ?? null,
        approval_kind: active?.approval_kind ?? null,
        active_at: active?.active_at ?? null,
        drift,
        unreadable: null,
      },
      sections: doc.exists && doc.content !== null ? buildSectionIndex(doc.content) : [],
      baseline_history: history,
    };
  }

  if (parsed.mode === "active") {
    if (active === null) {
      return {
        exists: false,
        content: null,
        source: null,
        source_rel: relPath,
        selection: {
          requested: parsed.selector,
          mode: "active",
          design_revision: null,
          baseline_id: null,
          approved_by: null,
          approval_kind: null,
          active_at: null,
          drift: null,
          unreadable: "没有生效基线：已审定基线快照不可得（先审定激活基线，或选「当前草稿」）",
        },
        sections: [],
        baseline_history: history,
      };
    }
    const hash = active.design_revision.content_sha256;
    const text = readVerifiedDesignSnapshot(projectId, dataDir, hash);
    if (text === null) {
      return {
        exists: false,
        content: null,
        source: snapshotAbsPath(projectId, dataDir, hash),
        source_rel: relPath,
        selection: {
          requested: parsed.selector,
          mode: "active",
          design_revision: hash,
          baseline_id: active.baseline_id,
          approved_by: active.approved_by,
          approval_kind: active.approval_kind,
          active_at: active.active_at,
          drift: null,
          unreadable:
            `已批准基线的设计快照（${short(hash)}）读不到或与基线记录不一致：该版本无法重建，` +
            "不套用当前通过结论（可改选「当前草稿」或恢复不可变快照后重读）",
        },
        sections: [],
        baseline_history: history,
      };
    }
    return {
      exists: true,
      content: text,
      source: snapshotAbsPath(projectId, dataDir, hash),
      source_rel: relPath,
      selection: {
        requested: parsed.selector,
        mode: "active",
        design_revision: hash,
        baseline_id: active.baseline_id,
        approved_by: active.approved_by,
        approval_kind: active.approval_kind,
        active_at: active.active_at,
        drift: null,
        unreadable: null,
      },
      sections: buildSectionIndex(text),
      baseline_history: history,
    };
  }

  // mode === revision：按 hash 读不可变历史快照；不猜、不套当前结论
  const hash = parsed.revision as string;
  const text = readVerifiedDesignSnapshot(projectId, dataDir, hash);
  // 同一设计修订可能被多条基线引用（same design 多 PLAN）——**原样逐条列**，不替用户挑一条
  const owners = history.filter((h) => h.design_revision.content_sha256 === hash);
  const owner = owners.length === 1 ? owners[0] : null;
  if (text === null) {
    return {
      exists: false,
      content: null,
      source: snapshotAbsPath(projectId, dataDir, hash),
      source_rel: relPath,
      selection: {
        requested: parsed.selector,
        mode: "revision",
        design_revision: hash,
        baseline_id: owner?.baseline_id ?? null,
        approved_by: owner?.approved_by ?? null,
        approval_kind: owner?.approval_kind ?? null,
        active_at: owner?.active_at ?? null,
        drift: null,
        unreadable:
          `该历史设计修订（${short(hash)}）的不可变快照读不到：历史状态未知，` +
          "不套用当前通过结论（§2.9、§6.12）",
      },
      sections: [],
      baseline_history: history,
    };
  }
  return {
    exists: true,
    content: text,
    source: snapshotAbsPath(projectId, dataDir, hash),
    source_rel: relPath,
    selection: {
      requested: parsed.selector,
      mode: "revision",
      design_revision: hash,
      baseline_id: owner?.baseline_id ?? null,
      approved_by: owner?.approved_by ?? null,
      approval_kind: owner?.approval_kind ?? null,
      active_at: owner?.active_at ?? null,
      drift: null,
      unreadable: null,
    },
    sections: buildSectionIndex(text),
    baseline_history: history,
  };
}
