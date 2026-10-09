// 运行入口的**版本轴**逐来源解析（DESIGN §3.7「还能开、但对应的那版成果已经旧了」；契约 F4「自报不自证」）。
//
// 为什么单独一个文件、且必须是 IO 层：
//   `runtimeEntries.ts` 是**纯函数**（零 IO）——它只回答"给定来源事实与一个当前版本，这条入口算
//   current/outdated/unknown"。但"当前版本"从哪来是读侧的事：契约 F4 明确**不能拿账本里自报的 code
//   revision 反推当前版本**，能当"当前版本"的只有**这份成果自己正式引用、且版本绑定一致的合法源清单**
//   现读复核的结论。所以本文件对**每条来源记录**做这件事，得出 `RuntimeEntryRevisionResolution` 再喂回纯函数。
//
// 判据（与 `statusProjection.ts#checksWithSourceManifests` **同一套边界**，不另造一套）：
//   · 只看该来源记录 `evidence_refs` 里**明确引用**的证据（不扫描全项目、不借其它 task/record/scope 的证据）；
//   · 载体读取走 `sourceEvidence.ts#readManifestCarrier`（核内容地址/bytes/kind；坏/截损一律不采信）；
//   · 版本绑定一致：源清单指纹必须**等于**该记录自己声明的 code 版本（`manifest.fingerprint === revision`）；
//     载体自报的来源类也要与记录声明的来源类一致（防"plan 清单给 code 成果背书"）；
//   · 现读复核走 `sourceEvidence.ts#verifySourceManifest`（越界/软链/超限/私密/忽略目录都在它里面处理）；
//   · 逐结果：`valid` → `current`；`invalidated`（覆盖源内容变了/被删）→ `outdated`；否则 → `unknown`；
//   · **每份候选先核到底，再归组去重**：组内（同一 `manifest.fingerprint`）结论必须**全体一致**，
//     不一致（含空/冲突 binding、同一指纹配不同 files 的清单）⇒ **冲突 ⇒ `unknown`**。结论只由这组
//     引用本身决定，**与 `evidence_refs` 的数组顺序无关**——绝不"保留第一份"就借它的绿（不然同一组
//     引用换个顺序就能给出 current / unknown 两个结论）。
//
// 拿不到可用清单的一切情形（没引用证据 / 错来源 / 错绑定 / 缺失 / 载体坏 / 多份歧义 / 组内冲突 /
// 现读取不到结论）一律**如实 `unknown`**——既不借任一份无关清单背书，也不猜成 current/outdated。入口
// "能不能打开"是另一条轴（`runtimeEntries.ts#runtimeEntryStateOf`），本文件**不**碰它。
//
// **不新增存储、不重写账本、不写任何字节**：只读现读复核。
import { evidenceBlobPath } from "./evidence";
import { withDerivationScope } from "./derivationScope";
import {
  projectRootOfWorkDir,
  readManifestCarrier,
  verifySourceManifest,
  type SourceManifestCarrier,
} from "./sourceEvidence";
import type { RuntimeEntryRevisionResolution } from "./runtimeEntries";

/** 解析一条来源记录所需的**最小结构面**（成果登记与结果回报来源都长这样） */
export interface RuntimeEntryRevisionSourceLike {
  /** 记录自己声明的版本（成果登记 `binding.revision` / 结果回报 `result_revision`） */
  revision: string | null;
  revision_kind: string | null;
  /** 记录**正式引用**的证据 id（`evidence_refs`）；不传/空 = 没有可核对的引用 */
  evidence_refs?: readonly string[];
}

const trim = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const unknownRes = (basis: string): RuntimeEntryRevisionResolution => ({
  state: "unknown",
  current_revision: null,
  registered_fingerprint: null,
  evidence_id: null,
  basis,
});

/** 单份候选载体的**完整核验**结论：先核来源类、再核版本绑定、再对盘现读，三环全过才可能 current/outdated */
interface CandidateVerdict {
  /** 该载体**声明**的清单指纹（归组与"多歧义/冲突"判据用；它不是结论本身） */
  fingerprint: string;
  evidence_id: string;
  state: RuntimeEntryRevisionResolution["state"];
  /** current = 登记指纹；outdated = 现读指纹；unknown = null */
  current_revision: string | null;
  /** 人话依据（`unknown` 时即原因） */
  basis: string;
}

/**
 * 把**一份**候选载体核到底：来源类一致 → 版本绑定一致 → 现读复核。
 * 任一环不过就是 `unknown`（并给出原因）；**不看**别的载体，也不因为"自己排在前面"就通行。
 *
 * 载体自报的来源类与记录声明的来源类必须同类（`binding.revision` 字面值不比：清单指纹是服务端 store
 * 那一刻才算出的，调用方登记时拿不到它，载体自报的是覆盖源的内容修订）——与 `checksWithSourceManifests` 同口径。
 */
function evaluateCandidate(
  projectRoot: string,
  evidence_id: string,
  carrier: SourceManifestCarrier,
  revision: string,
  kind: string,
): CandidateVerdict {
  const fingerprint = carrier.manifest.fingerprint;
  const cb = carrier.binding;
  if (cb === null || cb.revision.trim() === "" || cb.revision_kind !== kind) {
    const declared = cb === null ? "（无）" : `${cb.revision_kind}:${cb.revision.slice(0, 12)}…`;
    return {
      fingerprint,
      evidence_id,
      state: "unknown",
      current_revision: null,
      basis:
        `源清单载体自报的来源类（${declared}）与来源声明（${kind}:${revision.slice(0, 12)}…）不是同一来源类（或缺/空）：` +
        "不拿来源对不上的清单背书，版本轴如实未知",
    };
  }
  if (fingerprint !== revision) {
    return {
      fingerprint,
      evidence_id,
      state: "unknown",
      current_revision: null,
      basis: "来源引用的源清单指纹与它声明的 code 版本不一致（错绑定）：不拿一份无关清单背书，版本轴如实未知",
    };
  }
  // 现读复核：**只比清单声明的那些路径**——没被覆盖的无关文件变化不让它失效（有限范围的本义）
  const verdict = verifySourceManifest(projectRoot, carrier.manifest);
  if (verdict.status === "valid") {
    return {
      fingerprint,
      evidence_id,
      state: "current",
      current_revision: fingerprint,
      basis: "来源引用的源清单现读一致：覆盖的源码没变，绑定的成果版本仍是当前版本",
    };
  }
  if (verdict.status === "invalidated") {
    return {
      fingerprint,
      evidence_id,
      state: "outdated",
      current_revision: verdict.current_fingerprint,
      basis: `来源引用的源清单覆盖的源码已变（${verdict.reason}）：绑定的成果版本已过期（入口仍可打开，是另一条轴）`,
    };
  }
  return {
    fingerprint,
    evidence_id,
    state: "unknown",
    current_revision: null,
    basis: `源清单现读复核取不到结论（${verdict.reason}）：版本轴如实未知（不当通过）`,
  };
}

/**
 * 逐来源解析一条运行入口的"可核对当前版本"。纯 IO（现读该来源引用的源清单 + 复核盘上内容），
 * 不写任何字节；结论形状见 `RuntimeEntryRevisionResolution`。
 */
export function resolveRuntimeEntryRevision(
  workDir: string,
  source: RuntimeEntryRevisionSourceLike,
): RuntimeEntryRevisionResolution {
  const revision = trim(source.revision);
  const kind = trim(source.revision_kind);
  if (revision === null) {
    return unknownRes("来源没声明版本：没有可核对的成果版本，版本轴如实未知（不猜）");
  }
  if (kind !== "code") {
    // 源清单覆盖的是源码；其它来源类（design/plan/interface）没有对应的源码清单口径 → 不借、不猜
    return unknownRes(
      `来源声明的版本不是 code 类（${kind ?? "缺 revision_kind"}）：源清单只覆盖源码，不能给它背书，版本轴如实未知`,
    );
  }
  const refs = [...new Set((source.evidence_refs ?? []).map((r) => r.trim()).filter((r) => r !== ""))];
  if (refs.length === 0) {
    return unknownRes("来源没有正式引用任何证据（evidence_refs 为空）：没有可核对的源清单，版本轴如实未知");
  }

  // 逐条读"它明确引用"的证据载体；**完整**的合法源清单**全部**留下当候选——此处**不**按指纹去重、
  // 更不凭"第一份"定结论（去重与冲突判定都放到"每一份都核完"之后做）
  const candidates: { evidence_id: string; carrier: SourceManifestCarrier }[] = [];
  let sawManifest = false;
  for (const ref of refs) {
    let carrier: SourceManifestCarrier | null = null;
    try {
      // sha 必须严格 64hex，否则 evidenceBlobPath 直接拒（拒绝路径穿越）——与既有读侧边界一致
      carrier = readManifestCarrier(evidenceBlobPath(workDir, ref));
    } catch {
      carrier = null; // 引用不是合法内容地址（或读不了）：这条引用不构成可用来源
    }
    if (carrier === null) continue;
    sawManifest = true;
    if (!carrier.intact) continue; // 正文被改过/截损：证据不可信，不当来源（也不当"冲突"）
    candidates.push({ evidence_id: ref, carrier });
  }
  if (candidates.length === 0) {
    return unknownRes(
      sawManifest
        ? "来源引用的源清单载体完整性核验不过（正文被改过/截损）：不采信，版本轴如实未知"
        : "来源正式引用的证据里没有合法的源清单：没有可核对的来源，版本轴如实未知",
    );
  }

  // **先把每一份候选完整核验**，再按它声明的清单指纹归组去重。排序只让"多份结论相同时取哪一份"有确定性
  //（它们结论相同，取谁都不改变结论）；结论本身与 `evidence_refs` 的数组顺序无关。
  const projectRoot = projectRootOfWorkDir(workDir);
  const verdicts = candidates
    .map((c) => evaluateCandidate(projectRoot, c.evidence_id, c.carrier, revision, kind))
    .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id) || a.fingerprint.localeCompare(b.fingerprint));

  const fingerprints = [...new Set(verdicts.map((v) => v.fingerprint))];
  if (fingerprints.length > 1) {
    return unknownRes(
      `来源引用了 ${fingerprints.length} 份**不同**的源清单（歧义）：不借其中任意一份背书，版本轴如实未知`,
    );
  }
  const fingerprint = fingerprints[0];
  if (fingerprint !== revision) {
    return unknownRes(
      "来源引用的源清单指纹与它声明的 code 版本不一致（错绑定）：不拿一份无关清单背书，版本轴如实未知",
    );
  }

  // 同一指纹下的多份载体必须**结论一致**：不一致（含空/冲突 binding、清单自身不自洽）⇒ 冲突 ⇒ unknown。
  // 这样同一组引用无论数组顺序如何都给同一结论，也**绝不**"保留第一份"就借它的绿。
  const first = verdicts[0];
  const conflict = verdicts.some((v) => v.state !== first.state || v.current_revision !== first.current_revision);
  if (conflict) {
    const seen = [...new Set(verdicts.map((v) => v.state))].join("/");
    return unknownRes(
      `同一份源清单（指纹 ${fingerprint.slice(0, 12)}…）的 ${verdicts.length} 份载体结论不一致（${seen}）：` +
        "冲突不择优、不借第一份背书，版本轴如实未知",
    );
  }
  if (first.state === "unknown") return unknownRes(first.basis);
  return {
    state: first.state,
    current_revision: first.current_revision,
    registered_fingerprint: fingerprint,
    evidence_id: first.evidence_id,
    basis: first.basis,
  };
}

/**
 * 对一组来源逐个解析版本轴并挂上结论（**唯一装配 helper**：产品读口就用它，别各自拼一套）。
 * 返回新数组（不改入参）；每条来源都带上 `revision_resolution`（含如实 `unknown`）。
 *
 * 整段套一次只读派生作用域：同一次读口请求里多来源引用**同一份**清单时，载体读取与现读复核
 * （`readManifestCarrier` / `verifySourceManifest` 内建按路径/指纹复用）只算一次；作用域一出即丢，
 * **跨请求不缓存**，源一变下一个请求立刻看见（与 `collectProjectFacts` 同一套机制，不新造缓存）。
 */
export function withRuntimeEntryRevisions<T extends RuntimeEntryRevisionSourceLike>(
  workDir: string,
  sources: readonly T[],
): (T & { revision_resolution: RuntimeEntryRevisionResolution })[] {
  return withDerivationScope(() =>
    sources.map((s) => ({ ...s, revision_resolution: resolveRuntimeEntryRevision(workDir, s) })),
  );
}
