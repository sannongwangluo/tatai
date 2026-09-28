// R3「+ 添加项目」弹出表单：路径必填，名称/id 可选（R2 接口入参）。
// 成功 → 展示 kind 判定理由与 .gitignore 提示（DESIGN.md §8.2）并刷新列表；
// 失败 → 原样展示后端结构化错误（code + message），不吞异常。
// 试用反馈（2026-09-19，主人报障）：路径不该只能手敲——壳内加「浏览…」按钮走原生
// 目录选择框（src/ui/dir-picker.ts），浏览器里没有该入口，手敲行为不变。
import { useState } from "react";
import { addProject, type AddProjectInput } from "../api";
import { canPickDirectory, pickDirectory } from "../dir-picker";
import type { OnboardOk, OnboardErr } from "../../server/onboard";

interface Props {
  onClose: () => void;
  /** 添加成功后由父组件刷新列表 */
  onAdded: () => void;
}

export function AddProjectDialog({ onClose, onAdded }: Props) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<OnboardErr["error"] | null>(null);
  const [done, setDone] = useState<OnboardOk | null>(null);

  async function submit() {
    if (path.trim() === "") {
      setError({ code: "INVALID_INPUT", message: "路径不能为空" });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const input: AddProjectInput = { path: path.trim() };
      if (name.trim() !== "") input.name = name.trim();
      if (id.trim() !== "") input.id = id.trim();
      const result = await addProject(input);
      if (result.ok) {
        setDone(result);
        onAdded(); // 列表立即刷新，结果面板留在弹窗里给用户看
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError({ code: "INVALID_INPUT", message: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-96 rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold">添加项目</h2>

        {done ? (
          <div className="space-y-2 text-xs">
            <p className="text-green-400">
              {done.already_registered
                ? "该项目已在注册表中（幂等，未重复写入）"
                : "已加入注册表"}
            </p>
            <p className="text-neutral-300">
              kind 判定：<b>{done.detected.kind}</b>
            </p>
            <ul className="list-inside list-disc space-y-0.5 text-neutral-500">
              {done.detected.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {/* DESIGN.md §8.2：缺 `.工作台/` gitignore 行时把后端提示展示出来 */}
            {done.gitignore.hint && (
              <p className="rounded bg-yellow-900/40 px-2 py-1.5 text-yellow-300">
                {done.gitignore.hint}
              </p>
            )}
            <div className="flex justify-end pt-2">
              <button
                onClick={onClose}
                className="rounded bg-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-600"
              >
                完成
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <label className="block">
              <span className="mb-1 block text-neutral-400">路径（必填）</span>
              <div className="flex gap-2">
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="项目根目录的绝对路径"
                  className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none focus:border-neutral-500"
                />
                {canPickDirectory() && (
                  <button
                    type="button"
                    onClick={async () => {
                      const dir = await pickDirectory();
                      if (dir) setPath(dir); // 取消（null）时已填的值不动
                    }}
                    className="shrink-0 rounded bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700"
                  >
                    浏览…
                  </button>
                )}
              </div>
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-400">
                名称（可选，默认取目录名）
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none focus:border-neutral-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-400">
                id（可选，默认取目录名）
              </span>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none focus:border-neutral-500"
              />
            </label>

            {error && (
              <p className="rounded bg-red-900/40 px-2 py-1.5 text-red-300">
                [{error.code}] {error.message}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="rounded bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700"
              >
                取消
              </button>
              <button
                onClick={submit}
                disabled={submitting}
                className="rounded bg-neutral-100 px-3 py-1.5 text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                {submitting ? "提交中…" : "添加"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
