// 2026-09-19 试用增强：聊天自动携带项目实时状态（主人试用反馈 + 裁定：默认自动带，不加开关）。
// 背景：聊天页签挂在项目下却"盲聊"——原来只发聊天历史，模型对设计书/进度/Gate/架构一无所知，
// 问"我们走到哪了"答不上来（发问现场只拼历史：index.ts 聊天路由的 chatStream 调用）。
// 本模块在每条消息发出前**现读**几份只读快照，拼成一段背景材料，由聊天路由作为 system 消息
// 置于历史之前；因为每次都是现读，天然与磁盘现状实时对齐，不需要任何推送/缓存机制。
//
// 2026-09-20 V06-04（PLAN.md，DESIGN.md §2.8）：背景改由**分层上下文包**产出——
// 项目简报 → 施工图任务/生效决定(基线) → 相关章节 → 按需原文（含续读游标与覆盖账本）。
// 原来那套"设计书前 2 万字符 + 单文件截断"只描述已知约束，承担不了 §2.8 的完整协议；
// 现在长设计分段取回并**如实标注未覆盖范围**，施工图与生效决定/基线一起进背景。
// 能力清单、进度、模块、架构四节口径不变（既有断言依赖它们逐字稳定）。
//
// 口径红线：
// - 只读：全部走既有只读读口（getLive / readProgressReadonly / renderGraph / work/context），
//   不为读而建任何文件——progress 特意用 live.ts 的 readProgressReadonly（缺文件按初始态合成），
//   不用会落盘初始化的 readProgress。
// - 降级不阻断：任何一份读失败只在背景里落一行"读取失败"，聊天本身绝不因此挂掉
//   （错误文本过 sanitizeErrorMessage 脱敏，不递本机路径）。
// - 不扩写口：本模块只拼材料发给模型，不提供任何写回动作；落稿仍是聊天 → design.md 的唯一写口（§3.6）。
// - 落盘口径不变：背景材料只进模型请求，不写进会话 jsonl——历史读回仍是纯 user/assistant 行。
import { renderGraph } from "../arch/render";
import { getLive } from "./live";
import { readProgressReadonly } from "./live";
import { sanitizeErrorMessage } from "./redact";
import { buildContextPackage, type ContextPackage } from "./work/context";
import { CHAT_ACTION_KIND_LABELS, actionStatusLabel, listChatActions } from "./work/chatActions";

/** 设计书全文进背景材料的字符上限（V06-04 起由分层取回执行：超长分段并留续读游标） */
const DESIGN_MAX_CHARS = 20_000;
/** 动作流进背景材料的条数上限（getLive 已给前 50 条，这里再收紧——够回答"刚干了什么"即可） */
const EVENTS_MAX = 15;
/** 模块清单进背景材料的条数上限 */
const MODULES_MAX = 40;
/** 架构图顶层模块名进背景材料的条数上限 */
const ARCH_NODES_MAX = 40;
/** 分层上下文里列出的任务/未覆盖明细条数上限（防长名单把背景打成小作文） */
const LAYER_LIST_MAX = 40;
/** 动作回执进背景的条数上限（V06-07：够模型知道"刚才做过什么、成没成"即可） */
const ACTIONS_MAX = 10;

/** 本地 ISO 带偏移 → 精确到分钟（背景材料里秒级精度没有信息量，还占 token） */
function isoMinute(iso: string): string {
  return iso.length >= 16 ? iso.slice(0, 16) : iso;
}

/** 单节读取的统一降级：读失败返回一行脱敏说明，不让整份背景（更不让聊天）挂掉 */
function section(label: string, build: () => string): string {
  try {
    return build();
  } catch (e) {
    return `${label}读取失败：${sanitizeErrorMessage((e as Error).message)}`;
  }
}

/**
 * 分层上下文（V06-04，§2.8）：项目简报 → 施工图任务/生效决定(基线) → 相关章节 → 按需原文。
 * 长设计分段取回，页尾给出续读游标与**实际覆盖/未覆盖范围**；读失败按节降级。
 */
function layeredContext(projectId: string): string {
  const pkg: ContextPackage = buildContextPackage(projectId, { pageMaxChars: DESIGN_MAX_CHARS });
  const lines: string[] = [];
  lines.push(
    `（上下文包 ${pkg.package_id}，生成于 ${pkg.generated_at}；` +
      `设计修订 ${pkg.design_revision?.slice(0, 12) ?? "无"}，施工图修订 ${pkg.plan_revision?.slice(0, 12) ?? "无"}）`,
  );
  lines.push(`【项目简报】\n${pkg.brief.text}`);
  lines.push(
    pkg.baseline === null
      ? "【生效决定 / 基线】尚未激活成套图纸基线——不要假设按哪一版施工"
      : `【生效决定 / 基线】${pkg.baseline.baseline_id}（${pkg.baseline.active_at}，` +
          `${pkg.baseline.approved_by} / ${pkg.baseline.approval_kind}）；` +
          `设计 ${pkg.baseline.design_source} @ ${pkg.baseline.design_revision.slice(0, 12)}，` +
          `施工 ${pkg.baseline.plan_source} @ ${pkg.baseline.plan_revision.slice(0, 12)}`,
  );
  if (pkg.tasks.length > 0) {
    const shown = pkg.tasks.slice(0, LAYER_LIST_MAX);
    lines.push(
      `【施工图任务定义（${pkg.tasks.length} 张，取前面这些）】\n` +
        shown
          .map(
            (t) =>
              `- ${t.task_id}：${t.goal ?? "（无交付目标）"}` +
              `（依赖 ${t.dependency_ids.length > 0 ? t.dependency_ids.join("、") : "无"}；` +
              `验收检查项 ${t.acceptance_checks} 条；定义 ${t.definition_sha256.slice(0, 8)}）`,
          )
          .join("\n"),
    );
  }
  if (pkg.sections.length > 0) {
    const byKind = pkg.sections.filter((s) => s.kind === "design");
    if (byKind.length > 0) {
      lines.push(
        `【设计书章节索引（${byKind.length} 节）】` +
          byKind
            .slice(0, LAYER_LIST_MAX)
            .map((s) => `${s.title}（第 ${s.line_start}–${s.line_end} 行）`)
            .join("；"),
      );
    }
  }
  if (pkg.page !== null) {
    const p = pkg.page;
    lines.push(
      `【设计书正文（按 §2.8 分层取回；本页第 ${p.range.start}–${p.range.end} 行 / 共 ${p.total.lines} 行，` +
        `共 ${p.total.chars} 字）${p.complete ? "" : `；**未覆盖**第 ${p.range.end + 1}–${p.total.lines} 行，续读游标 ${p.next_cursor ?? "-"}`}】\n\n${p.text}`,
    );
  } else {
    lines.push("【设计书正文】该项目还没有设计书（可在聊天页点「落稿」把讨论写进去）");
  }
  // 覆盖账本摘要：说清哪些来源进了本背景、哪些没进（§2.8 不得用"没写"冒充"全量覆盖"）
  const covered = pkg.source_manifest.filter((m) => m.covered.complete);
  const omitted = pkg.omitted.slice(0, LAYER_LIST_MAX);
  lines.push(
    `【覆盖与未覆盖（服务器登记）】来源 ${pkg.source_manifest.length} 个，完整进本背景 ${covered.length} 个；` +
      (omitted.length === 0
        ? "未覆盖：无。"
        : `未覆盖 ${pkg.omitted.length} 项：\n` +
          omitted.map((o) => `- ${o.path}：${o.detail}`).join("\n") +
          (pkg.omitted.length > omitted.length ? `\n……另有 ${pkg.omitted.length - omitted.length} 项未列出` : "")),
  );
  if (pkg.stale_reasons.length > 0) {
    lines.push(`【陈旧提示】${pkg.stale_reasons.join("；")}`);
  }
  return lines.join("\n\n");
}

/**
 * 拼聊天背景材料（每条消息发出前现读）。调用点：index.ts 聊天路由。
 * 返回值作为 system 消息的 content；任何一节失败都只降级为该节的一行说明。
 */
export function buildChatContext(projectId: string, opts: { sessionId?: string | null } = {}): string {
  const parts: string[] = [];

  parts.push(
    "你是「塔台」工作台里的 Flash 助手。下面是该项目在本机磁盘上的实时快照（每次提问时现读），" +
      "回答时据此与项目对齐；快照之后磁盘可能又有新变化，拿不准就明说，不要编造项目里不存在的东西。",
  );

  // 2026-09-19 试用增强三期补丁：历史会话里可能留着升级前的旧话（"我看不到你的文件 /
  // 我不能改架构图"），模型会顺着旧话继续否认。每条消息都重申一次当前能力清单，
  // 并明示"以本清单为准"——旧会话立即自愈，不用用户换会话。
  parts.push(
    "【你当前的能力（以本清单为准）】\n" +
      "- 上述快照之外的细节，可用七只工具现场查/写：list_files（列项目文件清单——先摸清项目里有哪些文件，" +
      "路径直接喂给读文件工具）、read_file（读单个文件）、read_files（一次批量读最多 10 个文件，通读代码用）、" +
      "search_code（全项目搜代码）、get_arch（拿架构图全量数据）、" +
      "write_arch（给架构图三视图补全节点/连线——你**可以**改图，只动补全层）、" +
      "check_arch（架构对账——机械比对图与磁盘，拿悬空/重复/目录树嫌疑三类问题清单）。\n" +
      "- 执行纪律：被要求查证/改图就**直接动手**——工具就是你的手，不请示、不等确认、不要只给计划就停下；" +
      "完成声明必须以真实工具回执为据：没调过 write_arch 不许说「已改图」，没读过文件不许说「已核实」。\n" +
      "- 拿不准或信息不足：停下说明缺什么、需要什么，不猜、不编、不硬答。轮次预算快烧完时，" +
      "优先把已确证的结论落笔（write_arch）再收尾，别把预算全花在读文件上。\n" +
      "- 三视图与代码「对得上」的口径：图上节点 path 在磁盘真实存在；顶层大目录由静态解析负责（已上图）；" +
      "文件级细节靠图上下钻查看——不是把每个文件都画上顶层图。\n" +
      "- 补全层（write_arch）只装静态解析覆盖不到的**概念节点**（外部服务、跨目录机制、系统级调度）；" +
      "**不要把目录树/文件清单重建进补全层**（那是解析层的活，补了只会在 check_arch 里报目录树嫌疑）。\n" +
      "- 被要求「核对三视图与代码」时：先用 check_arch 拿机器对账清单，逐条修——不要自己 list_files 对着图一个个看。\n" +
      "- 你**可以**读项目的全部代码：先 list_files 拿清单，再 read_files 批量精读，不是只能一个文件一个文件慢慢读。\n" +
      "- 工具有轮次预算（每条消息约 20 轮）。预算烧完会如实收尾，用户发「继续」你接着干——新一轮有全新预算，" +
      "上一轮已读过的结论在历史里，**不要重读**，从中断处直接继续。\n" +
      "- **设计书（design.md）不是你写的**：你没有写设计书的工具，用户点「落稿」按钮把当前讨论提炼写入。" +
      "用户要你「补全/修改设计书」时，正确动作是：读代码 → 给结论 → 把要补的条目直接写成可落稿的 markdown 要点，" +
      "不要问「写到哪个文件」、不要找设计书文件、不要尝试用工具写它。\n" +
      "- 历史轮次里若出现过「我看不到本地文件/我不能改架构图/我读不了全量代码」一类旧说法，那是升级前的过时表态，" +
      "以本清单与本次实际工具结果为准，不要顺着旧话否认。",
  );

  // ① 进度 / Gate / 任务 / 动作流：getLive 五源合成（实况页签同一份数据，只读）
  parts.push(
    section("【当前进度】", () => {
      const live = getLive(projectId);
      const lines = [
        `阶段：${live.stage}`,
        `Gate 当前步：${live.gate.current_step}（${live.gate.step_name}，${live.gate.result}）`,
        `任务计数：todo ${live.task_counts.todo} / doing ${live.task_counts.doing} /` +
          ` done ${live.task_counts.done} / blocked ${live.task_counts.blocked}`,
        `谁在干活：${live.actor.kind === "user" ? "user（球在用户这边）" : live.actor.name}` +
          (live.actor.last_active_at ? `，最近活跃 ${isoMinute(live.actor.last_active_at)}` : ""),
      ];
      if (live.current_task) {
        lines.push(
          `当前 doing 任务：${live.current_task.title}` +
            `（${live.current_task.reporter}，更新于 ${isoMinute(live.current_task.updated_at)}）`,
        );
      }
      if (live.events.length > 0) {
        lines.push(`最近动作流（新在前，取前 ${EVENTS_MAX} 条）：`);
        for (const ev of live.events.slice(0, EVENTS_MAX)) {
          lines.push(`- [${isoMinute(ev.ts)}][${ev.kind}] ${ev.text}`);
        }
      } else {
        lines.push("最近动作流：暂无（还没改过文件 / 没有过关打回 / 没有自报任务）");
      }
      return lines.join("\n");
    }),
  );

  // ② 模块清单：progress.json 的 modules（id + 中文名 + 状态）
  parts.push(
    section("【模块清单】", () => {
      const modules = readProgressReadonly(projectId).modules;
      if (modules.length === 0) return "还没登记任何模块";
      const lines = modules.slice(0, MODULES_MAX).map((m) => `- ${m.name}（${m.id}）：${m.status}`);
      if (modules.length > MODULES_MAX) {
        lines.push(`…（共 ${modules.length} 个，只列前 ${MODULES_MAX} 个）`);
      }
      return lines.join("\n");
    }),
  );

  // ③ 架构图：静态解析的顶层模块名（renderGraph 与架构图页签同一份渲染数据，只读）
  parts.push(
    section("【架构图（静态解析）】", () => {
      const r = renderGraph(projectId);
      if (!r.exists || !r.graph) return "还没解析过（可在「架构图」页签点解析生成）";
      const names = r.graph.nodes.slice(0, ARCH_NODES_MAX).map((n) => n.name);
      const more =
        r.graph.nodes.length > ARCH_NODES_MAX ? ` …（共 ${r.graph.nodes.length} 个）` : "";
      return `顶层模块 ${r.graph.nodes.length} 个：${names.join("、")}${more}`;
    }),
  );

  // ④ 分层上下文（V06-04）：项目简报 → 施工图任务/生效决定 → 相关章节 → 按需原文
  //    （含施工图与生效基线；设计书正文按 §2.8 分段取回，未覆盖范围如实标注）
  parts.push(section("【分层上下文】", () => layeredContext(projectId)));

  // ⑤ V06-07：本会话之前的动作回执（六阶段文案来自**真实落盘回执**，不靠前端猜、不靠模型回忆）。
  //    只在本轮带了 sessionId 且确有动作时出现——不带会话的老调用点（如 MCP）背景逐字不变。
  if (opts.sessionId !== undefined && opts.sessionId !== null && opts.sessionId !== "") {
    const receipts = section("【本轮之前的动作回执】", () => recentActionLines(projectId, opts.sessionId!));
    if (receipts !== "" && !receipts.includes("读取失败")) parts.push(receipts);
  }

  return parts.join("\n\n");
}

/** 最近动作回执（V06-07）：一行一个动作——阶段文案 + 做了什么 + 影响对象；失败原因如实带上 */
function recentActionLines(projectId: string, sessionId: string): string {
  const actions = listChatActions(projectId, { sessionId }).slice(0, ACTIONS_MAX);
  if (actions.length === 0) return "";
  const lines = actions
    .map((a) => {
      const where = a.result_ref?.path === null || a.result_ref?.path === undefined ? "" : `｜产物 ${a.result_ref.path}`;
      const err = a.error === null ? "" : `｜失败原因：${a.error.message}`;
      const affects = a.affected_ids.length === 0 ? "" : `｜影响 ${a.affected_ids.slice(0, 6).join("、")}${a.affected_ids.length > 6 ? "…" : ""}`;
      return `- [${actionStatusLabel(a)}] ${CHAT_ACTION_KIND_LABELS[a.kind]}：${a.trigger.replace(/\s+/g, " ").slice(0, 60)}${where}${affects}${err}`;
    })
    .join("\n");
  return (
    "【本轮之前的动作回执（服务器落盘，重新打开会话也在）】\n" +
    lines +
    "\n（这些是**已发生的真实回执**：applied 才代表已写盘成功；review_needed 只代表待审定，别当已生效。）"
  );
}
