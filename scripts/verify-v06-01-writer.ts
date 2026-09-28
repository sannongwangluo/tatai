// V06-01 验证夹具：并发写入者（由 scripts/verify-v06-01.ts 起两个子进程调用）。
// 用法：tsx scripts/verify-v06-01-writer.ts <tag>
// 只做一件事：以 <tag> 为前缀**并发**提交 10 条命令，全成功 exit 0。
// 存在的意义：唯一写入服务的"序号无重号无洞"必须由**真两个进程**压出来，
// 单进程内的 Promise.all 是串行的，压不出跨进程交错。
import { WorkServiceClient } from "../src/server/work/service";
import { resolveDataDir } from "../src/server/registry";

const tag = process.argv[2] ?? "X";
const client = new WorkServiceClient({ dataDir: resolveDataDir() });

const jobs = Array.from({ length: 10 }, (_, i) =>
  client.submit({
    schema_version: 2,
    project_id: "v06-proj",
    change_id: "chg-v06-01",
    entity_id: `conc-${tag}-${i}`,
    expected_revision: null,
    type: "task.created",
    actor_id: `writer-${tag}`,
    role: "executor",
    idempotency_key: `conc-${tag}-${i}`,
    payload: { i },
  }),
);

const settled = await Promise.allSettled(jobs);
const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
if (failed.length > 0) {
  console.error(
    `${failed.length} 条并发提交失败：` +
      failed.map((f) => f.reason?.message ?? String(f.reason)).join(" | "),
  );
  process.exit(1);
}
