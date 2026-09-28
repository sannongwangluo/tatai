// 补修 A（V06-14）验证夹具：跨进程并发读写者（由 scripts/verify-v06-14-a.ts 起子进程调用）。
// 用法：tsx scripts/verify-v06-14-a-worker.ts write <tag> <count> <dataDir>
//       tsx scripts/verify-v06-14-a-worker.ts read  <tag> <reads> <dataDir>
// 为什么单开一个进程：进程内 `Promise.all` 走的是同一把同步文件锁，压不出跨进程交错；
// "一次普通登记不许把历史清零 / 不许丢更新"必须由**真两个进程**压出来才作数。
import path from "node:path";
import { addProject, listProjects, resolveDataDir } from "../src/server/registry";

const [mode = "", tag = "X", nArg = "10", dirArg = ""] = process.argv.slice(2);
const dataDir = dirArg !== "" ? dirArg : resolveDataDir();
const n = Number(nArg);

if (mode === "write") {
  for (let i = 0; i < n; i++) {
    addProject(
      {
        id: `${tag}-${i}`,
        name: `并发夹具 ${tag}-${i}`,
        path: path.resolve(dataDir, "..", "proj", tag, String(i)),
        kind: "backend",
      },
      dataDir,
    );
  }
  console.log(`[worker-${tag}] 登记 ${n} 个项目完成`);
} else if (mode === "read") {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  const errors: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const len = listProjects(dataDir).length;
      min = Math.min(min, len);
      max = Math.max(max, len);
    } catch (e) {
      errors.push(`${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  console.log(
    `[worker-${tag}] ${JSON.stringify({ tag, reads: n, min, max, errors })}`,
  );
} else {
  console.error(`[worker] 未知 mode: ${JSON.stringify(mode)}（只认 write / read）`);
  process.exitCode = 1;
}
