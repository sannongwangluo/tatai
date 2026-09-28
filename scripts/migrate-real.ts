// migrate-real：V07-03 真实项目迁移执行器（preview → backup → apply → validate ＋ 对账输出）。
// 用法：node --import tsx scripts/migrate-real.ts --project brain-memory --by "用户" --basis "2026-09-22 授权 v0.7 整轮"
// 红线：授权人与依据写进备份 manifest 留痕；任何一步失败立即停，不带病继续。
import { applyMigration, previewMigration, validateMigration } from "../src/server/work/migrate";

function argOf(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const project = argOf("project");
  const by = argOf("by");
  const basis = argOf("basis");
  if (project === null || by === null || basis === null) {
    console.error("用法：migrate-real.ts --project <id> --by <授权人> --basis <授权依据>");
    process.exit(2);
  }
  const real = { authorized_by: by, basis };

  console.log(`\n== ① preview（零写入）：${project}`);
  const preview = previewMigration(project, undefined, { real });
  for (const w of preview.warnings) console.log(`  ⚠ ${w}`);
  for (const t of preview.tasks) {
    console.log(
      `  ${t.v1.id}: v1=${t.v1.status} → ${t.event !== null ? `${t.event.type}（${t.status}）` : `跳过（${t.skip_reason}）`}`,
    );
  }

  console.log(`\n== ② backup＋apply：${project}`);
  const applied = applyMigration(project, undefined, { real });
  console.log(`  备份 ${applied.backup.backup_id}（${applied.backup.files.length} 件）；回执 ${applied.receipts.length} 条；跳过 ${applied.skipped.length} 条`);
  for (const s of applied.skipped) console.log(`  跳过 ${s.task_id}：${s.reason}`);

  console.log(`\n== ③ validate：${project}`);
  const validated = validateMigration(project, undefined, { real });
  for (const c of validated.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}：${c.detail}`);
  if (!validated.ok) {
    console.error(`validate 有 ${validated.problems.length} 项不过，迁移现场保留待排查（rollback 可回 v1）`);
    process.exit(1);
  }
  console.log(`\n迁移完成：${project}（v1 台账已备份，v2 投影生效，list_tasks 与事件流同源）`);
}

main().catch((e) => {
  console.error("migrate-real 失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
