// verify-v07-02：状态机工具面补全（PLAN V07-02）。
//   A 绑定导入回归：带 definition_change_id 绑定导入 → 读侧对齐零待重绑（固化 2026-09-21 缺陷①）
//   B 彩排闸：手工拼假哈希的 definition_imported → 服务边界拒收、零字节
//   C rebind_task e2e：改图纸制造合法待重绑 → 工具处置 → 对齐复洁、事件留痕
//   D 工具校验分支：未知任务点名拒；已绑定无需重绑
//   E 事件面检查：全登记绿；抽走 rebind_task 工具（破坏性试验）必须红
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkService } from "../src/server/work/service";
import { importTaskDefinitions, taskDefinitionHash } from "../src/server/work/plan";
import { alignDefinitionsAndStates, readTaskStates } from "../src/server/work/tasks";
import { loadDocument } from "../src/server/work/documents";
import { loadEvents } from "../src/server/work/eventStore";
import { rebindTaskTool } from "../src/mcp/tools/rebindTask";
import { checkEventSurface } from "./check-event-surface";
import { TOOLS } from "../src/mcp/tools/index";

const results: Array<[boolean, string]> = [];
const check = (ok: boolean, msg: string): void => {
  results.push([ok, msg]);
  console.log(`[verify] ${ok ? "PASS" : "FAIL"} ${msg}`);
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLAN_V1 = [
  "# 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-A | todo | 夹具卡A初版 | 施工授权 | 未施工 |",
  "",
  "### T-A 夹具卡A",
  "",
  "**设计依据**：§2.6。**依赖**：施工授权。",
  "",
  "- [ ] 检查项一",
  "",
].join("\r\n");

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "v0702-verify-"));
  const projRoot = path.join(dataDir, "proj");
  const workbench = path.join(projRoot, ".工作台");
  fs.mkdirSync(workbench, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "registry.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "v0702",
          name: "V07-02 验证夹具",
          path: projRoot,
          kind: "backend",
          registered_at: "2026-09-22T00:00:00+08:00",
          last_opened_at: "2026-09-22T00:00:00+08:00",
        },
      ],
    }),
  );
  process.env.TATAI_HOME = dataDir;
  fs.writeFileSync(path.join(workbench, "plan.md"), PLAN_V1, "utf8");

  const service = new WorkService({ dataDir });
  const workDir = path.join(workbench, "work");
  const eventCount = () => {
    try {
      return loadEvents(workDir).events.length;
    } catch {
      return 0;
    }
  };
  const planDoc = () => loadDocument("v0702", "plan", dataDir)!;
  const parseDefs = () => {
    const p = planDoc();
    return importTaskDefinitions(p.text, { plan_revision: p.revision.content_sha256 }).definitions;
  };
  const alignNow = () => {
    const p = planDoc();
    return alignDefinitionsAndStates(parseDefs(), readTaskStates(workDir).states, p.revision.content_sha256);
  };
  const envelope = {
    schema_version: 2,
    project_id: "v0702",
    change_id: "change-fixture",
    actor_id: "verify-v07-02",
    role: "coordinator",
    entity_id: "task:T-A",
    type: "task.definition_imported",
  } as const;

  // ── A 绑定导入回归 ──
  {
    // 先立批次（definition_change_id 的引用要在投影里对得上——C-015 一致校验面）
    const opened = await service.submit({
      schema_version: 2,
      project_id: "v0702",
      change_id: "change-fixture-bind",
      entity_id: "change:change-fixture-bind",
      type: "change.opened",
      expected_revision: null,
      actor_id: "verify-v07-02",
      role: "coordinator",
      idempotency_key: "v0702-a-change-open-1",
      payload: {
        goal: "夹具批次：验证绑定导入与重绑出口",
        authorized_scope: "仅本夹具",
        target_baseline: {
          baseline_id: null,
          design_revision: "0".repeat(64),
          plan_revision: "1".repeat(64),
        },
        affected_subsystems: ["夹具"],
        exit_criteria: "验证全绿",
      },
    });
    check(opened.ok, "A 夹具批次已立（绑定引用可解析）");
    const def = parseDefs().find((d) => d.task_id === "T-A")!;
    const boundDef = { ...def, change_id: "change-fixture-bind" };
    const r = await service.submit({
      ...envelope,
      expected_revision: null,
      idempotency_key: "v0702-a-import-1",
      payload: {
        definition_sha256: taskDefinitionHash(boundDef),
        plan_revision: planDoc().revision.content_sha256,
        definition_revision: 1,
        requirement_ids: null,
        definition_change_id: "change-fixture-bind",
      },
    });
    check(r.ok, `A 绑定导入提交成功（seq=${r.seq}）`);
    const align = alignNow();
    check(
      !align.needs_rebind.some((n) => n.task_id === "T-A"),
      `A 读侧对齐零待重绑（绑定哈希回放生效；needs_rebind=${align.needs_rebind.length}）`,
    );
  }

  // ── B 彩排闸 ──
  {
    const before = eventCount();
    let rejected = false;
    let message = "";
    try {
      await service.submit({
        ...envelope,
        expected_revision: 1,
        idempotency_key: "v0702-b-bogus-1",
        payload: {
          definition_sha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          plan_revision: planDoc().revision.content_sha256,
          definition_revision: 2,
          requirement_ids: null,
          definition_change_id: null,
        },
      });
    } catch (e) {
      rejected = true;
      message = e instanceof Error ? e.message : String(e);
    }
    check(rejected && message.includes("读侧现解析口径"), `B 彩排闸拒收假哈希导入（零字节：${eventCount() === before}）`);
    check(eventCount() === before, "B 拒收后事件数不变");
  }

  // ── C rebind_task e2e ──
  {
    fs.writeFileSync(
      path.join(workbench, "plan.md"),
      PLAN_V1.replace("夹具卡A初版", "夹具卡A修订版"),
      "utf8",
    );
    const stale = alignNow();
    check(
      stale.needs_rebind.some((n) => n.task_id === "T-A"),
      "C 改图纸后出现合法待重绑（定义真变了，§5.6）",
    );
    const ctx = {
      clientName: "verify-v0702",
      work: { submit: (command: unknown) => service.submit(command) },
    };
    const out = await rebindTaskTool.handler(
      { project_id: "v0702", task_id: "T-A", disposition: "continue", role: "executor" },
      ctx as never,
    );
    const parsed = JSON.parse((out.content ?? [{}])[0]?.text ?? "{}") as { ok?: boolean };
    check(parsed.ok === true, "C rebind_task 处置成功（task.rebound 落盘）");
    const after = alignNow();
    check(after.needs_rebind.length === 0, `C 处置后对齐复洁（needs_rebind=${after.needs_rebind.length}）`);
    const events = loadEvents(workDir).events;
    check(
      events.some((e) => e.type === "task.rebound" && e.payload?.disposition === "continue"),
      "C 事件流含 task.rebound（disposition=continue 留痕）",
    );
  }

  // ── D 工具校验分支 ──
  {
    const unknown = await rebindTaskTool.handler(
      { project_id: "v0702", task_id: "T-Z", disposition: "continue", role: "executor" },
      { clientName: "verify" } as never,
    );
    const unknownText = JSON.stringify(unknown).slice(0, 300);
    check(unknownText.includes("没有任务"), "D 未知任务点名拒绝");
    const again = await rebindTaskTool.handler(
      { project_id: "v0702", task_id: "T-A", disposition: "continue", role: "executor" },
      { clientName: "verify" } as never,
    );
    check(JSON.stringify(again).includes("无需重绑"), "D 已绑定当前定义 → 无需重绑（幂等口径）");
  }

  // ── E 事件面检查（含破坏性试验） ──
  {
    const green = checkEventSurface();
    check(green.ok, `E 事件面全覆盖（注册 ${green.covered} 种，问题 ${green.problems.length}）`);
    const sabotage = checkEventSurface(TOOLS.map((t) => t.name).filter((n) => n !== "rebind_task"));
    check(
      !sabotage.ok && sabotage.problems.some((p) => p.includes("task.rebound")),
      "E 破坏性试验：抽走 rebind_task 后检查必须红（点名 task.rebound 出口名存实亡）",
    );
  }

  if (process.env.TATAI_KEEP_TMP !== "1") {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log("[verify] 已清理隔离夹具目录（TATAI_KEEP_TMP=1 可保留现场）");
  }
  const fail = results.filter(([ok]) => !ok).length;
  console.log(`\n[verify] V07-02 结果：${results.length - fail} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[verify] 运行失败：", e);
  process.exit(1);
});
