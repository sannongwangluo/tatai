// V09-36 界面共享取数与明确新鲜度：`apiFetch`/`forwardFetch` 的**在途只读请求共享**验证（先红后绿）。
//
// 施工目标（PLAN.md V09-36；DESIGN.md §6.8；docs/unified-optimization-contract.md U4）：
//   ① 同项目、权限、参数、版本的 **GET/HEAD 在途请求合并**——相同完整 URL + method + headers/credentials
//      等语义参数并发只打一次网络；
//   ② 共享结果**每个调用者各拿一份可独立消费的 Response**（clone），一个读体不影响另一个；
//   ③ **写请求不合并**；**无 TTL 缓存**——完成/失败后槽即清，下一次调用必发新请求；
//   ④ **AbortSignal 每订阅者独立**：一个取消不取消其它；**全部取消才 abort 底层**；
//   ⑤ 取消后**新请求不得复用已 abort 的 promise**；
//   ⑥ 不同项目/权限/参数**不得串用**（key 含 URL 与语义 init）；
//   ⑦ 保持既有刷新语义（5 秒周期 / 回前台补拉 / SSE / 隐藏策略 / 切项目旧回包保护）——本脚本只读断言
//      useProjectRefresh.ts 现行口径仍在，不改它。
//
// 红绿口径（本卡"先用有意义反例红测，再实现再绿测"）：
//   · 同一条测试电池跑两遍——`naive`（等价改前"每次调用各自 fetch"的直通实现）应**至少**在
//     合并/中止隔离两类反例上 FAIL，证明原行为确有该缺陷；
//   · `shared`（被测 `src/ui/sharedRead.ts`）必须全 PASS。
//   两遍都用**真实 HTTP**：本脚本起一个真实 node:http 服务计数请求与客户端中止，不 mock 传输层。
//
// 隔离口径（AGENTS.md §5）：只监听 127.0.0.1 的随机端口，纯内存计数，不碰真实 ~/.tatai、真实项目、
//   账本或生产数据；不调模型、不联网外发。收尾关闭服务与残留连接。
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invalidateSharedReads, sharedReadFetch, type RawFetch } from "../src/ui/sharedRead";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(REPO_ROOT, "src", "ui");

// ── 计数服务器：真实 HTTP，记录每个请求与方法/URL/关键头，并记录"客户端中止（未写完就断）" ──
interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}
const hits: Hit[] = [];
const aborts: string[] = [];

function startServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const full = req.url ?? "/";
    hits.push({ method: req.method ?? "", url: full, headers: req.headers });
    const u = new URL(full, "http://127.0.0.1");
    let closedEarly = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        closedEarly = true;
        aborts.push(full);
      }
    });
    // 真实慢 body：先发头与半截 JSON，250ms 后补完。用于验证"取消一名订阅者只让它自己的 body reject"。
    if (u.pathname === "/slowbody") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":');
      setTimeout(() => {
        if (res.writableEnded) return;
        try {
          res.write("true}");
          res.end();
        } catch {
          /* 连接已断 */
        }
      }, 250);
      return;
    }
    const fail = u.searchParams.get("fail");
    if (fail === "reset") {
      req.socket.destroy();
      return;
    }
    // 定向用例（V09-26/F2 补齐）：`/git-status` 是**慢读口**——默认 400ms 后才回体，
    // 让调用方能在"在途"期间 abort（要证的是**真实中止网络**，不是回包后再过滤旧结果）。
    const isGitStatus = u.pathname.endsWith("/git-status");
    const delay = Number(u.searchParams.get("delay") ?? (isGitStatus ? "400" : "0"));
    const send = (): void => {
      if (closedEarly) return;
      try {
        if (fail === "500") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "boom" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            isGitStatus
              ? {
                  ok: true,
                  git: { probe_ok: true, is_repository: true, error: null },
                  reminder: { change_fingerprint: "fp-fixture", is_repository: true, probe_error: null },
                }
              : {
                  ok: true,
                  url: full,
                  echo: req.headers["x-echo"] ?? null,
                  headers: req.headers,
                  n: hits.filter((h) => h.url === full).length,
                },
          ),
        );
      } catch {
        /* 客户端已断/已写：忽略 */
      }
    };
    if (delay > 0) setTimeout(send, delay);
    else send();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── 断言与结算工具 ──
let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tick = (): Promise<void> => wait(0);
/** 服务器的 req.url 是 path+query；把被测的绝对 URL 归一后比对。 */
const pathOf = (url: string): string => {
  const u = new URL(url, "http://127.0.0.1");
  return `${u.pathname}${u.search}`;
};
const count = (url: string): number => hits.filter((h) => h.url === pathOf(url)).length;
const abortCount = (url: string): number => aborts.filter((a) => a === pathOf(url)).length;

type Settled = { ok: true; value: Response } | { ok: false; error: unknown };
async function settle(p: Promise<Response>): Promise<Settled> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e };
  }
}
const errName = (e: unknown): string => (e instanceof Error ? e.name : String(e));

// ── 测试电池：subject = 被测的"共享读"实现；raw = 真实 fetch 传输 ──
type Subject = (url: string, init: RequestInit | undefined, raw: RawFetch) => Promise<Response>;

let base = "";
let seq = 0;
const mkUrl = (label: string, qs = ""): string => `${base}/p/${label}-${++seq}${qs ? `?${qs}` : ""}`;

interface CaseResult {
  id: string;
  ok: boolean;
}

const needsMerge = new Set(["T1", "T6", "T7", "T10", "T12"]);

async function runBattery(tag: string, subject: Subject, raw: RawFetch): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  // 电池内部的 PASS/FAIL 只作取证与红绿对照，**不计入脚本退出码**（naive 基线本就应当 FAIL）。
  const rec = (id: string, cond: boolean, label: string, detail?: unknown): void => {
    console.log(`[verify] ${cond ? "PASS" : "FAIL"} [${tag}] ${id} ${label}`);
    if (!cond && detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
    out.push({ id, ok: cond });
  };
  console.log(`\n[verify] ── 电池 ${tag} ──`);

  // T1 相同 GET 在途合并 + 每个调用者独立可消费
  {
    const u = mkUrl("coalesce", "delay=150");
    const pa = subject(u, undefined, raw);
    const pb = subject(u, undefined, raw);
    const [ra, rb] = await Promise.all([settle(pa), settle(pb)]);
    const ta = ra.ok ? await ra.value.text() : "";
    const tb = rb.ok ? await rb.value.text() : "";
    rec(
      "T1",
      ra.ok && rb.ok && ra.value !== rb.value && count(u) === 1 && ta === tb && ta.includes('"ok":true'),
      "相同 GET 并发只打一次网络，两个调用者各拿独立可消费 Response",
      { count: count(u), raOk: ra.ok, rbOk: rb.ok, distinct: ra.ok && rb.ok ? ra.value !== rb.value : null, ta, tb },
    );
  }

  // T2 不同查询参数不合并
  {
    const x = `${base}/p/query-diff-${tag}?a=1&delay=80`;
    const y = `${base}/p/query-diff-${tag}?a=2&delay=80`;
    await Promise.all([settle(subject(x, undefined, raw)), settle(subject(y, undefined, raw))]);
    rec("T2", count(x) === 1 && count(y) === 1, "不同查询参数不合并（各打一次）", { cx: count(x), cy: count(y) });
  }

  // T3 不同请求头不合并
  {
    const u = mkUrl("hdr", "delay=80");
    const [ra, rb] = await Promise.all([
      settle(subject(u, { headers: { "x-echo": "a" } }, raw)),
      settle(subject(u, { headers: { "x-echo": "b" } }, raw)),
    ]);
    const ea = ra.ok ? ((await ra.value.json()) as { echo: string }).echo : null;
    const eb = rb.ok ? ((await rb.value.json()) as { echo: string }).echo : null;
    rec("T3", count(u) === 2 && ea === "a" && eb === "b", "不同请求头不合并，且各自语义透传", { count: count(u), ea, eb });
  }

  // T4 不同 credentials/缓存语义不合并
  {
    const u = mkUrl("cred", "delay=80");
    await Promise.all([
      settle(subject(u, { credentials: "omit" }, raw)),
      settle(subject(u, { credentials: "include" }, raw)),
    ]);
    rec("T4", count(u) === 2, "不同 credentials 不合并（语义参数进 key）", { count: count(u) });
  }

  // T5 写请求不合并
  {
    const u = mkUrl("post", "delay=80");
    const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    const [ra, rb] = await Promise.all([settle(subject(u, init, raw)), settle(subject(u, { ...init }, raw))]);
    const ta = ra.ok ? await ra.value.text() : "";
    const tb = rb.ok ? await rb.value.text() : "";
    rec("T5", count(u) === 2 && ta.includes('"ok":true') && tb.includes('"ok":true'), "POST 不合并（写请求各自发出）", { count: count(u) });
  }

  // T5b method 大小写归一："get" 与 "GET" 视为同一语义 → 合并
  {
    const u = mkUrl("method-case", "delay=120");
    const [ra, rb] = await Promise.all([
      settle(subject(u, { method: "get" }, raw)),
      settle(subject(u, { method: "GET" }, raw)),
    ]);
    rec("T5b", ra.ok && rb.ok && count(u) === 1, "method 大小写归一后仍合并", { count: count(u) });
  }

  // T6 中止隔离：一个取消不取消其它；底层不被 abort
  {
    const u = mkUrl("abort-iso", "delay=200");
    const c1 = new AbortController();
    const c2 = new AbortController();
    // 先挂结算（附上拒绝处理器）再取消，避免瞬时未处理的 promise 拒绝。
    const s1 = settle(subject(u, { signal: c1.signal }, raw));
    const s2 = settle(subject(u, { signal: c2.signal }, raw));
    await tick();
    c1.abort();
    const r1 = await s1;
    const r2 = await s2;
    const t2 = r2.ok ? await r2.value.text() : "";
    rec(
      "T6",
      !r1.ok && errName(r1.error) === "AbortError" && r2.ok && t2.includes('"ok":true') && count(u) === 1 && abortCount(u) === 0,
      "一个订阅者取消只拒自己；其它订阅者照常拿到响应；底层连接未被 abort",
      { r1: r1.ok ? "resolved" : errName(r1.error), r2ok: r2.ok, count: count(u), aborts: abortCount(u) },
    );
  }

  // T7 全部取消才 abort 底层 + T8 取消后新请求不复用已 abort 的 promise
  {
    const u = mkUrl("abort-all", "delay=500");
    const c1 = new AbortController();
    const c2 = new AbortController();
    const s1 = settle(subject(u, { signal: c1.signal }, raw));
    const s2 = settle(subject(u, { signal: c2.signal }, raw));
    await tick();
    c1.abort();
    await tick();
    c2.abort();
    const r1 = await s1;
    const r2 = await s2;
    await wait(120); // 让服务器观察到底层被 abort
    const allCancelled =
      !r1.ok && errName(r1.error) === "AbortError" && !r2.ok && errName(r2.error) === "AbortError" && count(u) === 1 && abortCount(u) === 1;
    rec("T7", allCancelled, "全部订阅者取消 → 底层被 abort（且只发过一次网络）", { count: count(u), aborts: abortCount(u) });

    const before = count(u);
    const again = await settle(subject(u, undefined, raw));
    rec("T8", again.ok && count(u) - before === 1, "取消后新请求必发新网络（不复用已 abort 的 promise）", { delta: count(u) - before });
  }

  // T9 无 TTL 缓存：完成后再调 → 新请求
  {
    const u = mkUrl("no-ttl", "");
    const r1 = await settle(subject(u, undefined, raw));
    const r2 = await settle(subject(u, undefined, raw));
    rec("T9", r1.ok && r2.ok && count(u) === 2, "完成后无 TTL：下一次调用必发新请求", { count: count(u) });
  }

  // T10 失败槽清理：共享的失败请求 + 之后重发；HTTP 500 仍算已结算的 Response（不抛）
  {
    const u = mkUrl("fail-clean", "fail=reset");
    const [ra, rb] = await Promise.all([settle(subject(u, undefined, raw)), settle(subject(u, undefined, raw))]);
    const n1 = count(u);
    const rc = await settle(subject(u, undefined, raw));
    const n2 = count(u);
    rec(
      "T10",
      !ra.ok && !rb.ok && n1 === 1 && !rc.ok && n2 === 2,
      "网络失败也合并成一次；失败槽清理后重发新请求",
      { n1, n2, ra: ra.ok, rb: rb.ok, rc: rc.ok },
    );

    const u500 = mkUrl("http-500", "delay=60&fail=500");
    const [sa, sb] = await Promise.all([settle(subject(u500, undefined, raw)), settle(subject(u500, undefined, raw))]);
    rec(
      "T10b",
      sa.ok && sb.ok && sa.value.status === 500 && sb.value.status === 500 && count(u500) === 1,
      "HTTP 500 是已结算 Response（fetch 不抛），仍合并成一次",
      { count: count(u500), sa: sa.ok ? sa.value.status : null, sb: sb.ok ? sb.value.status : null },
    );
  }

  // T11 不同项目 id 不串用
  {
    const ua = `${base}/api/projects/proj-A-${tag}/live?delay=60`;
    const ub = `${base}/api/projects/proj-B-${tag}/live?delay=60`;
    const [ra, rb] = await Promise.all([settle(subject(ua, undefined, raw)), settle(subject(ub, undefined, raw))]);
    const ba = ra.ok ? (await ra.value.json()) as { url: string } : { url: "" };
    const bb = rb.ok ? (await rb.value.json()) as { url: string } : { url: "" };
    rec(
      "T11",
      count(ua) === 1 && count(ub) === 1 && ba.url !== bb.url,
      "不同项目 id 不串用（各拿各自回包）",
      { ca: count(ua), cb: count(ub), ba: ba.url, bb: bb.url },
    );
  }

  // T12 三个并发相同 GET → 只打一次；三个都独立可消费
  {
    const u = mkUrl("triple", "delay=150");
    const ps = [subject(u, undefined, raw), subject(u, undefined, raw), subject(u, undefined, raw)];
    const rs = await Promise.all(ps.map(settle));
    const texts = await Promise.all(rs.map((r) => (r.ok ? r.value.text() : Promise.resolve(""))));
    rec(
      "T12",
      rs.every((r) => r.ok) && count(u) === 1 && new Set(texts).size === 1 && texts[0].includes('"ok":true'),
      "三个并发相同 GET 只打一次网络，三者都独立可消费",
      { count: count(u), ok: rs.map((r) => r.ok) },
    );
  }

  // 收尾：等所有在途都结束，槽应清空（不影响后续断言）
  await wait(80);
  info(`${tag} 电池小结：PASS ${out.filter((r) => r.ok).length}/${out.length}`);
  return out;
}

// ── 静态接线断言：api.ts / forwardApi.ts 必须经 sharedReadFetch；且不吃掉 verify-u1 的唯一裸 fetch 不变量 ──
function staticChecks(): void {
  console.log("\n[verify] ── 静态接线与刷新语义 ──");
  const apiSrc = fs.readFileSync(path.join(UI_DIR, "api.ts"), "utf8");
  const fwdSrc = fs.readFileSync(path.join(UI_DIR, "forwardApi.ts"), "utf8");
  const sharedSrc = fs.readFileSync(path.join(UI_DIR, "sharedRead.ts"), "utf8");
  const refreshSrc = fs.readFileSync(path.join(UI_DIR, "useProjectRefresh.ts"), "utf8");

  ok(/sharedReadFetch\(/.test(apiSrc), "api.ts#apiFetch 经 sharedReadFetch 走共享读口");
  ok(/sharedReadFetch\(/.test(fwdSrc), "forwardApi.ts#forwardFetch 经 sharedReadFetch 走共享读口");
  const bareFetch = [...apiSrc.matchAll(/(?<!api)fetch\(/g)].length; // 同 verify-u1 判据
  ok(bareFetch === 1, "api.ts 仍是全前端唯一裸 fetch 出口（保持 verify-u1 的 bareFetch===1 不变量）", { bareFetch });
  ok(!/import\.meta\.env/.test(sharedSrc), "sharedRead.ts 环境中立（不读 import.meta.env，便于隔离真跑）");
  ok(/PROJECT_REFRESH_INTERVAL_MS = 5000/.test(refreshSrc), "刷新周期仍为 5 秒（本轮不改刷新语义）");
  ok(/visibilitychange/.test(refreshSrc) && /addEventListener\("online"/.test(refreshSrc), "回前台补拉/在线恢复策略仍在");
  ok(
    /invalidateSharedReads/.test(refreshSrc),
    "useProjectRefresh 在回前台/在线恢复处接线失效代际（V09-38 复审：已知失效须作废旧在途）",
  );

  // U4 续修：三个 SSE 消费组件都必须把"已知失效"（onopen/onmessage 真变化）接进共享读取代际，
  // 且重拉有界（不每事件一请求）。ChangesEntry 保留既有 300ms 尾随 + 在途去重，不倒退。
  const changesSrc = fs.readFileSync(path.join(UI_DIR, "components", "ChangesEntry.tsx"), "utf8");
  const liveSrc = fs.readFileSync(path.join(UI_DIR, "components", "LiveView.tsx"), "utf8");
  const reminderSrc = fs.readFileSync(path.join(UI_DIR, "components", "VersionReminder.tsx"), "utf8");
  ok(
    /import \{ invalidateSharedReads \}/.test(changesSrc) && /invalidateSharedReads\(\)/.test(changesSrc),
    "ChangesEntry：已知失效作废读取代际（onopen/onmessage 真变化触发的对账不并入变化前在途）",
  );
  ok(/RESYNC_DEBOUNCE_MS = 300/.test(changesSrc), "ChangesEntry：保留 300ms 尾随合并窗口（不每事件一请求）");
  ok(
    /useBoundedReloader\(/.test(liveSrc) && /invalidateSharedReads\(\)/.test(liveSrc) && /RESYNC_DEBOUNCE_MS = 300/.test(liveSrc),
    "LiveView：有界重拉（useBoundedReloader）+ 已知失效作废代际 + 事件合并窗口",
  );
  ok(
    /useBoundedReloader\(/.test(reminderSrc) && /invalidateSharedReads\(\)/.test(reminderSrc) && /RESYNC_DEBOUNCE_MS = 500/.test(reminderSrc),
    "VersionReminder：有界重拉（useBoundedReloader）+ 已知失效作废代际 + 500ms 合并窗口",
  );
}

// ── V09-38 复审定向用例（真实 HTTP，不 mock）：头碰撞 / 同步异常清理 / body 取消隔离 / 写后失效代际 ──
async function directedChecks(raw: RawFetch): Promise<void> {
  console.log("\n[verify] ── 复审定向用例（真实 HTTP） ──");

  // U-HDR 头分隔符碰撞：{x:'a|y:b'} 与 {x:'a', y:'b'} 语义不同，不得合并
  {
    const u = mkUrl("hdr-collision", "delay=120");
    const [ra, rb] = await Promise.all([
      settle(sharedReadFetch(u, { headers: { x: "a|y:b" } }, raw)),
      settle(sharedReadFetch(u, { headers: { x: "a", y: "b" } }, raw)),
    ]);
    const ja = ra.ok ? ((await ra.value.json()) as { headers: Record<string, string> }) : null;
    const jb = rb.ok ? ((await rb.value.json()) as { headers: Record<string, string> }) : null;
    ok(
      ra.ok &&
        rb.ok &&
        count(u) === 2 &&
        ja?.headers.x === "a|y:b" &&
        jb?.headers.x === "a" &&
        jb?.headers.y === "b",
      "U-HDR 含分隔符的头值不再与多值头碰撞（2 次网络，各自语义透传）",
      { count: count(u), ja: ja?.headers, jb: jb?.headers },
    );
  }

  // U-HDR2 规范化：大小写/顺序不同但语义相同的头仍应合并（防"过度不共享"）
  {
    const u = mkUrl("hdr-norm", "delay=120");
    const [ra, rb] = await Promise.all([
      settle(sharedReadFetch(u, { headers: { "X-Echo": "same" } }, raw)),
      settle(sharedReadFetch(u, { headers: { "x-echo": "same" } }, raw)),
    ]);
    const ta = ra.ok ? await ra.value.text() : "";
    const tb = rb.ok ? await rb.value.text() : "";
    ok(ra.ok && rb.ok && count(u) === 1 && ta === tb, "U-HDR2 大小写归一后同义头仍合并（不因规范化而过度不共享）", { count: count(u) });
  }

  // U-SYNC 底层同步抛错：清槽并拒绝，不留永久空槽
  {
    let calls = 0;
    const syncThrow = ((): never => {
      calls += 1;
      throw new Error("synchronous transport error");
    }) as unknown as RawFetch;
    const first = await settle(sharedReadFetch("http://fixture/sync-throw", undefined, syncThrow));
    const second = await settle(sharedReadFetch("http://fixture/sync-throw", undefined, syncThrow));
    ok(
      !first.ok && !second.ok && calls === 2,
      "U-SYNC 同步抛错不留死槽：两次都拒绝、底层两次都真被调用",
      { calls, first: first.ok, second: second.ok },
    );
  }

  // U-BODY 真实慢 body：两订阅者，取消一人只让它自己的 body reject，另一人 body 成功
  {
    const u = `${base}/slowbody?case=abort-${++seq}`;
    const ctrl = new AbortController();
    const p1 = sharedReadFetch(u, { signal: ctrl.signal }, raw);
    const p2 = sharedReadFetch(u, undefined, raw);
    const [res1, res2] = await Promise.all([p1, p2]); // 头已到，body 尚未结束（慢 body）
    ctrl.abort();
    const b1 = await res1.json().then(
      () => "resolved",
      (e) => (e as Error).name,
    );
    const b2 = await res2.json().then(
      () => "resolved-ok",
      (e) => (e as Error).name,
    );
    ok(
      b1 === "AbortError" && b2 === "resolved-ok" && count(u) === 1 && abortCount(u) === 0,
      "U-BODY 取消一名订阅者只让其 body reject（AbortError），其它 body 成功；底层连接未被中止",
      { b1, b2, count: count(u), aborts: abortCount(u) },
    );
  }

  // U-EPOCH 写成功后新读不得并入写前旧在途（失效代际）
  {
    const readUrl = mkUrl("epoch-read", "delay=250");
    const p1 = sharedReadFetch(readUrl, undefined, raw); // 写前在途读
    await wait(30);
    const w = await sharedReadFetch(mkUrl("epoch-write", ""), { method: "POST", body: "x" }, raw);
    await w.text(); // 写完成（开始/完成都失效了代际）
    const p2 = sharedReadFetch(readUrl, undefined, raw); // 写后同 URL 新读
    const [r1, r2] = await Promise.all([p1, p2]);
    const [t1, t2] = await Promise.all([r1.text(), r2.text()]);
    ok(
      count(readUrl) === 2 && t1 === t2 && t2.includes('"ok":true'),
      "U-EPOCH 写成功后新读不并入写前旧在途（同 URL 打第二次网络）",
      { count: count(readUrl) },
    );
  }

  // U-EPOCH2 对照：无写时并发读仍合并（代际机制不破坏正常共享）
  {
    const u = mkUrl("epoch-merge", "delay=150");
    const p1 = sharedReadFetch(u, undefined, raw);
    const p2 = sharedReadFetch(u, undefined, raw);
    const [r1, r2] = await Promise.all([p1, p2]);
    const [t1, t2] = await Promise.all([r1.text(), r2.text()]);
    ok(count(u) === 1 && t1 === t2, "U-EPOCH2 对照：无写时并发读仍合并（不因代际而过度请求）", { count: count(u) });
  }

  // U-KNOWN 已知失效（SSE onopen/onmessage、回前台）作废代际：其后的新读不得并入变化前发出的在途 GET
  {
    const u = mkUrl("known-invalidation", "delay=250");
    const p1 = sharedReadFetch(u, undefined, raw); // 变化前发出的在途读
    await wait(30);
    invalidateSharedReads(); // 已知变化：三个 SSE 消费组件走的就是这一口
    const p2 = sharedReadFetch(u, undefined, raw); // 变化后新读
    const [r1, r2] = await Promise.all([p1, p2]);
    const [t1, t2] = await Promise.all([r1.text(), r2.text()]);
    ok(
      count(u) === 2 && t1 === t2 && t2.includes('"ok":true'),
      "U-KNOWN 已知失效后新读不并入变化前在途（同 URL 打第二次网络）",
      { count: count(u) },
    );
  }

  // U-UNSUPPORTED 认不出的 RequestInit（headers 值非字符串）不共享、逐字透传
  {
    const u = mkUrl("unsupported", "delay=60");
    const bad = { headers: { x: 123 as unknown as string } } as RequestInit;
    const [ra, rb] = await Promise.all([
      settle(sharedReadFetch(u, bad, raw)),
      settle(sharedReadFetch(u, bad, raw)),
    ]);
    ok(ra.ok && rb.ok && count(u) === 2, "U-UNSUPPORTED 认不出的 headers 不静默合并（逐字透传，2 次网络）", { count: count(u) });
  }
}

// ── V09-26/F2 补齐：getGitStatus 的 AbortSignal **真透传**（真 api.ts + 真 HTTP，不是字符串断言） ──
//
// 背景（`review-fixes` 与 `root-integration-review.md` 末项点名）：`VersionReminder.load` 早就
// 收到 AbortSignal，但 `api.ts#getGitStatus` 没有 options、也没把 signal 交到 `apiFetch`——换项目时
// 只是**过滤旧回包**，底层网络从未被取消；当时的注释声称"真正中止"，与事实不符。本段验证补齐后的行为：
//
//   · 载入**真实的** `src/ui/api.ts`（用 data: loader 只把 `tauri-env.ts` 里的 `import.meta.env`
//     换成测试注入对象——Node 里它本是 undefined；其余源码逐字不改），并让 `apiBase()` 指向本脚本
//     的计数服务器（`VITE_TATAI_API_BASE` 是产品里既有的构建期/验证期覆盖口）；
//   · 调用链逐层是真的：`getGitStatus(id,{signal})` → `apiFetch` → `sharedReadFetch` → `rawFetch`
//     → `fetch`（真 node:http 计数服务器，400ms 慢读口）；
//   · abort 后三条同时成立才算过：调用方拿到 `AbortError`、**实际 fetch 收到的那颗 signal 被置为
//     aborted**、计数服务器观察到客户端在途断开（`res` close 且未写完）——缺一即 FAIL。
async function gitStatusSignalChecks(): Promise<void> {
  console.log("\n[verify] ── 定向用例：getGitStatus 的 signal 真透传（真 api.ts + 真 HTTP） ──");
  const apiSrc = fs.readFileSync(path.join(UI_DIR, "api.ts"), "utf8");
  const reminderSrc = fs.readFileSync(path.join(UI_DIR, "components", "VersionReminder.tsx"), "utf8");
  // 静态接线（机械可核对，不替代下面的真跑）
  const gsBody = apiSrc.slice(apiSrc.indexOf("export async function getGitStatus("));
  ok(
    /export async function getGitStatus\(id: string, opts\?: FetchOpts\)/.test(apiSrc) &&
      /fetchInit\(opts\)/.test(gsBody.slice(0, 500)),
    "api.ts#getGitStatus 收可选 FetchOpts 并经 fetchInit(opts) 把 signal 交给 apiFetch",
  );
  ok(
    /getGitStatus\(id,\s*\{\s*signal\s*\}\)/.test(reminderSrc),
    "VersionReminder.load 把 useBoundedReloader 的 signal 传给 getGitStatus（不再只过滤旧回包）",
  );

  // 只重写 tauri-env.ts 的 `import.meta.env`（Node 里没有它），其余模块交给 tsx 的 loader 逐字转译。
  const loaderSrc = [
    "export async function load(url, context, nextLoad) {",
    "  const r = await nextLoad(url, context);",
    '  if (url.endsWith("/tauri-env.ts")) {',
    '    const raw = typeof r.source === "string" ? r.source : Buffer.from(r.source).toString("utf8");',
    '    const src = raw.split("import.meta.env").join("(globalThis.__TATAI_UI_TEST_ENV__ || {})");',
    "    return { ...r, source: src };",
    "  }",
    "  return r;",
    "}",
  ].join("\n");
  register(`data:text/javascript,${encodeURIComponent(loaderSrc)}`);
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.__TATAI_UI_TEST_ENV__ = { VITE_TATAI_API_BASE: base };

  const realFetch = globalThis.fetch;
  const wire: { url: string; signal: AbortSignal | null }[] = [];
  const settleAny = async <T>(
    p: Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
    try {
      return { ok: true, value: await p };
    } catch (e) {
      return { ok: false, error: e };
    }
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    wire.push({ url: String(input), signal: init?.signal ?? null });
    return realFetch.call(globalThis, input, init);
  }) as typeof fetch;
  try {
    const api = (await import(pathToFileURL(path.join(UI_DIR, "api.ts")).href)) as {
      getGitStatus: (id: string, opts?: { signal?: AbortSignal }) => Promise<{ git: Record<string, unknown>; reminder: Record<string, unknown> }>;
    };
    ok(typeof api.getGitStatus === "function", "成功载入真实 src/ui/api.ts（apiBase 指向计数服务器）");

    // GS1：在途 abort → 调用方 AbortError + 实际 fetch 的 signal 被中止 + 服务器看到在途断开
    {
      const id = `gs-abort-${++seq}`;
      const u = `${base}/api/projects/${id}/git-status`;
      const ctrl = new AbortController();
      const p = api.getGitStatus(id, { signal: ctrl.signal });
      await tick();
      const wireHit = wire.filter((w) => w.url === u).length;
      ctrl.abort();
      const r = await settleAny(p);
      await wait(150); // 等服务器观察到断开
      const seenSignal = wire.find((w) => w.url === u)?.signal ?? null;
      ok(
        !r.ok &&
          errName(r.error) === "AbortError" &&
          wireHit === 1 &&
          seenSignal !== null &&
          seenSignal.aborted &&
          count(u) === 1 &&
          abortCount(u) === 1,
        "GS1 在途 abort：调用方 AbortError + 实际 fetch 的 signal 被置 aborted + 服务器观察到在途断开",
        {
          caller: r.ok ? "resolved" : errName(r.error),
          wireHit,
          wireSignalAborted: seenSignal?.aborted ?? null,
          hits: count(u),
          serverAborts: abortCount(u),
        },
      );
    }

    // GS2：旧调用兼容（不给 opts）——照常拿到真回包；signal 由共享读层自理，调用方无需改
    {
      const id = `gs-legacy-${++seq}`;
      const u = `${base}/api/projects/${id}/git-status`;
      const r = await settleAny(api.getGitStatus(id));
      const body = r.ok
        ? (r.value as { git: { probe_ok: boolean }; reminder: { change_fingerprint: string } })
        : null;
      ok(
        r.ok && body !== null && body.git.probe_ok === true && body.reminder.change_fingerprint === "fp-fixture" && count(u) === 1,
        "GS2 旧调用（getGitStatus(id) 无 opts）逐字兼容：照常解析回包，无需改调用点",
        { ok: r.ok, body, hits: count(u) },
      );
    }

    // GS3 对照红测（证明本段真的在测"透传"，不是在测别的东西）：改前签名吞掉 opts 的等价实现
    // ——同样的在途 abort 做下去，底层不该被中止、调用方也不该收到 AbortError。若它也"绿"，
    // 说明上面的 GS1 判据没有区分力。
    {
      const id = `gs-prefix-${++seq}`;
      const u = `${base}/api/projects/${id}/git-status`;
      const ctrl = new AbortController();
      const p = api.getGitStatus(id); // 等价改前：opts 被吞，signal 到不了网络层
      await tick();
      ctrl.abort();
      const r = await settleAny(p);
      await wait(150);
      const seenSignal = wire.find((w) => w.url === u)?.signal ?? null;
      ok(
        r.ok && (seenSignal === null || !seenSignal.aborted) && count(u) === 1 && abortCount(u) === 0,
        "GS3 对照红测：吞掉 opts 的等价旧实现下，调用方照常成功、底层未被中止（本段判据有区分力）",
        { caller: r.ok ? "resolved" : errName(r.error), wireSignalAborted: seenSignal?.aborted ?? null, serverAborts: abortCount(u) },
      );
    }
  } finally {
    globalThis.fetch = realFetch;
    delete globals.__TATAI_UI_TEST_ENV__;
  }
}

async function main(): Promise<void> {
  const server = await startServer();
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  info(`计数服务器：${base}`);

  const raw: RawFetch = (u, i) => fetch(u, i);
  const naive: Subject = (u, i, r) => r(u, i);
  const shared: Subject = (u, i, r) => sharedReadFetch(u, i, r);

  try {
    const naiveResults = await runBattery("naive(改前直通)", naive, raw);
    const sharedResults = await runBattery("shared(被测实现)", shared, raw);

    // 反例红测：naive 至少在合并/中止隔离上 FAIL
    const naiveBy = new Map(naiveResults.map((r) => [r.id, r.ok]));
    const naiveBroken = [...needsMerge].filter((id) => naiveBy.get(id) === false);
    console.log("\n[verify] ── 反例红测（改前直通）──");
    ok(
      naiveBroken.length > 0,
      `改前直通在 ${naiveBroken.join("/")} 上 FAIL（证明原行为确有"重复网络/取消互伤/不收槽"缺陷）`,
      { naiveBroken },
    );

    // 被测实现必须全 PASS
    const sharedFails = sharedResults.filter((r) => !r.ok).map((r) => r.id);
    console.log("\n[verify] ── 被测实现 ──");
    ok(sharedFails.length === 0, `shared 实现全部用例 PASS（FAIL：${sharedFails.join("/") || "无"}）`, { sharedFails });

    staticChecks();
    await directedChecks(raw);
    await gitStatusSignalChecks();
  } finally {
    // 无论用例是否抛错都收掉计数服务器，避免"异常了但进程挂住不退出"（本脚本要先红后绿，不该卡住 CI）
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  }

  console.log(`\n[verify] 小结：PASS ${pass}，FAIL ${fails.length}`);
  if (fails.length > 0) {
    console.log("[verify] FAIL 明细：\n  - " + fails.join("\n  - "));
    process.exitCode = 1;
  } else {
    console.log("[verify] 结果: 全部 PASS");
  }
}

main().catch((e) => {
  console.error("[verify] 运行异常：", e);
  process.exitCode = 1;
});
