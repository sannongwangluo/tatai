// 唯一写宿主的所有权边界共享模块（V09-29 恢复保护；契约 `docs/forward-progress-contract.md` F3 尾段；
// DESIGN.md §2.6/§11.3；PLAN V09-14；现场依据 `.工作台/evidence/progress-loop-20261002/runtime-observation.md`）。
//
// 为什么单独一个模块：**桌面宿主（index.ts/workHost.ts）、独立 daemon（daemon.ts）与后台发现
// （syncDiscovery.ts）三处必须用同一份"谁是当前唯一写者"的判据与同一份冷启动仲裁**，不能各写各的。
// 现场（runtime-observation.md）：真实安装版 `/health` 读 15s 超时，同一个 `C:/Users/<user>/.tatai`
// 同时存在多个 daemon/write-service 进程——旧实现"探活超时即当死宿主"会在慢但存活的宿主旁再拉起第二个写者。
//
// 硬口径（不新增调度平台，只把已有描述符 + 文件锁 + pid 存活核实用对）：
//   ① **探活超时 ≠ 进程已停**：描述符所指 pid 仍活（含权限未知，保守算活）时只能报"不可达/所有权待核实"，
//      **绝不**据此另起写者；
//   ② **冷启动只允许一个发布者**：以 dataDir 下的有界跨进程文件锁串行化发布，锁内再看一次描述符存活，
//      已有活宿主就让位；真 pid 死（ESRCH）才允许清陈旧描述符后自愈发布；
//   ③ **所有权以描述符（pid + 本次启动令牌）为准**：失去描述符即失去写者身份——旧宿主不得继续后台发现，
//      退出也不得撤销新宿主的描述符；
//   ④ **描述符「坏/读不了」是"所有权未知"，不是"无人拥有"**（本文件补修，见 ownership-review-remaining.md
//      第 3、4 条）：下面用 `readDescriptorState` 把「没有」与「有但坏/读不了/形状不合法」分开；前者可冷启动，
//      后者保守**既不发布也不删除**——绝不拿"读不出来"当"没人写"去覆盖不明所有权。退出撤描述符与发布共用
//      同一把跨进程锁，锁内比对 pid+token 后再删（读—判—删原子化），避免删掉刚被别人接管的新文件。
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../fileLock";
import {
  descriptorPidAlive,
  removeServiceDescriptor,
  serviceDescriptorPath,
  type WorkServiceDescriptor,
} from "./service";

/** 发布仲裁 / 撤描述符共用的跨进程锁目标（`withFileLock` 在其旁建 `<target>.lock`；与描述符分开，避免锁写覆盖描述符） */
const PUBLISH_LOCK_TARGET = "work-service.publish";

/** 描述符现场的三态：没有 / 有且合法 / 有但坏·读不了·形状不合法 */
export type DescriptorStateKind = "missing" | "valid" | "invalid";

export interface DescriptorState {
  kind: DescriptorStateKind;
  /** 仅 `kind==="valid"` 时给解析后的描述符，其余为 null */
  descriptor: WorkServiceDescriptor | null;
  /** 仅 `kind==="invalid"` 时给原因（读失败/解析失败/字段不合法） */
  reason: string | null;
}

/**
 * **严格**读描述符：区分「没有」与「有但坏/读不了/形状不合法」。
 *
 * 为什么不能用 `service.readServiceDescriptor`：它把"文件在但读不出/解析不了/形状不对"一律吞成 `null`，
 * 与"文件根本不存在"不可区分——调用方于是把「所有权未知」当成「无人拥有」去冷启动覆盖（现场缺陷④）。
 * 字段判据与 `readServiceDescriptor` 同款（port/host/token 必须是合法类型），另加 pid 必须是正整数：
 * pid 都判不出就无法核实存活，一并按「坏」保守处理。
 */
export function readDescriptorState(dataDir: string): DescriptorState {
  const file = serviceDescriptorPath(dataDir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    // ENOENT = 真的没有；其余（EACCES/EPERM/目录/其它 IO 错）= 有但读不了 → 坏
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "missing", descriptor: null, reason: null };
    }
    return { kind: "invalid", descriptor: null, reason: `描述符存在但读不出：${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { kind: "invalid", descriptor: null, reason: `描述符不是合法 JSON：${(e as Error).message}` };
  }
  const d = parsed as Partial<WorkServiceDescriptor> | null;
  if (
    typeof d !== "object" ||
    d === null ||
    typeof d.port !== "number" ||
    typeof d.host !== "string" ||
    typeof d.token !== "string" ||
    typeof d.pid !== "number" ||
    !Number.isInteger(d.pid) ||
    d.pid <= 0
  ) {
    return {
      kind: "invalid",
      descriptor: null,
      reason: "描述符字段不合法（缺 pid/host/port/token 或类型不对）",
    };
  }
  return { kind: "valid", descriptor: d as WorkServiceDescriptor, reason: null };
}

export interface OwnershipView {
  /** 当前数据目录里的写入服务描述符（无/坏 = null） */
  descriptor: WorkServiceDescriptor | null;
  /** 描述符属于本进程（pid 相同；token 另判） */
  isSelf: boolean;
  /** 描述符所指 pid 是否仍活（含权限未知，保守算活；无描述符/坏描述符 = false） */
  pidAlive: boolean;
  /** 描述符现场三态（missing/valid/invalid）——调用方据此区分"无人拥有"与"所有权未知" */
  state: DescriptorStateKind;
  /** `state==="invalid"` 时的原因 */
  reason: string | null;
}

/** 读当前所有权现场（**只读**，不写盘、不探活、不拉进程）。坏/读不了的描述符 → `state:"invalid"`、`descriptor:null`。 */
export function readOwnership(dataDir: string): OwnershipView {
  const st = readDescriptorState(dataDir);
  if (st.kind !== "valid" || st.descriptor === null) {
    return { descriptor: null, isSelf: false, pidAlive: false, state: st.kind, reason: st.reason };
  }
  return {
    descriptor: st.descriptor,
    isSelf: st.descriptor.pid === process.pid,
    pidAlive: descriptorPidAlive(st.descriptor),
    state: "valid",
    reason: null,
  };
}

/**
 * 当前描述符是否仍属于本进程本次启动（**同一份**所有权判据）：
 *   · 给了 `token`（有令牌的宿主）：pid 与 token 都要对——描述符被别的宿主覆盖即判失去所有权；
 *   · 未给 token（旧调用方，仅按 pid）：pid 对即算持有。
 * 读不出描述符（缺/坏/读不了）一律判**未持有**——写者身份由描述符承载，没有一份合法描述符就不是当前写作方。
 */
export function descriptorBelongsTo(dataDir: string, token: string | null): boolean {
  const st = readDescriptorState(dataDir);
  if (st.kind !== "valid" || st.descriptor === null) return false;
  const desc = st.descriptor;
  if (desc.pid !== process.pid) return false;
  if (token !== null && desc.token !== token) return false;
  return true;
}

export interface PublishArbitration {
  published: boolean;
  /**
   * published=false 时的原因：
   *   · `owned_by_live_process`——既有描述符属于别的仍活进程（不覆盖）；
   *   · `descriptor_unreadable`——描述符在场但坏/读不了，所有权未知（保守不发布不删除）；
   *   · `publish_lock_busy`——拿不到发布锁（保守放弃，宁可晚一拍）。
   */
  reason: string | null;
  /** 仲裁时看到的既有描述符（排障用；坏描述符时为 null） */
  existing: WorkServiceDescriptor | null;
  /** 拿不到锁/锁超时的具体错误（仅排障；不吞成成功） */
  lock_error?: string;
}

/**
 * 冷启动发布仲裁（有界跨进程锁 + 存活核实**只允许一个发布者**）。
 *
 * `publish()` 负责写本进程描述符（如同步的 `workHost.publish(port, host)`）。锁内流程：
 *   ① 描述符**在场但坏/读不了**（`descriptor_unreadable`）→ **不发布也不删**（所有权未知，保守放弃）；
 *   ② 描述符属于**别的仍存活进程**（含权限未知）→ **不发布**，返回 `owned_by_live_process`；
 *   ③ 描述符属于本进程（重发布/接管窗口）→ 直接发布；
 *   ④ 否则（无描述符，或描述符 pid 已死 ESRCH）→ 清陈旧描述符后 `publish()` 自愈发布。
 *
 * 锁本身有界（`withFileLock` 超时抛错）：拿不到锁（另一进程正在发布/接管）时按 `publish_lock_busy`
 * **保守放弃发布**——宁可晚一拍交给别人，也不在两把锁之间插队造第二个写者。
 */
export function publishUnderOwnershipLock(
  dataDir: string,
  publish: () => void,
  opts: { lockTimeoutMs?: number } = {},
): PublishArbitration {
  const lockTarget = path.join(dataDir, PUBLISH_LOCK_TARGET);
  try {
    return withFileLock(
      lockTarget,
      (): PublishArbitration => {
        const st = readDescriptorState(dataDir);
        if (st.kind === "invalid") {
          // 所有权未知：既不发布、也**不删**——删掉它就等于替一个读不出来的描述符做决定。
          return { published: false, reason: "descriptor_unreadable", existing: null };
        }
        const existing = st.descriptor;
        if (existing !== null && existing.pid !== process.pid && descriptorPidAlive(existing)) {
          return { published: false, reason: "owned_by_live_process", existing };
        }
        if (existing !== null) removeServiceDescriptor(dataDir);
        publish();
        return { published: true, reason: null, existing };
      },
      opts.lockTimeoutMs,
    );
  } catch (e) {
    const st = readDescriptorState(dataDir);
    // 具体错误（拿不到锁/锁超时）由调用方日志里带上；这里不吞成成功
    return {
      published: false,
      reason: "publish_lock_busy",
      existing: st.descriptor,
      lock_error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface DescriptorRemoval {
  removed: boolean;
  /**
   * removed=false 时的原因：
   *   · `missing`——本来就没有描述符（无可撤）；
   *   · `descriptor_unreadable`——描述符在场但坏/读不了，所有权未知（保守不删）；
   *   · `owned_by_other`——描述符属于别的进程（本次启动已被新宿主接管，不删别人的）；
   *   · `lock_busy`——拿不到发布锁（保守不删，留待下次核对）。
   */
  reason: "missing" | "descriptor_unreadable" | "owned_by_other" | "lock_busy" | null;
  existing: WorkServiceDescriptor | null;
  lock_error?: string;
}

/** 自愈清理也必须在发布锁内重读；锁外看到死 PID 不能作为删除后来新描述符的依据。 */
export function removeDescriptorIfDead(dataDir: string): boolean {
  try {
    return withFileLock(path.join(dataDir, PUBLISH_LOCK_TARGET), () => {
      const current = readDescriptorState(dataDir);
      if (current.kind !== "valid" || current.descriptor === null || descriptorPidAlive(current.descriptor)) return false;
      removeServiceDescriptor(dataDir);
      return true;
    });
  } catch {
    return false; // 无法核实或锁忙时保留现场，由后续发布仲裁继续把关。
  }
}

/**
 * **锁内比对后删除**本进程的描述符（退出撤描述符走这里，与发布共用同一把跨进程锁）。
 *
 * 为什么必须原子：先前 `workHost.unpublish` 是"先 `readServiceDescriptor` 读到自己的描述符 → 再 `rm`"，
 * 两次操作之间如果新宿主恰好接管并写了**自己的**描述符，旧的 `rm` 就会把新文件删掉（第二个写者丢身份）。
 * 这里把「读—判—删」放进同一把发布锁：任何发布/接管都要先拿这把锁，故不会交错。
 *
 * 判据（与 `descriptorBelongsTo` 同一份）：pid + 本次启动 token 都对才删；描述符坏/读不了**保守不删**；
 * 属于别人不删；锁拿不到**保守不删**。任何一种不确定都选择"留着"——删错新宿主描述符的代价远大于留一个陈旧指针。
 */
export function removeDescriptorIfOwned(
  dataDir: string,
  token: string | null,
  opts: { lockTimeoutMs?: number } = {},
): DescriptorRemoval {
  const lockTarget = path.join(dataDir, PUBLISH_LOCK_TARGET);
  try {
    return withFileLock(
      lockTarget,
      (): DescriptorRemoval => {
        const st = readDescriptorState(dataDir);
        if (st.kind === "missing") return { removed: false, reason: "missing", existing: null };
        if (st.kind === "invalid") return { removed: false, reason: "descriptor_unreadable", existing: null };
        const desc = st.descriptor;
        if (desc === null) return { removed: false, reason: "missing", existing: null };
        const mine = desc.pid === process.pid && (token === null || desc.token === token);
        if (!mine) return { removed: false, reason: "owned_by_other", existing: desc };
        removeServiceDescriptor(dataDir);
        return { removed: true, reason: null, existing: desc };
      },
      opts.lockTimeoutMs,
    );
  } catch (e) {
    let existing: WorkServiceDescriptor | null = null;
    try {
      existing = readDescriptorState(dataDir).descriptor;
    } catch {
      existing = null;
    }
    return {
      removed: false,
      reason: "lock_busy",
      existing,
      lock_error: e instanceof Error ? e.message : String(e),
    };
  }
}
