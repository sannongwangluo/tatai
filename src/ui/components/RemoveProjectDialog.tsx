// R4 移除项目二次确认弹窗。
// 红线：移除只删注册表记录，绝不删磁盘目录——这句话必须明示给用户后再放行。
import { useState } from "react";
import { removeProject, type ProjectItem } from "../api";

interface Props {
  project: ProjectItem;
  onClose: () => void;
  /** 移除成功后由父组件刷新列表/清空选中态 */
  onRemoved: (id: string) => void;
}

export function RemoveProjectDialog({ project, onClose, onRemoved }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Q87：注册表已经移除成功，但资源回收没做完（超时/失败）时停在这一步如实说明
  const [recycleNotice, setRecycleNotice] = useState<string | null>(null);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      const released = await removeProject(project.id);
      // 回收没做完就说出来：超时/失败此前只在服务端 console 里，界面一路"成功"（Q87 实锤）
      if (released.timedOut || released.errors.length > 0) {
        setRecycleNotice(
          released.timedOut
            ? "项目已从注册表移除，但监听/终端会话的回收超时——可能仍有后台进程持有它，稍后可再看一眼。"
            : `项目已从注册表移除，但资源回收报错：${released.errors.join("；")}`,
        );
        setSubmitting(false);
        return;
      }
      onRemoved(project.id);
    } catch (e) {
      setError((e as Error).message);
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
        <h2 className="mb-3 text-sm font-semibold">移除项目</h2>
        <div className="space-y-2 text-xs">
          <p className="text-neutral-300">
            确认移除「{project.name}」？
          </p>
          <p className="rounded bg-yellow-900/40 px-2 py-1.5 text-yellow-300">
            只从注册表移除，不删磁盘目录。项目文件仍在 {project.path}
          </p>
          {error && (
            <p className="rounded bg-red-900/40 px-2 py-1.5 text-red-300">
              {error}
            </p>
          )}
          {recycleNotice && (
            <p
              data-recycle-warning
              className="rounded bg-yellow-900/40 px-2 py-1.5 text-yellow-300"
            >
              {recycleNotice}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            {recycleNotice ? (
              // 记录已移除，这一步只是让用户读完告警再收尾（列表刷新由 onRemoved 触发）
              <button
                data-recycle-ack
                onClick={() => onRemoved(project.id)}
                className="rounded bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700"
              >
                知道了
              </button>
            ) : (
              <>
                <button
                  onClick={onClose}
                  className="rounded bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700"
                >
                  取消
                </button>
                <button
                  onClick={confirm}
                  disabled={submitting}
                  className="rounded bg-red-700 px-3 py-1.5 text-neutral-100 hover:bg-red-600 disabled:opacity-50"
                >
                  {submitting ? "移除中…" : "确认移除"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
