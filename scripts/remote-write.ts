// 三期 S3：远程写模式的开关小 CLI（PLAN.md S3 卡 DoD①「二次确认」与 DoD③「关闭后立刻失效」的控制面）。
//
// 用法：
//   pnpm remote:write status                                   # 看当前写模式状态（含时段起点与开关文件路径）
//   pnpm remote:write off                                      # 关（立刻生效，不需要确认语）
//   pnpm remote:write on --confirm "我确认开启远程写模式"        # 开（要逐字确认语；且启动期必须已给双开关）
//
// 为什么是"文件 + CLI"而不是一个 HTTP 接口：服务只绑局域网 IP 时，**本机发出的请求来源也是那个局域网 IP**
// （不是回环），"主机专属接口"在 HTTP 面上立不住；而主机文件系统天然是信任边界——能写这个文件的进程本来就能
// 改这台机器。于是：远程设备永远打不开写模式（它碰不到这个文件），主机一条命令就能立刻关掉（DoD③）。
//
// 隐私（AGENTS.md §6）：只动全局数据目录 `<dataDir>/remote/write-mode.json`，不碰任何项目目录、不写仓库。
// 审计（DoD①）：每次真实翻转都由 `WriteModeController` 往 `<dataDir>/logs/remote-audit.jsonl`
// 记一条 `write-mode-on/off`（带时间戳与来源 `cli`）——那就是写模式时间段的边界。
import { RemoteAuditLog } from "../src/server/remote-audit";
import { resolveDataDir } from "../src/server/registry";
import { resolveRemoteConfig, WRITE_CONFIRM_PHRASE, WRITE_MODE_SWITCHES } from "../src/server/remote-config";
import { WriteModeController, writeModeStatePath, writeModeArmHint } from "../src/server/remote-write";

const action = (process.argv[2] ?? "status").trim().toLowerCase();

/** 从 `--confirm <值>` / `--confirm=<值>` 里取确认语 */
function confirmArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm") return argv[i + 1] ?? "";
    if (a.startsWith("--confirm=")) return a.slice("--confirm=".length);
  }
  return null;
}

function main(): number {
  const dataDir = resolveDataDir();
  if (!["status", "on", "off"].includes(action)) {
    console.error(`[remote-write] 不认识的动作: ${JSON.stringify(action)}（只接受 status / on / off）`);
    return 2;
  }
  const confirm = confirmArg(process.argv.slice(2));

  // 启动期口径：写模式能不能被运行期**打开**，取决于本次进程是否给了双开关（本 CLI 只能读环境变量，
  // 判定"当前服务进程是否 armed"由那边的 `cfg.writeEnabled` 决定——这里给的是"按当前环境重启后会不会 armed"）。
  // Q126（2026-09-19 审计）：**关**这条方向不再受这里影响——`setEnabled(false)` 的"值没变"判定看的是
  // 开关文件里写的值（不是 armed && 文件值），所以在本 CLI 没有环境变量的终端里跑 `off` 照样落盘生效。
  let armedByEnv = false;
  let cfgError: string | null = null;
  try {
    armedByEnv = resolveRemoteConfig(process.env).writeEnabled;
  } catch (e) {
    cfgError = (e as Error).message;
  }

  // 审计是 CLI 自己的旁路：写模式翻转要留痕，所以 CLI 也直接往同一份审计文件追加
  const audit = new RemoteAuditLog({ dataDir, repoRoot: process.cwd() });
  const ctl = new WriteModeController({ dataDir, startupEnabled: armedByEnv, audit });

  console.log(`[remote-write] 开关文件：${writeModeStatePath(dataDir)}`);
  if (cfgError) {
    console.log(`[remote-write] ⚠ 当前环境里的远程配置违规（${cfgError}）——` + "先把它改对再看状态");
  }

  if (action === "status") {
    const snap = ctl.snapshot();
    console.log(`[remote-write] 状态：写模式 ${snap.enabled ? "开" : "关（只读）"}`);
    console.log(`[remote-write] 启动期双开关（armed）：${snap.armed ? "已给" : "未给"}——未给时运行期打不开写模式`);
    console.log(`[remote-write] 时段起点：${snap.since}（来源 ${snap.source}）`);
    // Q94（2026-09-18 审计）：文件读不出来时不再静默——此前 status 也分不清"文件有效"与"文件坏了回落到 armed"
    if (snap.armed && snap.stateFileError) {
      console.log(
        `[remote-write] ⚠ ${snap.stateFileError}——**当前按「写模式关」算**（fail-closed）` +
          "：文件缺失/损坏时不再回落到启动期口径，要开得重新 on --confirm",
      );
    }
    console.log(`[remote-write] 审计：${audit.filePath()}（找 action=write-mode-on/off 这两类行圈时段）`);
    if (!snap.armed) console.log(`[remote-write] 要开写模式：${writeModeArmHint()}，然后重启后端`);
    return 0;
  }

  const result = ctl.setEnabled(action === "on", { by: "cli", confirm });
  if (!result.ok) {
    console.error(`[remote-write] 被拒 [${result.code}] ${result.message}`);
    if (result.code === "WRITE_CONFIRM_REQUIRED") {
      console.error(`[remote-write] 写法：pnpm remote:write on --confirm "${WRITE_CONFIRM_PHRASE}"`);
    }
    if (result.code === "WRITE_MODE_NOT_ARMED") {
      console.error(
        `[remote-write] 本次进程没 armed（双开关 = ${WRITE_MODE_SWITCHES.join(" + ")}）：` +
          "写模式只能显式开启，运行期不补票",
      );
    }
    return 1;
  }
  if (!result.changed) {
    console.log(`[remote-write] 写模式本来就是${action === "on" ? "开" : "关"}的：状态未变，未重复记时段边界`);
    return 0;
  }
  console.log(
    `[remote-write] 写模式已${action === "on" ? "打开" : "关闭"}；时段${action === "on" ? "起点" : "终点"} ` +
      `${result.snapshot.since}（已写审计）`,
  );
  if (action === "off") {
    console.log("[remote-write] 立即生效：运行中的后端**下一个写请求**就吃 403 REMOTE_READ_ONLY，不用重启");
  }
  return 0;
}

process.exit(main());
