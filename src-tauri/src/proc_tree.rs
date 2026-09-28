// 进程树收口（PLAN V09-14；DESIGN.md §11.3、§12.1-19、附录 E.10 第 2 行）。
//
// 问题：壳被**强制结束**（任务管理器「结束进程」、`taskkill /F` 不带 `/T`）时进程直接消失——
// 事件循环里的 `shutdown` 与 `Drop` 都不会跑（release 还是 `panic = "abort"`），原来那条
// `taskkill /T` 根本没机会发出去，node 子树成孤儿并占住端口（历史上登记为 `DESIGN.md` 附录 B「M-1」）。
//
// 收口：给壳拉起的后端挂 Windows **Job Object** 并置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
// 这把收口点交给内核：壳一死，它持有的 Job 句柄由内核关闭，Job 里的进程（＝后端及其后代）
// 整棵被终止，不依赖壳还能跑代码。它只终止**本 Job 的成员**（按句柄，不按进程名），
// 因此别的 agent 客户端 / 无关 node 进程不会被误杀。`taskkill /PID <pid> /T /F` 保留为兜底：
// 非 Windows 平台、Job 建不出来、以及「子进程在 assign 之前就抢先起了孙进程」那点窄竞态。
//
// 本文件**不依赖 tauri**：真壳（`backend.rs`）与验证用 launcher（`src-tauri/shell-sim`）
// 编的是同一份源码——不然验证脚本验的就是另写的一套收口逻辑，不是真跑的那套。

use std::process::{Child, Command, Stdio};

#[cfg(windows)]
use job::JobObject;

/// 一次收口的结果：供壳 / launcher 打日志，也供 `verify:v09-14` 核对"这一路真跑了"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReapNote {
    pub child_pid: u32,
    /// Job Object 生效并已 `TerminateJobObject`（整棵子树按句柄收口）。
    pub job_terminated: bool,
    /// 走了 `taskkill /PID /T /F` 兜底（Windows 上恒真）。
    pub taskkill_used: bool,
    /// Job 建不出来时的原因（如实登记：这一路只剩 taskkill，强杀仍可能留孤儿）。
    pub job_error: Option<String>,
}

impl ReapNote {
    pub fn describe(&self) -> String {
        format!(
            "pid={} job={} taskkill={}{}",
            self.child_pid,
            if self.job_terminated { "收口" } else { "未生效" },
            if self.taskkill_used { "兜底" } else { "未用" },
            match &self.job_error {
                Some(e) => format!("（Job 不可用：{e}）"),
                None => String::new(),
            }
        )
    }
}

/// 收口句柄：谁拉起谁收口；壳猝死时由内核接手（见文件头）。
pub struct ProcTree {
    #[cfg(windows)]
    job: Option<JobObject>,
    #[cfg(windows)]
    job_error: Option<String>,
}

impl ProcTree {
    /// 建 Job 并置 `KILL_ON_JOB_CLOSE`。建不出来**不致命**也不静默：原因留在
    /// [`ProcTree::job_error`]，收口退回 `taskkill` 兜底，由调用方如实打日志。
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            return match JobObject::create() {
                Ok(job) => Self { job: Some(job), job_error: None },
                Err(e) => Self { job: None, job_error: Some(e.to_string()) },
            };
        }
        #[cfg(not(windows))]
        Self {}
    }

    /// Job 是否可用（非 Windows 恒 false：那边没有 Job Object，收口靠 `kill_tree`）。
    pub fn job_active(&self) -> bool {
        #[cfg(windows)]
        {
            return self.job.is_some();
        }
        #[cfg(not(windows))]
        false
    }

    pub fn job_error(&self) -> Option<&str> {
        #[cfg(windows)]
        {
            return self.job_error.as_deref();
        }
        #[cfg(not(windows))]
        None
    }

    /// 把**已经 spawn 出来的**子进程放进 Job：此后它 fork 出的后代自动继承成员身份。
    /// 返回 Err 表示这层保护没挂上（壳要如实告警，收口只剩 taskkill 兜底）。
    pub fn assign(&self, child: &Child) -> Result<(), String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let Some(job) = self.job.as_ref() else {
                return Err(self
                    .job_error
                    .clone()
                    .unwrap_or_else(|| "Job Object 未建立（原因未知）".to_string()));
            };
            return job
                .assign(child.as_raw_handle() as isize)
                .map_err(|e| e.to_string());
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(())
        }
    }

    /// 收口顺序（固定，别调换）：
    ///   ① `TerminateJobObject`——按句柄终止整棵子树，精确、不按进程名、不误伤他人；
    ///   ② `kill_tree`——按 PID 杀整棵树作兜底，顺带 `wait()` 回收直接子进程句柄；
    ///   ③ 幂等：`child` 已被回收（take 走）时调用方根本不该走到这里，重复调用也只是空转。
    ///
    /// 强杀路径不经过本函数（壳已死）——那条路由内核在句柄关闭时按
    /// `KILL_ON_JOB_CLOSE` 收口，`ProcTree` 析构即关句柄。
    pub fn shutdown(&self, child: &mut Child) -> ReapNote {
        let mut note = ReapNote {
            child_pid: child.id(),
            job_terminated: false,
            taskkill_used: false,
            job_error: self.job_error().map(|e| e.to_string()),
        };
        #[cfg(windows)]
        if let Some(job) = self.job.as_ref() {
            job.terminate();
            note.job_terminated = true;
        }
        note.taskkill_used = kill_tree(child);
        note
    }
}

impl Default for ProcTree {
    fn default() -> Self {
        Self::new()
    }
}

/// Windows 上 tsx watch 会再套一层子进程：只杀直接子进程会留下孙进程，
/// 所以用 `taskkill /T` 杀整棵树；非 Windows 退回 kill 自身。
/// 返回是否真用了 taskkill（供收口日志如实登记这一路）。
pub fn kill_tree(child: &mut Child) -> bool {
    let mut used = false;
    if cfg!(windows) {
        let mut tk = Command::new("taskkill");
        tk.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // taskkill 同为控制台程序：退出收尾不带标志会闪一下黑窗（见 no_window 注释）
        no_window(&mut tk);
        let _ = tk.status();
        used = true;
    }
    let _ = child.kill();
    let _ = child.wait();
    used
}

/// Windows release（GUI 子系统）下 spawn 任何控制台程序（node / taskkill）都必须带
/// CREATE_NO_WINDOW：不带的话 Windows 会给子进程新开一个可见控制台窗口（用户实测
/// 2026-09-19：双击桌面图标，塔台窗口之外多开一个终端窗）。stdio 已 piped、后端日志
/// 已由 TATAI_LOG_TO_FILE 转文件，子进程无控制台不丢任何输出。
/// dev（debug_assertions）恒等返回：dev 从终端起，子进程沿用同一个控制台；若给 pnpm
/// 加这标志，tsx watch 再往下 spawn 的 node 每个反而会各开一个新窗。
#[cfg(all(windows, not(debug_assertions)))]
pub fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(any(not(windows), debug_assertions))]
pub fn no_window(_cmd: &mut Command) {}

/// Windows Job Object 的最小封装：只用到「建 Job / 置 KILL_ON_JOB_CLOSE / assign / 终止 / 关句柄」。
/// 依赖与许可：`windows` crate（`MIT OR Apache-2.0`），原文核对与准入依据见
/// `src-tauri/README.md` 与 `docs/LICENSE-AUDIT.md`（§7.4 要求）。
#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::io;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Job 句柄。**只存句柄值（`isize`）不存 `HANDLE`**：`windows` 0.61 的 `HANDLE` 是裸指针
    /// 包一层、既不是 `Send` 也不是 `Sync`，而壳要把收口句柄放进 Tauri 的 managed state
    /// （那里要求 `Send + Sync`）。句柄是进程级资源、跨线程用是安全的，存整数值是为了
    /// 不为此写一个 `unsafe impl Send`。
    pub struct JobObject {
        raw: isize,
    }

    impl JobObject {
        pub fn create() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(None, None) }.map_err(to_io)?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            let set = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size,
                )
            };
            if let Err(e) = set {
                // 建了 Job 却没置上标志等于白建（壳死后收口不了）——关掉句柄、如实报错
                unsafe { let _ = CloseHandle(handle); };
                return Err(to_io(e));
            }
            Ok(Self { raw: handle.0 as isize })
        }

        fn handle(&self) -> HANDLE {
            HANDLE(self.raw as *mut c_void)
        }

        pub fn assign(&self, process_raw: isize) -> io::Result<()> {
            let process = HANDLE(process_raw as *mut c_void);
            unsafe { AssignProcessToJobObject(self.handle(), process) }.map_err(to_io)
        }

        /// 终止 Job 内全部进程（退出码只作标记）。失败不致命：`kill_tree` 兜底照旧跑。
        pub fn terminate(&self) {
            let _ = unsafe { TerminateJobObject(self.handle(), 1) };
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            // 关句柄这一步就是强杀路径的收口点：句柄是最后一个时，内核按
            // KILL_ON_JOB_CLOSE 终止 Job 内全部进程。壳被强杀时由内核代劳。
            unsafe { let _ = CloseHandle(self.handle()); }
        }
    }

    fn to_io(e: windows::core::Error) -> io::Error {
        io::Error::other(e)
    }
}
