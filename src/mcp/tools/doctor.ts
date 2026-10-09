// doctor：接续入口的一探体检（PLAN V07-04；DESIGN 附录 C.5-4）。
//
// 为什么要有这一件：换会话/换模型接手时，最贵的不是"写代码"而是"先摸清哪一环是坏的"——
// 写服务没起、描述符指着死进程、基线早就失效、项目根本没迁到 v2、事件面有缺口，
// 这五种现场此前要分别读日志、试写入、翻盘上文件才能分辨。这里一次调用全部摊开，各自报因。
//
// **只读是默认**：默认只探活（probe + pid 存活判定），不杀进程、不撤描述符、不拉起 daemon、
// 不写任何事实。只有调用方显式给 heal=true 才走 V07-01 的自愈逻辑（清死描述符 → 按需拉起）再复探
// ——诊断工具不该自己动手改现场，除非人/agent 明确要求。
import fs from "node:fs";
import path from "node:path";
import { getProject, listProjects, resolveDataDir } from "../../server/registry";
import { nowIso } from "../../server/time";
import { activeBaseline, baselinesPath, loadDocument, type ProjectBaseline } from "../../server/work/documents";
import { baselineRevalidateOf } from "../../server/work/entry";
import { checkEventSurface, type SurfaceCheckResult } from "../../server/work/eventSurface";
import { isMigratedProject, latestBackupId, tasksFileOf } from "../../server/work/migrate";
import {
  WORK_TOKEN_HEADER,
  WorkServiceClient,
  descriptorPidAlive,
  readServiceDescriptor,
  serviceDescriptorPath,
  type WorkServiceDescriptor,
} from "../../server/work/service";
import { projectWorkDir } from "../../server/workstation";
import { compareBuildIdentities, resolveBuildIdentity, type BuildIdentity } from "../../shared/buildIdentity";
import { errorResult, textResult, type McpTool } from "./types";

/** 探活超时：体检要快，等 5s 才报"服务不可达"对"接手即摸底"没有意义 */
const PROBE_TIMEOUT_MS = 2500;

interface Section {
  ok: boolean | null;
  problems: string[];
}

/** 描述符新鲜度：在场/指向哪个地址/那个进程还活着吗（判据与自愈清理同一份） */
function descriptorReport(dataDir: string, desc: WorkServiceDescriptor | null): Record<string, unknown> & Section {
  const file = serviceDescriptorPath(dataDir);
  if (desc === null) {
    return {
      ok: null,
      present: false,
      path: file,
      problems: [],
      note: "数据目录里没有服务描述符：要么写入服务从未启动，要么已优雅退出并撤掉（这时按需拉起那条链会自己拉起）",
    };
  }
  const alive = descriptorPidAlive(desc);
  const startedMs = desc.started_at === undefined ? Number.NaN : Date.parse(desc.started_at);
  return {
    ok: alive,
    present: true,
    path: file,
    host: desc.host,
    port: desc.port,
    pid: desc.pid,
    url: desc.url,
    started_at: desc.started_at,
    age_seconds: Number.isNaN(startedMs) ? null : Math.max(0, Math.round((Date.now() - startedMs) / 1000)),
    pid_alive: alive,
    stale: !alive,
    problems: alive
      ? []
      : [
          `描述符陈旧：pid ${desc.pid} 已退出（端口 ${desc.host}:${desc.port} 不会有人应答）。` +
            "V07-01 自愈会清掉这个死指针并重新拉起独立写入服务；doctor 默认只报不动手（heal=true 才做）",
        ],
    note: alive ? null : "陈旧指针",
  };
}

/** 未知身份（P0/V09-45 §4.1）：读不到就如实 unknown + 原因，**绝不**猜成"一致"。 */
function unknownIdentity(reason: string): BuildIdentity {
  return { schema_version: 1, component: "server", embedded: false, reason };
}

/**
 * P0/V09-45（§4.6）：经**宿主 `/api/work/health`** 读回唯一写服务的构建身份（server 部件）。
 * 只读、有界、**不**自愈/不拉起（doctor 默认只读）；读不到就写 unknown 与原因。
 * 注意：这里回的是**宿主进程**的身份，不是本 MCP 进程的——两者可能不同批（正因如此才要对照）。
 */
async function hostBuildIdentity(desc: WorkServiceDescriptor | null, timeoutMs: number): Promise<BuildIdentity> {
  if (desc === null) return unknownIdentity("数据目录里没有服务描述符：读不到宿主构建身份");
  try {
    const res = await fetch(`http://${desc.host}:${desc.port}/api/work/health`, {
      headers: { [WORK_TOKEN_HEADER]: desc.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return unknownIdentity(`宿主 /api/work/health 返回 HTTP ${res.status}：读不到宿主构建身份`);
    const body = (await res.json().catch(() => null)) as { build_identity?: unknown } | null;
    const bi = body?.build_identity;
    if (bi === undefined || bi === null || typeof bi !== "object" || (bi as { embedded?: unknown }).embedded !== true) {
      return unknownIdentity("宿主未回内嵌构建身份（旧宿主或源码直跑）：按未知处理，不判一致");
    }
    return bi as BuildIdentity;
  } catch (e) {
    return unknownIdentity(`读宿主构建身份失败：${e instanceof Error ? e.message : String(e)}`);
  }
}/** 基线有效性（§2.9/§5.6）：生效基线 + 两份源图纸是否在激活后变过——判据与项目入口同一份 */
function baselineReport(projectId: string, dataDir: string): Record<string, unknown> & Section {
  const problems: string[] = [];
  let baseline: ProjectBaseline | null = null;
  try {
    baseline = activeBaseline(projectId, dataDir);
  } catch (e) {
    problems.push(`基线流水不可读（${baselinesPath(projectId, dataDir)}）：${e instanceof Error ? e.message : String(e)}`);
  }
  let designSha: string | null = null;
  let planSha: string | null = null;
  let planDefSha: string | null = null;
  try {
    const design = loadDocument(projectId, "design", dataDir);
    designSha = design === null ? null : design.revision.content_sha256;
  } catch (e) {
    problems.push(`设计书读不出来：${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const plan = loadDocument(projectId, "plan", dataDir);
    planSha = plan === null ? null : plan.revision.content_sha256;
    planDefSha = plan === null ? null : plan.revision.definition_sha256;
  } catch (e) {
    problems.push(`施工图读不出来：${e instanceof Error ? e.message : String(e)}`);
  }
  const health = baselineRevalidateOf(baseline, {
    design_revision: designSha,
    plan_revision: planSha,
    plan_definition_revision: planDefSha,
  });
  problems.push(...health.messages);
  return {
    ok: baseline !== null && !health.source_changed,
    active:
      baseline === null
        ? null
        : {
            baseline_id: baseline.baseline_id,
            active_at: baseline.active_at,
            approved_by: baseline.approved_by,
            approval_kind: baseline.approval_kind,
            design_revision: baseline.design_revision.content_sha256,
            plan_revision: baseline.plan_revision.content_sha256,
          },
    current_source: { design_revision: designSha, plan_revision: planSha },
    source_changed_since_baseline: health.source_changed,
    revalidate: health.messages,
    log: baselinesPath(projectId, dataDir),
    problems,
  };
}

/** 迁移状态：v1 台账还是 v2 事件流当家（迁移本身要显式授权，doctor 不代声明、不动数据） */
function migrationReport(projectId: string, dataDir: string): Record<string, unknown> & Section {
  const workDir = projectWorkDir(projectId, dataDir);
  const eventsFile = path.join(workDir, "events.jsonl");
  // 判据复用 migrate.ts 自己的两份只读事实，不在这里重新定义"什么叫迁移过"
  const migrated = isMigratedProject(projectId, dataDir);
  const backupId = latestBackupId(projectId, dataDir);
  const problems: string[] = [];
  if (!migrated) {
    problems.push(
      "项目未迁移到 v2：没有任何已提交事件（.工作台/work/events.jsonl 不在场）——" +
        "现在读的是 v1 台账、写走 v1 通道。迁移是显式授权的动作（隔离夹具 isolated:true / 真实项目 real:{authorized_by,basis}），" +
        "doctor 不代声明、不改数据",
    );
  } else if (backupId === null) {
    problems.push("已迁移但没有迁移备份目录：回滚不可用（备份是被引用的证据，不清理）");
  }
  return {
    ok: migrated && backupId !== null,
    migrated,
    v1_tasks_file_present: fs.existsSync(tasksFileOf(projectId, dataDir)),
    events_file_present: fs.existsSync(eventsFile),
    work_dir: workDir,
    latest_backup_id: backupId,
    problems,
  };
}

/** 事件面缺口（唯一事实源在 src/server/work/eventSurface.ts，CLI 与 doctor 读同一份） */
function eventSurfaceReport(surface: SurfaceCheckResult): Record<string, unknown> & Section {
  return {
    ok: surface.ok,
    registered: surface.covered,
    tool_surfaces: surface.toolSurfaces.length,
    problems: surface.problems,
  };
}

/** doctor 的可注入判据（验证脚本用它造"事件面缺口"现场；产品路径一律走真实检查器） */
export interface DoctorDeps {
  checkEventSurface?: () => SurfaceCheckResult;
}

export function createDoctorTool(deps: DoctorDeps = {}): McpTool {
  const surfaceCheck = deps.checkEventSurface ?? (() => checkEventSurface());
  return {
    name: "doctor",
    description:
      "接续入口体检（DESIGN 附录 C.5-4）：一次调用报写服务探活／描述符新鲜度／基线有效性／迁移状态／事件面缺口，各自给报因。" +
      "默认只读（只探活，不杀进程、不撤描述符、不拉起服务、不写事实）；heal=true 才按 V07-01 自愈逻辑清理死描述符并拉起写入服务再复探。" +
      "给 project_id 才有基线与迁移两项（它们是项目自己的事实）",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "注册表里的项目 id（省略则跳过基线与迁移两项）" },
        heal: { type: "boolean", description: "true = 探活不可用时执行 V07-01 自愈（清死描述符/按需拉起）再复探；默认 false 只读" },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const dataDir = resolveDataDir();
      const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
      const heal = args.heal === true;
      if (projectId !== "" && getProject(projectId, dataDir) === undefined) {
        const known = listProjects(dataDir).map((p) => p.id);
        return errorResult(
          JSON.stringify(
            { ok: false, code: "INVALID_COMMAND", message: `项目不存在: ${projectId}`, detail: { known_projects: known } },
            null,
            2,
          ),
        );
      }

      const client = new WorkServiceClient({ dataDir, timeoutMs: PROBE_TIMEOUT_MS });
      const probed = await client.probe();
      let availability = probed;
      let healReport: Record<string, unknown> = {
        requested: heal,
        attempted: false,
        note: heal ? "探活已可用，无需自愈" : "只读探活（未请求自愈）",
      };
      if (heal && !probed.available) {
        const healed = await client.ensureWorkService();
        availability = await client.probe();
        healReport = {
          requested: true,
          attempted: true,
          available_after: availability.available,
          descriptor_after:
            healed === null ? null : { pid: healed.pid, host: healed.host, port: healed.port, url: healed.url },
          note: availability.available
            ? "已按 V07-01 自愈：清陈旧描述符／按需拉起独立写入服务后复探通过"
            : "自愈未成功（拉起失败或拉起后仍探不通）——见 service.problems",
        };
      }
      const descriptor = descriptorReport(dataDir, readServiceDescriptor(dataDir));
      const serviceProblems: string[] = [...descriptor.problems];
      if (!availability.available) {
        serviceProblems.unshift(`写入服务不可达：${availability.reason ?? "未知原因"}`);
      }
      // P0/V09-45（Codex 纠正 4）：doctor 要**同时**报出本 MCP 进程自身加载的身份与宿主身份——
      // 只报宿主会把"只换了磁盘、旧 MCP 进程仍是旧版"这一 P0 原问题漏掉。两者做偏斜三态比较，
      // **任一侧未内嵌一律 unknown，不判一致**（判据唯一来源 src/shared/buildIdentity.ts）。
      const mcpIdentity = resolveBuildIdentity("server");
      const hostIdentity = await hostBuildIdentity(availability.descriptor, PROBE_TIMEOUT_MS);
      const identitySkew = compareBuildIdentities(mcpIdentity, hostIdentity);
      const service: Record<string, unknown> & Section = {
        ok: availability.available && descriptor.ok !== false,
        reachable: availability.available,
        reason: availability.reason,
        probe_timeout_ms: PROBE_TIMEOUT_MS,
        data_dir: dataDir,
        heal: healReport,
        descriptor,
        // 本进程（MCP）自身身份：取自编译期内联常量；tsx 直跑/旧包 ⇒ unknown。
        build_identity: mcpIdentity,
        // 宿主（唯一写服务）身份：经 /api/work/health 只读回读。
        host_build_identity: hostIdentity,
        // MCP↔宿主偏斜三态：unknown 不算一致（UI 侧的 ui↔宿主比较由界面诊断负责）。
        build_identity_skew: identitySkew,
        problems: serviceProblems,
      };

      const baseline: Record<string, unknown> & Section =
        projectId === ""
          ? { ok: null, problems: [], skipped: "未给 project_id：基线是项目自己的事实，不猜项目" }
          : baselineReport(projectId, dataDir);
      const migration: Record<string, unknown> & Section =
        projectId === ""
          ? { ok: null, problems: [], skipped: "未给 project_id：迁移状态是项目自己的事实，不猜项目" }
          : migrationReport(projectId, dataDir);
      const eventSurface = eventSurfaceReport(surfaceCheck());

      const sections: [string, Record<string, unknown> & Section][] = [
        ["service", service],
        ["baseline", baseline],
        ["migration", migration],
        ["event_surface", eventSurface],
      ];
      const problems = sections.flatMap(([name, s]) => s.problems.map((p) => `${name}: ${p}`));
      const checked = sections.filter(([, s]) => s.ok !== null);
      const ok = checked.every(([, s]) => s.ok === true);
      return textResult(
        JSON.stringify(
          {
            ok,
            data_dir: dataDir,
            generated_at: nowIso(),
            project_id: projectId === "" ? null : projectId,
            service,
            baseline,
            migration,
            event_surface: eventSurface,
            problems,
          },
          null,
          2,
        ),
      );
    },
  };
}

/** 注册表登记用（默认真实判据；验证脚本用 createDoctorTool 注入破坏性现场） */
export const doctorTool: McpTool = createDoctorTool();
