// 2026-09-19 试用增强（主人拍板"都要做全"）：聊天工具调用循环抽成共享件。
// 原来这段循环长在 index.ts 聊天路由里（SSE 写盘与循环逻辑缠在一起）；MCP ask_flash
// （§6.4，同日拍板）需要**同一个循环**给 agent 用——两处各抄一份必然跑偏，抽到这里：
//   · HTTP 聊天路由：消费事件 → SSE（delta/tool 事件照旧，落盘口径不变）
//   · MCP ask_flash：消费事件 → 拼一次性回答（不落任何会话 jsonl）
// 事件流不携带任何持久化副作用——落盘/不落盘由**调用方**决定，本模块只跑模型与工具。
// 同日试用反馈补：输出被 max_tokens 截断（finish_reason=length）时自动断点续写——
// 续写指令与次数上限与 chatWithContinue 共用 flash.ts 里同一份常量，不另起口径。
// 2026-09-19 试用反馈（简报覆盖对账，主人拍板）：ask_flash 开 full_coverage 时，服务器
// 机械记录 read_file/read_files 点过的路径，终答前与文件清单做差集——没读齐自动点名续读、
// 读齐/续满都在回答末尾附「覆盖对账」回执。「读没读全」由服务器数出来，不靠模型自觉；
// 聊天页签暂不启用（聊天有自己的「继续」口径）。
//
// 2026-09-20 V06-04（PLAN.md，DESIGN.md §2.8 / §3.6）：上面那条"点过的路径"记账是错的——
// **请求过 ≠ 读到**：批量读里被总量上限跳过的、不存在的、二进制的、只读到前 48000 字的文件
// 全被算成"已读"。现在改为 `work/context.ts#CoverageLedger`：只认工具回执
// （`chatTools.ReadReceipt`）里**真实返回的行/字节范围**，被截断的算"只读到一部分"，
// 失败/未读/二进制排除一律不计入已覆盖，且回执逐条说明原因（不缩小清单、不跳过 tests、
// 不隐藏二进制排除）。同一份账本也供 `ask_flash` 的 full_coverage 用。
// 另外：模型被轮次上限、超时或错误打断时，服务器把"已确认来源 + 续接位置"落成检查点
// （`.工作台/work/context-resume.json`），下一轮进场时由服务器注入续接指令——
// §3.6 的"发「继续」接着干、已读不重读"从此不依赖模型自觉。
import path from "node:path";
import { CHAT_TOOLS, collectFiles, executeChatTool } from "./chatTools";
import { getProject } from "./registry";
import {
  buildContextPackage,
  buildResumeCheckpoint,
  clearCheckpoint,
  CoverageLedger,
  formatCoverageReceipt,
  loadCheckpoint,
  resolveCheckpoint,
  saveCheckpoint,
  type CoverageSummary,
  type ResumeCheckpoint,
} from "./work/context";
import {
  chatStreamEvents,
  CONTINUE_MAX,
  CONTINUE_PROMPT,
  TRUNCATED_TAIL,
  type FlashRoundMessage,
} from "./flash";

/** 工具调用循环上限：防模型无限套娃（每轮还能并点最多 5 只手，见 TOOL_CALLS_PER_ROUND）。
 *  2026-09-19 试用反馈 8→20：让 Flash 通读大项目全量代码再补设计书，8 轮不够烧（实测
 *  在「读全量代码」任务中途撞顶，回答只剩半截）；每条用户消息重置预算，20 轮仍封顶防失控。 */
const TOOL_MAX_ROUNDS = 20;
/** full_coverage 时的总轮次帽：读全量代码要「先探索再读全」，20 轮不够烧——实测第二大脑
 *  193 个真文件：模型自然流程烧约 10 轮 + 对账续读约 10 轮即撞 20 帽，还剩 82 个没读齐；
 *  提到 30 仍封顶防失控。聊天页签不启用 full_coverage，帽仍是 20。 */
const COVERAGE_TOOL_MAX_ROUNDS = 30;
const TOOL_CALLS_PER_ROUND = 5;
/** 覆盖对账（fullCoverage）：清单没读齐时自动点名续读的轮数上限——每轮最多还能并点
 *  5 只手 × 每手 10 文件；实测大文件项目每轮只能推进约 15 个（整批 9.6 万字上限卡着），
 *  约 200 个真文件的 scopes 要 10 轮级兜底（总轮次仍受 TOOL_MAX_ROUNDS=20 封顶）；
 *  续满仍没读齐就如实列未读，不静默漏。 */
const COVERAGE_MAX_ROUNDS = 10;
/** 覆盖对账的清单上限（与 list_files 的 400 截断解耦：对账要尽量全，超上限如实注明截断） */
const COVERAGE_MANIFEST_MAX_FILES = 2000;
/** 覆盖对账回执/续读指令里最多点名的路径条数（防超大差集把消息打成小作文） */
const COVERAGE_LIST_MAX_PATHS = 60;
/** 覆盖对账不计入的扩展名：这些文件 read_file 本来就拒读（二进制），要求「读过」纯属
 *  浪费批次——按扩展名排除并在回执写明数量（声明的边界不算偏差）。read_file 本体的
 *  二进制判定仍按内容（NUL），此处只是对账清单口径，不影响 list_files 照常列出。 */
const COVERAGE_SKIP_EXT = new Set([
  ".db",
  ".sqlite",
  ".sqlite3",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".7z",
  ".exe",
  ".dll",
  ".bin",
  ".onnx",
  ".gguf",
  ".wav",
  ".mp3",
  ".mp4",
]);

/** 一轮聊天里往外吐的事件：delta=正文增量；tool=一次工具调用（给前端"正在查项目"提示/审计留痕用） */
export type ChatTurnEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; summary: string };

/** 一轮跑完的真实回执（ask_flash 把它写进返回值；HTTP 聊天路由按需取用） */
export interface ChatTurnReceipt {
  project_id: string;
  /** 产生回执的上下文包（中断时非空） */
  package_id: string | null;
  tool_rounds_used: number;
  /** true = 这一轮被打断（轮次上限/模型错误），已留检查点 */
  interrupted: boolean;
  checkpoint: ResumeCheckpoint | null;
  coverage: CoverageSummary | null;
  confirmed_sources: { path: string; content_sha256: string; complete: boolean }[];
}

/**
 * 跑一轮"带工具的聊天"：toolMessages 由调用方备好（system 背景 + 历史已在内），
 * 循环直到模型给出纯文本终答或轮次耗尽。完整正文由调用方自己累计 delta 得到——
 * 这样模型中途抛错时，调用方（HTTP 路由）手里的半截文本不丢（Q34 失败留痕要用）。
 * 轮次耗尽：补一句如实提示当终答（与原路由行为逐字一致），并留下检查点（§2.8）。
 * 截断续写：某轮纯文本收尾且 finish_reason=length 时，把已出的半截当 assistant 行、
 * 追加续写指令再要一段（最多 CONTINUE_MAX 次，delta 照常往外流，用户看到的是连贯全文）；
 * 续满仍截断则末尾如实标记。续写指令只进当次请求循环，不落任何盘。
 * opts.maxTokens 平时不动（flash.ts 默认 8192），只给验证脚本强制小上限制造截断用。
 * opts.baseURL / opts.maxToolRounds 同为验证钩子（把模型指向可控夹具、把轮次帽收小），
 * 产品路径不传。opts.onReceipt 在一轮结束时给调用方一份机器可读回执（覆盖摘要 + 检查点）。
 * opts.fullCoverage（ask_flash 交接简报场景）：覆盖对账——终答前服务器拿文件清单（与
 * list_files 同源收集）减去**真读到的范围**，差集非空自动点名续读（COVERAGE_MAX_ROUNDS 上限），
 * 读齐/续满都在回答末尾附对账回执；未读文件如实列出，不静默漏。
 * opts.coverageScope：对账范围（相对项目根的目录列表，由 ask_flash 侧预先校验存在）——
 * 项目根混着审计备份/归档垃圾时（如实测第二大脑 _briefs/ 约 1700 个备份文件），全根对账
 * 永远读不齐；范围口径让「全量」指真代码，回执写明范围、范围外明示未计入。
 */
export async function* runChatTurn(
  projectId: string,
  toolMessages: FlashRoundMessage[],
  opts: {
    model: string;
    temperature?: number;
    maxTokens?: number;
    /** 思考档透传（2026-09-19 服务端口径：显式 effort 会强制开思考、与 id 无关）；不传走 flash.ts 默认 high */
    reasoningEffort?: "high" | "medium" | "low" | "";
    fullCoverage?: boolean;
    coverageScope?: string[];
    /** 验证钩子：模型基址（默认走 flash.ts 的配置发现） */
    baseURL?: string;
    /** 验证钩子：工具轮次上限（默认 20 / full_coverage 30） */
    maxToolRounds?: number;
    onReceipt?: (receipt: ChatTurnReceipt) => void;
    /**
     * V06-07：每次工具调用的真实回执回调（"工具动作与结果关联持久化"用）。
     * 不传时行为与本卡之前逐字相同——本钩子只把**已经发生的**回执递出去，不改变工具行为。
     */
    onToolResult?: (r: { name: string; summary: string; writes: { path: string; affected_ids: string[] }[] }) => void;
  },
): AsyncGenerator<ChatTurnEvent, void, void> {
  let toolRoundsUsed = 0;
  let continuationsUsed = 0;
  // ── 覆盖账本（V06-04）：只记**真实取回的范围**，请求本身不产生"已覆盖" ──
  const ledger = new CoverageLedger();
  let coverageRoundsUsed = 0;
  const roundCeiling = opts.maxToolRounds ?? (opts.fullCoverage ? COVERAGE_TOOL_MAX_ROUNDS : TOOL_MAX_ROUNDS);
  let manifestState: { files: string[]; truncated: boolean; skippedBinary: number } | null | undefined;
  const getManifest = (): { files: string[]; truncated: boolean; skippedBinary: number } | null => {
    if (manifestState !== undefined) return manifestState;
    const project = getProject(projectId);
    if (!project) return null;
    const scopes = (opts.coverageScope ?? []).filter((s) => typeof s === "string" && s.trim() !== "");
    let collected: { files: string[]; truncated: boolean };
    if (scopes.length === 0) {
      collected = collectFiles(project.path, "", COVERAGE_MANIFEST_MAX_FILES);
    } else {
      // 范围口径：多个目录的并集（去重排序保持确定性）；目录有效性由 ask_flash 侧先校验
      const files = new Set<string>();
      let truncated = false;
      for (const rel of scopes) {
        const r = collectFiles(project.path, rel, COVERAGE_MANIFEST_MAX_FILES);
        for (const f of r.files) files.add(f);
        truncated = truncated || r.truncated;
      }
      collected = { files: [...files].sort(), truncated };
    }
    const keep = collected.files.filter((f) => !COVERAGE_SKIP_EXT.has(path.extname(f).toLowerCase()));
    const skipped = collected.files.filter((f) => COVERAGE_SKIP_EXT.has(path.extname(f).toLowerCase()));
    manifestState = { files: keep, truncated: collected.truncated, skippedBinary: skipped.length };
    // 账本与清单同源：清单被上限截断、二进制按扩展名排除，都要在账本里如实登记
    ledger.setManifest(keep, { truncated: collected.truncated, binaryExcluded: skipped });
    return manifestState;
  };
  const unreadFiles = (): string[] | null => {
    // 清单按需现算（与 list_files 同源收集），算完即登记进账本
    const m = getManifest();
    return m === null ? null : ledger.unread();
  };
  const coverageReport = (): string => {
    const m = getManifest();
    if (!m) return "";
    const scopes = (opts.coverageScope ?? []).filter((s) => typeof s === "string" && s.trim() !== "");
    // 范围口径要写进回执：范围外的文件**未计入对账**——声明的边界不算偏差，不写才是
    const scopeNote = scopes.length > 0 ? `对账范围：${scopes.join("、")}（范围外文件未计入对账）\n` : "";
    if (ledger.hasManifest()) return formatCoverageReceipt(ledger.summary(), scopeNote);
    return formatCoverageReceipt(
      {
        manifest_files: m.files.length,
        fully_read: 0,
        partial: 0,
        failed: 0,
        never_read: m.files.length,
        binary_excluded: m.skippedBinary,
        list_truncated: m.truncated,
        covered_chars: 0,
        total_chars: 0,
        omitted: [],
        confirmed: [],
      },
      scopeNote,
    );
  };

  // ── 中断续接（V06-04）：上一轮留下的检查点先消化——已确认来源不重读、已变质的来源作废 ──
  let resumeNote: string | null = null;
  const pendingCheckpoint = loadCheckpoint(projectId);
  if (pendingCheckpoint !== null) {
    try {
      const resolution = resolveCheckpoint(pendingCheckpoint, projectId);
      ledger.seedConfirmed(resolution.confirmed_sources);
      resumeNote = resolution.text;
    } catch {
      resumeNote = null; // 项目读不到等：不注入，不把一个辅助机制变成阻断
    }
  }
  if (resumeNote !== null) {
    // 插在历史之前（紧跟 system 背景）：模型先看到中断现场，再看到本轮的问题
    toolMessages.splice(Math.min(1, toolMessages.length), 0, { role: "user", content: resumeNote });
  }

  let interrupted: { reason: ResumeCheckpoint["reason"]; detail: string } | null = null;
  let lastCheckpoint: ResumeCheckpoint | null = null;

  /** 造并落检查点（只保留**真读到**的来源）；失败只记 null，不把辅助机制变成阻断 */
  const makeCheckpoint = (reason: ResumeCheckpoint["reason"], detail: string): ResumeCheckpoint | null => {
    try {
      const pkg = buildContextPackage(projectId, { ledger });
      const cp = buildResumeCheckpoint(pkg, ledger, { reason, detail });
      saveCheckpoint(projectId, cp);
      return cp;
    } catch {
      return null;
    }
  };

  try {
    for (;;) {
      let pending: { id: string; name: string; arguments: string }[] = [];
      let finishReason: string | null = null;
      let roundText = "";
      for await (const ev of chatStreamEvents(toolMessages, {
        model: opts.model,
        tools: CHAT_TOOLS,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      })) {
        if (ev.type === "delta") {
          roundText += ev.text;
          yield { type: "delta", text: ev.text };
        } else if (ev.type === "tool_calls") {
          pending = ev.calls;
        } else {
          finishReason = ev.reason;
        }
      }
      if (pending.length > 0) {
        toolRoundsUsed++;
        if (toolRoundsUsed >= roundCeiling) {
          // 轮次用尽还没终答：把已流出的文本当终答收尾（不追打），如实提示＋告诉用户怎么接着干
          yield {
            type: "delta",
            text: "\n\n（已达本轮工具调用上限，以上为目前收到的回答；发一句「继续」我从这里接着干，已读过的不会重读。）",
          };
          interrupted = {
            reason: "tool_rounds_exhausted",
            detail: `工具轮次上限 ${roundCeiling} 用尽（已跑 ${toolRoundsUsed} 轮）`,
          };
          if (opts.fullCoverage) {
            const unread = unreadFiles();
            if (unread !== null && unread.length > 0) yield { type: "delta", text: coverageReport() };
          }
          break;
        }
        toolMessages.push({
          role: "assistant",
          content: null,
          tool_calls: pending.slice(0, TOOL_CALLS_PER_ROUND).map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        });
        for (const call of pending.slice(0, TOOL_CALLS_PER_ROUND)) {
          const { result, summary, reads, writes } = executeChatTool(projectId, call.name, call.arguments);
          // 覆盖账本：先记"点过"，再按**真实回执**记结果——只有真取到的范围才算已覆盖
          for (const r of reads ?? []) {
            ledger.noteRequest(r.path);
            ledger.noteReceipt(r);
          }
          // V06-07：把这次工具调用的真实回执递给调用方（缺省不传 = 行为不变）
          opts.onToolResult?.({ name: call.name, summary, writes: writes ?? [] });
          // 工具活动事件：HTTP 侧当前端当"正在查项目…"动态行；不落盘
          yield { type: "tool", name: call.name, summary };
          toolMessages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        continue;
      }
      // 纯文本收尾：被截断且还有续写预算 → 接着要；续满仍截断 → 如实标记后收工
      if (finishReason === "length" && continuationsUsed < CONTINUE_MAX) {
        continuationsUsed++;
        toolMessages.push(
          { role: "assistant", content: roundText },
          { role: "user", content: CONTINUE_PROMPT },
        );
        continue;
      }
      if (finishReason === "length") {
        yield { type: "delta", text: TRUNCATED_TAIL };
      }
      // 覆盖对账（fullCoverage）：清单没读齐 → 点名续读（预算内）；读齐/续满 → 出对账回执再收工
      if (opts.fullCoverage) {
        const unread = unreadFiles();
        if (unread !== null && unread.length > 0 && coverageRoundsUsed < COVERAGE_MAX_ROUNDS) {
          coverageRoundsUsed++;
          const shown = unread.slice(0, COVERAGE_LIST_MAX_PATHS).map((f) => `- ${f}`).join("\n");
          const more =
            unread.length > COVERAGE_LIST_MAX_PATHS
              ? `\n……另有 ${unread.length - COVERAGE_LIST_MAX_PATHS} 个未列出，先读上面这些`
              : "";
          toolMessages.push(
            { role: "assistant", content: roundText },
            {
              role: "user",
              content:
                "（覆盖对账：下面这些清单文件你还没读过。这一轮只读文件——用 read_files 尽量并行多批把下列全部读完，" +
                "不要夹长篇正文；都读完后下一轮再基于全部已读内容给最终回答，回答开头写明「基于 N 个文件」的覆盖声明、" +
                "关键结论标注来源文件路径。）\n" + shown + more,
            },
          );
          continue;
        }
        if (unread !== null) yield { type: "delta", text: coverageReport() };
      }
      break;
    }
  } catch (e) {
    // 模型/网络出错：如实留检查点再抛（调用方自己决定落盘与 SSE error）
    interrupted = { reason: "interrupted", detail: `本轮被错误中断：${(e as Error).message}` };
    lastCheckpoint = makeCheckpoint(interrupted.reason, interrupted.detail);
    if (lastCheckpoint !== null && lastCheckpoint.resume_position !== null) {
      yield {
        type: "delta",
        text:
          `\n\n（本轮中断：已保留现场——已确认来源 ${lastCheckpoint.confirmed_sources.length} 个不会重读；` +
          `续接位置：${lastCheckpoint.resume_position.detail}。发一句「继续」我接着干。）`,
      };
    }
    emitReceipt();
    throw e;
  }

  if (interrupted !== null) {
    lastCheckpoint = makeCheckpoint(interrupted.reason, interrupted.detail);
    if (lastCheckpoint !== null) {
      // 续接位置也如实说给用户（§3.6 的「继续」口径，这回是服务器记着的）
      const pos = lastCheckpoint.resume_position;
      yield {
        type: "delta",
        text:
          `（服务器已保留续接现场：已确认来源 ${lastCheckpoint.confirmed_sources.length} 个不会重读` +
          (pos !== null ? `；续接位置：${pos.detail}` : "") +
          (lastCheckpoint.pending_paths.length > 0 ? `；还有 ${lastCheckpoint.pending_paths.length} 个文件没读到` : "") +
          "。）",
      };
    }
  } else {
    // 正常收工：中断现场已消化，清掉检查点（不然下一轮会莫名注入"上一轮中断"）
    clearCheckpoint(projectId);
  }

  emitReceipt();

  function emitReceipt(): void {
    if (opts.onReceipt === undefined) return;
    const summary = ledger.hasManifest() ? ledger.summary() : null;
    opts.onReceipt({
      project_id: projectId,
      package_id: lastCheckpoint?.package_id ?? null,
      tool_rounds_used: toolRoundsUsed,
      interrupted: interrupted !== null,
      checkpoint: lastCheckpoint,
      coverage: summary,
      confirmed_sources: ledger.confirmedSeeds().map((c) => ({
        path: c.path,
        content_sha256: c.content_sha256,
        complete: c.complete,
      })),
    });
  }
}
