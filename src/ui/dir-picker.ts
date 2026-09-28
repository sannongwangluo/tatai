// 试用反馈（2026-09-19，主人报障）：「+ 添加项目」的路径只能手敲——桌面壳里改用原生
// 目录选择框选，浏览器里没有这条路（web 页面拿不到本机目录选择 UI），行为保持手敲不变。
//
// 口径（与 external-link.ts 同款边界）：
//   · 只在 Tauri 壳内可用（isTauriShell() 判定），浏览器里调用方不显示「浏览…」入口；
//   · 只开 directory 模式（directory:true + multiple:false）——选的是「项目根目录」，
//     不许顺手选文件；
//   · 用户取消返回 null（不是错误），调用方保持已填的值不动。
import { open } from "@tauri-apps/plugin-dialog";
import { isTauriShell } from "./tauri-env";

/** 壳内能否弹原生目录选择框（浏览器里恒 false，调用方据此不显示「浏览…」入口）。 */
export function canPickDirectory(): boolean {
  return isTauriShell();
}

/** 弹原生目录选择框：选中返回绝对路径，取消/失败返回 null（手敲值不动）。 */
export async function pickDirectory(): Promise<string | null> {
  try {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null; // multiple:false 时选中是单个字符串
  } catch (e) {
    console.error(`[tatai] 目录选择框失败：${String(e)}`);
    return null;
  }
}
