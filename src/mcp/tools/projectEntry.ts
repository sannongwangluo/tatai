// 项目入口与连续接续的 MCP 工具（PLAN.md V06-10；DESIGN.md §6.7 / §6.2 / §2.7）。
//
// 三个工具（都在这一个文件里，职责分得很清，别混）：
//   · `project_entry`     **只读**接续入口：给有效基线、上下文清单、未结束 run、下一动作、理由与必读原文。
//                         它不认领、不写事件、不调模型（§6.7「读取入口不自动认领，也不悄悄调用付费模型」）。
//   · `claim_task`        唯一原子写：带 `expected_revision` 认领（可续约/释放）；冲突明确拒绝并给重新读状态的入口。
//   · `submit_task_result` 结果回报：重查 版本/认领/租约/依赖/证据 后提交，并**接着读下一动作**（§6.7 的循环收口）。
//
// 为什么入口与认领分成两个工具：§6.7 与 §2.7 都要求"只读入口不认领"、"领取是带预期版本的单独原子写"。
// 合成一个工具会让"读一下"变成可能产生写入的动作，违反红线。
import { isWorkError } from "../../server/work/types";
import { evaluateProjectEntry } from "../../server/work/entry";
import { graphSummaryOf } from "../../arch/sixGraphs";
import { claimTask, releaseClaim, renewClaim, reopenTask, submitTaskResult, DEFAULT_LEASE_MS, LEASE_NOTE } from "../../server/work/claims";
import { RESULT_SUBMIT_REQUIRED_KEYS } from "../../server/work/submitChecks";
import { resolveDataDir } from "../../server/registry";
import { hostEntryView, hostSyncView } from "./syncHost";
import { errorResult, textResult, type McpContext, type McpTool, type ToolResult } from "./types";

/** 结构化拒绝：内容照原样给（含 code/failures/revision/read_again），isError 让客户端按失败处理 */
function jsonError(payload: unknown): ToolResult {
  return errorResult(JSON.stringify(payload, null, 2));
}

function jsonOk(payload: unknown): ToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}

function strOrNull(args: Record<string, unknown>, key: string): string | null {
  const v = str(args, key);
  return v === "" ? null : v;
}

function numOrNull(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "");
}

/** 转接客户端（唯一写入服务）不在时的统一话术：不自己写事件（§2.6） */
function serviceUnavailable(e: unknown): ToolResult | null {
  if (isWorkError(e) && e.code === "SERVICE_UNAVAILABLE") {
    return jsonError({ ok: false, code: "SERVICE_UNAVAILABLE", message: e.message, detail: e.detail });
  }
  return null;
}

function failWith(e: unknown, what: string): ToolResult {
  const offline = serviceUnavailable(e);
  if (offline !== null) return offline;
  if (isWorkError(e)) return jsonError({ ok: false, code: e.code, message: e.message, detail: e.detail });
  return errorResult(`${what}失败：${e instanceof Error ? e.message : String(e)}`);
}

// ── ① project_entry：只读接续入口 ──

export const projectEntryTool: McpTool = {
  name: "project_entry",
  description:
    "项目接续入口（只读）：入参 project_id/role/client_capabilities/known_revision/resume_hint；返回 project/baseline/" +
    "context_manifest/current_change/current_runs/next_action/reasons/required_reads，另带 **graph_summary**（六图摘要：" +
    "六图各一行＋同一快照标识＋基线/更新时间＋更新中或过期状态与原因＋异常＋下一读取入口）。只读、不认领、不调模型（DESIGN.md §6.7）。" +
    "六图**完整**状态走 `get_project_graphs`（摘要只给指针与状态，不内联整图；两者同一份事实与判据）；" +
    "**架构判断/影响分析前先取 mode=full 并按同快照游标取齐**（next_read_entry 已指向 full；complete:true 只表示图对象取完，" +
    "不等于源码全覆盖——采集残缺/忽略目录/旧聚合桶见 notes 与 anomalies），再读设计书、施工图与相关源码。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      role: { type: "string", description: "调用方角色（如 executor/auditor/coordinator/designer/user；角色名不是安全凭证）" },
      client_capabilities: {
        description:
          "客户端自述能力：字符串/数组/对象皆可（read_only / continuable / coordination，或 {can_continue:true}）。" +
          "**不声明按「仅可读取」处理**——只读客户端只拿读取与接续指令（DESIGN.md §6.2）",
      },
      known_revision: {
        type: "string",
        description: "调用方已知的版本（基线 id 或设计/施工图修订 sha256）；落后于当前有效版本时不派新任务",
      },
      resume_hint: { type: "string", description: "可选：接续提示（任务或交接 ID）；只是提示，不越权绕过角色/依赖/范围检查" },
      preconditions: {
        type: "boolean",
        description:
          "可选（V09-34，默认 false）：附一份**接续前置事实说明**（缺项/责任角色/下一步/补取入口，逐项 blocking:false，" +
          "只解释不改门禁）。默认不附＝保持 §6.7 恰好九字段的既有契约；为 true 时结果多一个 `preconditions` 字段。",
      },
      expected_revision: {
        type: "string",
        description:
          "可选（V09-53／§2.9）：调用方持有的 `work_package.package_revision`。不符即工作包显式 `REVISION_CHANGED`" +
          "（**不静默返回跨版本数据**）——与功能清单读口的 `expected_revision` 同口径。与逐 check 工作包及分页游标同版本。",
      },
      work_package_cursor: {
        type: "string",
        description: "可选（V09-53）：逐 check 工作包的分页游标（绑定 package_revision **与本次请求**，跨版本/跨请求即失效）。",
      },
      work_package_limit: {
        type: "number",
        description: "可选（V09-53）：逐 check 工作包每页条数（1..200，缺省 200）。越界由工作包显式 `INVALID_INPUT`。",
      },
    },
    required: ["project_id", "role"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const projectId = str(args, "project_id");
    const role = str(args, "role");
    if (projectId === "" || role === "") return errorResult("project_entry 缺入参 project_id/role（两者都必填）");
    try {
      const dataDir = resolveDataDir();
      // V09-23 返工C（Codex 反例12）：entry 的 sync_summary 必须在**响应层**用唯一宿主的**同一份**后台发现错误重算
      // （MCP 另一进程自己汇为空，不能冒充"后台无故障"）；宿主不可达且已配置时 fail-closed。
      const wantPreconditions = args.preconditions === true;
      // V09-53：工作包入参（`expected_revision`/分页游标/limit）在宿主路径与本地路径**同一份**解析，
      // 避免两条路径判据漂移（宿主只读入口接收同名查询参数，见 `service.ts#/api/work/entry`）。
      const wpCursor = strOrNull(args, "work_package_cursor");
      const wpLimit = args.work_package_limit === undefined ? undefined : (args.work_package_limit as number);
      const wpExpected = strOrNull(args, "expected_revision");
      const wpPagingRequested = wpCursor !== null || wpLimit !== undefined;
      // V09-31：优先唯一宿主只读入口——一次返回入口 + 六图摘要（同一份现读快照贯通入口/图/同步），
      // 消除「远端 sync + 本地入口 + 第三次图」三次重派生。宿主不可达才回退下面的本地路径（不假装健康）。
      // V09-53（D1）：宿主入口**也带逐 check 工作包**（显式 opt-in，默认不影响旧宿主回包）；旧宿主
      // （不认该查询参数）会原样省略该字段 ⇒ `task_brief` 如实标 `unsupported_by_host`，**不本地另算**。
      const hostEntry = await hostEntryView(
        projectId,
        dataDir,
        {
          role,
          known_revision: strOrNull(args, "known_revision"),
          resume_hint: strOrNull(args, "resume_hint"),
          client_capabilities: args.client_capabilities,
        },
        {
          ...(wantPreconditions ? { preconditions: true } : {}),
          work_package: true,
          ...(wpCursor === null ? {} : { work_package_cursor: wpCursor }),
          ...(wpLimit === undefined ? {} : { work_package_limit: wpLimit }),
          ...(wpExpected === null ? {} : { work_package_expected_revision: wpExpected }),
        },
      );
      if (hostEntry.view !== null) {
        // 保持 project_entry 既有形状：入口字段在顶层 + `graph_summary`；再带兼容可选字段（版本/来源/口径）。
        return jsonOk({
          ...hostEntry.view.entry,
          graph_summary: hostEntry.view.graph_summary,
          versions: hostEntry.view.versions,
          source: hostEntry.view.source,
          contract: hostEntry.view.contract,
        });
      }
      // 宿主**明确报错**（SOURCE_CHANGED / LEDGER_UNSTABLE / HEALTH_UNSTABLE / READ_QUEUE_FULL…）：
      // 原样上抛，**不**悄悄回退本地路径绕过后假装成功（复审根因一）。宿主不可达才是下面 fail-closed 回退。
      if (hostEntry.error !== null) {
        return jsonError({
          ok: false,
          code: hostEntry.error.code,
          message: hostEntry.error.message,
          detail: hostEntry.error.detail,
          source: "host",
          note:
            "唯一宿主只读入口明确报错：按结构化错误如实上抛（可重试的瞬时态），" +
            "不静默回退本地路径绕过（宿主不可达才走 fail-closed 本地回退）",
        });
      }
      const view = await hostSyncView(projectId, dataDir, ctx?.work);
      const entry = evaluateProjectEntry(
        {
          project_id: projectId,
          role,
          client_capabilities: args.client_capabilities,
          known_revision: strOrNull(args, "known_revision"),
          resume_hint: strOrNull(args, "resume_hint"),
        },
        {
          dataDir,
          syncDiscoveryIssues: view.discovery_issues,
          ...(wantPreconditions ? { preconditions: true } : {}),
          // V09-53（B3/§2.7）：入口随包带出**逐 check 工作包**（只读派生，与入口判定同一份 facts.obligations）。
          // 默认九字段的**服务端函数契约**不变（那是 `evaluateProjectEntry` 的 opts 语义）；MCP 层在此显式索取，
          // 与 graph_summary/versions/source 同为工具层附加字段。**宿主路径与本地路径同一份入参解析**（上面已算
          // `wpCursor/wpLimit/wpExpected`），不两条路径各算一套；旧宿主不认该参数时会省略该字段，`task_brief`
          // 如实标 `unsupported_by_host`，绝不本地另算一套（§6.6/§6.11）。
          work_package: true,
          // V09-53：`expected_revision`／分页游标与包版本**真实相连**（不是只有纯函数支持）——
          // 调用方拿到的旧包版本/旧游标在这里被显式拒（REVISION_CHANGED），不静默返回跨版本数据（§2.9）。
          ...(wpPagingRequested
            ? {
                work_package_paging: {
                  ...(wpCursor === null ? {} : { cursor: wpCursor }),
                  ...(wpLimit === undefined ? {} : { limit: wpLimit }),
                },
              }
            : {}),
          ...(wpExpected === null ? {} : { work_package_expected_revision: wpExpected }),
        },
      );
      // V09-19（§6.7）：入口另带**六图摘要**——六图各一行＋同一快照标识＋基线/更新时间＋更新中或过期状态与原因＋
      // 异常＋下一读取入口。摘要**不内联整图**（完整状态走 get_project_graphs），但必须与整图**同一份事实与判据**
      // （同一个 `sixGraphsOf` 摘要模式）。摘要算不出来**不阻断入口**：如实带一条原因，其余字段照给。
      let graphSummary: unknown = null;
      try {
        graphSummary = graphSummaryOf(projectId, { dataDir });
      } catch (e) {
        graphSummary = {
          available: false,
          reason: `六图摘要算不出来：${e instanceof Error ? e.message : String(e)}（按「读不到」如实表达，不假装有图）`,
          next_read_entry: {
            tool: "get_project_graphs",
            args: { project_id: projectId, graph: "all", mode: "full" },
            note: "六图完整状态在本工具（架构判断/影响分析用 mode=full 并按同快照游标逐图取齐；complete:true 只表示图对象取完，不等于源码全覆盖）",
          },
        };
      }
      return jsonOk({ ...entry, graph_summary: graphSummary });
    } catch (e) {
      return failWith(e, "project_entry");
    }
  },
};

// ── ② claim_task：原子领取 / 续约 / 释放 ──

export const claimTaskTool: McpTool = {
  name: "claim_task",
  description:
    "领取/续约/释放任务认领（唯一原子写）：op=claim（默认）/renew/release；claim 带 expected_revision（project_entry 的理由里有），" +
    "冲突明确拒绝并给重新读状态的入口。租约到期只表示「当前所有权需核实」，重派要写 takeover_basis（DESIGN.md §2.7/§6.7）。" +
    "op=reopen（V09-10／附录 F）：**协调器专用**的受控重开——已提交（result_submitted）的卡重开为新 attempt" +
    "（attempt+1、新 run_id/attempt_id、新工作目录、旧 token 即刻作废、旧结果永久保留）；必须带可取回的 reopen_basis" +
    "（项目根内相对路径/event:<id>/64 位证据哈希，取不回即拒）；重开不产生任何执行事实、不恢复旧绿",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["claim", "renew", "release", "reopen"], description: "默认 claim；reopen 为协调器专用（附录 F）" },
      project_id: { type: "string" },
      task_id: { type: "string" },
      role: { type: "string", description: "本客户端角色（op=reopen 必须 coordinator）" },
      owner_id: { type: "string", description: "执行者标识（缺省取 MCP 客户端名）" },
      change_id: { type: "string", description: "本次变更批次 id" },
      expected_revision: { type: "number", description: "领取前读到的实体版本（project_entry 的 reasons 给了 task_revision）" },
      workspace: { type: "string", description: "隔离工作目录（缺省 .工作台/runs/<task>/<attempt>；隔离要执行器真落实）" },
      lease_ms: { type: "number", description: `租约时长毫秒（缺省 ${DEFAULT_LEASE_MS}）` },
      attempt: { type: "number", description: "第几次尝试（重派 +1）" },
      takeover_basis: {
        type: "string",
        description: `旧认领已到期仍要接手时的核实依据（隔离了新工作目录 / 确认旧进程已停止且旧认领失效）。${LEASE_NOTE}`,
      },
      claim_token: { type: "string", description: "op=renew/release 时必填：本次认领的 token" },
      reason: { type: "string", description: "op=release 时的释放理由；op=reopen 时的返工理由（必填，改版重交/复核重验分开写）" },
      reopen_basis: {
        type: "array",
        items: { type: "string" },
        description:
          "op=reopen 必填：可取回的授权依据（≥1 条；项目根内相对路径须真实存在 / event:<id> 在本项目账本 / 64 位证据哈希在库；取不回即拒，DESIGN.md 附录 E.4/F.2）",
      },
      request_id: { type: "string", description: "op=reopen 可选幂等键：重复重开返回原回执、不另起 attempt" },
    },
    required: ["project_id", "task_id", "role", "change_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext) => {
    const op = (str(args, "op") || "claim") as "claim" | "renew" | "release" | "reopen";
    const projectId = str(args, "project_id");
    const taskId = str(args, "task_id");
    const role = str(args, "role");
    const changeId = str(args, "change_id");
    if (projectId === "" || taskId === "" || role === "" || changeId === "") {
      return errorResult("claim_task 缺入参 project_id/task_id/role/change_id");
    }
    if (op !== "claim" && op !== "renew" && op !== "release" && op !== "reopen") {
      return errorResult(`claim_task 的 op 只接受 claim/renew/release/reopen（收到 ${JSON.stringify(args.op)}）`);
    }
    const submitter = ctx?.work;
    if (submitter === undefined) {
      return errorResult("claim_task 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者，MCP 不自己追加事件（DESIGN.md §2.6）");
    }
    const ownerId = str(args, "owner_id") || ctx?.clientName || role;
    const dataDir = resolveDataDir();
    try {
      if (op === "reopen") {
        // V09-10（附录 F）：协调器受控重开——核实链在 claims.reopenTask + 唯一写入服务边界（同一份判据）
        const basis = strList(args, "reopen_basis");
        const reasonText = str(args, "reason");
        if (basis.length === 0 || reasonText === "") {
          return errorResult("claim_task(op=reopen) 要求 reopen_basis（≥1 条可取回依据）与 reason（返工理由）");
        }
        const outcome = await reopenTask(
          {
            project_id: projectId,
            task_id: taskId,
            role,
            actor_id: ownerId,
            change_id: changeId,
            reopen_basis: basis,
            reason: reasonText,
            ...(numOrNull(args, "expected_revision") === null
              ? {}
              : { expected_revision: numOrNull(args, "expected_revision")! }),
            ...(strOrNull(args, "workspace") === null ? {} : { workspace: str(args, "workspace") }),
            ...(strOrNull(args, "request_id") === null ? {} : { request_id: str(args, "request_id") }),
          },
          submitter,
          dataDir,
        );
        return outcome.ok ? jsonOk(outcome) : jsonError(outcome);
      }
      if (op === "claim") {
        const outcome = await claimTask(
          {
            project_id: projectId,
            task_id: taskId,
            role,
            owner_id: ownerId,
            change_id: changeId,
            // 给了就按"我以为的版本"原子写；没给就现读当前版本再原子写（**不传 null**——
            // null 的语义是"期望该实体尚不存在"，会误把已有任务判成版本冲突）
            ...(numOrNull(args, "expected_revision") === null
              ? {}
              : { expected_revision: numOrNull(args, "expected_revision")! }),
            ...(strOrNull(args, "workspace") === null ? {} : { workspace: str(args, "workspace") }),
            ...(numOrNull(args, "lease_ms") === null ? {} : { lease_ms: numOrNull(args, "lease_ms")! }),
            ...(numOrNull(args, "attempt") === null ? {} : { attempt: numOrNull(args, "attempt")! }),
            ...(strOrNull(args, "takeover_basis") === null ? {} : { takeover_basis: str(args, "takeover_basis") }),
          },
          submitter,
          dataDir,
        );
        return outcome.ok ? jsonOk(outcome) : jsonError(outcome);
      }
      const token = str(args, "claim_token");
      const expected = numOrNull(args, "expected_revision");
      if (token === "" || expected === null) {
        return errorResult(`claim_task(op=${op}) 要求 claim_token 与 expected_revision（project_entry 的理由里有当前版本/token）`);
      }
      if (op === "renew") {
        const outcome = await renewClaim(
          {
            project_id: projectId,
            task_id: taskId,
            role,
            owner_id: ownerId,
            change_id: changeId,
            claim_token: token,
            expected_revision: expected,
            ...(numOrNull(args, "lease_ms") === null ? {} : { lease_ms: numOrNull(args, "lease_ms")! }),
          },
          submitter,
          dataDir,
        );
        return outcome.ok ? jsonOk(outcome) : jsonError(outcome);
      }
      const outcome = await releaseClaim(
        {
          project_id: projectId,
          task_id: taskId,
          role,
          owner_id: ownerId,
          change_id: changeId,
          claim_token: token,
          expected_revision: expected,
          ...(strOrNull(args, "reason") === null ? {} : { reason: str(args, "reason") }),
        },
        submitter,
        dataDir,
      );
      return outcome.ok ? jsonOk(outcome) : jsonError(outcome);
    } catch (e) {
      return failWith(e, `claim_task(${op})`);
    }
  },
};

// ── ③ submit_task_result：结果回报 + 接着读下一动作 ──

/**
 * `submit_task_result` 的输入 schema 与必填（P2/V09-47：只读预检 `preflight_task_result` **复用同一份**，
 * 保证「输入与提交同形、原必填不省略」；本对象**逐字不变**）。
 */
export const SUBMIT_TASK_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    project_id: { type: "string" },
    task_id: { type: "string" },
    role: { type: "string" },
    owner_id: { type: "string", description: "缺省取 MCP 客户端名" },
    change_id: { type: "string" },
    claim_token: { type: "string", description: "本次认领的 token（所有交付检查当前认领 token）" },
    expected_revision: { type: "number", description: "提交前读到的实体版本（必须与现场一致）" },
    deliverables: { type: "array", items: { type: "string" }, description: "交付物（§2.7 交接包必含项）" },
    evidence_refs: {
      type: "array",
      items: { type: "string" },
      description: "证据引用（至少一条）：内容寻址 sha256，或项目根内相对路径（不存在会被拒）",
    },
    verification: {
      type: "array",
      description: "实际验证命令 + 退出码 + 输出位置（§5.4 交付包；未跑的命令不许写成通过）",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          exit_code: { type: "number" },
          output_ref: { type: "string" },
        },
        required: ["command", "exit_code"],
      },
    },
    untested: { type: "array", items: { type: "string" }, description: "未测项（如实；空数组也要显式给）" },
    known_issues: { type: "array", items: { type: "string" }, description: "已知问题" },
    diff_ref: { type: "string", description: "结果 diff/内容哈希的取回位置" },
    result_revision: { type: "string", description: "结果绑定的代码/内容版本（复核基准，§5.6）" },
    runtime_entries: {
      type: "array",
      description:
        "本次交付的**可体验运行入口**（可选；DESIGN.md §3.7）：每项 {scenario,url,verified_at,status,reason}。" +
        "url 只接受 http(s)；verified_at 必须能解析出真实时刻；status=reachable/unreachable/unknown，" +
        "非 reachable 必须写 reason。读侧与成果登记走**同一套校验**，非法登记读回来是 EVENT_INVALID；" +
        "不声明＝这次没入口（不是错误）",
      items: {
        type: "object",
        properties: {
          scenario: { type: "string", description: "场景名（如「下单流程走一遍」）" },
          url: { type: "string", description: "实际入口地址（只接受 http(s)）" },
          verified_at: { type: "string", description: "执行者实际验证时间（带偏移 ISO）" },
          status: {
            type: "string",
            enum: ["reachable", "unreachable", "unknown"],
            description: "执行者实测写下的探测结果（塔台不代跑探测）",
          },
          reason: { type: "string", description: "status != reachable 时必填的不可用原因" },
        },
        required: ["scenario", "url", "verified_at", "status"],
      },
    },
    ownership_basis: { type: "string", description: `租约已到期仍要提交时的核实依据。${LEASE_NOTE}` },
  },
  // P2/V09-47 返工：必填**从共享只读判据核的同一份清单派生**（`submitChecks.RESULT_SUBMIT_REQUIRED_KEYS`），
  // 预检与真实提交的 schema 不再各写一遍、不会漂移；值与原先逐字相同。
  required: [...RESULT_SUBMIT_REQUIRED_KEYS],
  additionalProperties: false,
};

/** `submit_task_result` 的必填字段（预检同形；调用方与服务端都按此判定必填，逐字不变） */
export const SUBMIT_TASK_RESULT_REQUIRED: readonly string[] = [...RESULT_SUBMIT_REQUIRED_KEYS];

export const submitTaskResultTool: McpTool = {
  name: "submit_task_result",
  description:
    "提交任务结果（重查 任务版本/认领 token/租约/依赖释放/证据 后再写），提交成功后**接着读下一动作**。" +
    "结果只表示「执行者已提交结果」，不等于审计通过或人工验收接受（DESIGN.md §5.4/§6.7）",
  inputSchema: SUBMIT_TASK_RESULT_SCHEMA,
  handler: async (args, ctx?: McpContext) => {
    const projectId = str(args, "project_id");
    const taskId = str(args, "task_id");
    const role = str(args, "role");
    const changeId = str(args, "change_id");
    const claimToken = str(args, "claim_token");
    const expected = numOrNull(args, "expected_revision");
    if (projectId === "" || taskId === "" || role === "" || changeId === "" || claimToken === "" || expected === null) {
      return errorResult(
        "submit_task_result 缺入参 project_id/task_id/role/change_id/claim_token/expected_revision",
      );
    }
    const submitter = ctx?.work;
    if (submitter === undefined) {
      return errorResult("submit_task_result 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者（DESIGN.md §2.6）");
    }
    const ownerId = str(args, "owner_id") || ctx?.clientName || role;
    const dataDir = resolveDataDir();
    const verification: { command: string; exit_code: number; output_ref?: string | null }[] = Array.isArray(args.verification)
      ? (args.verification as unknown[])
          .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
          .map((v) => ({
            command: typeof v.command === "string" ? v.command : "",
            exit_code: typeof v.exit_code === "number" ? v.exit_code : -1,
            output_ref: typeof v.output_ref === "string" ? v.output_ref : null,
          }))
      : [];
    try {
      const outcome = await submitTaskResult(
        {
          project_id: projectId,
          task_id: taskId,
          role,
          owner_id: ownerId,
          change_id: changeId,
          claim_token: claimToken,
          expected_revision: expected,
          deliverables: strList(args, "deliverables"),
          evidence_refs: strList(args, "evidence_refs"),
          verification,
          untested: strList(args, "untested"),
          known_issues: strList(args, "known_issues"),
          diff_ref: strOrNull(args, "diff_ref"),
          result_revision: strOrNull(args, "result_revision"),
          // 补修 F3：可选的可体验运行入口，原样透传到结果回报（闸门在读侧，与成果登记同口径）。
          // **不要**在这里用 `Array.isArray` 过滤：那样"传了但类型不对"会被静默丢掉、写入方还看到成功，
          // 等于把读侧闸门废掉。只要调用方给了这个键就原样带走，非法值交给读侧报 `EVENT_INVALID`。
          ...(args.runtime_entries === undefined ? {} : { runtime_entries: args.runtime_entries }),
          ...(strOrNull(args, "ownership_basis") === null ? {} : { ownership_basis: str(args, "ownership_basis") }),
        },
        {
          submitter,
          // 回报后读取下一动作：只读入口按新事实重新判（§6.7 的循环收口）
          readNextAction: (id, query) => {
            const entry = evaluateProjectEntry(
              { project_id: id, role: query.role, client_capabilities: query.client_capabilities, known_revision: query.known_revision },
              { dataDir },
            );
            return { next_action: entry.next_action, reasons: entry.reasons, required_reads: entry.required_reads };
          },
        },
        dataDir,
      );
      return outcome.ok ? jsonOk(outcome) : jsonError(outcome);
    } catch (e) {
      return failWith(e, "submit_task_result");
    }
  },
};

/** 本卡新增的三个工具（index.ts 按此顺序登记；`project_entry` 只读，另两个是 v2 写口） */
export const projectEntryTools: readonly McpTool[] = [projectEntryTool, claimTaskTool, submitTaskResultTool];

/** 供 select_project 做能力发现：本卡暴露的接续接口名（§6.2「记录实际能力」） */
export const ENTRY_INTERFACE_NAMES: readonly string[] = [projectEntryTool.name, claimTaskTool.name, submitTaskResultTool.name];

/** 能力档位说明（select_project 里如实回给调用方） */
export function capabilityTiersOf(workAvailable: boolean): Record<string, string> {
  return {
    read_only: "可用：本机任何 MCP 客户端经当前工具面读取（list_projects/select_project/read_*/project_entry）",
    continuable: workAvailable
      ? "可用：v2 唯一写入服务在线（descriptor 存在），可认领/回报（claim_task/submit_task_result）"
      : "不可用：v2 唯一写入服务没在跑，认领会得到 SERVICE_UNAVAILABLE（MCP 不自己写事件，§2.6）",
    coordination: "未交付：拉起/终止外部执行进程属外部协调器（V06-11），塔台不假称已支持（§6.2/§6.5）",
  };
}
