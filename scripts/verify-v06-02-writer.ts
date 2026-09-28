// V06-02 验证夹具：并发改稿/激活的第二个进程（由 scripts/verify-v06-02.ts 起子进程调用）。
// 用法：tsx scripts/verify-v06-02-writer.ts <tag> <dataDir> <projectId> <mode>
//
// 为什么必须是**真子进程**：跨进程的"读—改—写"交错在单进程里用 Promise.all 压不出来
// （JS 单线程，await 之间不会真的并行）。本卡要证明的是「并发改稿不覆盖」——
// 于是让这个进程拿着**改稿前**的草稿哈希去激活，主进程在同一窗口里改稿并先激活成功，
// 它必须被 VERSION_CONFLICT 拒绝，且不得覆盖主进程写下的任何字节。
//
// mode：
//   stale   读一次两图纸 → 落 ready 标记 → 等 go 标记 → 用改稿前的哈希激活，期望被拒（exit 0）
//   current 现读现激活，期望成功（exit 0）；被并发对手抢先而撞上冲突也算如实（exit 4）
import fs from "node:fs";
import path from "node:path";
import { WorkError } from "../src/server/work/types";
import { activateBaseline, loadDocument } from "../src/server/work/documents";

const [tag = "X", dataDir = "", projectId = "", mode = "current"] = process.argv.slice(2);
if (dataDir === "" || projectId === "") {
  console.error("[writer] 用法: verify-v06-02-writer.ts <tag> <dataDir> <projectId> <mode>");
  process.exit(2);
}

const readyFile = path.join(dataDir, `ready-${tag}`);
const goFile = path.join(dataDir, `go-${tag}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const approval = {
  approved_by: "gpt-6",
  approval_basis: "并发夹具：用户已委派的技术审定（§2.9）",
  approval_kind: "delegated_technical_review" as const,
};

async function snapshotExpected(): Promise<Record<string, string>> {
  const design = loadDocument(projectId, "design", dataDir);
  const plan = loadDocument(projectId, "plan", dataDir);
  if (design === null || plan === null) {
    console.error(`[writer-${tag}] 图纸缺失，夹具准备不完整`);
    process.exit(5);
  }
  return {
    design_source_path: design.source.rel_path,
    design_content_sha256: design.revision.content_sha256,
    plan_source_path: plan.source.rel_path,
    plan_definition_sha256: plan.revision.definition_sha256,
  };
}

if (mode === "stale") {
  const expected = await snapshotExpected();
  fs.writeFileSync(readyFile, JSON.stringify(expected), "utf8");
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(goFile)) break;
    await sleep(50);
  }
  if (!fs.existsSync(goFile)) {
    console.error(`[writer-${tag}] 等 go 标记超时`);
    process.exit(6);
  }
  try {
    const r = activateBaseline(projectId, { ...approval, expected }, dataDir);
    console.error(`[writer-${tag}] 期望被拒，实际激活成功（baseline=${r.baseline.baseline_id}，created=${r.created}）`);
    process.exit(3);
  } catch (e) {
    if (e instanceof WorkError && e.code === "VERSION_CONFLICT") {
      console.log(`WRITER_${tag}_STALE_REJECTED code=VERSION_CONFLICT changed=${JSON.stringify(e.detail.changed)}`);
      process.exit(0);
    }
    console.error(`[writer-${tag}] 期望 VERSION_CONFLICT，实际 ${(e as Error).message}`);
    process.exit(7);
  }
}

// mode === "current"
const expected = await snapshotExpected();
try {
  const r = activateBaseline(projectId, { ...approval, expected }, dataDir);
  console.log(`WRITER_${tag}_ACTIVATED baseline=${r.baseline.baseline_id} created=${r.created}`);
  process.exit(0);
} catch (e) {
  if (e instanceof WorkError && e.code === "VERSION_CONFLICT") {
    console.log(`WRITER_${tag}_VERSION_CONFLICT`);
    process.exit(4);
  }
  console.error(`[writer-${tag}] 激活失败：${(e as Error).message}`);
  process.exit(7);
}
