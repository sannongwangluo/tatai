// append_discuss：追加一条待议记录（提疑权，DESIGN.md §3.5/§6.3 第七行）。
// ████ 硬性权限红线（§6.3）：只能追加，不能修改/删除已有待议条目 ████
// 本工具 inputSchema 只收 project_id + content；任何带 index/edit/delete 等意图的
// 额外字段都会被 additionalProperties:false 在入口拒绝，handler 再做一次显式拦截兜底。
import { appendDiscuss } from "../../server/workstation";
import { errorResult, textResult, type McpTool } from "./types";

/** 试图定位/改写已有条目的字段名：出现即拒绝（兜底，schema 层已挡） */
const FORBIDDEN_KEYS = ["index", "line", "edit", "delete", "remove", "replace", "update", "entry_id"];

export const appendDiscussTool: McpTool = {
  name: "append_discuss",
  description:
    "追加一条待议记录（提疑权，DESIGN.md §3.5）；只能追加新条目，任何修改/删除已有条目的入参形态都会被拒绝",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      content: { type: "string", description: "待议内容本体（日期前缀由数据层补，内部换行折叠为空格）" },
    },
    required: ["project_id", "content"],
    additionalProperties: false,
  },
  handler: (args) => {
    const offending = FORBIDDEN_KEYS.filter((k) => k in args);
    if (offending.length > 0) {
      return errorResult(
        `append_discuss 只能追加新条目，不接受修改/删除已有条目的入参字段: ${offending.join(", ")}（DESIGN.md §6.3 硬性权限）`,
      );
    }
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    const content = typeof args.content === "string" ? args.content : "";
    if (projectId === "" || content.trim() === "") {
      return errorResult("append_discuss 缺入参 project_id/content（content 不能为空）");
    }
    const receipt = appendDiscuss(projectId, content);
    return textResult(JSON.stringify(receipt, null, 2));
  },
};
