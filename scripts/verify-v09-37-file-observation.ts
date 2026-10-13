// V09-37 剩余热路径修复 · 源清单「文件观测」共享 —— 行为/边界回归（本卡专项）。
//
// 被钉住的性质（对应 performance-file-reuse/REPORT.md 的验收正反例）：
//   T1 判据保真：同一份清单在**作用域内**与**无作用域**现算的 verdict **逐字段相同**（含 changed/missing/
//      unreadable/current_fingerprint/reason）。共享观测只省重复现读，不改判据。
//   T2 同文件不同 expected sha 独立判据：两份清单共享同一文件、声明不同 sha —— 各自独立结论（一份 valid、
//      一份 invalidated），且该文件在一次派生内只被读+哈希一次。
//   T3 跨 root 不串：不同项目根下同名相对路径各读各内容；拿别 root 内容的清单必须 invalidated。
//   T4 删除/改动**下一个请求**立刻失效（新派生重新现读，非跨请求缓存）。
//   T5 同请求统一快照：同一次派生内首份清单的观测被后一份沿用（如实标注的口径）；**跨请求**重读即见改动。
//   T6 软链（本体/祖先）→ unreadable（不放行）。
//   T7 越界路径（`..`）→ unreadable。
//   T8 超单文件上限 → unreadable。
//   T9 每清单总预算独立：超总预算清单 unreadable，**不污染**同派生里的小清单（仍 valid）。
//   T10 忽略失败 fail-closed：坏 `.git` 探针失败 → unreadable；真被忽略路径 → unreadable。
//   T11 嵌套作用域共享观测；异常退出后记忆清空、新派生重新现读。
//   T12 返回结论互不污染（独立副本）。
//   T13 作用域外逐次现读（行为不变）。
//   T14 预算检查在**新读之前**：真实读次数/字节有界（第 9 个大文件不被新读、实读字节 ≤ 64MiB）、
//       超限拒绝**不污染**共享（小清单随后仍能读该文件）、去重收益保留（已读文件不再重读）。
//   T15 postread actualbytes > stat：stat 低报时**不放宽**旧约束——读到的实际字节突破单文件/总预算即拒。
//
// 隔离口径（AGENTS.md §5）：夹具一律在系统 tmp 下 `tatai-v0937-fileobs-` 前缀目录里自建自清，
//   不碰真实注册表/真实项目/生产数据；不 build、不起服务、不调模型。Windows 无权限建软链时如实 SKIP。
//
// 运行：node --import tsx scripts/verify-v09-37-file-observation.ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildSourceManifest,
  verifySourceManifest,
  manifestFingerprintOf,
  normalizeManifestPath,
  SOURCE_MANIFEST_VERSION,
  MAX_SOURCE_MANIFEST_FILE_BYTES,
  MAX_SOURCE_MANIFEST_TOTAL_BYTES,
  type SourceManifest,
} from "../src/server/work/sourceEvidence";
import { withDerivationScope, derivationScopeStats } from "../src/server/work/derivationScope";

const fails: string[] = [];
let pass = 0;
function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`[verify] PASS ${label}`);
  } else {
    fails.push(label);
    process.exitCode = 1;
    console.log(`[verify] FAIL ${label}`);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1400)}`);
  }
}
const skip = (label: string): void => console.log(`[verify] SKIP ${label}`);

const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");

// ── 只读产品源码的 fs 调用计数（证明"同一文件一次派生内只读一次"） ──
const origRead = fs.readFileSync.bind(fs);
let readCount = new Map<string, number>();
let counting = false;
(fs as unknown as Record<string, unknown>).readFileSync = (...args: unknown[]) => {
  if (counting) {
    const p = String(args[0]);
    readCount.set(p, (readCount.get(p) ?? 0) + 1);
  }
  return (origRead as (...a: unknown[]) => unknown)(...args);
};
function countReads<T>(fn: () => T): { value: T; reads: number } {
  readCount = new Map();
  counting = true;
  try {
    const value = fn();
    return { value, reads: [...readCount.values()].reduce((a, b) => a + b, 0) };
  } finally {
    counting = false;
  }
}
function readsOf(p: string): number {
  return readCount.get(path.resolve(p)) ?? readCount.get(p) ?? 0;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0937-fileobs-"));

function newRoot(name: string): string {
  const r = path.join(tmp, name);
  fs.mkdirSync(path.join(r, "src"), { recursive: true });
  return r;
}
function writeFile(root: string, rel: string, content: string | Buffer): { sha256: string; bytes: number } {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { sha256: sha256(buf), bytes: buf.length };
}
/** 手工构造一份**自洽**清单（不经登记；用于声明"与盘上不符/越界/软链"等读侧反例） */
function manualManifest(entries: { path: string; sha256: string; bytes: number }[]): SourceManifest {
  const files = entries.map((e) => ({ path: e.path, sha256: e.sha256, bytes: e.bytes }));
  return { version: SOURCE_MANIFEST_VERSION, files, fingerprint: manifestFingerprintOf(files) };
}
/** 模拟 postread actualbytes > stat：把指定路径的 `lstat` 体积低报为 0（其余保持真实），用于验证边界不被放宽 */
function withFakedSmallStat<T>(paths: Set<string>, fn: () => T): T {
  const orig = fs.lstatSync.bind(fs);
  (fs as unknown as Record<string, unknown>).lstatSync = (...args: unknown[]) => {
    const st = (orig as (...a: unknown[]) => fs.Stats)(...args);
    if (paths.has(path.resolve(String(args[0])))) st.size = 0;
    return st;
  };
  try {
    return fn();
  } finally {
    (fs as unknown as Record<string, unknown>).lstatSync = orig;
  }
}

try {
  // ───────────────────────── T1 判据保真（作用域内 == 无作用域） ─────────────────────────
  {
    const root = newRoot("t1");
    writeFile(root, "src/keep.ts", "KEEP");
    writeFile(root, "src/change.ts", "OLD");
    const m = manualManifest([
      { path: "src/keep.ts", ...writeFile(root, "src/keep.ts", "KEEP") },
      { path: "src/change.ts", sha256: sha256("SOMETHING-ELSE"), bytes: 13 }, // 内容与盘上不符 → changed
      { path: "src/gone.ts", sha256: sha256("x"), bytes: 1 }, // 盘上不存在 → missing
    ]);
    const inScope = withDerivationScope(() => verifySourceManifest(root, m));
    const outScope = verifySourceManifest(root, m);
    ok(
      JSON.stringify(inScope) === JSON.stringify(outScope) && inScope.status === "invalidated",
      "T1 作用域内 == 无作用域 逐字段相同（invalidated：changed+missing）",
      { inScope, outScope },
    );
  }

  // ───────────────────── T2 同文件不同 expected sha 独立判据 + 一次读 ─────────────────────
  {
    const root = newRoot("t2");
    const f = writeFile(root, "src/f.ts", "hello-sha");
    const fAbs = path.join(root, "src/f.ts");
    const good = manualManifest([{ path: "src/f.ts", ...f }]);
    const wrong = manualManifest([{ path: "src/f.ts", sha256: sha256("totally-different"), bytes: f.bytes }]);
    const { value, reads } = countReads(() =>
      withDerivationScope(() => [verifySourceManifest(root, good), verifySourceManifest(root, wrong)]),
    );
    const [vg, vw] = value;
    ok(vg.status === "valid", "T2 声明正确 sha 的清单 → valid", vg);
    ok(vw.status === "invalidated" && vw.changed.includes("src/f.ts"), "T2 共享同文件、声明不同 sha → 独立 invalidated", vw);
    ok(readsOf(fAbs) === 1, "T2 该文件在一次派生内只读 1 次", { reads: readsOf(fAbs), total: reads });
  }

  // ───────────────────────────── T3 跨 root 不串 ─────────────────────────────
  {
    const ra = newRoot("t3a");
    const rb = newRoot("t3b");
    const a = writeFile(ra, "src/x.ts", "AAA");
    const b = writeFile(rb, "src/x.ts", "BBB");
    const ma = buildSourceManifest(ra, ["src/x.ts"]);
    const mb = buildSourceManifest(rb, ["src/x.ts"]);
    const [va, vb] = withDerivationScope(() => [verifySourceManifest(ra, ma), verifySourceManifest(rb, mb)]);
    ok(va.status === "valid" && vb.status === "valid", "T3 同名相对路径跨 root 各读各内容（都 valid）", { va, vb });
    const wrongA = manualManifest([{ path: "src/x.ts", sha256: b.sha256, bytes: b.bytes }]);
    ok(
      withDerivationScope(() => verifySourceManifest(ra, wrongA)).status === "invalidated",
      "T3 rootA 清单拿 rootB 内容 → invalidated（观测不跨 root 串味）",
    );
    ok(a.sha256 !== b.sha256, "T3 夹具两 root 内容确实不同");
  }

  // ───────────────────── T4 改动/删除 下一个请求立刻失效 ─────────────────────
  {
    const root = newRoot("t4");
    const g = writeFile(root, "src/g.ts", "v1");
    const m = buildSourceManifest(root, ["src/g.ts"]);
    ok(withDerivationScope(() => verifySourceManifest(root, m)).status === "valid", "T4 初始 valid");
    fs.writeFileSync(path.join(root, "src/g.ts"), "v2-longer");
    ok(
      withDerivationScope(() => verifySourceManifest(root, m)).status === "invalidated",
      "T4 改动 → 下一个请求立刻 invalidated（无跨请求缓存）",
    );
    fs.rmSync(path.join(root, "src/g.ts"));
    const v = withDerivationScope(() => verifySourceManifest(root, m));
    ok(v.status === "invalidated" && v.missing.includes("src/g.ts"), "T4 删除 → 下一个请求立刻 missing", v);
    ok(g.bytes === 2, "T4 夹具初始字节数");
  }

  // ───────────────── T5 同请求统一快照（如实标注） + 跨请求重读 ─────────────────
  {
    const root = newRoot("t5");
    const h = writeFile(root, "src/h.ts", "S1");
    writeFile(root, "src/onlyA.ts", "A");
    writeFile(root, "src/onlyB.ts", "B");
    const m5a = buildSourceManifest(root, ["src/h.ts", "src/onlyA.ts"]);
    const m5b = buildSourceManifest(root, ["src/h.ts", "src/onlyB.ts"]);
    const hAbs = path.join(root, "src/h.ts");
    const { value } = countReads(() =>
      withDerivationScope(() => {
        const a = verifySourceManifest(root, m5a);
        fs.writeFileSync(hAbs, "S2"); // 同一派生内改盘上文件
        const b = verifySourceManifest(root, m5b);
        return { a, b };
      }),
    );
    ok(value.a.status === "valid", "T5 首个清单 valid");
    ok(
      value.b.status === "valid",
      "T5 统一快照：同派生内后一份清单沿用首观测（改盘不影响本派生结论，如实口径）",
      value.b,
    );
    ok(readsOf(hAbs) === 1, "T5 同一派生内 h.ts 只观测一次", readsOf(hAbs));
    const next = withDerivationScope(() => verifySourceManifest(root, m5b));
    ok(next.status === "invalidated", "T5 跨请求重读 → 改动即失效", next);
    ok(h.bytes === 2, "T5 夹具初始字节");
  }

  // ───────────────────────── T6 软链（本体/祖先） ─────────────────────────
  {
    const root = newRoot("t6");
    const real = writeFile(root, "src/real.ts", "REAL");
    let made = 0;
    try {
      fs.symlinkSync(path.join(root, "src/real.ts"), path.join(root, "src/link.ts"), "file");
      made += 1;
    } catch {
      /* Windows 无权限 */
    }
    if (made >= 1) {
      const ml = manualManifest([{ path: "src/link.ts", sha256: real.sha256, bytes: real.bytes }]);
      const v = withDerivationScope(() => verifySourceManifest(root, ml));
      ok(v.status === "unreadable" && v.unreadable.includes("src/link.ts"), "T6 本体软链 → unreadable", v);
    } else {
      skip("T6 本体软链 → unreadable（Windows 无建软链权限）");
    }
    // 祖先目录软链逃出 root
    const outside = path.join(tmp, "t6-outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "esc.ts"), "ESC");
    let madeDir = 0;
    try {
      fs.symlinkSync(outside, path.join(root, "srcdir"), "junction");
      madeDir += 1;
    } catch {
      /* 无权限 */
    }
    if (madeDir >= 1) {
      const me = manualManifest([{ path: "srcdir/esc.ts", sha256: sha256("ESC"), bytes: 3 }]);
      const v = withDerivationScope(() => verifySourceManifest(root, me));
      ok(v.status === "unreadable" && v.unreadable.includes("srcdir/esc.ts"), "T6 祖先目录软链逃出 root → unreadable", v);
    } else {
      skip("T6 祖先目录软链 → unreadable（Windows 无建 junction 权限）");
    }
  }

  // ───────────────────────── T7 越界路径 ─────────────────────────
  {
    const root = newRoot("t7");
    const mo = manualManifest([{ path: "../evil.ts", sha256: sha256("x"), bytes: 1 }]);
    const v = withDerivationScope(() => verifySourceManifest(root, mo));
    ok(v.status === "unreadable" && v.unreadable.includes("../evil.ts"), "T7 越界（..）路径 → unreadable", v);
  }

  // ───────────────────────── T8 超单文件上限 ─────────────────────────
  {
    const root = newRoot("t8");
    const big = Buffer.alloc(MAX_SOURCE_MANIFEST_FILE_BYTES + 1, 0x61);
    const w = writeFile(root, "src/big.bin", big);
    const m = manualManifest([{ path: "src/big.bin", ...w }]);
    const v = withDerivationScope(() => verifySourceManifest(root, m));
    ok(v.status === "unreadable" && v.unreadable.includes("src/big.bin"), "T8 超单文件上限 → unreadable", v);
  }

  // ─────────────────── T9 每清单总预算独立 + 不污染 ───────────────────
  {
    const root = newRoot("t9");
    const SIZE = MAX_SOURCE_MANIFEST_FILE_BYTES; // 8 MiB/文件，9 个 = 72 MiB > 64 MiB 总上限
    const entries: { path: string; sha256: string; bytes: number }[] = [];
    for (let i = 0; i < 9; i += 1) {
      const rel = `src/b${i}.bin`;
      const buf = Buffer.alloc(SIZE, 0x30 + i);
      fs.writeFileSync(path.join(root, rel), buf);
      entries.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
    }
    const big = manualManifest(entries);
    const small = manualManifest(entries.slice(0, 3));
    const [vb, vs] = withDerivationScope(() => [verifySourceManifest(root, big), verifySourceManifest(root, small)]);
    ok(vb.status === "unreadable", "T9 9×8MiB 超总预算 → unreadable", { status: vb.status, unreadable: vb.unreadable });
    ok(vs.status === "valid", "T9 预算拒绝**不污染**同派生小清单（仍 valid）", vs);
  }

  // ─────────────────── T10 忽略失败 fail-closed ───────────────────
  {
    const root = newRoot("t10");
    const z = writeFile(root, "src/z.ts", "Z");
    fs.mkdirSync(path.join(root, ".git")); // 空 .git → 坏仓库 → git 探针失败
    const m = manualManifest([{ path: "src/z.ts", ...z }]);
    const v = withDerivationScope(() => verifySourceManifest(root, m));
    ok(
      v.status === "unreadable" && /无法核实源文件的忽略规则/.test(v.reason),
      "T10 坏 .git 探针失败 → fail-closed unreadable",
      v,
    );
  }
  {
    const root = newRoot("t10b");
    spawnSync("git", ["-C", root, "init"], { windowsHide: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
    const ig = writeFile(root, "ignored.txt", "IGNORED");
    const okf = writeFile(root, "src/ok.ts", "OK");
    if (fs.existsSync(path.join(root, ".git"))) {
      const mIg = manualManifest([{ path: "ignored.txt", ...ig }]);
      const v = withDerivationScope(() => verifySourceManifest(root, mIg));
      ok(v.status === "unreadable" && /已被忽略/.test(v.reason), "T10 真被 git 忽略路径 → unreadable", v);
      const mOk = manualManifest([{ path: "src/ok.ts", ...okf }]);
      ok(withDerivationScope(() => verifySourceManifest(root, mOk)).status === "valid", "T10 未忽略路径不受影响 → valid");
    } else {
      skip("T10 真被忽略路径（git init 不可用）");
    }
  }

  // ─────────────────── T11 嵌套共享 + 异常退出清空 ───────────────────
  {
    const root = newRoot("t11");
    writeFile(root, "src/n.ts", "N");
    const m = buildSourceManifest(root, ["src/n.ts"]);
    const nAbs = path.join(root, "src/n.ts");
    const { value } = countReads(() =>
      withDerivationScope(() => {
        const a = verifySourceManifest(root, m);
        const b = withDerivationScope(() => verifySourceManifest(root, m));
        return [a, b];
      }),
    );
    ok(value[0].status === "valid" && value[1].status === "valid", "T11 嵌套作用域结论一致");
    ok(readsOf(nAbs) === 1, "T11 嵌套作用域共享观测（同一文件只读 1 次）", readsOf(nAbs));
    try {
      withDerivationScope(() => {
        verifySourceManifest(root, m);
        throw new Error("boom");
      });
      ok(false, "T11 夹具应抛错");
    } catch {
      /* expected */
    }
    const st = derivationScopeStats();
    ok(st.active === false && st.entries === 0, "T11 异常退出后作用域记忆清空、深度归零", st);
    const { value: v2 } = countReads(() => withDerivationScope(() => verifySourceManifest(root, m)));
    ok(readsOf(nAbs) === 1 && v2.status === "valid", "T11 异常退出后新派生重新现读（非跨请求缓存）", readsOf(nAbs));
  }

  // ─────────────────── T12 返回结论互不污染 ───────────────────
  {
    const root = newRoot("t12");
    writeFile(root, "src/p.ts", "P");
    writeFile(root, "src/q.ts", "Q");
    const mp = buildSourceManifest(root, ["src/p.ts"]);
    const mq = buildSourceManifest(root, ["src/q.ts"]);
    const [vp, vq] = withDerivationScope(() => [verifySourceManifest(root, mp), verifySourceManifest(root, mq)]);
    vp.changed.push("POLLUTED");
    ok(!vq.changed.includes("POLLUTED"), "T12 一份清单的返回数组被改不污染另一份", { vp, vq });
  }

  // ─────────────────── T13 作用域外逐次现读（行为不变） ───────────────────
  {
    const root = newRoot("t13");
    writeFile(root, "src/r.ts", "R");
    const m = buildSourceManifest(root, ["src/r.ts"]);
    const rAbs = path.join(root, "src/r.ts");
    const { reads } = countReads(() => {
      verifySourceManifest(root, m);
      verifySourceManifest(root, m);
    });
    ok(readsOf(rAbs) === 2, "T13 无作用域时两次调用读两次（老路径行为不变）", readsOf(rAbs));
    void reads;
  }

  // ═════════ T14 预算检查在**新读之前**：真实读次数/字节有界 + 拒绝不污染共享 + 去重收益保留 ═════════
  // 复现 root 反例（9×8MiB=72MiB；旧实现在共享观测里先读满 72MiB 才判超 64MiB）：断言预算拒绝发生在
  // **任何新读之前**——第 9 个文件不被新读、实读字节 ≤ 64MiB，且拒绝后其它清单仍能读它、去重收益保留。
  {
    const root = newRoot("t14");
    const SIZE = MAX_SOURCE_MANIFEST_FILE_BYTES; // 8 MiB / 文件
    const entries: { path: string; sha256: string; bytes: number }[] = [];
    for (let i = 0; i < 9; i += 1) {
      const rel = `src/b${i}.bin`;
      const buf = Buffer.alloc(SIZE, 0x30 + i);
      fs.writeFileSync(path.join(root, rel), buf);
      entries.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
    }
    const big = manualManifest(entries);
    const first3 = manualManifest(entries.slice(0, 3));
    const only9th = manualManifest([entries[8]]);
    const absOf = new Set(entries.map((e) => path.resolve(path.join(root, e.path))));

    // 只统计这批夹具文件的真实读次数与读到字节（product 走 fs.readFileSync）
    const orig = fs.readFileSync.bind(fs);
    let perFile = new Map<string, number>();
    let totalBytes = 0;
    function instrument<T>(fn: () => T): T {
      perFile = new Map();
      totalBytes = 0;
      (fs as unknown as Record<string, unknown>).readFileSync = (...args: unknown[]) => {
        const out = (orig as (...a: unknown[]) => unknown)(...args) as Buffer;
        const p = path.resolve(String(args[0]));
        if (absOf.has(p)) {
          perFile.set(p, (perFile.get(p) ?? 0) + 1);
          totalBytes += out.length;
        }
        return out;
      };
      try {
        return fn();
      } finally {
        (fs as unknown as Record<string, unknown>).readFileSync = orig;
      }
    }
    const readsAt = (i: number): number => perFile.get(path.resolve(path.join(root, entries[i].path))) ?? 0;
    const totalReads = (): number => [...perFile.values()].reduce((a, b) => a + b, 0);

    // T14a 大清单超总预算：读满 64MiB 即止，第 9 个文件**不被新读**
    {
      const v = instrument(() => withDerivationScope(() => verifySourceManifest(root, big)));
      ok(
        v.status === "unreadable" && v.unreadable.includes("src/b8.bin"),
        "T14a 9×8MiB 超总预算 → unreadable（点第 9 条）",
        { status: v.status, unreadable: v.unreadable },
      );
      ok(readsAt(8) === 0, "T14a 预算拒绝后第 9 个文件**不被新读**（budget-before-new-read）", { b8: readsAt(8) });
      ok(totalBytes <= MAX_SOURCE_MANIFEST_TOTAL_BYTES, "T14a 实际读取字节 ≤ 总预算 64MiB", { totalBytes, limit: MAX_SOURCE_MANIFEST_TOTAL_BYTES });
      ok(totalReads() === 8, "T14a 实际读次数 = 8（不是 9）", { reads: totalReads() });
    }

    // T14b 拒绝不污染共享：大清单拒了 b8，同派生引用 b8 的小清单仍能读它并 valid
    {
      const r = instrument(() =>
        withDerivationScope(() => ({ b: verifySourceManifest(root, big), n: verifySourceManifest(root, only9th) })),
      );
      ok(r.b.status === "unreadable", "T14b 大清单仍 unreadable");
      ok(r.n.status === "valid", "T14b 超限大清单之后，引用被拒文件的小清单仍能读它 → valid（拒绝不进共享）", r.n);
      ok(readsAt(8) === 1, "T14b 被拒文件随后被小清单读 1 次（未被污染成不可读）", { b8: readsAt(8) });
    }

    // T14c 共享去重收益保留：大清单已读的 b0..b2，小清单命中缓存不再新读
    {
      const vS = instrument(() =>
        withDerivationScope(() => {
          verifySourceManifest(root, big);
          return verifySourceManifest(root, first3);
        }),
      );
      ok(vS.status === "valid", "T14c 同派生小清单（b0..b2）→ valid", vS);
      ok(
        readsAt(0) === 1 && readsAt(1) === 1 && readsAt(2) === 1,
        "T14c 共享收益保留：b0..b2 各只读 1 次（小清单 0 次新读）",
        { b0: readsAt(0), b1: readsAt(1), b2: readsAt(2) },
      );
    }
  }

  // ═════ T15 postread actualbytes > stat：stat 低报**不放宽**旧约束（实际字节突破单文件/总预算即拒） ═════
  // 根因：stat 体积是"读之前"的估计，若它低报，前置检查会放行；但**读到的实际字节**仍必须守住边界——
  // 读后按实际字节复核，绝不因低报就把超限内容当通过（旧实现只用 st.size 前置检查，低报时会静默放行）。
  {
    const root = newRoot("t15");
    const rel = "src/sneaky.bin";
    const big = Buffer.alloc(MAX_SOURCE_MANIFEST_FILE_BYTES + 1, 0x61);
    fs.writeFileSync(path.join(root, rel), big);
    const bigAbs = path.resolve(path.join(root, rel));
    const m = manualManifest([{ path: rel, sha256: sha256(big), bytes: big.length }]);
    const v1 = withFakedSmallStat(new Set([bigAbs]), () => withDerivationScope(() => verifySourceManifest(root, m)));
    ok(v1.status === "unreadable" && v1.unreadable.includes(rel), "T15a stat 低报 → 读后仍按实际字节拒（不突破单文件上限）", v1);

    const root2 = newRoot("t15b");
    const entries2: { path: string; sha256: string; bytes: number }[] = [];
    for (let i = 0; i < 8; i += 1) {
      const r = `src/b${i}.bin`;
      const buf = Buffer.alloc(MAX_SOURCE_MANIFEST_FILE_BYTES, 0x30 + i);
      fs.writeFileSync(path.join(root2, r), buf);
      entries2.push({ path: r, sha256: sha256(buf), bytes: buf.length });
    }
    const extraRel = "src/extra.bin";
    const extra = Buffer.alloc(MAX_SOURCE_MANIFEST_FILE_BYTES, 0x5a);
    fs.writeFileSync(path.join(root2, extraRel), extra);
    const extraAbs = path.resolve(path.join(root2, extraRel));
    const m2 = manualManifest([...entries2, { path: extraRel, sha256: sha256(extra), bytes: extra.length }]);
    const v2 = withFakedSmallStat(new Set([extraAbs]), () => withDerivationScope(() => verifySourceManifest(root2, m2)));
    ok(
      v2.status === "unreadable" && v2.unreadable.includes(extraRel),
      "T15b 满 64MiB 后 stat 低报的文件读后仍按实际字节拒（不突破每清单总预算）",
      { status: v2.status, unreadable: v2.unreadable },
    );
  }
  void normalizeManifestPath;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n[verify-v09-37-file-observation] PASS ${pass} · FAIL ${fails.length}`);
if (fails.length > 0) console.log("失败项：" + fails.join(" | "));
