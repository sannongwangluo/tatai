// verify-v07-03：v2 迁移收口（真实项目授权闸 ＋ 空台账切换 ＋ 投影同源 ＋ 历史回放幂等）。
//   ① 授权闸：无声明拒；isolated:true 过；real:{authorized_by,basis} 过且写进备份 manifest
//   ② 合成 v1 项目全流程（real 通道）：apply→validate 全过；tasks.json 带 v2 投影标记；
//      list_tasks 与 v2 状态同源同账（done→result_submitted 只到这一级，不冒充验收）
//   ③ 回放幂等：同一确定性幂等键重发 → 原回执，事件数不增
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigration, previewMigration, validateMigration, readBackupManifest, MIGRATION_BACKUP_DIRNAME } from "../src/server/work/migrate";
import { readTaskStates } from "../src/server/work/tasks";
import { loadEvents } from "../src/server/work/eventStore";
import { listTasksTool } from "../src/mcp/tools/listTasks";
import { WorkService as Service } from "../src/server/work/service";

const results: Array<[boolean, string]> = [];
const check = (ok: boolean, msg: string): void => {
  results.push([ok, msg]);
  console.log(`[verify] ${ok ? "PASS" : "FAIL"} ${msg}`);
};

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "v0703-verify-"));
  const projRoot = path.join(dataDir, "proj");
  const bench = path.join(projRoot, ".工作台");
  fs.mkdirSync(bench, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "registry.json"),
    JSON.stringify({
      version: 1,
      projects: [
        { id: "v0703", name: "V07-03 夹具", path: projRoot, kind: "backend", registered_at: "2026-09-22T00:00:00+08:00", last_opened_at: "2026-09-22T00:00:00+08:00" },
      ],
    }),
  );
  process.env.TATAI_HOME = dataDir;
  fs.writeFileSync(
    path.join(bench, "tasks.json"),
    JSON.stringify(
      {
        version: 1,
        tasks: [
          { id: "F-1", title: "已完成卡", module_id: "", status: "done", reporter: "fixture", updated_at: "2026-09-21T00:00:00+08:00", note: "历史交付" },
          { id: "F-2", title: "未动工卡", module_id: "", status: "todo", reporter: "fixture", updated_at: "2026-09-21T00:00:00+08:00" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(bench, "progress.json"), JSON.stringify({ version: 1, current_step: "develop", modules: [] }), "utf8");
  const workDir = path.join(bench, "work");

  // ── ① 授权闸 ──
  {
    let rejected = false;
    try {
      previewMigration("v0703");
    } catch {
      rejected = true;
    }
    check(rejected, "① 无声明 → 迁移拒绝（默认只服务隔离夹具）");
    const real = { authorized_by: "用户", basis: "2026-09-22 授权 v0.7 整轮施工" };
    const p = previewMigration("v0703", dataDir, { real });
    check(p.tasks.length === 2, `① real 声明过闸：预览 ${p.tasks.length} 张 v1 卡`);
  }

  // ── ② 全流程（real 通道） ──
  {
    const real = { authorized_by: "用户", basis: "2026-09-22 授权 v0.7 整轮施工" };
    const applied = applyMigration("v0703", dataDir, { real });
    check(applied.receipts.length >= 1, `② apply 提交 ${applied.receipts.length} 条事件`);
    const validated = validateMigration("v0703", dataDir, { real });
    check(validated.ok && validated.problems.length === 0, `② validate 全过（${validated.checks.length} 项检查）`);
    const manifest = readBackupManifest("v0703", applied.backup.backup_id, dataDir);
    check(
      manifest.authorization?.authorized_by === "用户" && manifest.authorization.basis.includes("v0.7"),
      "② 备份 manifest 留痕授权（authorized_by/basis 原样在案）",
    );
    const states = readTaskStates(workDir).states;
    check(states["F-1"]?.status === "result_submitted", "② v1 done → v2 result_submitted（只到这一级，不冒充验收）");
    check(states["F-2"]?.status === "preparing" || states["F-2"] === undefined, "② v1 todo → 未开工（不无中生有）");
    const out = await listTasksTool.handler({ project_id: "v0703" });
    const parsed = JSON.parse((out.content ?? [{}])[0]?.text ?? "{}") as {
      tasks?: Array<{ id: string; status: string }>;
      projection?: unknown;
    };
    check(
      parsed.tasks?.some((t) => t.id === "F-1" && t.status === "done") === true && parsed.projection != null,
      "② list_tasks 读到同源投影（F-1 done + projection 来源声明）",
    );
  }

  // ── ③ 回放幂等 ──
  {
    const service = new Service({ dataDir });
    const cmd = {
      schema_version: 2,
      project_id: "v0703",
      change_id: "change-none",
      entity_id: "task:F-1",
      type: "task.result_submitted",
      expected_revision: readTaskStates(workDir).states["F-1"]?.revision ?? null,
      actor_id: "verify",
      role: "coordinator",
      idempotency_key: "v0703-idem-test:1",
      payload: { deliverables: ["幂等验证"], evidence_refs: ["progress.json"], meaning: "测试" },
    };
    const r1 = service.submit(cmd);
    const before = loadEvents(workDir).events.length;
    const r2 = service.submit(cmd);
    const after = loadEvents(workDir).events.length;
    check(r2.duplicate === true && r2.event_id === r1.event_id && after === before, "③ 同幂等键重发 → 原回执零新增（回放脚本可安全重跑）");
  }

  if (process.env.TATAI_KEEP_TMP !== "1") {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log("[verify] 已清理隔离夹具目录（TATAI_KEEP_TMP=1 可保留现场）");
  }
  void MIGRATION_BACKUP_DIRNAME;
  const fail = results.filter(([ok]) => !ok).length;
  console.log(`\n[verify] V07-03 结果：${results.length - fail} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[verify] 运行失败：", e);
  process.exit(1);
});
