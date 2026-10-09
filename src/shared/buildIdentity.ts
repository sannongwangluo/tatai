// 运行部件构建身份（P0 / 卡 V09-45；docs/agent-optimization-20261006.md §4.1、§4.4、§4.6）。
//
// 这个模块回答一个问题：**此刻正在运行的这个部件，本身是哪一次构建做出来的**。
// 它与既有 V09-04 的构建戳（`scripts/lib/buildStamp.ts`）不是一回事、也不互相替代：
//   · 构建戳 = 「这批产物出自某一次构建运行，该运行结束时的树指纹是 X」——描述**某次构建运行**；
//   · 构建身份 = 「这个运行部件实际加载了哪次构建」——描述**进程里跑着的东西**。
// 两者经发布清单（package-bind / buildOutputManifest）**关联**，不互相冒充（§4.4 明确）。
//
// 红线（本模块逐条守）：
//  · **浏览器安全**：零 node import、零 React——前端与服务端共用同一份类型与判定，不各写一套。
//  · **内嵌值，不读磁盘冒充进程**：身份由构建器 `define` 在编译期内联（`src/shared/version.ts` 同类先例），
//    读口只回**启动时载入的常量**；请求时读盘上的 build-stamp 冒充"我加载的是它"是禁止的（§4.4）。
//  · **未知就是未知**：未内嵌（tsx 直跑源码、未重建的旧包、身份读不出）一律走 `embedded:false`，
//    **不得**与已知身份比较出"一致"（§4.1、§4.6 三态）。
//  · **类型上不可能自相矛盾**：`embedded:true` 只出现在 `KnownBuildIdentity` 上（Codex 对 P0 的纠正）。

/** 部件类型（闭集）：随包后端 / 前端产物 */
export type BuildComponent = "server" | "ui";

/** 两部件**各自实际生效**的编译目标（不是同一个纯环境标签，也不是"后端目标"外推到前端）。
 *  server = `scripts/build-server.ts` 传给 vite 的 `build.target`；ui = `vite.config.ts` 传给 vite 的
 *  `build.target`。声明值来自同一处常量，且**确实驱动**真正的构建选项——因此不会出现"标签说 node20、
 *  实际前端不是 node20"的冒充（Codex 对 P0 的纠正）。 */
export interface BuildTargets {
  server: string;
  ui: string;
}

/** 实际参与编译的打包器版本（构建身份要能区分"同源码/锁但换过工具链"）：
 *  从**已安装依赖**解析真实版本（vite 从仓库根解析，rollup/esbuild 从 vite 自身解析）；读不出如实写
 *  "unknown"，**不编**。 */
export interface BundlerVersions {
  vite: string;
  rollup: string;
  esbuild: string;
}

/** 工具链身份：构建环境与实际编译工具链——同一源码+不同编译目标或不同打包器版本不应算同一 release（§4.3） */
export interface ToolchainIdentity {
  /** process.version，如 "v24.18.0" */
  node: string;
  /** 构建时实际使用的 pnpm 版本；读不出就如实写 "unknown"，不编 */
  pnpm: string;
  /** process.platform */
  platform: string;
  /** process.arch */
  arch: string;
  /** 两部件各自实际生效的编译目标（见 BuildTargets） */
  targets: BuildTargets;
  /** 实际打包器版本（见 BundlerVersions） */
  bundler: BundlerVersions;
}

/** 已内嵌身份：只有构建期真的把身份烙进这份产物时才可能出现 */
export interface KnownBuildIdentity {
  schema_version: 1;
  component: BuildComponent;
  embedded: true;
  /** 见 §4.3：同一批构建的 server/ui 相同 */
  release_id: string;
  /** 见 §4.3：按部件区分 */
  build_id: string;
  /** 本部件构建输入集指纹（内容哈希，与 Git ref 无关） */
  source_input_fingerprint: string;
  /** 只标时间，**不参与** release_id/build_id 推导（§4.3、§4.8-4） */
  built_at: string;
  /** 构建环境与编译目标（进 release_id；随身份一并带出便于对照） */
  toolchain: ToolchainIdentity;
}

/** 未知身份：源码直跑 / 旧包未内嵌 / 身份读不出；**不得**与已知身份比较出「一致」 */
export interface UnknownBuildIdentity {
  schema_version: 1;
  component: BuildComponent;
  embedded: false;
  /** 直跑源码 / 未内嵌 / 读取失败（原样带出） */
  reason: string;
}

export type BuildIdentity = KnownBuildIdentity | UnknownBuildIdentity;

/** 一次构建**内嵌**的整份身份（两个部件一份，release_id 共享）。
 *  内嵌值只可能是已内嵌身份——"不知道"不经这里表达（未知由 `resolveBuildIdentity` 的返回类型表达）。 */
export interface BuildIdentityBundle {
  server: KnownBuildIdentity;
  ui: KnownBuildIdentity;
}

/** 构建器 `define` 注入的标识符（vite/rollup 编译期替换；未注入时不定义） */
declare const __TATAI_BUILD_IDENTITY__: BuildIdentityBundle | undefined;

const COMPONENTS: readonly BuildComponent[] = ["server", "ui"];

function unknownIdentity(component: BuildComponent, reason: string): UnknownBuildIdentity {
  return { schema_version: 1, component, embedded: false, reason };
}

/** 取内嵌常量；未内嵌（`typeof` 对未声明标识符安全）或读取抛错都返回 undefined。 */
function embeddedBundle(): BuildIdentityBundle | undefined {
  try {
    if (typeof __TATAI_BUILD_IDENTITY__ === "undefined" || __TATAI_BUILD_IDENTITY__ === null) return undefined;
    return __TATAI_BUILD_IDENTITY__;
  } catch {
    return undefined;
  }
}

/** 工具链身份的形状校验（构建层离线读回与构建戳校验共用同一份，不各写一遍）。 */
export function isToolchainIdentity(v: unknown): v is ToolchainIdentity {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  if (typeof t.node !== "string" || typeof t.pnpm !== "string" || typeof t.platform !== "string" || typeof t.arch !== "string") {
    return false;
  }
  const tg = t.targets;
  if (
    typeof tg !== "object" ||
    tg === null ||
    typeof (tg as Record<string, unknown>).server !== "string" ||
    (tg as Record<string, unknown>).server === "" ||
    typeof (tg as Record<string, unknown>).ui !== "string" ||
    (tg as Record<string, unknown>).ui === ""
  ) {
    return false;
  }
  const b = t.bundler;
  if (
    typeof b !== "object" ||
    b === null ||
    typeof (b as Record<string, unknown>).vite !== "string" ||
    typeof (b as Record<string, unknown>).rollup !== "string" ||
    typeof (b as Record<string, unknown>).esbuild !== "string"
  ) {
    return false;
  }
  return true;
}

/** 把内嵌值收窄成已知身份；任一字段不合法即视为读不出（返回 null，**绝不**猜测补齐）。
 *  导出给构建/验证层的离线读回共用（同一判据，不各写一份字段校验）。 */
export function narrowKnownIdentity(component: BuildComponent, raw: unknown): KnownBuildIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== 1 || r.component !== component || r.embedded !== true) return null;
  if (typeof r.release_id !== "string" || r.release_id === "") return null;
  if (typeof r.build_id !== "string" || r.build_id === "") return null;
  if (typeof r.source_input_fingerprint !== "string" || r.source_input_fingerprint === "") return null;
  if (typeof r.built_at !== "string" || Number.isNaN(Date.parse(r.built_at))) return null;
  if (!isToolchainIdentity(r.toolchain)) return null;
  return {
    schema_version: 1,
    component,
    embedded: true,
    release_id: r.release_id,
    build_id: r.build_id,
    source_input_fingerprint: r.source_input_fingerprint,
    built_at: r.built_at,
    toolchain: r.toolchain,
  };
}

/**
 * 取某个部件的运行身份。
 * 未内嵌 → `embedded:false` 的未知态（带原因）；内嵌但字段不合法 → 同样未知态（原因写清）。
 */
export function resolveBuildIdentity(component: BuildComponent): BuildIdentity {
  const bundle = embeddedBundle();
  if (bundle === undefined) {
    return unknownIdentity(component, "未内嵌构建身份：源码直跑（tsx/vite dev）或产物来自未内嵌身份的旧构建");
  }
  const raw = (bundle as unknown as Record<string, unknown>)[component];
  if (raw === undefined || raw === null) {
    return unknownIdentity(component, `内嵌身份里没有 ${component} 部件条目（构建期内联不完整）`);
  }
  const known = narrowKnownIdentity(component, raw);
  return known ?? unknownIdentity(component, `内嵌的 ${component} 身份字段不合法（读不出，按未知处理）`);
}

/** 偏斜判定三态（§4.6）：任一侧未内嵌一律 `unknown`，**不得**判 `same_release`。 */
export type SkewState = "same_release" | "skew" | "unknown";

export interface SkewVerdict {
  state: SkewState;
  /** 人读的一句话（点名前缀 12 位的部件与 release_id） */
  detail: string;
}

/** release_id 前 12 位（与 §4.6「点名部件与 release_id 前 12 位」一致） */
export function shortReleaseId(identity: BuildIdentity): string | null {
  return identity.embedded ? identity.release_id.slice(0, 12) : null;
}

/**
 * 两个部件身份是否同一 release（签核用的唯一判据，只有这一处）。
 * 任一侧 `embedded !== true` ⇒ `unknown`（点名原因），**不判一致**。
 */
export function compareBuildIdentities(a: BuildIdentity, b: BuildIdentity): SkewVerdict {
  if (!a.embedded || !b.embedded) {
    const side = (id: BuildIdentity, name: string): string =>
      id.embedded ? `${name}=${id.release_id.slice(0, 12)}` : `${name} 未内嵌（${id.reason}）`;
    return {
      state: "unknown",
      detail: `无法比较：${side(a, a.component)} / ${side(b, b.component)}——未知不等于一致`,
    };
  }
  if (a.release_id === b.release_id) {
    return {
      state: "same_release",
      detail: `${a.component} 与 ${b.component} 同批构建（release_id ${a.release_id.slice(0, 12)}）`,
    };
  }
  return {
    state: "skew",
    detail:
      `版本错配：${a.component} release_id ${a.release_id.slice(0, 12)} ≠ ` +
      `${b.component} release_id ${b.release_id.slice(0, 12)}——两部件不是同一批构建`,
  };
}

/** 内嵌身份里的部件名闭集（供构建层与读口共用，避免各写一份字面量） */
export { COMPONENTS as BUILD_COMPONENTS };
