// ask_flash：把"读项目代码/文档并回答"的一次性问答**委托给塔台里的 Flash**
// （DESIGN.md §6.4，2026-09-19 主人拍板新增）。动机：贵模型（agent 侧）把读代码总结的
// 粗活外包给便宜的 Flash——省钱且可并行；速度预期如实：Flash 带工具按需读，是分钟级不是秒级。
//
// 口径（与聊天页签同一份，不另起行为档案）：
//   · 背景：buildChatContext 现读项目实时快照（设计书/进度/Gate/动作流/架构，§3.6）；
//   · 七只手：list_files / read_file / read_files / search_code / get_arch / write_arch / check_arch
//     （与聊天同一清单；write_arch 只写补全层这一个文件，§3.2 红线不变；check_arch 只读对账）；
//   · 不落盘：回答**不写进任何会话 jsonl**（聊天记录属于聊天页签的会话，agent 委托的
//     一次性问答不是会话）；工具轮次同样只在本次调用内存活；
//   · full_coverage（2026-09-19 主人拍板，交接简报场景）：服务器机械对账——清单减实读，
//     没读齐自动点名续读、读齐才收工，回答末尾附对账回执；「读没读全」不靠模型自觉；
//   · 超时预期：会真调工具读代码，几十秒正常——MCP 客户端超时给足。
import fs from "node:fs";
import { buildChatContext } from "../../server/chatContext";
import { runChatTurn, type ChatTurnReceipt } from "../../server/chatTurn";
import { DEFAULT_MODEL, type FlashRoundMessage } from "../../server/flash";
import { safeResolve } from "../../server/chatTools";
import { getProject } from "../../server/registry";
import { errorResult, textResult, type McpTool } from "./types";

export const askFlashTool: McpTool = {
  name: "ask_flash",
  description:
    "把一个需要读项目代码/文档才能回答的问题委托给塔台里的 Flash：它带项目实时上下文包（项目简报/施工图任务与生效基线/" +
    "设计书按需分段）与七只工具" +
    "（列文件清单/读文件/批量读/搜代码/看架构图/补全架构图/架构对账）自行查证后作答。适合让便宜模型干读代码总结的粗活、" +
    "贵模型拿结论；要交接简报/读全量代码时传 full_coverage=true——服务器按**真实取回的行/字节范围**对账" +
    "（请求过不算读到、读一段不算读完、截断/失败/二进制排除都不计已读），没读齐自动点名续读，" +
    "回答带覆盖声明与对账回执，返回值里另附同一份结构化 coverage。会真调工具读代码，耗时几十秒正常。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "注册表里的项目 id" },
      question: { type: "string", description: "要 Flash 查证回答的问题（它会自己读文件，问题写清要什么）" },
      full_coverage: {
        type: "boolean",
        description:
          "开覆盖对账（要交接简报/读全量代码时建议开）：服务器机械核验清单里的文件是否真被读到（按实际取回范围），" +
          "没读齐自动点名续读，回答末尾附对账回执、返回值附同一份 coverage——「读没读全」由机器保证，不靠模型自觉",
      },
      coverage_scope: {
        type: "array",
        items: { type: "string" },
        description:
          "覆盖对账的范围（相对项目根的目录列表，如 [\"src\",\"docs\",\"tests\",\"scripts\"]，不传=整个项目根）。" +
          "项目根混着备份/归档垃圾时务必传——对账只对范围内的文件算「读全」，回执写明范围、范围外未计入",
      },
    },
    required: ["project_id", "question"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (projectId === "" || question === "") {
      return errorResult("ask_flash 缺入参 project_id / question");
    }
    const fullCoverage = args.full_coverage === true;
    // coverage_scope 预校验：目录不存在/越界直接报错——不静默缩范围假装读全（拼路径红线同款）
    const scopeList = Array.isArray(args.coverage_scope)
      ? args.coverage_scope.filter((s): s is string => typeof s === "string" && s.trim() !== "")
      : [];
    if (scopeList.length > 0) {
      const project = getProject(projectId);
      if (!project) return errorResult(`项目不存在: ${projectId}`);
      for (const s of scopeList) {
        const abs = safeResolve(project.path, s);
        let isDir = false;
        try {
          isDir = abs !== null && fs.statSync(abs).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          return errorResult(`coverage_scope 含无效目录：${s}（须是项目根内存在的目录）`);
        }
      }
    }
    // 与聊天页签同一份背景 + 同一个工具循环（chatTurn），只有"不落盘"这一处差别；
    // full_coverage 时加注读全指引（覆盖声明/出处标注），对账本身在 chatTurn 里机械执行
    const toolMessages: FlashRoundMessage[] = [
      { role: "system", content: buildChatContext(projectId) },
      {
        role: "user",
        content:
          `${question}\n\n（本次是一次性委托问答：直接查证作答，不需要寒暄；结论里注明依据来自哪些文件。）` +
          (fullCoverage
            ? "\n（覆盖对账已启用：先用 list_files 拿清单，再用 read_files 分批把清单文件全部读完再回答；" +
              "最终回答开头写明「基于 N 个文件」的覆盖声明，关键结论标注来源文件路径；没读完会被点名续读。" +
              (scopeList.length > 0 ? `本次对账范围限定在：${scopeList.join("、")}——列这些目录的清单并读全。）` : "）")
            : ""),
      },
    ];
    let answer = "";
    const toolsUsed: string[] = [];
    // V06-04：覆盖对账改用 `work/context.ts` 的同一份账本（只认真实取回的范围）——
    // 真失败/截断/未读不再算已读；回执既进回答正文（模型与用户看），也进本工具的结构化返回值
    // （调用方/审计脚本按同一份数对账，口径只有一份，不靠模型自述）
    let receipt: ChatTurnReceipt | null = null;
    try {
      for await (const ev of runChatTurn(projectId, toolMessages, {
        model: DEFAULT_MODEL,
        ...(fullCoverage ? { fullCoverage: true } : {}),
        ...(scopeList.length > 0 ? { coverageScope: scopeList } : {}),
        onReceipt: (r) => {
          receipt = r;
        },
      })) {
        if (ev.type === "delta") answer += ev.text;
        else toolsUsed.push(`${ev.name}：${ev.summary}`);
      }
    } catch (e) {
      return errorResult(`ask_flash 执行失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return textResult(
      JSON.stringify(
        {
          answer,
          tools_used: toolsUsed,
          coverage: receipt === null ? null : (receipt as ChatTurnReceipt).coverage,
        },
        null,
        2,
      ),
    );
  },
};
