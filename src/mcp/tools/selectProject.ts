// select_project：按 project_id 或 path 选中项目（DESIGN.md §6.3 第二行，两种入参二选一）。
// 返回项目根目录 + `.工作台/` 路径；`.工作台/`（progress.json）不存在则按 G1 口径初始化（幂等），
// 并顺手刷新注册表 last_opened_at。path 入参只在注册表里解析，不接受未注册路径（防越权）。
//
// V06-10（§6.7「兼容原选项目接口」）：**入参与既有返回字段一字不改**（verify:m2/m5 守着），
// 只**追加**能力发现字段——本接口本身只是"仅可读取"，接续入口在 `project_entry`，
// 认领写口在 `claim_task`；且如实说明"MCP 提供工具不等于客户端必然主动调用"（§6.2）。
import path from "node:path";
import { getProject, listProjects, touchLastOpened } from "../../server/registry";
import { initWorkstation, workstationDir } from "../../server/workstation";
import { ENTRY_INTERFACE_NAMES, capabilityTiersOf } from "./projectEntry";
import { errorResult, textResult, type McpContext, type McpTool } from "./types";

export const selectProjectTool: McpTool = {
  name: "select_project",
  description:
    "选中一个项目：入参 project_id 或 path 二选一；返回项目根目录与 .工作台/ 路径（不存在则初始化）（DESIGN.md §6.3）。" +
    "本接口**只提供读取**（不返回下一动作）；接续入口是 project_entry（DESIGN.md §6.7）",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id（与 path 二选一）" },
      path: { type: "string", description: "项目根目录绝对路径（与 project_id 二选一，须已注册）" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx?: McpContext) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    const argPath = typeof args.path === "string" ? args.path.trim() : "";
    if ((projectId === "") === (argPath === "")) {
      return errorResult("select_project 入参 project_id 与 path 必须二选一（恰好给一个）");
    }
    let id = projectId;
    if (id === "") {
      const resolved = path.resolve(argPath);
      const found = listProjects().find((p) => path.resolve(p.path) === resolved);
      if (!found) {
        return errorResult(`路径未在塔台注册表中注册: ${argPath}`);
      }
      id = found.id;
    }
    const project = getProject(id);
    if (!project) {
      return errorResult(`项目不存在: ${id}`);
    }
    const created = initWorkstation(id);
    touchLastOpened(id);
    // 能力发现（§6.2）：本接口 = 仅可读取；接续/协调档位的实际可用性如实探测，不假称全自动
    const workAvailable = await probeWorkService(ctx);
    return textResult(
      JSON.stringify(
        {
          id: project.id,
          name: project.name,
          path: project.path,
          kind: project.kind,
          workstation_dir: workstationDir(id),
          workstation_initialized: created,
          capability: {
            interface: "select_project",
            class: "read_only",
            class_label: "仅可读取",
            note:
              "本接口只给项目根目录与 .工作台/ 路径（不返回下一动作、不认领）。" +
              "接续入口请调 project_entry；领取/回报见 claim_task / submit_task_result（DESIGN.md §6.7）",
            entry_interfaces: ENTRY_INTERFACE_NAMES,
            entry_requires_capability: "continuable",
            tiers: capabilityTiersOf(workAvailable),
            // 如实：暴露了工具 ≠ 客户端会主动调用（§6.2）
            caveat:
              "MCP 提供工具不等于客户端必然主动调用；实际能力档位（只读/可接续/可协调执行）要按接入端实测记录，待 V06-11 编成适配档案",
          },
        },
        null,
        2,
      ),
    );
  },
};

/** 探测 v2 唯一写入服务是否在线（只读探活；服务不在也照常返回，不当失败） */
async function probeWorkService(ctx?: McpContext): Promise<boolean> {
  try {
    const probe = ctx?.work?.probe();
    if (probe === undefined) return false;
    const result = await probe;
    return result.available === true;
  } catch {
    return false;
  }
}
