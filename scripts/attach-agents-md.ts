// attach-agents-md CLI（M3；V06-10 改为标记区收敛）：把塔台入口规则接到被纳管项目的 AGENTS.md
// ——客户端实际会载入的那个文件（DESIGN.md §6.2 / §6.7）。
// 用法：pnpm attach:agents-md -- <project_id>
// 口径：没有标记段 → 末尾追加；标记段过期 → **只替换标记区**（用户自写规则一字不动）；
//      标记段已与模板一致 → 一个字节都不写（命令退出码仍为 0，回执里说清"没改"）。
import { attachAgentsMd } from "../src/server/attachAgentsMd";

const projectId = process.argv.slice(2).find((a) => a !== "--")?.trim();
if (!projectId) {
  console.error("用法: pnpm attach:agents-md -- <project_id>");
  process.exit(1);
}

try {
  const result = attachAgentsMd(projectId);
  if (!result.inserted) {
    console.log(`[attach] 标记区已与模板一致，逐字节未改: ${result.file}`);
  } else if (result.updated) {
    console.log(`[attach] 已收敛标记区（用户自写规则未动）: ${result.file}`);
  } else {
    console.log(
      `[attach] 已接入: ${result.file}${result.created ? "（AGENTS.md 不存在，已建最小骨架）" : ""}`,
    );
  }
} catch (e) {
  console.error(`[attach] 失败: ${(e as Error).message}`);
  process.exit(1);
}
