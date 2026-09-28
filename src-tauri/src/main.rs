// 塔台桌面壳（PLAN.md U1 / DESIGN.md §11.3）：Rust 侧只有两件职责——
//   ① 打开窗口，加载**同一份前端产物**（`dist/`，dev 下是 vite 的 5173）；
//   ② 拉起并回收本地 Node 服务（见 backend.rs：谁拉起谁回收）。
// 红线：这里不写任何业务 UI（U1 跑偏点：不许为桌面端另写一套界面）；
// 窗口里的界面与浏览器里的是同一个 `src/ui`，壳只负责"装东西的箱子"。
// 前端可调能力只有两个插件：opener（Q224：壳内点站外链接改交系统浏览器，权限范围限
// http/https）与 dialog（2026-09-19 试用反馈：添加项目选目录的原生选择框，只放 allow-open），
// 见 capabilities/default.json；除此之外无自定义命令。能力清单以那份文件为准。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod proc_tree;

use tauri::RunEvent;

fn main() {
    // 第一件事挂壳自己的 panic hook（Q141）：release 下 panic 文案默认只能写进一个不存在的控制台，
    // 双击启动失败 = 没反应、没窗口、没日志；挂上之后落 shell.log 并弹窗，至少留下可诊断信息。
    install_panic_hook();

    // 先拉起后端再进事件循环：窗口一开就有数据（/health 探活挪在后台线程，M-3——后端起不来
    // 也不拖开窗，界面会报连不上；但"端口已被占用"这一档 Q140 改成弹窗明示，见 backend::spawn）。
    // 初始化脚本把本轮实际后端地址注入窗口（TATAI_PORT 覆盖时前端跟着走，见 backend.rs）。
    let app = tauri::Builder::default()
        // Q224：注册 opener 插件（前端 `src/ui/external-link.ts` 调它的 open_url）。
        // 权限收在 capabilities/default.json：只放 http/https 两种 url，不含 open-path / reveal。
        .plugin(tauri_plugin_opener::init())
        // 试用反馈（2026-09-19，主人报障）：注册 dialog 插件——「+ 添加项目」的路径
        // 此前只能手敲。前端 `src/ui/dir-picker.ts` 调它的 open（directory 模式）。
        // 权限同样收窄在 capabilities/default.json：只放 allow-open 一条，不含 save/ask/confirm。
        .plugin(tauri_plugin_dialog::init())
        .append_invoke_initialization_script(backend::api_origin_init_script())
        .setup(|app| {
            backend::spawn(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("[tatai] Tauri 壳构建失败");

    app.run(|app_handle, event| match event {
        // 口径（U1 DoD②）：谁拉起谁回收。窗口全关 / 走正常退出路径时，
        // 在这里收口整棵 Node 子进程树（V09-14 起＝Job Object 整棵终止 + taskkill /T 兜底），
        // 不留僵尸。
        // 注意：BackendProcess 的 Drop **不是**异常路径的保险——release 是 `panic = "abort"`，
        // 恐慌不展开、强杀更不跑 Drop（Q140 审计实锤，详见 backend.rs 中 Drop 的注释）。
        // 强杀那条路由**内核**兜：壳持有的 Job 句柄被内核关闭 ⇒ JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        // 终止 Job 内全部进程（V09-14，见 proc_tree.rs；DESIGN.md §11.3 / §12.1-19）。
        RunEvent::ExitRequested { .. } | RunEvent::Exit => backend::shutdown(app_handle),
        _ => {}
    });
}

/// 壳自己的 panic hook（Q141）：先照旧让默认 hook 打印（dev 有控制台，行为不变），再把同一件事
/// 转进 `backend::shell_fatal`——release 下落 shell.log + 弹 MessageBox，双击启动失败不再是哑谜。
/// `panic = "abort"` 下 hook 仍会先跑完再 abort，所以这条通道对 release 有效。
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        let detail = match info.payload().downcast_ref::<&str>() {
            Some(s) => (*s).to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => s.clone(),
                None => "（非字符串 panic 载荷）".to_string(),
            },
        };
        let place = match info.location() {
            Some(l) => format!("{}:{}", l.file(), l.line()),
            None => "位置未知".to_string(),
        };
        backend::shell_fatal(&format!("[tatai] 壳 panic：{detail}（{place}）"));
    }));
}
