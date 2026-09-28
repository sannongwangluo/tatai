use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn main() {
    stage_webview2_loader();
    tauri_build::build();
}

/// 打包前置：把 `WebView2Loader.dll` 摆到 `bundle.resources` 会扫的位置（`tauri.conf.json` 里那条资源）。
///
/// **为什么要有这一步（U3 实测，2026-09-18）**：本机工具链是 windows-gnu，壳**静态导入**
/// `WebView2Loader.dll`（tauri-build 的 gnu 分支专门把这个 DLL 复制到 `target/<profile>/`，就是因为它运行期要），
/// 但 tauri-bundler 的 NSIS 分支只在 `settings.target().ends_with("-gnu")` 时才把它打进安装包；
/// 而不传 `--target` 时那个 target 取的是 **CLI 自己的编译期三元组**
/// （`tauri_utils::platform::target_triple()` 走 `cfg!()`，即 npm 发的 win32-x64-**msvc** 版 CLI）——
/// 判定不成立，NSIS 包里缺这个 DLL，装出来的 exe 一启动就死在
/// `STATUS_DLL_NOT_FOUND (0xC0000135)`（本机实测退出码 3221225781）。
/// MSI 分支没有这道门（它扫 target 目录下的 `*.dll`），反倒带上了——两个包不一致。
///
/// 走 `bundle.resources` 则两个打包器都会带上，且不依赖 CLI 怎么认 target；这一步只负责把文件摆到源路径上。
/// MSVC 工具链同样需要这个 DLL（那边链的是 `WebView2Loader.dll.lib` 导入库），所以这里不按工具链分支。
/// 取文件的位置与 tauri-build 一致：先找 `webview2-com-sys` 构建脚本的输出（干净构建时它一定已经跑过），
/// 再退回 `target/<profile>/WebView2Loader.dll`（tauri-build 上一次的复制结果）。
fn stage_webview2_loader() {
    let Ok(out_dir) = std::env::var("OUT_DIR") else { return };
    // OUT_DIR = <target dir>[/<triple>]/<profile>/build/<pkg>-<hash>/out（取法与 tauri-build 一致）
    let Some(profile_dir) = Path::new(&out_dir).ancestors().nth(3) else { return };
    let dest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("WebView2Loader.dll");
    let Some(src) = find_loader(profile_dir) else {
        // L-1：cargo:warning 一行一条独立输出——此前把两行提示塞进同一条 println（续行还带缩进），
        // cargo 只认行首恰好是 `cargo:warning=` 的行，第二行会被当普通输出吞掉。
        // L-2：源找不到但 dest 已在（上轮构建残留）时如实说"沿用旧版"——打包照样能过，
        // 但打进包的可能是过期 DLL，不能沉默。
        if dest.exists() {
            println!(
                "cargo:warning=[tatai] 本轮找不到 WebView2Loader.dll 的新源（{} 下没有 webview2-com-sys 的输出，也没有上一轮的复制件）",
                profile_dir.display()
            );
            println!(
                "cargo:warning=[tatai] 沿用旧版 DLL（上轮构建残留）：{}，可能与本轮依赖版本不一致",
                dest.display()
            );
            // dest 比 build 目录里现存的任何 webview2-com-sys DLL（不分 arch）都旧 → 再加一条
            if let (Some(dest_mtime), Some(newest)) = (file_mtime(&dest), newest_loader_mtime(profile_dir)) {
                if dest_mtime < newest {
                    println!("cargo:warning=[tatai] 且它比 build 目录里现存的 webview2-com-sys DLL 旧，建议 cargo clean 后整轮重建");
                }
            }
        } else {
            println!(
                "cargo:warning=[tatai] 找不到 WebView2Loader.dll（{} 下既没有 webview2-com-sys 的输出，也没有上一轮的复制件）",
                profile_dir.display()
            );
            println!("cargo:warning=[tatai] `bundle.resources` 里声明了它，打包会直接失败——先确认 webview2-com-sys 的构建脚本跑过");
        }
        return;
    };
    if std::fs::read(&src).ok() == std::fs::read(&dest).ok() {
        return;
    }
    match std::fs::create_dir_all(dest.parent().unwrap()).and_then(|_| std::fs::copy(&src, &dest)) {
        Ok(n) => println!(
            "cargo:warning=[tatai] 随包资源 WebView2Loader.dll 已就位（{n} 字节，取自 {}）",
            src.display()
        ),
        Err(e) => println!("cargo:warning=[tatai] 复制 WebView2Loader.dll 失败：{e}"),
    }
}

fn find_loader(profile_dir: &Path) -> Option<PathBuf> {
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x64",
        Ok("x86") => "x86",
        Ok("aarch64") => "arm64",
        _ => return None,
    };
    // L-2：build/ 下可能并存多轮 webview2-com-sys-<hash> 目录（cargo 重跑会留旧的），
    // 撞到第一个就用可能是上轮残留的旧 DLL——按 DLL 的 mtime 取最新一份。
    if let Ok(entries) = std::fs::read_dir(profile_dir.join("build")) {
        let mut newest: Option<(SystemTime, PathBuf)> = None;
        for entry in entries.flatten() {
            let pkg_dir = entry.path();
            if !pkg_dir.to_string_lossy().contains("webview2-com-sys") {
                continue;
            }
            let candidate = pkg_dir.join("out").join(arch).join("WebView2Loader.dll");
            let Some(mtime) = file_mtime(&candidate) else { continue };
            if newest.as_ref().map_or(true, |(t, _)| mtime > *t) {
                newest = Some((mtime, candidate));
            }
        }
        if let Some((_, path)) = newest {
            return Some(path);
        }
    }
    let copy = profile_dir.join("WebView2Loader.dll");
    copy.exists().then_some(copy)
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// build 目录里**任何** webview2-com-sys 的 WebView2Loader.dll（不分 arch）中最新一份的 mtime：
/// 找不到新源、只能沿用旧 dest 时，拿它判断 dest 是否已落后于现存产物（L-2 的对账口径）。
fn newest_loader_mtime(profile_dir: &Path) -> Option<SystemTime> {
    let entries = std::fs::read_dir(profile_dir.join("build")).ok()?;
    let mut newest = None;
    for entry in entries.flatten() {
        let pkg_dir = entry.path();
        if !pkg_dir.to_string_lossy().contains("webview2-com-sys") {
            continue;
        }
        let Ok(out_entries) = std::fs::read_dir(pkg_dir.join("out")) else { continue };
        for arch_dir in out_entries.flatten() {
            if let Some(mtime) = file_mtime(&arch_dir.path().join("WebView2Loader.dll")) {
                newest = Some(newest.map_or(mtime, |n: SystemTime| n.max(mtime)));
            }
        }
    }
    newest
}
