// 补全层 replace 引用守卫验证（R20260920-1 修复批 2：T11/R1-ZS-003，对应问题账 R1-C-013）。
// 用法：node --import tsx scripts/verify-arch-guard.ts（或 pnpm verify:arch-guard）
//
// 判词口径（TPL-09 §二 R1-ZS-003，五条全落）：
//   1) 不只会拦 replace []——任何 replace 的「旧 ID − 新 ID」差集都在写前核引用；
//   2) 引用核对基于**变更前现场**，不许先把旧边清空再判"无引用"；
//   3) 有引用 → 拒绝整次写入、返回被引用 ID 与来源、原文件逐字节不变（原子性：不许半写）；
//   4) 引用源读取失败 → fail-closed（拒绝，不按"无引用"放行）；
//   5) 无引用节点的正常清理与 append 语义保留（不把正常操作拦死）。
//
// 覆盖场景（全部纯执行器 + os.tmpdir() 临时 home/项目，不调模型、不起服务、不碰任何真实项目的 `.工作台`）：
//   a 判词反例复刻：先写有连线的补全节点再 replace 空集 → 拒绝 + 返回被引用 ID/来源 + 落盘逐字节不变；
//   b 部分 replace：差集含被引用 ID（保留 A/C、删 B，B 被边引用）→ 拒整次；
//   c 差集全是无引用 ID → 正常清删成功；
//   d append 含已存在 ID → 既有语义不变（跳过重复）；
//   e 引用源读取失败（chat-actions.jsonl 坏 JSON）→ fail-closed 拒绝，不放行；
//   g 引用源二/三：聊天动作 affected_ids / 变更记录 target=concept 指向被删概念 → 拒绝；
//   f 守卫只对 replace 生效：带引用的概念仍可 append，无 replace 写路径不受影响。
//
// 隔离与清理：夹具一律建在 `os.tmpdir()` 下的临时目录，跑完即删；注册表/补全层/引用源都落在临时 home 的
// 临时项目里，不读不写用户真实 TATAI_HOME 与任何纳管项目。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applySupplementInput, readSupplement } from "../src/arch/supplement";
import { WsError } from "../src/server/workstation";
import { addProject } from "../src/server/registry";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fail += 1;
    process.exitCode = 1;
  }
};

// 临时数据目录（不碰真实 TATAI_HOME 与真实项目）
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-arch-guard-"));
console.log(`[verify] 临时夹具根：${tmpBase}`);

interface Fixture {
  id: string;
  home: string;
  supFile: string;
  workDir: string;
}

/** 每个场景一个隔离项目（各自的 supplement.json / work 目录，互不串扰） */
function makeProject(id: string): Fixture {
  const home = path.join(tmpBase, `home-${id}`);
  const proj = path.join(tmpBase, `proj-${id}`);
  fs.mkdirSync(path.join(proj, ".工作台", "arch"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".工作台", "work"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  addProject({ id, name: id, path: proj, kind: "backend" }, home);
  // 解析层空骨架（补全层独挑，聚焦守卫口径）；边端点校验的 known 集只需补全节点
  fs.writeFileSync(
    path.join(proj, ".工作台", "arch", "modules.json"),
    JSON.stringify({ version: 1, modules: [], budget_exhausted: false }),
    "utf8",
  );
  return {
    id,
    home,
    supFile: path.join(proj, ".工作台", "arch", "supplement.json"),
    workDir: path.join(proj, ".工作台", "work"),
  };
}

/** 落盘件字节（不存在按空 Buffer，供"逐字节不变"断言） */
const supBytes = (p: string): Buffer => (fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0));

/** 跑一次写入并抓拒绝错误（成功返回 null） */
function captureReject(fn: () => unknown): WsError | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof WsError ? e : (e as WsError);
  }
}

// ══════════════════════════ a 判词反例复刻：有连线 → replace 空集 ══════════════════════════
console.log("\n[verify] ── a 判词反例复刻：有连线的补全节点 replace 空集 → 拒绝 + 原件逐字节不变");
{
  const p = makeProject("a");
  const rec = applySupplementInput(
    p.id,
    {
      nodes: [
        { id: "bus", name: "消息总线" },
        { id: "gw", name: "网关" },
        { id: "db", name: "库" },
      ],
      edges: [
        { from: "bus", to: "gw" },
        { from: "gw", to: "db" },
      ],
      mode: "replace",
    },
    p.home,
  );
  ok(rec.added_nodes === 3 && rec.added_edges === 2, `a 先写入 3 个有连线的补全节点（+${rec.added_nodes} 节点 / +${rec.added_edges} 边）`);
  const before = supBytes(p.supFile);
  const err = captureReject(() => applySupplementInput(p.id, { nodes: [], edges: [], mode: "replace" }, p.home));
  ok(err !== null && err.code === "ARCH_SUPPLEMENT_REFERENCED", `a replace 空集被拒（错误码 ${err?.code ?? "无"}）`);
  const msg = err?.message ?? "";
  ok(
    msg.includes("chat:bus") && msg.includes("chat:gw") && msg.includes("chat:db"),
    "a 返回被引用的 ID 列表（chat:bus / chat:gw / chat:db）",
  );
  ok(msg.includes("补全层边 chat:bus→chat:gw") && msg.includes("引用来源"), "a 返回引用来源（补全层边）");
  ok(msg.includes("变更记录"), "a 明确指向「须走变更记录」路径，未伪造该路径已实现");
  const after = supBytes(p.supFile);
  ok(before.length > 0 && before.equals(after), "a 落盘文件与拒前逐字节相同（原子性：不许半写）");
}

// ══════════════════════════ b 部分 replace：差集含被引用 ID ══════════════════════════
console.log("\n[verify] ── b 部分 replace：保留 A/C、删 B（B 被边 b→c 引用）→ 拒整次");
{
  const p = makeProject("b");
  applySupplementInput(
    p.id,
    {
      nodes: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
      edges: [{ from: "b", to: "c" }],
      mode: "replace",
    },
    p.home,
  );
  const before = supBytes(p.supFile);
  const err = captureReject(() =>
    applySupplementInput(
      p.id,
      {
        nodes: [
          { id: "a", name: "A" },
          { id: "c", name: "C" },
        ],
        mode: "replace",
      },
      p.home,
    ),
  );
  ok(err !== null && err.code === "ARCH_SUPPLEMENT_REFERENCED", `b 差集含被引用的 chat:b → 拒整次（错误码 ${err?.code ?? "无"}）`);
  const msg = err?.message ?? "";
  ok(msg.includes("chat:b（引用来源") && !msg.includes("chat:a（引用来源"), "b 只报被引用的 chat:b，不误列未移除的 chat:a");
  ok(before.equals(supBytes(p.supFile)), "b 原文件逐字节不变（不为差集里未引用部分半写）");
}

// ══════════════════════════ c 差集全无引用 → 正常清删 ══════════════════════════
console.log("\n[verify] ── c 差集全是无引用 ID → 正常清删成功");
{
  const p = makeProject("c");
  applySupplementInput(
    p.id,
    {
      nodes: [
        { id: "x", name: "X" },
        { id: "y", name: "Y" },
      ],
      mode: "replace",
    },
    p.home,
  );
  const rec = applySupplementInput(p.id, { nodes: [], edges: [], mode: "replace" }, p.home);
  ok(rec.total_nodes === 0 && rec.total_edges === 0, `c 无引用两个节点正常清删（total_nodes=${rec.total_nodes}）`);
  const after = readSupplement(p.id, p.home);
  ok(after !== null && after.nodes.length === 0, "c 落盘确认已清空（正常清理不被拦死）");
}

// ══════════════════════════ d append 含已存在 ID → 既有语义不变 ══════════════════════════
console.log("\n[verify] ── d append 含已存在 ID → 既有语义不变（跳过重复）");
{
  const p = makeProject("d");
  const r1 = applySupplementInput(
    p.id,
    {
      nodes: [
        { id: "bus", name: "总线" },
        { id: "gw", name: "网关" },
      ],
      edges: [{ from: "bus", to: "gw" }],
    },
    p.home,
  );
  const r2 = applySupplementInput(p.id, { nodes: [{ id: "bus", name: "总线" }] }, p.home);
  ok(r1.added_nodes === 2 && r1.added_edges === 1, `d 首次 append 落 2 节点 1 边（+${r1.added_nodes}/+${r1.added_edges}）`);
  ok(r2.added_nodes === 0 && r2.skipped_duplicate_nodes === 1, `d 再 append 已存在 id → 跳过重复（added=${r2.added_nodes}、skipped=${r2.skipped_duplicate_nodes}），未被守卫拦`);
  ok((readSupplement(p.id, p.home)?.nodes.length ?? 0) === 2, "d append 语义不变（原有节点仍在）");
}

// ══════════════════════ e 引用源读取失败（坏 JSON）→ fail-closed ══════════════════════
console.log("\n[verify] ── e 引用源读取失败（chat-actions.jsonl 坏 JSON）→ fail-closed 拒绝，不放行");
{
  const p = makeProject("e");
  applySupplementInput(p.id, { nodes: [{ id: "lonely", name: "孤立" }], mode: "replace" }, p.home); // 无引用节点
  const before = supBytes(p.supFile);
  fs.writeFileSync(path.join(p.workDir, "chat-actions.jsonl"), "{ 这不是合法 JSON\n", "utf8"); // 坏夹具
  const err = captureReject(() => applySupplementInput(p.id, { nodes: [], edges: [], mode: "replace" }, p.home));
  ok(
    err !== null && err.code === "ARCH_SUPPLEMENT_REF_UNREADABLE",
    `e 引用源坏 JSON → 拒绝（错误码 ${err?.code ?? "无"}），不按"无引用"放行`,
  );
  ok(before.equals(supBytes(p.supFile)), "e 原文件逐字节不变");
}

// ══════════════════════ g 引用源二/三：动作回执 / 变更记录 ══════════════════════
console.log("\n[verify] ── g 引用源二/三：聊天动作 affected_ids / 变更记录 target=concept → 拒绝");
{
  // ② 聊天动作记录 affected_ids
  const p1 = makeProject("g1");
  applySupplementInput(p1.id, { nodes: [{ id: "z", name: "Z" }], mode: "replace" }, p1.home);
  fs.writeFileSync(
    path.join(p1.workDir, "chat-actions.jsonl"),
    JSON.stringify({ action_id: "act-g1", project_id: p1.id, affected_ids: ["chat:z"], tool_receipts: [] }) + "\n",
    "utf8",
  );
  const e1 = captureReject(() => applySupplementInput(p1.id, { nodes: [], edges: [], mode: "replace" }, p1.home));
  ok(
    e1 !== null && e1.code === "ARCH_SUPPLEMENT_REFERENCED" && e1.message.includes("chat:z") && e1.message.includes("聊天动作 act-g1"),
    `g 聊天动作 affected_ids 指向 chat:z → 拒绝且写明来源（错误码 ${e1?.code ?? "无"}）`,
  );

  // ③ 变更/问题记录 target=concept
  const p2 = makeProject("g2");
  applySupplementInput(p2.id, { nodes: [{ id: "y", name: "Y" }], mode: "replace" }, p2.home);
  fs.writeFileSync(
    path.join(p2.workDir, "chat-changes.jsonl"),
    JSON.stringify({ change_id: "chg-g2", kind: "issue", target: { kind: "concept", id: "chat:y" } }) + "\n",
    "utf8",
  );
  const e2 = captureReject(() => applySupplementInput(p2.id, { nodes: [], edges: [], mode: "replace" }, p2.home));
  ok(
    e2 !== null && e2.code === "ARCH_SUPPLEMENT_REFERENCED" && e2.message.includes("变更/问题记录 chg-g2"),
    `g 变更记录 target=concept 指向 chat:y → 拒绝（错误码 ${e2?.code ?? "无"}）`,
  );

  // 否定对照：引用记录指向**别的** id（不在差集里）不拦正常清理
  const p3 = makeProject("g3");
  applySupplementInput(p3.id, { nodes: [{ id: "free", name: "Free" }], mode: "replace" }, p3.home);
  fs.writeFileSync(
    path.join(p3.workDir, "chat-actions.jsonl"),
    JSON.stringify({ action_id: "act-g3", affected_ids: ["chat:other"], tool_receipts: [] }) + "\n",
    "utf8",
  );
  const r3 = applySupplementInput(p3.id, { nodes: [], edges: [], mode: "replace" }, p3.home);
  ok(r3.total_nodes === 0, "g 引用记录指向别的 id 时不妨碍无引用节点清理（total_nodes=0）");
}

// ══════════════════ f 守卫只对 replace 生效：append 无 replace 路径不受影响 ══════════════════
console.log("\n[verify] ── f 守卫只对 replace 生效：带引用的概念仍可 append");
{
  const p = makeProject("f");
  applySupplementInput(p.id, { nodes: [{ id: "hub", name: "Hub" }], mode: "append" }, p.home);
  fs.writeFileSync(
    path.join(p.workDir, "chat-actions.jsonl"),
    JSON.stringify({ action_id: "act-f", affected_ids: ["chat:hub"], tool_receipts: [] }) + "\n",
    "utf8",
  );
  const r = applySupplementInput(p.id, { nodes: [{ id: "new", name: "New" }], mode: "append" }, p.home);
  ok(r.added_nodes === 1 && r.total_nodes === 2, `f append 不受守卫影响（+${r.added_nodes} 节点，共 ${r.total_nodes}）`);
  // 对照：同项目 replace 删被引用的 chat:hub → 被拒（证明守卫确实挂在 replace 上）
  const err = captureReject(() =>
    applySupplementInput(p.id, { nodes: [{ id: "new", name: "New" }], mode: "replace" }, p.home),
  );
  ok(err !== null && err.code === "ARCH_SUPPLEMENT_REFERENCED", `f 同项目 replace 删 chat:hub → 拒（错误码 ${err?.code ?? "无"}）`);
}

// ── 清理临时夹具 ──
try {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] 临时夹具已删除");
} catch {
  console.log(`[verify] 临时夹具删除失败（Windows 偶发占用，残留无害）：${tmpBase}`);
}

console.log(`\n[verify] 结果：${pass} PASS / ${fail} FAIL`);
