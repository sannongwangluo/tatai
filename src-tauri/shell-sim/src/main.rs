// 壳替身（PNPM `verify:v09-14` 用；PLAN V09-14 允许的"可测试 launcher"）。
//
// 它把桌面壳的**进程生命周期**照原样跑一遍，但不做 UI、不开窗、不依赖 tauri：
//   ① 按 `src-tauri/src/backend.rs` dev 分支的配方拉起真后端（`cmd /C pnpm dev:server`，
//      cwd = 仓库根，`TATAI_PORT` 透传），或按打包分支配方（`node <entry>`）；
//   ② 用**同一份** `proc_tree.rs`（`#[path]` 编进来，不是另写一份）建 Job Object、
//      把后端挂进去——这就是真壳在跑的那段收口代码；
//   ③ 三种收尾：`--exit` 走正常退出路径（与壳的 RunEvent::Exit → backend::shutdown 同一函数）、
//      `--abrupt-exit` 直接 exit（模拟 panic=abort 那条"来不及收口"的路，验内核按
//      KILL_ON_JOB_CLOSE 兜底）、`--hold` 挂住不动（等外部 `taskkill /F` 强杀，验 ②）。
//
// `--no-job` 是**反例开关**：不挂 Job，复现历史上"强杀壳 → node 孤儿占住端口"那条路，
// 证明验证脚本的断言真能抓到这种残留（不然"通过"没有意义）。
//
// 输出（stdout，逐行可解析，验证脚本按前缀取值）：
//   [sim] SIM_PID=<pid> / BACKEND_PID=<pid> / JOB=on|off JOB_ERR=<..> / HEALTH=ok pid=<..> port=<..>
//   [sim] HOLDING / [sim] REAP <ReapNote.describe()> / [sim] EXIT=<code>
// 后端自己的 stdout/stderr 照壳的格式转发成 `[tatai-server:out]` / `[tatai-server:err]`。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[path = "../../src/proc_tree.rs"]
mod proc_tree;

use proc_tree::{no_window, ProcTree};

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1).cloned())
}

fn flag(args: &[String], key: &str) -> bool {
    args.iter().any(|a| a == key)
}

fn say(line: &str) {
    println!("[sim] {line}");
    // 脚本按行实时读，别让 stdout 缓冲把证据卡住
    let _ = std::io::stdout().flush();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let port: u16 = arg_value(&args, "--port")
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787);
    let home = arg_value(&args, "--home");
    let cwd = arg_value(&args, "--cwd").unwrap_or_else(|| ".".to_string());
    let entry = arg_value(&args, "--entry");
    let no_job = flag(&args, "--no-job");
    let hold = flag(&args, "--hold");
    let abrupt = flag(&args, "--abrupt-exit");
    let health_timeout = arg_value(&args, "--health-timeout")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30);

    say(&format!("SIM_PID={}", std::process::id()));

    // `--selfcheck`：只证明这个可执行文件真能跑起来（火绒曾拦新建 EXE：产出 0 字节或拒绝执行），
    // 不拉任何后端。验证脚本用它做"launcher 可执行"这一条断言。
    if flag(&args, "--selfcheck") {
        say(&format!(
            "SELFCHECK=ok exe={} rust_job_available={}",
            std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
            ProcTree::new().job_active()
        ));
        say("EXIT=0");
        return;
    }

    // ── 拉起配方与 backend.rs 一致（dev：cmd /C pnpm dev:server；打包：node <entry>）──
    let mut command = match &entry {
        Some(js) => {
            let mut c = Command::new("node");
            c.arg(js);
            c
        }
        None => {
            if cfg!(windows) {
                let mut c = Command::new("cmd");
                c.args(["/C", "pnpm", "dev:server"]);
                c
            } else {
                let mut c = Command::new("pnpm");
                c.arg("dev:server");
                c
            }
        }
    };
    command
        .current_dir(&cwd)
        .env("TATAI_PORT", port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(h) = &home {
        command.env("TATAI_HOME", h);
    }
    no_window(&mut command);

    // Job 先建后 spawn：把"子进程抢先 fork 孙进程"的竞态窗口压到最小（与 backend.rs 同序）
    let tree = if no_job { None } else { Some(ProcTree::new()) };
    if let Some(t) = &tree {
        if t.job_active() {
            say("JOB=on");
        } else {
            say(&format!(
                "JOB=off JOB_ERR={}",
                t.job_error().unwrap_or("Job Object 未建立（原因未知）")
            ));
        }
    } else {
        say("JOB=off JOB_ERR=--no-job（反例：不挂 Job，复现强杀留孤儿）");
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            say(&format!("SPAWN_FAIL={e}"));
            std::process::exit(2);
        }
    };
    say(&format!("BACKEND_PID={}", child.id()));

    if let Some(t) = &tree {
        match t.assign(&child) {
            Ok(()) => say("ASSIGN=ok"),
            Err(e) => say(&format!("ASSIGN=fail {e}")),
        }
    }

    // 转发后端输出（同壳的口径：跨块残字节留到下一块，中文不裂成 U+FFFD）
    forward(child.stdout.take(), "out");
    forward(child.stderr.take(), "err");

    // 探活：真发一次 GET /health（与壳同口径，只用于"什么时候可以收尾"）
    let deadline = Instant::now() + Duration::from_secs(health_timeout);
    let mut ready_pid: Option<u32> = None;
    while Instant::now() < deadline {
        if let Some((status, body)) = http_get(port, "/health") {
            if status == 200 {
                ready_pid = health_pid(&body);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    match ready_pid {
        Some(pid) => say(&format!("HEALTH=ok pid={pid} port={port}")),
        None => say(&format!("HEALTH=fail port={port} timeout={health_timeout}s")),
    }

    if hold {
        say("HOLDING");
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }

    if abrupt {
        // 不跑 shutdown：模拟"壳来不及收口就没了"。Job 生效时内核会在句柄关闭时收口子树。
        say("EXIT=abrupt");
        std::process::exit(0);
    }

    // `--exit-after <秒>`：探活后再等一会儿才走正常退出——给验证脚本留出"记前一轮读数"的窗口
    // （不设它就直接收尾，脚本可能来不及读端口与 pid）。
    if let Some(secs) = arg_value(&args, "--exit-after").and_then(|v| v.parse::<u64>().ok()) {
        say(&format!("EXIT_AFTER={secs}"));
        std::thread::sleep(Duration::from_secs(secs));
    }

    // 正常退出路径：与壳 RunEvent::Exit → backend::shutdown 调的是同一个收口函数
    let note = match &tree {
        Some(t) => t.shutdown(&mut child),
        None => proc_tree::ReapNote {
            child_pid: child.id(),
            job_terminated: false,
            taskkill_used: proc_tree::kill_tree(&mut child),
            job_error: Some("--no-job".to_string()),
        },
    };
    say(&format!("REAP {}", note.describe()));
    say("EXIT=0");
}

/// 后端 stdout/stderr → 本进程 stdout（壳的 `forward` 同口径）。
fn forward<R: Read + Send + 'static>(pipe: Option<R>, tag: &'static str) {
    let Some(mut reader) = pipe else { return };
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let cut = carry.len() - incomplete_tail_len(&carry);
                    for line in String::from_utf8_lossy(&carry[..cut]).lines() {
                        println!("[tatai-server:{tag}] {line}");
                    }
                    carry.drain(..cut);
                }
            }
        }
        for line in String::from_utf8_lossy(&carry).lines() {
            println!("[tatai-server:{tag}] {line}");
        }
    });
}

/// 只解码"能安全解码的最长前缀"（末尾残字节留到下一块），口径与 backend.rs 的 forward 相同。
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

/// 一次极简 HTTP GET（只够探活用）——壳里那份在 backend.rs，这里是壳替身自己的探针。
fn http_get(port: u16, path: &str) -> Option<(u16, String)> {
    let addr = format!("127.0.0.1:{port}");
    let sock = addr.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&sock, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
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

fn health_pid(body: &str) -> Option<u32> {
    let rest = body.split_once("\"pid\":")?.1;
    let digits: &str = rest.trim_start().split(|c: char| !c.is_ascii_digit()).next()?;
    digits.parse().ok()
}
