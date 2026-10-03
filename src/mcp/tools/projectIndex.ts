// project_index：持久项目说明索引（Agent 编写的 `docs/project-notes.json`）的读口与维护入口
// —— 2026-10-03 统一优化 U5／U5.1（DESIGN.md §6.8；docs/unified-optimization-contract.md U5/U5.1；PLAN V09-39）。
//
// 为什么需要它：接手 agent 需要「这个模块/路径是干什么的、跟谁有关系、有哪些接口与约束、对应哪张卡/哪些测试/证据」，
// 而这些是 **Agent 编写的待审说明**，不是设计、不是事件、不是验收事实。本工具把它落成**项目根内 docs/project-notes.json**
// 的版本化索引（稳定 id、职责、关系、接口、约束、有限来源 {path,sha256}、task_ids/tests/evidence 引用）并支持按路径/任务取材。
//
// 口径（契约 U5/U5.1，别改）：
//   · **读/impact/coverage 只读零副作用**：直接本地读，**不 ensure 宿主、不拉 writer、不调模型**；
//   · **upsert/remove 经唯一宿主**：stdio 进程不自己写项目目录，转 `ctx.work`（见 `projectIndexHost`）；
//   · **Agent 声明默认待审**：条目自带 evidence 字段也**不能**冒充 verified（`verification.status=declared`）；
//   · **未声明 ≠ 无影响**：impact 命中不到时 coverage=unknown，不推断「没有影响」；
//   · **交接覆盖**：coverage 列必需材料/实际返回范围版本/遗漏/补取工具；送达不等于理解不等于验收，
//     未取原文/未读源码的范围不宣称 covered；
//   · 索引是 Agent 后补的**导航**，不是新设计权威，不改六图颜色/状态/Gate，不新增用户 Gate。
import { resolveDataDir } from "../../server/registry";
import { WorkError } from "../../server/work/types";
import {
  PROJECT_NOTES_REL,
  projectIndexCoverage,
  projectIndexImpact,
  readProjectNotesIndex,
} from "../../server/work/projectIndex";
import { callProjectIndexHost, type ProjectIndexWriteOp } from "../../server/work/projectIndexHost";
import { errorResult, textResult, type McpTool } from "./types";

const strOf = (args: Record<string, unknown>, key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");

function jsonError(code: string, message: string, detail: Record<string, unknown> = {}): ReturnType<typeof errorResult> {
  return errorResult(JSON.stringify({ ok: false, code, message, detail }, null, 2));
}

export const projectIndexTool: McpTool = {
  name: "project_index",
  description:
    "持久项目说明索引（Agent 编写的项目根内 `" + PROJECT_NOTES_REL + "`）（DESIGN §6.8／契约 U5·U5.1）。" +
    "它维护「模块/文件干什么、跟谁有关系、有哪些接口与约束、对应哪些卡/测试/证据」——**待审说明层**，不是设计、不是事件、不是验收事实。" +
    "op=read **只读**（本地读，不拉写入服务）：按 `path`/`task_id`/`id` 取条目摘要与来源状态（ok/stale/missing/unreadable）；" +
    "不存在时明确**空索引**（不能据此推断没有影响）；项目已有**异 schema 同名文档**时明确冲突、不覆盖。" +
    "op=impact **只读**：给定 `path`/`task_id` 出**显式声明关系**＋**来源新鲜度 code_references[].source_current**（只表示来源当前存在且哈希相符，**不证明**声明的引用/关系已验证，关系仍是 declared 待审）＋未知 coverage（**未声明 ≠ 无影响**）。" +
    "op=coverage **只读**：交接清单（必需材料/实际返回范围与版本/遗漏/补取工具）——送达不等于理解或验收，未读源码不宣称 covered。" +
    "op=upsert／op=remove **写**：经唯一宿主，用完整文件 hash 做 CAS（`expected_file_sha256`，先 read 取回再回填），锁内核对后原子写；" +
    "只维护指定条目（增量），未知字段/重复 id/超条目·字节/`..`·绝对路径/junction 逃逸/凭据路径一律拒；来源在写下时现读核对完整 sha（不许编造当前哈希）；" +
    "保持 id 的显式 upsert 处理路径迁移；删除条目只删说明，不删源文件/业务证据。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      op: { type: "string", enum: ["read", "impact", "coverage", "upsert", "remove"], description: "读（read/impact/coverage）或写（upsert/remove，经唯一宿主）" },
      path: { type: "string", description: "按项目根内相对路径检索（read/impact/coverage）" },
      task_id: { type: "string", description: "按卡号检索条目（read/impact/coverage）" },
      id: { type: "string", description: "按条目稳定 id 精确取（read/impact/coverage）" },
      limit: { type: "number", description: "read 返回条目数上限（≥1 整数；超上限如实标 truncated）" },
      expected_file_sha256: {
        type: "string",
        description: "写（upsert/remove）的 CAS 版本：先 op=read 取回 `notes_file.version_sha256` 再回填；文件不存在时用 null。与当前不符即 VERSION_CONFLICT，不写",
      },
      entries: {
        type: "array",
        description: "op=upsert 要新增/更新的条目数组（按 id 合并；每项含 id/responsibility/paths/interfaces/constraints/relations/sources[{path,sha256}]/task_ids/tests/evidence_refs/declared_by）",
        items: { type: "object" },
      },
      ids: { type: "array", description: "op=remove 要删除的说明条目 id 数组（只删说明，不删源文件/证据）", items: { type: "string" } },
      declared_by: { type: "string", description: "op=upsert 缺省声明者（条目自身 declared_by 优先）" },
    },
    required: ["project_id", "op"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const projectId = strOf(args, "project_id");
    if (projectId === "") return errorResult("project_index 缺入参 project_id");
    const op = strOf(args, "op");
    const pathArg = strOf(args, "path");
    const taskArg = strOf(args, "task_id");
    const idArg = strOf(args, "id");
    try {
      if (op === "read") {
        const limitRaw = args.limit;
        const limit = limitRaw === undefined ? undefined : typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw >= 1 ? limitRaw : NaN;
        if (limit !== undefined && Number.isNaN(limit)) return errorResult(`project_index 的 limit 必须是 ≥1 的整数（收到 ${JSON.stringify(limitRaw)}）`);
        const result = readProjectNotesIndex(projectId, {
          dataDir: resolveDataDir(),
          ...(pathArg === "" ? {} : { path: pathArg }),
          ...(taskArg === "" ? {} : { task_id: taskArg }),
          ...(idArg === "" ? {} : { id: idArg }),
          ...(limit === undefined ? {} : { limit }),
        });
        return textResult(JSON.stringify(result, null, 2));
      }
      if (op === "impact") {
        const result = projectIndexImpact(projectId, {
          dataDir: resolveDataDir(),
          ...(pathArg === "" ? {} : { path: pathArg }),
          ...(taskArg === "" ? {} : { task_id: taskArg }),
          ...(idArg === "" ? {} : { id: idArg }),
        });
        return textResult(JSON.stringify(result, null, 2));
      }
      if (op === "coverage") {
        const result = projectIndexCoverage(projectId, {
          dataDir: resolveDataDir(),
          ...(pathArg === "" ? {} : { path: pathArg }),
          ...(taskArg === "" ? {} : { task_id: taskArg }),
          ...(idArg === "" ? {} : { id: idArg }),
        });
        return textResult(JSON.stringify(result, null, 2));
      }
      if (op === "upsert" || op === "remove") {
        const work = ctx?.work;
        if (work === undefined) {
          throw new WorkError("SERVICE_UNAVAILABLE", `project_index 拿不到转接客户端（ctx.work）：说明索引的写只经唯一写入服务`, { op });
        }
        const expected = args.expected_file_sha256 === undefined || args.expected_file_sha256 === null || args.expected_file_sha256 === "" ? null : args.expected_file_sha256;
        if (expected !== null && (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))) {
          throw new WorkError("INVALID_COMMAND", `expected_file_sha256 必须是 64 位小写十六进制或 null（收到 ${JSON.stringify(args.expected_file_sha256)}）`, { field: "expected_file_sha256" });
        }
        const payload: Record<string, unknown> = { expected_file_sha256: expected };
        if (op === "upsert") {
          if (!Array.isArray(args.entries) || args.entries.length === 0) {
            return errorResult("project_index op=upsert 需要非空的 entries 数组（增量 upsert 只维护指定条目）");
          }
          payload.entries = args.entries;
          const declaredBy = strOf(args, "declared_by");
          if (declaredBy !== "") payload.declared_by = declaredBy;
        } else {
          if (!Array.isArray(args.ids) || args.ids.length === 0) {
            return errorResult("project_index op=remove 需要非空的 ids 数组（删除说明是显式动作，不猜）");
          }
          payload.ids = args.ids;
        }
        const raw = await callProjectIndexHost(work, projectId, op as ProjectIndexWriteOp, payload);
        // 写完把**当前**读数带回，调用方不必再猜（read 与写同一份判据）
        const view = readProjectNotesIndex(projectId, { dataDir: resolveDataDir() });
        return textResult(JSON.stringify({ ok: true, op, result: raw, notes_file: view.notes_file }, null, 2));
      }
      return errorResult(`project_index 的 op 只接受 read/impact/coverage/upsert/remove（收到 ${JSON.stringify(op || "(缺)")}）`);
    } catch (e) {
      if (e instanceof WorkError) return jsonError(e.code, e.message, e.detail ?? {});
      return errorResult(`project_index 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
