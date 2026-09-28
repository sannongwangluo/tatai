// 项目级界面状态（DESIGN.md §3.1）：切项目保留**各自的**页面、图缩放/折叠、选中项、聊天草稿
// 与滚动位置；异步返回按项目核对，旧项目的响应不许写进新项目的界面。
//
// 为什么要单独一层（而不是各自 useState）：草稿、页面、选中项、滚动位置散在 App / ChatView /
// PlanView / DesignView 里，各写各的 useState 就必然"切项目丢一半"。这里给出一份**按项目 id 分桶**
// 的唯一状态源，任何组件读写同一份口径。
//
// 存储策略：
//   · 进程内 Map（切项目/切页签即时生效，零 IO）；
//   · sessionStorage 镜像（**刷新不丢草稿**，§3.14 演练项）；用 session 而不是 local——本页面实例
//     自己的现场，不开新标签页共享（§3.1「不做任意增开浏览器式 Tab」）。
//   · 存储层任何异常（隐私模式禁用 storage / 配额满）都吞掉并退回纯内存，绝不让界面因为
//     "存不下现场"而崩掉。
import { useCallback, useSyncExternalStore } from "react";

/** 主工作面页面（§3.1 主导航五个 + 辅助入口两个） */
export type ViewKey = "arch" | "design" | "plan" | "chat" | "live" | "overview" | "terminal";

export interface ProjectScope {
  /** 当前页面（每项目各记各的） */
  view: ViewKey;
  /** 聊天未发草稿（每项目各留各的；发送成功才清） */
  chatDraft: string;
  /** 各页的选中项（施工图选中卡 / 待议选中条目 / 项目图选中节点；键 = 页名） */
  selections: Record<string, string>;
  /** 各页的滚动位置（键 = 页名；滚回去时用） */
  scroll: Record<string, number>;
  /** 实况与验收页的子页签（live / acceptance） */
  liveSub: "live" | "acceptance";
  /** 项目图页的页签（三个主视图 / 技术详情；由 ArchView 自己维护并回写） */
  archTab: string | null;
}

const STORAGE_PREFIX = "tatai.scope.";

function emptyScope(): ProjectScope {
  return {
    view: "arch",
    chatDraft: "",
    selections: {},
    scroll: {},
    liveSub: "live",
    archTab: null,
  };
}

const store = new Map<string, ProjectScope>();
const listeners = new Set<() => void>();

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function readMirror(projectId: string): ProjectScope | null {
  try {
    const raw = sessionStorage.getItem(storageKey(projectId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ProjectScope>;
    return { ...emptyScope(), ...parsed };
  } catch {
    return null;
  }
}

function writeMirror(projectId: string, scope: ProjectScope): void {
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(scope));
  } catch {
    /* 存不下不影响界面：本进程内 Map 仍然有效 */
  }
}

/** 取某项目的现场（首次访问时从 sessionStorage 恢复；没有就是默认值） */
export function getScope(projectId: string): ProjectScope {
  const existing = store.get(projectId);
  if (existing !== undefined) return existing;
  const scope = readMirror(projectId) ?? emptyScope();
  store.set(projectId, scope);
  return scope;
}

/** 合并写：只改传进来的字段（其它项目/其它字段原样） */
export function patchScope(projectId: string, patch: Partial<ProjectScope>): void {
  const next = { ...getScope(projectId), ...patch };
  store.set(projectId, next);
  writeMirror(projectId, next);
  for (const l of listeners) l();
}

/** 选中项/滚动位置这类"键值桶"的合并写（不同页各留各的） */
export function patchScopeBucket(
  projectId: string,
  bucket: "selections" | "scroll",
  key: string,
  value: string | number,
): void {
  const cur = getScope(projectId);
  if (cur[bucket][key] === value) return;
  patchScope(projectId, { [bucket]: { ...cur[bucket], [key]: value } } as Partial<ProjectScope>);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 项目现场 hook：`scope` 随项目切换/自身写入重渲染，`patch` 是合并写。
 * 换项目时返回的是**那个项目**的现场（不是上一个项目的），这就是"不串状态"的落点。
 */
export function useProjectScope(projectId: string): {
  scope: ProjectScope;
  patch: (patch: Partial<ProjectScope>) => void;
  setBucket: (bucket: "selections" | "scroll", key: string, value: string | number) => void;
} {
  const scope = useSyncExternalStore(
    subscribe,
    () => getScope(projectId),
    () => getScope(projectId),
  );
  const patch = useCallback(
    (p: Partial<ProjectScope>) => patchScope(projectId, p),
    [projectId],
  );
  const setBucket = useCallback(
    (bucket: "selections" | "scroll", key: string, value: string | number) =>
      patchScopeBucket(projectId, bucket, key, value),
    [projectId],
  );
  return { scope, patch, setBucket };
}
