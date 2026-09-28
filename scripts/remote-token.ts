// 三期 S1：远程访问口令的小 CLI（PLAN.md S1 卡「鉴权模块」的取用面）。
//
// 用法：
//   pnpm remote:token           # 查看当前口令与到期时间（没有就现签一枚）
//   pnpm remote:token rotate    # 轮换：旧口令立刻失效（所有既有会话一并作废）
//
// 为什么要有它：口令只落全局数据目录 `<dataDir>/remote/auth.json`，服务端启动日志**不打印口令本体**
// （日志会被复制/贴出去）；用户要把它填进手机或另一台设备的请求头，就用这个命令在本机控制台取。
// 隐私（AGENTS.md §6）：只读写全局数据目录，不碰任何项目目录、不写仓库。
import { AuthService, permissionHint } from "../src/server/auth";
import { resolveDataDir } from "../src/server/registry";
import {
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_TOKEN_TTL_MS,
  lanAddresses,
  resolveRemoteConfig,
  tokenFilePath,
} from "../src/server/remote-config";

const action = (process.argv[2] ?? "show").trim();

function main(): number {
  const dataDir = resolveDataDir();
  if (action !== "show" && action !== "rotate") {
    console.error(`[remote-token] 不认识的动作: ${JSON.stringify(action)}（只接受 show / rotate）`);
    return 2;
  }

  // 口令 TTL 沿用与后端同一份配置解析（同一环境变量口径，别在两处各算一遍）
  let tokenTtlMs = DEFAULT_TOKEN_TTL_MS;
  let sessionTtlMs = DEFAULT_SESSION_TTL_MS;
  try {
    const cfg = resolveRemoteConfig(process.env);
    tokenTtlMs = cfg.tokenTtlMs;
    sessionTtlMs = cfg.sessionTtlMs;
  } catch (e) {
    console.error(`[remote-token] 环境里的远程配置本身违规：${(e as Error).message}`);
    return 1;
  }

  const auth = new AuthService({ dataDir, tokenTtlMs, sessionTtlMs });
  const created = action === "rotate" ? false : auth.load() === null;
  const record = action === "rotate" ? auth.rotateToken() : auth.ensureToken().record;

  console.log(`[remote-token] 口令文件：${tokenFilePath(dataDir)}`);
  console.log(`[remote-token] ${permissionHint(dataDir)}`);
  if (action === "rotate") console.log("[remote-token] 已轮换：旧口令与所有会话立即失效");
  else if (created) console.log("[remote-token] 此前没有口令，已新签一枚");
  console.log(`[remote-token] 签发时间：${record.created_at}${record.rotated_at ? `（最近轮换 ${record.rotated_at}）` : ""}`);
  console.log(`[remote-token] 到期时间：${record.expires_at}`);
  console.log(`[remote-token] 口令（Bearer）：${record.token}`);
  console.log("[remote-token] ↑ 是密钥：不要贴进聊天/截图/仓库；只在你要授权的设备上填一次");
  console.log(`[remote-token] 用法：curl -H "Authorization: Bearer <口令>" http://<局域网 IP>:8787/health`);
  for (const { iface, address } of lanAddresses()) {
    console.log(`[remote-token] 本机局域网地址：${address}（${iface}）`);
  }
  return 0;
}

process.exit(main());
