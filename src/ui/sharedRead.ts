// V09-36（PLAN.md V09-36；DESIGN.md §6.8；docs/unified-optimization-contract.md U4）
// V09-38 复审修正：头规范化防碰撞、同步异常清理、每订阅者独立 body 取消、写后失效代际。
//
// 界面「在途只读请求共享」：把 `apiFetch` / `forwardFetch` 发出的**同项目、同权限、同参数、同版本**的
// GET/HEAD 请求在**在途期间**合并成一次真实网络，每个调用者各拿一份**独立可消费**的 `Response`。
// 这是「同版事实只求值一次」在 UI 侧的最小落点（契约 U4），**不是缓存**：
//
//   · 只合并 **GET/HEAD**；带 body 的请求一律不合并；**写请求（POST/PUT/DELETE/PATCH）不合并**。
//   · key = method + 完整 URL（含项目 id 与查询参数）+ **规范化后的**语义 init。headers 用
//     `[name, value][]` 二维数组的规范 JSON（不是 `a:b|c:d` 拼串），彻底消除"值里含分隔符"的碰撞；
//     认不出的 RequestInit/headers 一律**不共享**（逐字透传），绝不静默误合并。
//   · **失效代际（epoch）**：写请求开始/完成、以及明确失效（回前台/在线恢复）时递增读取代际。
//     新读**不会**加入写前旧代际的在途槽——相同 URL 不自动等于相同版本。
//   · **无 TTL**：底层结算（完成/失败/全部取消）即刻清槽，下一次调用必发新请求。
//   · **AbortSignal 每订阅者独立**：每个订阅者拿到一份 clone 并用**独立 `ReadableStream`** 包装，
//     该订阅者取消只 error/取消**自己那一支** body，不影响其它订阅者，也不中止底层连接；
//     **只有全部订阅者都取消**时才 abort 底层控制器并清槽。status/headers 语义保留。
//   · **同步异常清理**：底层传输**同步抛错**时立刻清掉刚登记的槽并拒绝，绝不留下永久空槽。
//   · 取消后槽已清除，**新请求不会复用已 abort 的 promise**。
//
// 传输层由调用方注入（`raw`，落在 `api.ts#rawFetch`）——保持「全前端唯一裸 fetch 出口」这一既有
// 不变量（scripts/verify-u1.ts 的 bareFetch===1）；本模块自身不直接持有 `fetch`，因此可在 Node 隔离
// 真跑（真实 HTTP 并发 + 不同 abort 客户端），不依赖浏览器/壳环境。

export type RawFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface Subscriber {
  done: boolean;
  signal: AbortSignal | null;
  onAbort: () => void;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
}

interface Slot {
  key: string;
  /** 该槽登记时的读取代际；只有代际仍等于当前值的新读才允许并入 */
  gen: number;
  controller: AbortController;
  subscribers: Set<Subscriber>;
}

/** 在途槽：key → 那一笔共享的真实网络。结算/全部取消即删。 */
const inflight = new Map<string, Slot>();

/** 只读且无体的语义安全方法（与 HTTP 幂等读语义一致）。 */
const SHAREABLE_METHODS = new Set(["GET", "HEAD"]);
const ARRAY_ITERATOR = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)?.value;
const HEADERS_ITERATOR = typeof Headers === "function"
  ? Object.getOwnPropertyDescriptor(Headers.prototype, Symbol.iterator)?.value : undefined;

/**
 * 读取代际。写请求（写开始 + 写完成）与明确的失效点（回前台/在线恢复）会 +1；
 * 新读只并入**同一代际**的在途槽，因此"写成功后"的新读绝不会复用"写前"发出的旧在途请求。
 */
let readGeneration = 0;

/**
 * 主动作废当前读取代际（V09-38 复审）。用于**已知失效**的时刻：写请求由本模块自动调用；
 * 界面层可在明确知道"数据可能已变"时调用（如 `useProjectRefresh` 的回前台/在线恢复）。
 * 只影响"新读要不要并入旧在途"，不会取消任何在途请求，也不改变刷新频率/隐藏策略。
 */
export function invalidateSharedReads(): void {
  readGeneration += 1;
}

/** 当前读取代际（验证/调试用；只读） */
export function currentReadGeneration(): number {
  return readGeneration;
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

/**
 * 头规范化：头名大小写及不同头的顺序无关；同名多值保留平台 Headers 的追加顺序。
 * 返回二维数组（交给 JSON 序列化），不能按值排序而把 a,b 与 b,a 合并。
 * 认不出的形态（非 HeadersInit、值不是字符串）返回 `null` → 调用方**不共享**。
 */
function normalizeHeaders(headers: HeadersInit | undefined | null): Array<[string, string]> | null {
  if (headers === undefined) return [];
  if (headers === null) return null; // 平台拒绝 null，不能借空头的成功在途响应掩盖错误。
  if (typeof Headers === "function" && headers instanceof Headers) {
    // 可执行迭代器只能让真实 fetch 消费一次；预检不访问自定义 getter。
    if (Object.getPrototypeOf(headers) !== Headers.prototype ||
        Object.getOwnPropertyDescriptor(headers, Symbol.iterator) !== undefined ||
        Object.getOwnPropertyDescriptor(Headers.prototype, Symbol.iterator)?.value !== HEADERS_ITERATOR) return null;
  } else if (Array.isArray(headers)) {
    const ordinaryArray = (value: unknown): value is unknown[] => Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype &&
      Object.getOwnPropertyDescriptor(value, Symbol.iterator) === undefined &&
      Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)?.value === ARRAY_ITERATOR;
    if (!ordinaryArray(headers)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(headers);
    for (let i = 0; i < headers.length; i++) {
      const descriptor = descriptors[String(i)];
      if (descriptor === undefined || !("value" in descriptor)) return null;
      const pair = descriptor.value;
      if (!ordinaryArray(pair) || pair.length !== 2) return null;
      if (typeof Object.getOwnPropertyDescriptor(pair, "0")?.value !== "string" ||
          typeof Object.getOwnPropertyDescriptor(pair, "1")?.value !== "string") return null;
    }
  } else if (typeof headers === "object") {
    const proto = Object.getPrototypeOf(headers);
    if ((proto !== Object.prototype && proto !== null) || Symbol.iterator in headers) return null;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(headers))) {
      if (!("value" in descriptor) || typeof descriptor.value !== "string") return null;
    }
  } else {
    return null;
  }
  if (typeof Headers !== "function") return null;
  const normalized: Array<[string, string]> = [];
  new Headers(headers).forEach((value, name) => normalized.push([name, value]));
  return normalized;
}

/** 计算共享 key；返回 null 表示「不共享」（非 GET/HEAD、带 body、或认不出的 init/headers）。 */
function canonicalKey(url: string, method: string, init: RequestInit | undefined): string | null {
  if (!SHAREABLE_METHODS.has(method)) return null;
  try {
    const fields: string[] = [];
    const record = init as Record<string, unknown> | undefined;
    for (const k of Object.keys(record ?? {}).sort()) {
      if (k === "signal" || k === "method") continue; // 每订阅者独立 / 已并入前缀
      const v = record?.[k];
      if (k === "body") {
        if (v !== undefined && v !== null) return null; // 带 body 不共享
        continue;
      }
      if (v === undefined) continue;
      if (k === "headers") {
        const norm = normalizeHeaders(v as HeadersInit);
        if (norm === null) return null; // 认不出的 headers：不共享，逐字透传
        fields.push(`headers=${JSON.stringify(norm)}`);
        continue;
      }
      if (typeof v === "function") return null; // 无法稳定序列化：不共享
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (s === undefined) return null;
      fields.push(`${k}=${s}`);
    }
    return `${method}\u0000${url}\u0000${fields.join("\u0000")}`;
  } catch {
    return null; // 循环引用等：认不出就不共享
  }
}

/** 登记一个订阅者：各自可独立取消，且拿到独立的可消费响应。 */
function subscribe(slot: Slot, signal: AbortSignal | null | undefined): Promise<Response> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<Response>((resolve, reject) => {
    const sub: Subscriber = { done: false, signal: signal ?? null, onAbort: () => {}, resolve, reject };
    sub.onAbort = () => {
      if (sub.done) return;
      sub.done = true;
      sub.signal?.removeEventListener("abort", sub.onAbort);
      slot.subscribers.delete(sub);
      reject(abortError());
      // 最后一个订阅者也退出：中止底层并清槽——取消后新请求不复用已 abort 的 promise
      if (slot.subscribers.size === 0) {
        if (inflight.get(slot.key) === slot) inflight.delete(slot.key);
        slot.controller.abort();
      }
    };
    slot.subscribers.add(sub);
    if (sub.signal) sub.signal.addEventListener("abort", sub.onAbort, { once: true });
  });
}

/**
 * 把一份响应 clone 包成**该订阅者专属**的 `ReadableStream`，并绑定它自己的取消信号：
 * 该信号一旦 abort，只 error/取消这一支；其它订阅者的 clone 分支不受影响。
 * status/headers 语义保留；不整段 buffer 正文（逐块转发）。
 */
function bindBranch(res: Response, signal: AbortSignal | null): Response {
  const body = res.body;
  if (signal === null || body === null || res.status === 0) return res;
  const reader = body.getReader();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settled = false;
  const cleanup = (): void => {
    if (signal !== null) signal.removeEventListener("abort", onAbort);
  };
  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      ctrl?.error(abortError());
    } catch {
      /* 流已关闭/已 error：忽略 */
    }
    void reader.cancel().catch(() => undefined);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(c) {
      if (settled) return;
      try {
        const { done, value } = await reader.read();
        if (settled) return;
        if (done) {
          settled = true;
          cleanup();
          c.close();
        } else {
          c.enqueue(value);
        }
      } catch (e) {
        if (!settled) {
          settled = true;
          cleanup();
          c.error(e);
        }
      }
    },
    cancel(reason) {
      settled = true;
      cleanup();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** 底层结算：清槽（无 TTL），把结果分发给当前订阅者；每个订阅者各拿一份独立支流。 */
function settle(slot: Slot, outcome: { response: Response } | { error: unknown }): void {
  if (inflight.get(slot.key) === slot) inflight.delete(slot.key);
  const response = "response" in outcome ? outcome.response : null;
  const error = "error" in outcome ? outcome.error : null;
  const subs = [...slot.subscribers];
  slot.subscribers.clear();
  if (response !== null) {
    for (const sub of subs) {
      if (sub.done) continue;
      sub.done = true;
      sub.signal?.removeEventListener("abort", sub.onAbort);
      try {
        sub.resolve(bindBranch(response.clone(), sub.signal));
      } catch (e) {
        sub.reject(e);
      }
    }
    // 原始响应无人消费：取消它这一支（各 clone 分支独立，不受影响；未读分支随之释放）。
    if (response.body !== null) void response.body.cancel().catch(() => undefined);
  } else {
    for (const sub of subs) {
      if (sub.done) continue;
      sub.done = true;
      sub.signal?.removeEventListener("abort", sub.onAbort);
      sub.reject(error);
    }
  }
}

/**
 * 在途只读请求共享入口。GET/HEAD 且无 body 时合并同 key、**同代际**的在途请求；其余情况逐字透传给 `raw`。
 * 语义与返回契约对调用者透明：调用者仍按普通 `fetch` 使用（可读 body、可 abort 自己）。
 */
export function sharedReadFetch(url: string, init: RequestInit | undefined, raw: RawFetch): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const shareable = SHAREABLE_METHODS.has(method);
  const key = canonicalKey(url, method, init);
  if (key === null) {
    // 写请求 / 带 body / 认不出的 init：不共享，逐字透传。
    // 写请求在**开始**与**完成**都失效读取代际：写前发出的在途读，写后不得再被并入。
    if (!shareable) invalidateSharedReads();
    let p: Promise<Response>;
    try {
      p = raw(url, init);
    } catch (e) {
      return Promise.reject(e);
    }
    if (!shareable) {
      p.then(
        () => invalidateSharedReads(),
        () => invalidateSharedReads(),
      );
    }
    return p;
  }

  const existing = inflight.get(key);
  if (existing !== undefined && existing.gen === readGeneration) return subscribe(existing, init?.signal);
  if (init?.signal?.aborted) return Promise.reject(abortError());

  const { signal: _callerSignal, ...rest } = init ?? {};
  void _callerSignal;
  const controller = new AbortController();
  const slot: Slot = { key, gen: readGeneration, controller, subscribers: new Set() };
  inflight.set(key, slot); // 先登记槽，再发起：并发调用才能命中同一笔网络
  let promise: Promise<Response>;
  try {
    promise = raw(url, { ...rest, method, signal: controller.signal });
  } catch (e) {
    // **同步抛错**：清掉刚登记的槽，否则后续同 key 调用会永久 pending 在一个死槽上。
    if (inflight.get(key) === slot) inflight.delete(key);
    return Promise.reject(e);
  }
  promise.then(
    (response) => settle(slot, { response }),
    (error) => settle(slot, { error }),
  );
  return subscribe(slot, init?.signal);
}
