// expand_module：**深层结构经 MCP 取回**的就地展开读口
// —— 2026-10-03 统一优化 U3（DESIGN.md §6.8；docs/unified-optimization-contract.md U3；PLAN V09-35）。
//
// 为什么需要它：技术详情三图（方框图／数据流向图／思维导图）只画**顶层模块**（模块划分规则是
// 「顶层目录为候选，候选数 < MIN_MODULES 才按二级目录细分」），所以顶层目录 ≥ 5 的项目（含塔台自身）
// 在图上只有顶层一格。下钻能力**早已实现**（A4 懒加载），但过去只挂在 HTTP
// `POST /api/projects/:id/arch/expand` 上，MCP 侧没有入口——接手 agent 想知道「src 里有什么、谁依赖谁」
// 只能绕开塔台自己扫盘（结果不进图、换会话即丢）。
//
// 口径（契约 U3／OPT-06，别改）：
//   · **复用同一份派生**：直接调 `arch/expand.ts` 的 `expandProject`（与 HTTP 路由同一个函数、
//     同一个 id 口径、同一套防爆炸与预算、同一套中间联接点防逃逸），本文件**不重算任何图事实**；
//   · **分页来源版本**：分页模式下额外带 `children_fingerprint`（直接子级身份清单 sha256）＝本次分页的
//     来源版本。续页时回传 `source_fingerprint`：不符即 `PAGE_SOURCE_CHANGED`，**不跨版本拼页**；
//   · **不宣称完整**：`stats.budget_exhausted`／`truncated.children` 如实带出；规则忽略目录属规则性排除；
//   · **只读**：不写 modules.json／blueprint.json／progress.json／账本，不调模型（`llm_calls` 恒 0）；
//   · 依赖边是**静态 import 结构线索**（§3.2／§11.2），不是业务数据流、不证明质量通过。
//   · **源变失效**只对分页窗口的**成员集合**负责（成员增删改名/换类型 → 指纹变）；子级内容变化不动窗口，
//     故不据此声称内容未变（内容证明见契约 U1：mtime/size/seq 都不算证据）。
import { expandProject } from "../../arch/expand";
import { IGNORED_SEGMENTS } from "../../arch/parse";
import { RENDER_FULL_LIMITS } from "../../arch/config";
import { isWorkError } from "../../server/work/types";
import { errorResult, textResult, type McpTool } from "./types";

/** 同源 HTTP 路由（回执里点名，便于逐字段对账；本工具与它读同一份派生） */
const HTTP_ROUTE = "POST /api/projects/:id/arch/expand";

function nonNegIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

export const expandModuleTool: McpTool = {
  name: "expand_module",
  description:
    "**就地展开**项目的一个模块，取它的直接子级、子级间依赖与对外依赖（只读、不调模型）（DESIGN.md §6.8／契约 U3）。" +
    "用途：技术详情三图只画顶层模块，本工具补上「往下看一层／逐层下钻」的 MCP 入口——" +
    "子目录成子模块节点、文件成文件节点（文件名即名字，纯静态零 LLM），子树内源码按 import 聚合出**结构线索**。" +
    "与 HTTP `" + HTTP_ROUTE + "` **同一份派生**（同一个 expandProject、同一套防爆炸与预算、同一个 id 口径、同一套路径防逃逸）：" +
    "业务数据（children/external/truncated/limit/stats）逐项一致；duration_ms/parse_ms 只是现场读数，不作相等判据。" +
    "分页：给 `children_offset` 切**稳定分页**（排序后全量直接子级的窗口），返回 children_total/offset/returned/has_more " +
    "与 `source_fingerprint`（本次分页来源版本）；续页回传 `source_fingerprint`，源变（成员增删改名/换类型）即 `PAGE_SOURCE_CHANGED`，不跨版本拼页。" +
    "**不宣称完整**：`stats.budget_exhausted=true` 表示遍历/解析到点收工（本次不是全部）；规则忽略目录（node_modules/.git/dist/缓存等）按规则不入图，属规则性排除。" +
    "路径经**联接点/软链**解析后落在项目根外一律拒绝（含中间段）。" +
    "返回的依赖边是**静态 import 结构线索**，不是业务数据流、也不证明质量通过（§3.2／§11.2）；" +
    "六图状态与证据请看 get_arch／get_project_graphs（本工具不改图、不改状态、不写任何文件）。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      module_path: {
        type: "string",
        description:
          "相对项目根的 posix 路径（如 `src`、`src/arch`）；`.` = 根散文件模块（只列根直属文件）。必须是项目根内真实存在的目录：`..`／绝对路径／盘符／忽略目录段／**经软链或联接点解析后（含中间段）落在项目根外**一律拒绝",
      },
      children_limit: {
        type: "number",
        description: `本次单枝子级上限（≥1 的整数）。缺省＝概览口径（单枝上限 40，与图面一致）；参考全量口径 ${RENDER_FULL_LIMITS.MAX_CHILDREN}。超上限走聚合节点并如实带 truncated.children`,
      },
      children_offset: {
        type: "number",
        description:
          "给了就切**稳定分页**（≥0 的整数）：按排序后全量直接子级开窗，逐页取回上限外子级；返回 children_total/children_offset/children_returned/children_has_more 与 source_fingerprint。不传＝缺省截断口径。" +
            "（HTTP body 用 camelCase `childrenOffset`，参数名不同、语义相同）",
      },
      source_fingerprint: {
        type: "string",
        description:
          "上一页返回的分页来源版本（`children_fingerprint`，64 位十六进制）。续页时回传：与当前直接子级身份清单不符即 `PAGE_SOURCE_CHANGED`（源变，须从 0 重取，不跨版本拼页）。只与 children_offset 搭配使用",
      },
      include_external: {
        type: "boolean",
        description: "缺省 true。是否返回指向**子树之外**的依赖（`external`）：它是子树级读数，不随分页子级窗口截断",
      },
    },
    required: ["project_id", "module_path"],
    additionalProperties: false,
  },
  handler: (args) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    if (projectId === "") return errorResult("expand_module 缺入参 project_id");
    const modulePath = typeof args.module_path === "string" ? args.module_path.trim() : "";
    if (modulePath === "") return errorResult("expand_module 缺入参 module_path（相对项目根的 posix 路径，根散文件模块给 `.`）");

    const rawLimit = args.children_limit;
    const childrenLimit = rawLimit === undefined ? null : nonNegIntOrNull(rawLimit);
    if (rawLimit !== undefined && (childrenLimit === null || childrenLimit < 1)) {
      return errorResult(`children_limit 必须是 ≥1 的整数（收到 ${JSON.stringify(rawLimit)}）；不传＝缺省口径`);
    }
    const rawOffset = args.children_offset;
    const childrenOffset = rawOffset === undefined ? null : nonNegIntOrNull(rawOffset);
    if (rawOffset !== undefined && childrenOffset === null) {
      return errorResult(`children_offset 必须是 ≥0 的整数（收到 ${JSON.stringify(rawOffset)}）；不传＝缺省截断口径`);
    }
    const sourceFingerprint = typeof args.source_fingerprint === "string" ? args.source_fingerprint.trim() : "";
    if (sourceFingerprint !== "" && childrenOffset === null) {
      return errorResult(
        "expand_module 的 source_fingerprint 只与 children_offset（分页）搭配使用：没有分页窗口就没有来源版本可核",
      );
    }
    if (sourceFingerprint !== "" && !/^[0-9a-f]{64}$/.test(sourceFingerprint)) {
      return errorResult(`source_fingerprint 必须是 64 位十六进制（收到 ${JSON.stringify(sourceFingerprint)}）`);
    }
    const includeExternal = args.include_external !== false;
    const jsonError = (code: string, message: string, detail: Record<string, unknown> = {}) =>
      errorResult(JSON.stringify({ ok: false, code, message, detail }, null, 2));

    let result: ReturnType<typeof expandProject>;
    try {
      result = expandProject(projectId, modulePath, undefined, {
        ...(childrenLimit === null ? {} : { childrenLimit }),
        ...(childrenOffset === null ? {} : { childrenOffset }),
        ...(childrenOffset === null ? {} : { childrenSource: true }),
      });
    } catch (e) {
      if (isWorkError(e)) return jsonError(e.code, e.message, e.detail ?? {});
      // 路径不合法/目录不存在/联接点逃逸在 expand 里抛 WsError（不是 WorkError）：原样带出 code 与可读原因
      const message = e instanceof Error ? e.message : String(e);
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "EXPAND_FAILED";
      return jsonError(code, message, { module_path: modulePath, project_id: projectId });
    }

    const verifyCurrentFingerprint = result.children_fingerprint ?? null;
    if (sourceFingerprint !== "" && verifyCurrentFingerprint !== null && sourceFingerprint !== verifyCurrentFingerprint) {
      return jsonError(
        "PAGE_SOURCE_CHANGED",
        `分页来源版本已变：本页直接子级的身份清单指纹是 ${verifyCurrentFingerprint.slice(0, 16)}…，` +
          `而传入的 source_fingerprint 是 ${sourceFingerprint.slice(0, 16)}…。` +
          "成员集合变了 ⇒ 用旧窗口续页会漏项/重复（不跨版本拼页）。请从 children_offset=0 重新开始整轮分页",
        {
          project_id: projectId,
          module_path: modulePath,
          expected_source_fingerprint: verifyCurrentFingerprint,
          given_source_fingerprint: sourceFingerprint,
        },
      );
    }

    const { external, children_fingerprint, ...rest } = result;
    const currentFingerprint = children_fingerprint ?? null;
    return textResult(
      JSON.stringify(
        {
          project_id: projectId,
          module_path: modulePath,
          ...rest,
          ...(includeExternal ? { external } : {}),
          source_fingerprint: currentFingerprint,
          ignored_dir_segments: [...IGNORED_SEGMENTS].sort(),
          external_scope: includeExternal
            ? "external 是**子树级**读数（该子树内文件指向子树外的 import 聚合），不随 children_offset 的子级窗口变化"
            : null,
          pagination:
            childrenOffset === null
              ? null
              : {
                  source_fingerprint: currentFingerprint,
                  fingerprint_kind: "direct_children_identity",
                  verified: sourceFingerprint === "" ? null : true,
                  note:
                    "source_fingerprint ＝直接子级身份清单（排序后的 kind+name）sha256，认证的是**分页窗口成员集合**未变；" +
                    "续页请原样回传；成员增删改名/换类型即失效（PAGE_SOURCE_CHANGED）。它不证明子级内容未变（内容证明见契约 U1）",
                },
          source: {
            kind: "code_static_import",
            semantics: "static_reference",
            is_business_data_flow: false,
            note:
              "本条（含 children[].deps 与 external）是静态 import 的结构线索，方向＝依赖方 → 被依赖方；" +
              "不是业务数据流、不证明质量通过（DESIGN §3.2／§11.2）。图事实请看 get_arch／get_project_graphs",
          },
          same_source: {
            route: HTTP_ROUTE,
            note: "与上述 HTTP 路由同一份派生：业务数据逐项一致；duration_ms/parse_ms 是现场读数，不作相等判据",
          },
          readings: {
            duration_ms: result.duration_ms,
            parse_ms: result.parse_ms,
            timing_note: "耗时字段属运行现场读数，两次执行不要求逐字相等",
          },
        },
        null,
        2,
      ),
    );
  },
};
