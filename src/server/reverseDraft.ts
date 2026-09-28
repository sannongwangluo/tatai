import fs from "node:fs";
import path from "node:path";
import { getProject } from "./registry";
import { scanProjectAsync, type ProjectScan } from "./scanner";
import { queryMemory, type MemoryQueryResult } from "./memory";
// chatWithContinue：逆向起草是长输出，超单次输出上限时自动断点续写（§3.6，2026-09-19 试用反馈）
import { chatWithContinue as flashChat, DEFAULT_MODEL, extractJsonValue } from "./flash";
import { parsePlanTable, validatePlanTasks } from "./work/planValidate";
import {
  designPath,
  readDesign,
  readProgress,
  recordGateTransition,
  workstationDir,
  WsError,
  GATE_STEPS,
  type Progress,
} from "./workstation";
import { nowIso } from "./time";

// 逆向落稿第三卡（B3，DESIGN.md §9 全节）：起草雏形 + Gate 推断 + 定版入口 + 对账钩子。
// 流程（§9.2）：扫描 + 记忆检索 → Flash 起草雏形（项目是什么 / 模块划分 /
// 当前实际阶段 / Gate 标在哪一步 四块）→ 人/Max 定版 → 对账自动启动。
// 口径（§9.3）：
//   · 不问用户"这项目是干嘛的"——先自己扫，扫完给雏形让人改；
//   · Gate 位置是【推断初值 + 由人确认】，不是直接定稿；
//   · 定版只能由人/Max 触发（finalizeDraft 的 gate_step 来自人的确认）；
//   · 起草稿落 .工作台/design.draft.md——【草稿不是 design.md】，互不混淆；
//   · 起草稿不覆盖已有 design.md（DoD⑤：无设计书才写，有则 conflict 走待议/融合）。
// 对账钩子（A5 联动，DoD④）：定版完成时落 .工作台/arch/reconcile-request.json
//   ——A5 卡消费此文件作为"定版后对账自动启动"的触发源（A5 未开工，本卡只留钩子）。

const DRAFT_FILE = "design.draft.md";
/** V06-07（DESIGN §9.2）：逆向落稿产出**两份草稿**——设计草稿 + 剩余施工草稿 */
const PLAN_DRAFT_FILE = "plan.draft.md";
const RECONCILE_DIR = "arch";
const RECONCILE_FILE = "reconcile-request.json";
const MEMORY_QUERY_LIMIT = 8;

const GATE_STEP_IDS: readonly string[] = GATE_STEPS.map((s) => s.id);

/** 原子写文本（与 workstation.writeTextAtomic 同一惯例：先写临时文件再 rename） */
function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function draftPath(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), DRAFT_FILE);
}

function reconcileRequestPath(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), RECONCILE_DIR, RECONCILE_FILE);
}

/** 草稿读取结果；exists:false = 还没有逆向草稿（正常空态） */
export type ReverseDraftDoc =
  | { exists: true; content: string; source: string }
  | { exists: false };

/** 读逆向草稿全文（GET 路由用） */
export function readReverseDraft(projectId: string, dataDir?: string): ReverseDraftDoc {
  const file = draftPath(projectId, dataDir);
  if (!fs.existsSync(file)) return { exists: false };
  return { exists: true, content: fs.readFileSync(file, "utf8"), source: file };
}

function planDraftPath(projectId: string, dataDir?: string): string {
  return path.join(workstationDir(projectId, dataDir), PLAN_DRAFT_FILE);
}

/**
 * 读**剩余施工草稿**全文（V06-07 双文档链的第二份，§9.2）。
 * 不存在返回 {exists:false}（正常空态：还没逆向起草，或那份没生成出来）。
 */
export function readReversePlanDraft(projectId: string, dataDir?: string): ReverseDraftDoc {
  const file = planDraftPath(projectId, dataDir);
  if (!fs.existsSync(file)) return { exists: false };
  return { exists: true, content: fs.readFileSync(file, "utf8"), source: file };
}

/** 推断依据（§9.3：git 活跃度 / 文件完整度 / README 措辞，本地先算一份供起草与定版参考） */
export interface InferEvidence {
  git: string;
  files: string;
  readme: string;
  memory: string;
}

/** 起草结果：冲突（已有 design.md，不覆盖）或成功（草稿已落盘 + 推断 Gate 初值） */
export type DraftDesignResult =
  | {
      conflict: true;
      design_source: string;
      hint: string;
    }
  | {
      conflict: false;
      draft_source: string;
      inferred_gate_step: string;
      evidence: InferEvidence;
      memory: MemoryQueryResult;
      model: string;
      duration_ms: number;
      /**
       * V06-07 双文档链②：**剩余施工草稿**（DESIGN §9.2「形成设计草稿及剩余施工草稿」）。
       * 落盘成功才有值；第二份没生成出来时是 null + `plan_draft_error` 如实说明。
       */
      plan_draft: RemainingPlanDraft | null;
      plan_draft_error: string | null;
    };

/** 剩余施工草稿的落盘回执（两份草稿都有来源，§9.2） */
export interface RemainingPlanDraft {
  /** 落盘绝对路径（对外由 HTTP 层裁掉，与 draft_source 同口径） */
  source: string;
  content: string;
  task_ids: string[];
  /** 标了"待验证"的条目数（无验证证据的既有实现——原 Gate 不会被它填绿） */
  pending_verification: number;
  /** 起草时读到的来源（扫描 / 设计草稿 / 推断依据） */
  sources: string[];
}

/** 把扫描结果压成给 Flash 的紧凑摘要（全量 JSON 太长，起草只需要结构信号） */
function summarizeScan(scan: ProjectScan): string {
  const lines: string[] = [];
  lines.push(
    `文件树：共 ${scan.tree.total_files} 个文件，最深 ${scan.tree.max_depth} 层` +
      (scan.tree.truncated ? `（有目录超量截断: ${scan.tree.truncated_dirs.join(", ")}）` : ""),
  );
  lines.push(
    `扩展名 top：${scan.tree.by_extension.map((e) => `${e.ext}×${e.count}`).join(" ") || "(无)"}`,
  );
  lines.push(
    `顶层目录：${scan.tree.top_dirs.slice(0, 15).map((d) => `${d.name}(${d.files})`).join(" ") || "(无)"}`,
  );
  if (scan.readme) {
    lines.push(`README（${scan.readme.path}）标题：${scan.readme.title}`);
    lines.push(`README 摘要：${scan.readme.excerpt.replace(/\s+/g, " ").slice(0, 800)}`);
  } else {
    lines.push("README：无");
  }
  lines.push(
    `docs 清单（${scan.docs.length} 条）：${scan.docs.slice(0, 20).map((d) => d.path).join(", ") || "(无)"}`,
  );
  if (scan.git.has_git) {
    lines.push(
      `git：总提交 ${scan.git.total_commits ?? "?"} 次，近 30 天 ${scan.git.commits_last_30d} 次，最近提交 ${scan.git.last_commit_at ?? "?"}`,
    );
    lines.push(`最近提交：${scan.git.recent_commits.slice(0, 8).join(" | ") || "(无)"}`);
  } else {
    lines.push("git：无 .git");
  }
  const pkg = scan.manifests.package_json;
  const py = scan.manifests.pyproject_toml;
  if (pkg?.exists) {
    lines.push(
      `package.json：name=${pkg.name ?? "?"} description=${pkg.description ?? "?"} scripts=[${pkg.scripts.join(",")}] deps=[${pkg.dependencies.slice(0, 20).join(",")}]`,
    );
  }
  if (py?.exists) {
    lines.push(`pyproject.toml：name=${py.name ?? "?"} description=${py.description ?? "?"}`);
  }
  const others = scan.manifests.others.filter((o) => o.exists).map((o) => o.name);
  if (others.length > 0) lines.push(`其他清单/配置：${others.join(", ")}`);
  return lines.join("\n");
}

/** 本地推断依据（§9.3 三路信号 + 记忆可用性）；与 LLM 推断互相印证，定版时给人看 */
function buildEvidence(scan: ProjectScan, memory: MemoryQueryResult): InferEvidence {
  const git = scan.git.has_git
    ? `总提交 ${scan.git.total_commits ?? "?"} 次、近 30 天 ${scan.git.commits_last_30d} 次、最近 ${scan.git.last_commit_at ?? "?"}`
    : "无 .git（活跃度信号缺失）";
  const files = `共 ${scan.tree.total_files} 文件、${scan.tree.top_dirs.length} 个顶层目录、最深 ${scan.tree.max_depth} 层` +
    (scan.tree.truncated ? "、有截断" : "");
  const readme = scan.readme
    ? `有 README（${scan.readme.path}），措辞：「${scan.readme.title}」`
    : "无 README";
  const mem = memory.available
    ? `记忆检索命中 ${memory.results.length} 条历史记忆`
    : `记忆检索不可用（${memory.reason}），仅按代码扫描推断`;
  return { git, files, readme, memory: mem };
}

/** 从 Flash 输出里解析推断 Gate 步（§9.3 推断初值）；解析失败兜底 "develop" 并照常返回 */
function parseInferredGateStep(markdown: string): string {
  // 优先找「推断 Gate 步：xxx」显式行，其次在含 Gate 的行里找七步 id
  const explicit = markdown.match(
    /推断\s*Gate\s*步[：:]\s*`?\s*(kickoff|requirement|design|tasks|develop|verify|deliver)\b/i,
  );
  if (explicit) return explicit[1].toLowerCase();
  for (const line of markdown.split(/\r?\n/).reverse()) {
    if (!/gate/i.test(line)) continue;
    const m = line.match(/\b(kickoff|requirement|design|tasks|develop|verify|deliver)\b/i);
    if (m) return m[1].toLowerCase();
  }
  return "develop";
}

// ── V06-07 双文档链②：剩余施工草稿（§9.2「形成设计草稿及剩余施工草稿」）──

interface RemainingPlanJson {
  observed: { path: string; what: string; evidence: string }[];
  tasks: {
    card_id: string;
    goal: string;
    dependencies: string;
    evidence: string;
    files: string;
    checks: string[];
    body: string;
  }[];
  notes: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 模型输出 → 剩余施工草稿 JSON（形状不对就丢条目，不硬塞） */
function parseRemainingPlan(json: unknown): RemainingPlanJson {
  const out: RemainingPlanJson = { observed: [], tasks: [], notes: [] };
  if (typeof json !== "object" || json === null) return out;
  const root = json as Record<string, unknown>;
  out.notes = arr(root.notes).map(str).filter((s) => s !== "");
  for (const raw of arr(root.observed)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const what = str(r.what);
    if (what === "") continue;
    out.observed.push({ path: str(r.path), what, evidence: str(r.evidence) });
  }
  for (const raw of arr(root.tasks)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const cardId = str(r.card_id);
    const goal = str(r.goal);
    const evidence = str(r.evidence);
    if (cardId === "" || goal === "" || evidence === "") continue; // 无验收的新卡一律不收
    out.tasks.push({
      card_id: cardId,
      goal,
      dependencies: str(r.dependencies),
      evidence,
      files: str(r.files),
      checks: arr(r.checks).map(str).filter((s) => s !== ""),
      body: typeof r.body === "string" ? r.body.trim() : "",
    });
  }
  return out;
}

/** 剩余施工草稿的 markdown（表格口径与 planValidate 一致；既有实现一律标"待验证"） */
function renderRemainingPlan(
  projectName: string,
  parsed: RemainingPlanJson,
  sources: string[],
): string {
  const lines: string[] = [
    `# ${projectName} 剩余施工草稿（逆向落稿 · 未定版）`,
    "",
    "> 本文件是**剩余施工草稿**（DESIGN §9.2），**不是 plan.md**——由设计角色审定后才转正。",
    "> 逆向只描述**可观测实现**：现有代码没有验证证据 → 一律标**待验证**，不自动填绿、不改 Gate（§9.3）。",
    "",
    "## 剩余施工任务",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const t of parsed.tasks) {
    lines.push(`| ${t.card_id} | todo | ${t.goal.replace(/\|/g, "\\|")} | ${t.dependencies} | ${t.evidence.replace(/\|/g, "\\|")} |`);
  }
  if (parsed.tasks.length === 0) lines.push("| （无） |  |  |  |  |");
  lines.push("");
  for (const t of parsed.tasks) {
    lines.push(`### ${t.card_id} ${t.goal}`, "");
    if (t.files !== "") lines.push(`**文件责任**：${t.files}`, "");
    lines.push("**设计依据**：design.draft.md（逆向草稿，待设计角色审定）", "");
    if (t.checks.length > 0) {
      for (const c of t.checks) lines.push(`- [ ] ${c}`);
      lines.push("");
    }
    if (t.body !== "") lines.push(t.body, "");
    lines.push(`**交付**：${t.evidence}`, "");
  }
  lines.push("## 已观测到的实现（无验证证据 → 待验证，§9.3）", "");
  if (parsed.observed.length === 0) {
    lines.push("- （本次扫描没有得到可陈述的实现细节）");
  } else {
    for (const o of parsed.observed) {
      const where = o.path === "" ? "" : `\`${o.path}\`：`;
      lines.push(`- ${where}${o.what} —— 证据：${o.evidence === "" ? "无（待验证）" : o.evidence}**（待验证）**`);
    }
  }
  lines.push("", "## 来源", "");
  for (const s of sources) lines.push(`- ${s}`);
  if (parsed.notes.length > 0) {
    lines.push("", "## 提醒", "");
    for (const n of parsed.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 起草雏形（B3 核心，§9.2）：
 * 并行取 scanProject + queryMemory（query=项目名）→ 拼提示词调 flash.chat() →
 * 产出含四块的雏形 markdown + 推断依据 → 落 .工作台/design.draft.md。
 * 已有 design.md → 不生成不覆盖，返回 {conflict:true} + 待议通道提示（DoD⑤）。
 * 记忆检索不可用 → 降级为"仅代码扫描"照常起草（B2 降级红线），不阻塞。
 */
export async function draftDesign(
  projectId: string,
  opts: { memoryTimeoutMs?: number } = {},
  dataDir?: string,
): Promise<DraftDesignResult> {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  // DoD⑤ 红线：已有 design.md 一律不覆盖（塔台自身的 repo 根 DESIGN.md 同理 conflict）
  const existing = readDesign(projectId, dataDir);
  if (existing.exists) {
    return {
      conflict: true,
      design_source: existing.source,
      hint: "该项目已有 design.md，逆向起草不覆盖；如需融合请走待议通道（追加 design.discuss.md）由人/Max 定夺",
    };
  }

  const t0 = Date.now();
  // Q131（2026-09-19 审计）：scan 走异步版（git 子进程不阻塞事件循环）——起草期间 UI 的 SSE/轮询照常
  const [scan, memory] = await Promise.all([
    scanProjectAsync(projectId, dataDir),
    queryMemory(project.name, {
      limit: MEMORY_QUERY_LIMIT,
      ...(opts.memoryTimeoutMs !== undefined ? { timeoutMs: opts.memoryTimeoutMs } : {}),
    }),
  ]);
  const evidence = buildEvidence(scan, memory);
  const memorySection = memory.available
    ? memory.results.length > 0
      ? memory.results.map((h, i) => `${i + 1}. ${h.summary}`).join("\n")
      : "（检索可用但零命中）"
    : `（记忆检索不可用：${memory.reason}——按"仅代码扫描"起草）`;

  const gateList = GATE_STEPS.map((s) => `${s.id}=${s.name}`).join(" / ");
  const markdown = await flashChat(
    [
      {
        role: "system",
        content:
          "你是逆向落稿起草助手（塔台 DESIGN §9.2）。根据对老项目的扫描结果与历史记忆摘要，" +
          "起草该项目的设计书雏形。硬性要求：\n" +
          "1. 只输出 markdown 正文，不要解释、不要客套；\n" +
          "2. 必须恰好包含以下四个二级小节，标题一字不差：\n" +
          "   ## 一、项目是什么\n   ## 二、模块划分\n   ## 三、当前实际阶段\n   ## 四、Gate 标在哪一步\n" +
          "3. 模块划分按顶层目录/清单文件归纳 5–15 个大模块，每条一句话；\n" +
          "4. Gate 七步口径：" + gateList + "。\n" +
          "   在「四、Gate 标在哪一步」里给出推断的一步，最后一行必须写「推断 Gate 步：<id>」，" +
          "   并说明推断理由（git 活跃度、文件完整度、README 措辞）；拿不准就给最接近的一步，不许拒绝推断；\n" +
          "5. 历史记忆只是背景参考，主题是该项目本身；不要编造扫描结果里不存在的文件或功能。",
      },
      {
        role: "user",
        content:
          `项目名：${project.name}\n项目类型：${project.kind}\n\n` +
          `【代码扫描摘要】\n${summarizeScan(scan)}\n\n` +
          `【历史记忆摘要（记忆检索，主题词级）】\n${memorySection}\n\n` +
          `【本地推断依据】\ngit 活跃度：${evidence.git}\n文件完整度：${evidence.files}\nREADME 措辞：${evidence.readme}\n\n` +
          "请起草四块雏形。",
      },
    ],
    { model: DEFAULT_MODEL, timeoutMs: 120_000 },
  );

  if (markdown.trim() === "") {
    throw new WsError("INVALID_INPUT", "Flash 起草返回空内容，未落草稿");
  }
  const inferredGateStep = parseInferredGateStep(markdown);

  const draftText = [
    `# ${project.name} 设计稿（逆向落稿草稿 · 未定版）`,
    "",
    "> 本文件是逆向落稿草稿（B3，DESIGN §9.2），**不是 design.md**——由人确认 Gate 步后定版转正。",
    "",
    markdown.trim(),
    "",
    "---",
    "",
    "## 推断依据（§9.3，本地信号）",
    "",
    `- git 活跃度：${evidence.git}`,
    `- 文件完整度：${evidence.files}`,
    `- README 措辞：${evidence.readme}`,
    `- 历史记忆：${evidence.memory}`,
    `- 推断 Gate 步：${inferredGateStep}（**推断初值，由人确认**，DESIGN §9.3）`,
    "",
  ].join("\n");

  const file = draftPath(projectId, dataDir);
  writeTextAtomic(file, draftText);

  // ── V06-07 双文档链②：剩余施工草稿（§9.2）──
  // 两份草稿**都有来源**：设计草稿来自扫描+记忆；施工草稿来自同一份扫描 + 刚写的设计草稿。
  // 第二份失败不连坐第一份：如实返回 plan_draft_error，设计草稿照常可用（不假装两份都成了）。
  let planDraft: RemainingPlanDraft | null = null;
  let planDraftError: string | null = null;
  const sources = [
    `代码扫描：${evidence.files}`,
    `git 活跃度：${evidence.git}`,
    `README：${evidence.readme}`,
    `设计草稿：${DRAFT_FILE}`,
    `历史记忆：${evidence.memory}（记忆检索不可用时如实登记，不假装查过）`,
  ];
  try {
    const remaining = await flashChat(
      [
        {
          role: "system",
          content:
            "你是逆向落稿的**剩余施工草稿**助手（塔台 DESIGN §9.2）。根据老项目的扫描结果与刚起草的设计雏形，" +
            "给出「还差什么才能说这个项目做完了」的施工卡草案，并如实登记已经观测到的实现。硬性要求：\n" +
            "1. 只输出一个 JSON 对象，不要围栏、不要解释：\n" +
            "   {\"observed\":[{\"path\":\"相对路径\",\"what\":\"观测到的实现\",\"evidence\":\"有的证据或留空\"}]," +
            "\"tasks\":[{\"card_id\":\"RV-01\",\"goal\":\"交付目标一句话\",\"dependencies\":\"依赖的卡号，可空\"," +
            "\"evidence\":\"完成证据（必填，空卡不收）\",\"files\":\"允许改的路径\",\"checks\":[\"可运行检查项\"],\"body\":\"补充说明，可空\"}]," +
            "\"notes\":[\"提醒\"]}；\n" +
            "2. **已写代码不能自动算通过**：observed 里每条都是「观测到的实现」，不要写「已完成」「已验证」；\n" +
            "3. 每张卡必须有完成证据；依赖只能指向本次其它卡号；不要编造扫描结果里没有的文件；\n" +
            "4. 剩余施工卡描述**差的活**，不重复描述已经写完的代码。",
        },
        {
          role: "user",
          content:
            `项目名：${project.name}\n项目类型：${project.kind}\n\n` +
            `【代码扫描摘要】\n${summarizeScan(scan)}\n\n` +
            `【设计雏形（刚起草，未定版）】\n${markdown.trim()}\n\n` +
            `【本地推断依据】\ngit 活跃度：${evidence.git}\n文件完整度：${evidence.files}\nREADME 措辞：${evidence.readme}\n\n` +
            "请给出剩余施工草稿 JSON。",
        },
      ],
      { model: DEFAULT_MODEL, timeoutMs: 120_000 },
    );
    const { json } = extractJsonValue(remaining);
    const parsed = parseRemainingPlan(json);
    if (json === null) {
      planDraftError = "模型输出里没有 JSON：剩余施工草稿未生成";
    } else if (parsed.tasks.length === 0) {
      planDraftError = "模型没给出任何合格施工卡（每张卡都要求完成证据）：剩余施工草稿未生成";
    } else {
      const planDraftText = renderRemainingPlan(project.name, parsed, sources);
      // 结构校验：不合法就不落盘（两份草稿都不能是坏图纸）
      const table = parsePlanTable(planDraftText);
      const issues = validatePlanTasks(table?.rows ?? [], table !== null);
      if (issues.length > 0) {
        planDraftError = `剩余施工草稿结构校验不通过：${issues.map((i) => i.detail).join("；")}`;
      } else {
        const planFile = planDraftPath(projectId, dataDir);
        writeTextAtomic(planFile, planDraftText);
        planDraft = {
          source: planFile,
          content: planDraftText,
          task_ids: (table?.rows ?? []).map((r) => r.id),
          pending_verification: parsed.observed.length,
          sources,
        };
      }
    }
  } catch (e) {
    planDraftError = `剩余施工草稿起草失败：${(e as Error).message}`;
  }

  return {
    conflict: false,
    draft_source: file,
    inferred_gate_step: inferredGateStep,
    evidence,
    memory,
    model: DEFAULT_MODEL,
    duration_ms: Date.now() - t0,
    plan_draft: planDraft,
    plan_draft_error: planDraftError,
  };
}

/** 定版回执：三处落盘证据（design.md / progress.json / 对账钩子）一并返回 */
export interface FinalizeResult {
  design_source: string;
  gate_step: string;
  progress: Progress;
  reconcile_request_source: string;
  reconcile_request: { ts: string; trigger: string; gate_step: string };
}

/**
 * 定版（B3，§9.2「Max/人定版」+ §9.3「定版只能由人/Max 触发」）：
 * 入参 gate_step 是【人确认后的 Gate 位置】（推断初值只是默认值，确认权在人）。
 * 动作：
 *   1. 无 design.draft.md → 拒绝（400）；已有 design.md → 拒绝（不覆盖红线）；
 *   2. 草稿转正为 design.md（无则建；去掉"未定版"标记，改写定版注记）；
 *   3. progress.json：gate_step 之前的步逐步行 recordGateTransition(pass)，
 *      current_step 落在确认的 gate_step；每步留 gate.jsonl 行（by:"user"，note"逆向落稿定版"）；
 *   4. 触发对账钩子：落 .工作台/arch/reconcile-request.json——A5 卡消费此文件
 *      作为"定版后对账自动启动"的触发源（§9.2 流程末环；A5 未开工，本卡只留钩子）。
 */
export function finalizeDraft(
  projectId: string,
  input: { gate_step: string; note?: string | null },
  dataDir?: string,
): FinalizeResult {
  const project = getProject(projectId, dataDir);
  if (!project) {
    throw new WsError("PROJECT_NOT_FOUND", `项目不存在: ${projectId}`);
  }
  const gateStep = input.gate_step;
  if (!GATE_STEP_IDS.includes(gateStep)) {
    throw new WsError(
      "INVALID_STEP",
      `非法 gate_step: ${JSON.stringify(gateStep)}，只接受 ${GATE_STEP_IDS.join("/")}`,
    );
  }
  const draft = readReverseDraft(projectId, dataDir);
  if (!draft.exists) {
    throw new WsError("INVALID_INPUT", "没有逆向草稿（.工作台/design.draft.md 不存在），请先生成草稿再定版");
  }
  // 不覆盖红线：定版只在"还没有 design.md"时放行（DoD⑤ 与 draftDesign 同一口径）
  const existing = readDesign(projectId, dataDir);
  if (existing.exists) {
    throw new WsError(
      "INVALID_INPUT",
      `已有 design.md（${existing.source}），逆向定版不覆盖；融合走待议通道`,
    );
  }

  // 1) 草稿转正：去"未定版"标记，换定版注记（人确认信息留痕进设计书正文头部）
  const confirmNote =
    typeof input.note === "string" && input.note.trim() !== "" ? `；备注：${input.note.trim()}` : "";
  const finalizedText = draft.content
    .replace("（逆向落稿草稿 · 未定版）", "")
    .replace(
      /> 本文件是逆向落稿草稿（B3，DESIGN §9.2），\*\*不是 design.md\*\*——由人确认 Gate 步后定版转正。/,
      `> 逆向落稿定版（B3，DESIGN §9.2）：由人确认 Gate 步 = ${gateStep}（${nowIso()}）${confirmNote}。`,
    );
  const designFile = designPath(projectId, dataDir);

  // Q30(c)：design.md 与 Gate 推进是跨文件双写、无事务。此前先写 design.md 再逐步 pass，中途抛错
  // （最典型是"当前 Gate 步已晚于确认步 → 不回退"这条 INVALID_INPUT）就留下"设计书已存在、Gate 没跟上"
  // 的哑状态：重试被上面的"已有 design.md 不覆盖"挡住，且没有任何回执说明推进到第几步。
  // 处置：把能为的检查**挪到写之前**（先读一次 progress，步序不允许就整笔不写），
  // 并在写之后仍失败时把刚写下的 design.md 撤掉（进来前已断言它不存在，撤掉 = 回到调用前状态）。
  const gateIndex = GATE_STEP_IDS.indexOf(gateStep);
  const beforeWrite = readProgress(projectId, dataDir).gate.current_step;
  if (GATE_STEP_IDS.indexOf(beforeWrite) > gateIndex) {
    throw new WsError(
      "INVALID_INPUT",
      `当前 Gate 步（${beforeWrite}）已晚于确认步（${gateStep}），逆向定版不回退 Gate（design.md 未写）`,
    );
  }

  writeTextAtomic(designFile, finalizedText);

  // 2) Gate 位置：从 kickoff 起逐步 pass 到 gate_step 前一步，current_step 停在确认的步。
  //    走 recordGateTransition 统一入口（by 固定 "user"、留 gate.jsonl 行），不另写一套存储。
  const note = `逆向落稿定版${confirmNote}`;
  try {
    for (;;) {
      const progress = readProgress(projectId, dataDir);
      const cur = progress.gate.current_step;
      if (cur === gateStep) break;
      if (GATE_STEP_IDS.indexOf(cur) > gateIndex) {
        throw new WsError(
          "INVALID_INPUT",
          `当前 Gate 步（${cur}）已晚于确认步（${gateStep}），逆向定版不回退 Gate`,
        );
      }
      recordGateTransition(projectId, { step: cur, result: "pass", note }, dataDir);
    }
  } catch (e) {
    try {
      fs.rmSync(designFile, { force: true }); // 回到"还没有 design.md"的调用前状态，允许重试
    } catch {
      // 撤不掉也只能如实抛出原错误
    }
    throw e;
  }
  const progress = readProgress(projectId, dataDir);

  // 3) 对账钩子（DoD④）：A5 卡消费此文件启动"设计书 ↔ 代码"对账标黄（§4.5/§9.2）
  const reconcileRequest = { ts: nowIso(), trigger: "reverse-draft-finalize", gate_step: gateStep };
  const reconcileFile = reconcileRequestPath(projectId, dataDir);
  writeTextAtomic(reconcileFile, JSON.stringify(reconcileRequest, null, 2) + "\n");

  return {
    design_source: designFile,
    gate_step: gateStep,
    progress,
    reconcile_request_source: reconcileFile,
    reconcile_request: reconcileRequest,
  };
}
