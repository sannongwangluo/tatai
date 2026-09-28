// 本地 Node 服务的生命周期（U1 DoD②：谁拉起、谁回收，退出不留僵尸）。
//
// 拉起：
//   - dev（debug 构建）：工作目录 = 仓库根，跑 `pnpm dev:server`（= `tsx watch src/server/index.ts`，
//     与浏览器里 `pnpm dev` 用的**同一条后端配方**，不另抄一份）；
//   - 打包（release 构建）：工作目录 = 应用资源目录，跑 `node <resource_dir>/server/index.js`。
//     该入口由 U2 的 `pnpm build:server` 产出（`src-tauri/resources/server/`），经 `tauri.conf.json`
//     的 `bundle.resources` 落到 `<resource_dir>/server/`，正是这里找的路径；
//     入口不存在时打印明确报错并继续开窗口（不静默失败，也不假装服务起来了）。
//
// node 运行时口径（U2 定，理由见 src-tauri/README.md）：随包产物**复用系统 PATH 里的 node**，
// 不把 node.exe（单文件 ~80MB）打进安装包——打进去直接击穿 U3 卡的 3–10MB 体积目标。
// 打包分支因此先探一次 `node --version`：探不到就打一条能照做的报错，不留下"窗口开了但没数据"的哑谜。
//
// 回收（V09-14 改）：退出时收口整棵子树——① Windows Job Object 按句柄终止 Job 内全部进程
// （Job 置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，壳被**强杀**时由内核在句柄关闭时收口，
// 不依赖壳还能跑代码）；② `taskkill /PID <pid> /T /F` 保留为兜底（tsx watch 会再套一层子进程，
// 只 kill 直接子进程会留下孙进程僵尸）；随后 wait 回收句柄。Drop 兜住非正常退出路径。
// 收口原语在 `proc_tree.rs`（不依赖 tauri，验证用 launcher 编同一份）。
//
// 端口：TATAI_PORT（缺省 8787），透传给子进程；壳内前端要打同一个端口——由 [`api_origin_init_script`]
// 把**实际**端口注入窗口（`window.__TATAI_API_ORIGIN__`），前端口径见 src/ui/tauri-env.ts。
// spawn 之前先做**端口预检**（M-2）：已被监听就不拉，防止两代后端抢同一个端口。
//
// 探活（M-2/M-3）：/health 的等待放在后台线程（不拖开窗）；200 之外还做**应答方归属对账**
// （响应体的 pid 要对得上本轮子进程，防上一代残留后端冒名应答的假就绪）。
// 壳自身的诊断行在 release 下同步抄一份到 <全局数据目录>/logs/shell.log（M-4，见 shell_log）；
// 致命路径（端口被占、壳 panic）另走 shell_fatal——release 下再弹一次 MessageBox，
// 因为 GUI 子系统没有控制台，只落 stderr/shell.log 等于没说话（Q140/Q141）。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::proc_tree::{kill_tree, no_window, ProcTree};

/// 后端端口缺省值：与 `src/server/index.ts` 的 PORT 缺省、vite 代理缺省同口径。
pub const DEFAULT_PORT: u16 = 8787;

/// 等后端起来的时限：超时不阻断开窗（界面会显示连不上后端），但要如实打印。
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

/// 壳持有的子进程句柄 + 整棵子树的收口句柄。
/// `child` take() 过即为已回收，可重复调用 shutdown。
pub struct BackendProcess {
    child: Mutex<Option<Child>>,
    /// Windows Job Object：置 KILL_ON_JOB_CLOSE，壳一死由内核按它终止整棵后端子树（V09-14）。
    tree: ProcTree,
}

impl BackendProcess {
    fn new(child: Child, tree: ProcTree) -> Self {
        Self { child: Mutex::new(Some(child)), tree }
    }
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        // 兜底路径：**状态真被析构**时（正常返回、App 被回收等 Rust 真能跑到 drop 的路径）不留僵尸。
        // 它兜不住下面两条路，别把它当异常路径的保险（Q140，2026-09-19 二轮审计实锤；
        // 此前这里写"panic 展开"是错的，与同文件 shutdown 里的注释自相矛盾）：
        //   - release 构建是 `panic = "abort"`（Cargo.toml）：恐慌不展开，drop 不跑；
        //   - 壳被强杀（`taskkill /F`、任务管理器"结束进程"）：进程直接没了，drop 同样不跑。
        // V09-14（2026-09-25）起强杀那条路**不再留孤儿**：drop 不跑也无所谓，内核会在壳的
        // Job 句柄关闭时按 KILL_ON_JOB_CLOSE 终止整棵子树（`tree` 字段析构即关句柄）。
        // 这里保留显式 kill_tree，覆盖"能跑到析构、但 Job 没建起来"的降级情形。
        if let Some(mut child) = self.child.lock().unwrap().take() {
            kill_tree(&mut child);
        }
    }
}

fn port() -> u16 {
    std::env::var("TATAI_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// 注入窗口的初始化脚本：把本轮实际后端地址写进 `window.__TATAI_API_ORIGIN__`
/// （端口同 [`port`]，`TATAI_PORT` 覆盖时前后端一起走）。走 Tauri 的初始化脚本通道
/// （页面脚本执行前注入、不受页面 CSP 约束），前端 `src/ui/tauri-env.ts` 的 `apiBase()` 读它；
/// 读到非法值时那边退回写死的缺省地址。
pub fn api_origin_init_script() -> String {
    format!(
        "window.__TATAI_API_ORIGIN__ = \"http://127.0.0.1:{}\";",
        port()
    )
}

/// dev 下工作目录就是仓库根（src-tauri 的上一级），用仓库里已有的 dev:server 脚本。
fn dev_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("[tatai] src-tauri 之上应有仓库根")
        .to_path_buf()
}

/// 把 Windows 的 verbatim 路径（`\\?\D:\x`、`\\?\UNC\srv\share`）还原成普通形式——
/// 专供**传给 Node 的参数**用（Node 不认 `\\?\` 前缀，见上面 spawn 里的实证报错）。
/// 非 Windows 或本来就没有前缀时原样返回。
fn plain_path_arg(p: &Path) -> String {
    let raw = p.to_string_lossy().into_owned();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw
    }
}

// ██ M-4：壳自身诊断的落盘（release）██
// release 产物是 GUI 子系统（main.rs 的 windows_subsystem），双击启动没有控制台——壳自己的
// println!/eprintln! 与转发的后端日志一样会凭空消失（TS 侧同问题的解法是 backendLog.ts 把
// 后端 stdout 抄一份到 logs/backend.log，见那边注释）。这里同口径把**壳自身**的诊断行抄到
// `<全局数据目录>/logs/shell.log`；转发的后端日志（[tatai-server:*]）不重复落——那份已由
// TATAI_LOG_TO_FILE=1 落进 backend.log。数据目录口径与 TS 侧 registry.ts 的 resolveDataDir
// 一致：TATAI_HOME > ~/.tatai；Rust 侧不为此引依赖，用 %USERPROFILE% 拼 ~/.tatai
// （Windows 上 Node 的 os.homedir() 取的正是这个变量）。打不开文件就静默放弃——日志是旁路，
// 绝不拖累启动；dev（debug 构建）不落盘，行为与本卡之前逐字相同。

/// 全局数据目录（TATAI_HOME > ~/.tatai），口径对应 TS 侧 `registry.ts` 的 `resolveDataDir`。
fn global_data_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("TATAI_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join(".tatai"))
}

fn append_shell_log(msg: &str) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(dir) = global_data_dir().map(|d| d.join("logs")) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("shell.log"))
    else {
        return;
    };
    let _ = writeln!(file, "{msg}");
}

/// 壳自身诊断（正常路径）：控制台照打，release 下同步抄进 shell.log（M-4）。
fn shell_log(msg: &str) {
    println!("{msg}");
    append_shell_log(msg);
}

/// 壳自身诊断（出错路径）：走 stderr，其余同 [`shell_log`]。
fn shell_warn(msg: &str) {
    eprintln!("{msg}");
    append_shell_log(msg);
}

/// shell.log 的绝对路径（口径与 [`append_shell_log`] 完全一致）；取不到全局数据目录时为 None。
pub fn shell_log_path() -> Option<PathBuf> {
    global_data_dir().map(|d| d.join("logs").join("shell.log"))
}

/// 壳自身诊断（致命路径）：控制台 + shell.log + **release 弹窗**。
/// 为什么单开一档（Q141，2026-09-19 二轮审计）：release 产物是 GUI 子系统（main.rs 的
/// `windows_subsystem`），双击启动没有控制台——`eprintln!` 写的 stderr 无处可去，shell.log 又要
/// 用户知道去翻；于是"启动失败"就是双击没反应、零反馈。这里把同一句话用 MessageBoxW 直接摆到人眼前。
/// dev（debug 构建）有控制台，弹窗只会挡路，行为与 [`shell_warn`] 逐字相同（打印 + 落盘）。
pub fn shell_fatal(msg: &str) {
    eprintln!("{msg}");
    append_shell_log(msg);
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        let log_hint = match shell_log_path() {
            Some(p) => format!("\n\n诊断行已追加到：{}", p.display()),
            None => String::new(),
        };
        win_dialog::show(&format!("{msg}{log_hint}"), "塔台（Tatai）");
    }
}

/// 极简 MessageBoxW（MB_OK + 警告图标）——release 下唯一还能把话说给人听的通道。
/// **一处直声明的 FFI**：user32 是 Windows 系统 DLL，tauri/WebView2 那条链本来就静态导入它
/// （`src-tauri/README.md` 的 WebView2Loader.dll 一节），就为一句弹窗去开 `windows` crate 的
/// Win32_UI 大 feature 不值当，所以这里保持直接声明这一个函数（签名与 Win32 文档一致）。
/// 注：V09-14 起 `windows` crate 已是本 crate 的直接依赖，但只开 `proc_tree.rs` 收口子树用的
/// 四个 feature（Foundation/Security/JobObjects/Threading），**不**为本弹窗扩 feature（口径见
/// `src-tauri/README.md` 的进程树收口一节）。
#[cfg(windows)]
mod win_dialog {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, u_type: u32) -> i32;
    }

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONWARNING: u32 = 0x0000_0030;

    /// 同步弹窗，阻塞到用户点掉；只在 release 的致命路径上调，正常路径不弹。
    pub fn show(text: &str, caption: &str) {
        let text: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let caption: Vec<u16> = caption.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: 两个指针都指向调用期间存活、以 0 结尾的 UTF-16 缓冲；hwnd 传 null = 无父窗口。
        let _ = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                MB_OK | MB_ICONWARNING,
            )
        };
    }
}

pub fn spawn(app: &AppHandle) {
    let port = port();

    // M-2：spawn 之前先做端口预检。已被监听还照拉，就是两代后端抢同一个端口：新进程绑不上
    // （或 tsx watch 反复重启），界面打到谁全凭运气。所以跳过拉起、窗口照开。
    // Q140（2026-09-19 二轮审计）：这里以前只走 `shell_warn` 就 return——release 是 GUI 子系统、
    // 没有控制台，shell.log 也没人会去翻，等于**静默**：窗口照开，界面还接上占用者（多半是上一代
    // 后端，吃的是旧代码旧数据，看着却一切正常）。所以改走 shell_fatal：落盘 + 弹窗把话说在人眼前。
    // 两点刻意保持：
    //   - 仍然不拦窗口。DESIGN.md 附录 B「M-1」登记的处置口径就是"下次启动**报占用并明示**"，
    //     对"入口缺失 / node 探不到"等既有失败路径也是"窗口照开"——这里不另立新规矩。
    //   - **不自动杀占用者**。壳分不清"上一代残留"和"另一个正在运行的塔台实例/用户在跑的 dev 后端"，
    //     贸然 taskkill 会打断正在用的那个（新增回归），所以只给 pid + 处置命令，由人决定。
    if port_listening(port) {
        let occupant_pid = http_get(port, "/health")
            .as_ref()
            .and_then(|(_, body)| health_pid(body));
        let occupant = match occupant_pid {
            Some(pid) => format!("占用者应答了塔台的 /health：pid={pid}（疑似上一代塔台后端未退干净）"),
            None => "占用者没有应答塔台的 /health（可能是别的程序，也可能是卡住的后端）".to_string(),
        };
        let what_to_do = match occupant_pid {
            Some(pid) => format!(
                "要恢复：结束它（`taskkill /PID {pid} /T /F`，或在任务管理器里结束该 node 进程）后重启塔台；\
                 也可以换个端口启动——设 `TATAI_PORT` 环境变量"
            ),
            None => format!(
                "占用者是谁可用 `netstat -ano | findstr :{port}` 查；腾出端口后重启塔台即可，\
                 也可以换个端口启动——设 `TATAI_PORT` 环境变量"
            ),
        };
        shell_fatal(&format!(
            "[tatai] 端口 {port} 已被监听（127.0.0.1:{port} 可连通）：**本次没有拉起新后端**，\
             窗口里的界面会连到这个占用者（可能不是本代后端）。{occupant}。{what_to_do}"
        ));
        return;
    }

    let (program, args, cwd, what) = if cfg!(debug_assertions) {
        (pnpm_program(), pnpm_args(&["dev:server"]), dev_workspace_root(), "pnpm dev:server（dev：仓库根）")
    } else {
        let resources = match app.path().resource_dir() {
            Ok(dir) => dir,
            Err(e) => {
                shell_warn(&format!("[tatai] 取资源目录失败，后端未启动：{e}"));
                return;
            }
        };
        let entry = resources.join("server").join("index.js");
        if !entry.exists() {
            shell_warn(&format!(
                "[tatai] 未找到随包的后端入口 {}：先跑 `pnpm build:server` 再 `pnpm tauri:build`（产物布局见 src-tauri/README.md）",
                entry.display()
            ));
            return;
        }
        // node 只探一次版本：探不到就报能照做的错（口径与理由见文件头）
        let mut probe = Command::new("node");
        probe.arg("--version");
        // 探测也是一次 spawn：不带 CREATE_NO_WINDOW 会闪一个控制台黑窗（见 no_window 注释）
        no_window(&mut probe);
        match probe.output() {
            Ok(out) => shell_log(&format!(
                "[tatai] 打包态复用系统 node：{}",
                String::from_utf8_lossy(&out.stdout).trim()
            )),
            Err(e) => {
                shell_warn(&format!(
                    "[tatai] 找不到 node（{e}）：打包态后端需要系统 PATH 里的 node >= 20，装好 node 再启动塔台（口径见 src-tauri/README.md）"
                ));
                return;
            }
        }
        // 本机实证（U2，2026-09-18）：Tauri 的 resource_dir() 是 **verbatim 路径**（`\\?\D:\...`），
        // 直接当 node 的参数传下去，Node 会拿它去 lstat，报
        //   `Error: EISDIR: illegal operation on a directory, lstat 'D:'`
        // 后端起不来（Windows API 认 `\\?\` 前缀，Node 的路径处理不认）。
        // 所以：给 Node 的**参数**一律去掉前缀；`current_dir` 保留 verbatim（CreateProcessW 认，
        // 顺带还能吃超过 260 字符的长路径）。
        let entry_arg = plain_path_arg(&entry);
        (PathBuf::from("node"), vec![entry_arg], resources, "node（打包：资源目录）")
    };

    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&cwd)
        .env("TATAI_PORT", port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 用户实测（2026-09-19）：release 是 GUI 子系统，spawn 控制台程序（node）不带
    // CREATE_NO_WINDOW 时 Windows 会给子进程新开一个可见控制台窗口——双击桌面图标启动，
    // 塔台窗口之外会多开一个终端窗，就是它。stdio 已 piped、日志已转文件，无控制台不丢输出。
    no_window(&mut command);

    // U2：打包态让后端把 stdout/stderr 再抄一份到 <全局数据目录>/logs/backend.log——
    // GUI 子系统双击启动没有控制台，转发到壳 stdout 的那份日志否则凭空消失。
    // 路径口径（TATAI_HOME > ~/.tatai）在 TS 侧一处定死（src/server/backendLog.ts），Rust 侧不重复实现。
    if !cfg!(debug_assertions) {
        command.env("TATAI_LOG_TO_FILE", "1");
    }

    shell_log(&format!(
        "[tatai] 拉起后端：{what}｜{program:?} {args:?}｜端口 {port}"
    ));

    // V09-14：Job 先建好再 spawn——spawn 一返回就 assign，把"子进程在挂上 Job 之前就抢先
    // fork 孙进程"的竞态窗口压到最小（真实拉起链 cmd→pnpm→tsx→node 要几百毫秒才起第二层）。
    let tree = ProcTree::new();
    if !tree.job_active() {
        shell_warn(&format!(
            "[tatai] Job Object 不可用（{}）：本次收口只剩 taskkill /T 兜底——壳被强杀时可能留孤儿并占住端口（行为见 src-tauri/README.md）",
            tree.job_error().unwrap_or("原因未知")
        ));
    }

    match command.spawn() {
        Ok(mut child) => {
            let pid = child.id();
            // assign 紧贴 spawn：Job 生效后，后端 fork 出的后代自动继承成员身份，
            // 壳一死（含强杀）由内核按 KILL_ON_JOB_CLOSE 整棵终止。
            match tree.assign(&child) {
                Ok(()) => shell_log(&format!(
                    "[tatai] 后端 pid={pid} 已挂进 Job Object（KILL_ON_JOB_CLOSE：壳正常退出或强杀都由整棵子树收口）"
                )),
                Err(e) => shell_warn(&format!(
                    "[tatai] 后端 pid={pid} 没能挂进 Job Object（{e}）：本次收口退回 taskkill /T 兜底；壳被强杀时可能留孤儿"
                )),
            }
            forward(child.stdout.take(), "out");
            forward(child.stderr.take(), "err");
            // manage 必须在起探活线程**之前**完成：保持"状态先就位、诊断后跑"的顺序语义
            // （探活线程本身只读端口不碰状态，但顺序不能反过来赌运气）。
            app.manage(BackendProcess::new(child, tree));
            shell_log(&format!("[tatai] 后端 pid={pid}"));
            // M-3：探活挪到后台线程（与上面 forward 的转发线程同风格）。此前在 setup 主线程上
            // 同步等 /health，后端起不来时会把开窗一起拖住整整 HEALTH_TIMEOUT——窗口该照开，
            // 就绪与否只是诊断信息（界面自会报连不上），就绪/超时都只打印，不动窗口逻辑。
            // M-2：/health 的 pid 归属对账只在打包分支有意义——那边壳直接 spawn node，
            // child.id() 就是服务本体；dev 经 cmd→pnpm→tsx 多层包装，child.id() 是垫片
            // 进程，对账永远对不上，只能退回"200 即就绪"。
            let expected_pid = if cfg!(debug_assertions) { None } else { Some(pid) };
            std::thread::spawn(move || wait_health(port, expected_pid));
        }
        Err(e) => shell_warn(&format!("[tatai] 拉起后端失败（{}）：{e}", program.display())),
    }
}

/// 退出路径上的回收入口：幂等，收口整棵子树后 wait。
/// 正常退出（窗口关闭 / Exit）走这里；**强杀**不经过本函数——那条路由内核在壳的 Job 句柄
/// 关闭时按 KILL_ON_JOB_CLOSE 收口（V09-14，`proc_tree.rs`）。
pub fn shutdown(app: &AppHandle) {
    // 后端没拉起来的早退路径（资源目录/入口缺失、node 探不到、端口被占、spawn 失败）从未 manage 过状态，
    // state() 在未 manage 时直接 panic（release 下 panic=abort）——try_state，没状态=没子进程可回收。
    let Some(state) = app.try_state::<BackendProcess>() else { return };
    let taken = state.child.lock().unwrap().take();
    if let Some(mut child) = taken {
        shell_log(&format!("[tatai] 回收后端 pid={}（整棵子进程树）", child.id()));
        let note = state.tree.shutdown(&mut child);
        shell_log(&format!("[tatai] 回收完成：{}", note.describe()));
    }
}

fn pnpm_program() -> PathBuf {
    // Windows 上 pnpm 是 .cmd 垫片，必须经 cmd /C 才跑得起来；其余平台直接执行 pnpm。
    if cfg!(windows) {
        PathBuf::from("cmd")
    } else {
        PathBuf::from("pnpm")
    }
}

/// 与 pnpm_program 配套：Windows 补 `/C pnpm <脚本>`，其余平台直接 `<脚本>`。
fn pnpm_args(script_args: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if cfg!(windows) {
        args.push("/C".into());
        args.push("pnpm".into());
    }
    args.extend(script_args.iter().map(|a| (*a).to_string()));
    args
}

/// 缓冲区末尾"起了头没凑齐"的 UTF-8 残字节数（0 = 末尾落在字符边界上，整块都能解码）。
/// UTF-8 一个字符最多 4 字节，所以只看末尾 3 字节；续字节（0x80-0xBF）与非法首字节不认，
/// 它们交给 `from_utf8_lossy` 照原样落 U+FFFD（不无限往后攒）。
fn incomplete_tail_len(bytes: &[u8]) -> usize {
    for back in 1..=3usize.min(bytes.len()) {
        let need = match bytes[bytes.len() - back] {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => continue,
        };
        if need > back {
            return back;
        }
    }
    0
}

/// 取缓冲里"能安全解码的最长前缀"（末尾不完整的 UTF-8 字符留在 `carry` 里等下一块），
/// 解码完把那一段从 `carry` 里拿走。Q61（2026-09-18 审计）：此前每块各自 `from_utf8_lossy`，
/// 中文（3 字节）正好跨 read 边界时两半各成一个 U+FFFD——诊断行乱码。现在残字节跨块保留。
fn take_complete_prefix(carry: &mut Vec<u8>) -> String {
    let cut = carry.len() - incomplete_tail_len(carry);
    let text = String::from_utf8_lossy(&carry[..cut]).into_owned();
    carry.drain(..cut);
    text
}

fn forward<R: Read + Send + 'static>(pipe: Option<R>, tag: &'static str) {
    let Some(pipe) = pipe else { return };
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut reader = pipe;
        // 跨 read 的残字节：末尾不完整的 UTF-8 字符留到下一块再解码（见 take_complete_prefix）
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    for line in take_complete_prefix(&mut carry).lines() {
                        println!("[tatai-server:{tag}] {line}");
                    }
                }
            }
        }
        // 收尾：进程退出时残字节不足一个完整字符也如实落一行（不静默丢字节）
        if !carry.is_empty() {
            for line in String::from_utf8_lossy(&carry).lines() {
                println!("[tatai-server:{tag}] {line}");
            }
        }
    });
}

/// 探活：真发一次 `GET /health`（不是只看端口能不能连），拿状态行判断后端真活了。
/// M-2：状态行之外再做**应答方归属对账**——200 且响应体 pid == 本轮子进程 pid 才算就绪，
/// 防"/health 是上一代残留后端在应"的假就绪（端口预检之后仍可能有竞态窗口）。
/// `expected_pid` 为 None（dev 多层拉起）或响应体没有 pid 字段（旧版后端）时退回只看
/// 状态行，不硬卡——对账是加严，不是新的就绪门槛。运行在后台线程（M-3），只打印不动窗口。
fn wait_health(port: u16, expected_pid: Option<u32>) {
    let pid_note = match expected_pid {
        Some(pid) => format!("pid={pid}"),
        None => "dev 经 pnpm/tsx 多层拉起，pid 不对账".to_string(),
    };
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if let Some((status, body)) = http_get(port, "/health") {
            if status == 200 {
                match (expected_pid, health_pid(&body)) {
                    (Some(want), Some(got)) if got == want => {
                        shell_log(&format!(
                            "[tatai] 后端就绪：http://127.0.0.1:{port}/health → 200（pid={got}，归属对账通过）"
                        ));
                        return;
                    }
                    (Some(want), Some(got)) => {
                        // 不算就绪，且不必再等：应答方是别人这件事不会随时间自愈。
                        shell_warn(&format!(
                            "[tatai] /health 有应答但不是本轮拉起的后端（应答 pid={got}，本轮子进程 pid={want}）：\
                             疑似上一代塔台后端未退干净仍占着端口，不算就绪；窗口照开，界面连到的可能不是新后端"
                        ));
                        return;
                    }
                    (Some(_), None) => {
                        shell_log(&format!(
                            "[tatai] 后端就绪：http://127.0.0.1:{port}/health → 200（响应无 pid 字段，未做归属对账；{pid_note}）"
                        ));
                        return;
                    }
                    (None, _) => {
                        shell_log(&format!(
                            "[tatai] 后端就绪：http://127.0.0.1:{port}/health → 200（{pid_note}）"
                        ));
                        return;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    shell_warn(&format!(
        "[tatai] 等后端 /health 超过 {}s 仍未就绪（{pid_note}），窗口照开，界面自会报连不上",
        HEALTH_TIMEOUT.as_secs()
    ));
}

/// M-2：端口预检——127.0.0.1:{port} 能连通即为已被监听（后端默认就绑回环，
/// 见 src/server/index.ts 的 HOST 口径；连接即断，对占用者只是一次空连接）。
fn port_listening(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(sock) = addr.parse() else { return false };
    TcpStream::connect_timeout(&sock, Duration::from_millis(300)).is_ok()
}

/// 从 /health 响应体里抠 pid。响应体是 TS 侧 `JSON.stringify` 的紧凑 JSON（无空格），
/// `"pid":` 只会以键名出现——值里的引号会被转义成 `\"`，拼不出这个序列——所以不引
/// serde 也能安全定位（本 crate 也没有 JSON 依赖，见 Cargo.toml）。抠不出来按
/// "没有 pid 字段"处理（旧版后端，退回只看状态行）。
fn health_pid(body: &str) -> Option<u32> {
    let rest = body.split_once("\"pid\":")?.1;
    let digits: &str = rest
        .trim_start()
        .split(|c: char| !c.is_ascii_digit())
        .next()?;
    digits.parse().ok()
}

/// 一次极简 HTTP GET：返回 (状态码, 响应体)。只喂探活用，不是通用 HTTP 客户端。
fn http_get(port: u16, path: &str) -> Option<(u16, String)> {
    let addr = format!("127.0.0.1:{port}");
    let sock = addr.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&sock, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    let status = raw.split_whitespace().nth(1)?.parse().ok()?;
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    Some((status, body))
}

// `no_window` 与 `kill_tree` 已随 V09-14 挪进 `proc_tree.rs`：验证用 launcher
// （`src-tauri/shell-sim`）编的是同一份收口原语，不另写一套。

// ───────────────────────── 单测（Q61：跨 read 的 UTF-8 残字节） ─────────────────────────
// 为什么加：`forward` 里的解码错在**跨块边界**上——只有真按 1 字节切一遍才能验到，
// 静态审查与平常跑（整块落一行）都看不出来。这几条把边界情形钉住（含"按 1 字节喂"的整串对照）。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_tail_len_matches_char_boundaries() {
        assert_eq!(incomplete_tail_len(b""), 0);
        assert_eq!(incomplete_tail_len(b"abc\n"), 0); // ASCII 全完整
        assert_eq!(incomplete_tail_len("中文日志".as_bytes()), 0); // 完整汉字：末尾在字符边界
        let zhong = "中".as_bytes(); // 3 字节
        assert_eq!(incomplete_tail_len(&zhong[..1]), 1);
        assert_eq!(incomplete_tail_len(&zhong[..2]), 2);
        assert_eq!(incomplete_tail_len(&zhong[..3]), 0);
        let emoji = "😀".as_bytes(); // 4 字节
        assert_eq!(incomplete_tail_len(&emoji[..3]), 3);
        assert_eq!(incomplete_tail_len(&emoji[..4]), 0);
        // 非法字节不算"残字节"（交给 lossy 落 U+FFFD，不无限攒）
        assert_eq!(incomplete_tail_len(&[0xff]), 0);
        assert_eq!(incomplete_tail_len(&[0x80, 0x80]), 0);
    }

    #[test]
    fn chunked_feed_has_no_replacement_char() {
        // 每 1 字节喂一次（最坏切法）：解码出来的串必须与原文逐字相同、一个 U+FFFD 都没有
        let source = "第一行：服务端启动\n第二行：记忆检索不下发远程\n😀 完\n";
        let mut carry: Vec<u8> = Vec::new();
        let mut got = String::new();
        for b in source.as_bytes() {
            carry.push(*b);
            got.push_str(&take_complete_prefix(&mut carry));
        }
        got.push_str(&String::from_utf8_lossy(&carry)); // 收尾与 forward 同口径
        assert_eq!(got, source);
        assert!(!got.contains('\u{FFFD}'), "不应出现替换符：{got:?}");
    }

    #[test]
    fn invalid_bytes_still_decode_lossy() {
        // 真坏字节照旧落 U+FFFD（不因为"攒残字节"把坏字节也攒着不放）
        let mut carry: Vec<u8> = vec![0x41, 0xff, 0x42];
        let text = take_complete_prefix(&mut carry);
        assert_eq!(text, "A\u{FFFD}B");
        assert!(carry.is_empty());
    }
}
