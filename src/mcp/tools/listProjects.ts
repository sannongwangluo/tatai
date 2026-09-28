// list_projects：列出注册表里的全部项目（DESIGN.md §6.3 第一行，入参：无，返回：项目列表 id/name/path/kind）。
// 直接复用 src/server/registry.ts 读同一份 registry.json，证明 MCP 链路通。
import { listProjects } from "../../server/registry";
import { textResult, type McpTool } from "./types";

export const listProjectsTool: McpTool = {
  name: "list_projects",
  description: "列出塔台注册表里的全部项目（id/name/path/kind），用于选项目（DESIGN.md §6.3）",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: () => {
    const projects = listProjects().map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      kind: p.kind,
    }));
    return textResult(JSON.stringify({ projects }, null, 2));
  },
};
