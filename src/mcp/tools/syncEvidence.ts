// 同步证据的 MCP 接口（PLAN V09-23；DESIGN.md §2.10 / §6.4；docs/sync-evidence-contract.md「接口、界面和交付」）。
//
// 三个规范接口：
//   · register_sync_contract（明确写入；限设计/协调职责，记 actor）→ 经唯一写口提交 sync.contract_registered；
//     `contract` 声明为 object|string：对象直接登记，JSON 文本再走一遍重复字段检查（含转义同名键）。
//     写路径与 duplicate 短路都回报 `registered_seq`（原登记事件真实序号，取自事件账本，非 last_seq），
//     duplicate 另带回只读 `registration` 元数据，供断线后的调用者恢复登记截点；原 `receipt` 保留向后兼容。
//   · scan_sync_evidence（明确有写入）→ 请求**宿主**扫描（与后台发现共用同一逻辑、单飞队列与唯一写口）；
//   · read_sync_status（只读）→ 从**唯一宿主**只读读口取同一份 report（MCP 另一进程不拿本进程空汇冒充后台无故障），
//     取不到且已配置时 fail-closed（见 syncHost.ts）；不触发扫描、不写账、不拉起写者。
//
// HTTP/界面同判据：结果形状与判据的唯一出处是 src/shared/syncEvidence.ts 与 src/server/work/sync.ts。
import { getProject, resolveDataDir } from "../../server/registry";
import { projectWorkDir } from "../../server/workstation";
import "../../server/work/syncGraph"; // 组合根：注册 graph_full 六图探针（sync.ts 不反向 import 上层模块）
import { buildRegisterContractCommand, existingContractSha, syncEntityRevision } from "../../server/work/sync";
import { syncContractSha256, validateSyncContract } from "../../server/work/syncContract";
import { loadEvents } from "../../server/work/eventStore";
import { WorkError } from "../../server/work/types";
import type { SyncContract } from "../../shared/syncEvidence";
import { hostSyncView } from "./syncHost";
import { errorResult, textResult, type McpTool } from "./types";

const projectIdOf = (args: Record<string, unknown>): string => (typeof args.project_id === "string" ? args.project_id.trim() : "");
const roleOf = (args: Record<string, unknown>): string => (typeof args.role === "string" ? args.role.trim() : "");

/** 原登记事件的**只读元数据**（duplicate 短路时从真实账本取回，供断线后的调用者续作） */
interface RegisteredContractMeta {
  seq: number;
  event_id: string;
  project_id: string;
  batch_id: string;
  contract_sha256: string;
  entity_id: string;
  change_id: string;
  actor_id: string;
  role: string;
  received_at: string;
}

/**
 * 从本项目**真实事件账本**取回某批次契约的原始登记事件（exact batch + contract sha，取**最早**一条＝原登记）。
 * 只读：不猜 seq、不用 `last_seq` 顶、不新写事件/投影；找不到（或 payload 是坏领域事实核不出哈希）返回 null，
 * 由调用方**明确报错、零新增**（不降级成"就当没登记"或编一个序号）。
 */
function findRegisteredContract(projectId: string, dataDir: string, batchId: string, contractSha: string): RegisteredContractMeta | null {
  const { events } = loadEvents(projectWorkDir(projectId, dataDir));
  for (const e of events) {
    if (e.type !== "sync.contract_registered") continue;
    let folded: SyncContract;
    try {
      folded = validateSyncContract(e.payload);
    } catch {
      continue; // 坏领域事实在别处 fail-closed；这里不猜、不拿它当原登记
    }
    if (folded.batch_id !== batchId) continue;
    if (syncContractSha256(folded) !== contractSha) continue;
    return {
      seq: e.seq,
      event_id: e.event_id,
      project_id: e.project_id,
      batch_id: batchId,
      contract_sha256: contractSha,
      entity_id: e.entity_id,
      change_id: e.change_id,
      actor_id: e.actor_id,
      role: e.role,
      received_at: e.received_at,
    };
  }
  return null;
}

export const readSyncStatusTool: McpTool = {
  name: "read_sync_status",
  description:
    "只读：读项目当前的同步证据状态（配置/结论/逐项缺口/核对时间）。从唯一宿主只读读口取同一份判据（宿主不可达且已配置时 fail-closed）；不触发扫描、不写账、不拉起写者。",
  inputSchema: { type: "object", properties: { project_id: { type: "string", description: "注册表里的项目 id" } }, required: ["project_id"], additionalProperties: false },
  handler: async (args, ctx) => {
    const projectId = projectIdOf(args);
    if (projectId === "") return errorResult("read_sync_status 缺入参 project_id");
    try {
      const view = await hostSyncView(projectId, resolveDataDir(), ctx?.work);
      return textResult(JSON.stringify(view.report, null, 2));
    } catch (e) {
      return errorResult(e instanceof WorkError ? `${e.code}: ${e.message}` : `read_sync_status 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const registerSyncContractTool: McpTool = {
  name: "register_sync_contract",
  description:
    "写入：登记一个同步批次的**应同步清单**（契约）。限设计/协调职责（role 需 designer/coordinator），记 actor。契约闭键校验、来源哈希实核、同批次改内容拒、supersedes 不得减少旧必需项或把 blocks_entry 改 false。登记后 Agent 交付 `<batch_id>.evidence.json` 证据包，由扫描逐项核对。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      role: { type: "string", description: "调用方角色（同步契约登记限 designer/coordinator）" },
      contract: {
        description: "同步契约对象；严格客户端也可给 JSON 文本（文本通道额外做重复字段检查，含转义同名键）",
        anyOf: [{ type: "object" }, { type: "string" }],
      },
      change_id: { type: "string", description: "事件信封的变更批次（缺省 change-none）" },
    },
    required: ["project_id", "role", "contract"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const projectId = projectIdOf(args);
    const role = roleOf(args);
    if (projectId === "" || role === "") return errorResult("register_sync_contract 缺入参 project_id/role");
    const raw = args.contract;
    const contractText = typeof raw === "string" ? raw : undefined;
    let contract: unknown = raw;
    if (typeof raw === "string") {
      try {
        contract = JSON.parse(raw);
      } catch (e) {
        return errorResult(`register_sync_contract 的 contract 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      const dataDir = resolveDataDir();
      if (getProject(projectId, dataDir) === undefined) throw new WorkError("INVALID_COMMAND", `项目不存在: ${projectId}`, { project_id: projectId });
      const work = ctx?.work;
      if (work === undefined) throw new WorkError("SERVICE_UNAVAILABLE", "register_sync_contract 拿不到转接客户端（ctx.work）：v2 事实只有一个写入者", { tool: "register_sync_contract" });
      const changeId = typeof args.change_id === "string" && args.change_id.trim() !== "" ? args.change_id.trim() : "change-none";
      const batchId = typeof (contract as { batch_id?: unknown }).batch_id === "string" ? ((contract as { batch_id: string }).batch_id) : "";
      // 登记前**幂等短路**（只读预检，避免 expected_revision 变化造成的幂等键漂移）：
      // 同 batch 同内容 → 直接回报 duplicate（零新增事件）；同 batch 异内容 → 拒。
      const probe = buildRegisterContractCommand({ projectId, changeId, actorId: ctx?.clientName ?? role, role, contract, contractText, expectedRevision: null });
      const incomingSha = syncContractSha256(probe.payload as unknown as SyncContract);
      const existingSha = batchId === "" ? null : existingContractSha(projectId, dataDir, batchId);
      if (existingSha !== null) {
        if (existingSha === incomingSha) {
          // duplicate 短路也必须能**恢复真实登记截点**：断线后的调用者拿这个 seq 接着作，
          // 不用最新序号顶。取不到原事件就明确失败、零新增（不猜序号、不编 receipt）。
          const registration = findRegisteredContract(projectId, dataDir, batchId, incomingSha);
          if (registration === null) {
            return errorResult(`INVALID_COMMAND: 批次 ${batchId} 显示已登记（内容哈希一致），但在本项目事件账本里找不到对应的 sync.contract_registered 原始事件——不猜序号、零新增；请核实账本一致性后再试`);
          }
          return textResult(JSON.stringify({ ok: true, project_id: projectId, batch_id: batchId, contract_sha256: incomingSha, duplicate: true, registered_seq: registration.seq, registration, note: "同批次同内容：幂等短路，未新增事件。registered_seq 为**原登记**事件序号（取自真实账本，非当前 last_seq），可据此恢复登记截点" }, null, 2));
        }
        return errorResult(`INVALID_COMMAND: 批次 ${batchId} 已登记且内容不同——同 batch 改内容拒（要改范围用新批次并显式 supersedes）`);
      }
      const rev = batchId === "" ? 0 : syncEntityRevision(projectId, dataDir, batchId);
      const cmd = buildRegisterContractCommand({ projectId, changeId, actorId: ctx?.clientName ?? role, role, contract, contractText, expectedRevision: rev === 0 ? null : rev });
      const receipt = await work.submit(cmd);
      // registered_seq 与 duplicate 短路同口径（都是**本次登记事件**的真实序号；receipt 原样保留向后兼容）。
      return textResult(JSON.stringify({ ok: receipt.ok, project_id: projectId, batch_id: batchId, contract_sha256: syncContractSha256(cmd.payload as unknown as SyncContract), registered_seq: receipt.seq, duplicate: receipt.duplicate, receipt }, null, 2));
    } catch (e) {
      return errorResult(e instanceof WorkError ? `${e.code}: ${e.message}` : `register_sync_contract 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const scanSyncEvidenceTool: McpTool = {
  name: "scan_sync_evidence",
  description:
    "写入：请求**唯一写入服务宿主**扫描本项目的证据收件目录（.工作台/work/sync-inbox），逐项核对当前实际目标并向账本写 sync.evidence_checked。与后台自动发现共用同一逻辑与真正唯一写口；重复扫描零重复效果（稳定幂等键）。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      role: { type: "string", description: "调用方角色（缺省 coordinator）" },
    },
    required: ["project_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const projectId = projectIdOf(args);
    if (projectId === "") return errorResult("scan_sync_evidence 缺入参 project_id");
    const role = roleOf(args) || "coordinator";
    try {
      const work = ctx?.work;
      if (work === undefined) throw new WorkError("SERVICE_UNAVAILABLE", "scan_sync_evidence 拿不到转接客户端（ctx.work）：扫描只在唯一写服务宿主执行", { tool: "scan_sync_evidence" });
      const outcome = await work.scanSyncEvidence(projectId, { role });
      return textResult(JSON.stringify(outcome, null, 2));
    } catch (e) {
      return errorResult(e instanceof WorkError ? `${e.code}: ${e.message}` : `scan_sync_evidence 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/** 三个工具一并登记用 */
export const SYNC_EVIDENCE_TOOLS: readonly McpTool[] = [registerSyncContractTool, scanSyncEvidenceTool, readSyncStatusTool];
