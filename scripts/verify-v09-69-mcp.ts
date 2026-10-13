// verify-v09-69-mcp：MCP `doctor` 的 runtime 段与 runtime_only 轻量模式（V09-69；DESIGN §3.18/§6.15）。
//
// 覆盖（chk-v09-69-04）：
//   A `doctor` 默认附 runtime 段；**读宿主同一只读读口**（同一 builder），不本地重算。
//   B `doctor({runtime_only:true})` 轻量模式：只取运行诊断，不跑探活/基线/迁移/事件面；不启动服务、不触发自愈。
//   C runtime_only **不拉 daemon**：描述符缺失时只读地报 unavailable，**不**写描述符、**不**新起进程。
//   D 旧宿主/旧客户端不支持 ⇒ runtime `unknown` + `unsupported:["runtime_diagnostics"]`（**不回退写路由**）。
//   E 输入语义：runtime_only 与 runtime:false 互斥 ⇒ INVALID_INPUT。
//   F MCP 读数与宿主 HTTP 读数**同源**（除 generated_at 外逐字段相等）。
// 隔离口径：mkdtemp 隔离 TATAI_HOME + 隔离项目；HTTP 绑 127.0.0.1:0；TATAI_NO_AUTOSTART=1。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(REPO_ROOT, rel)).href)) as T;

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1400)}`);
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-69-mcp-"));
const HOME = path.join(tmpRoot, "home"); // 真宿主（会发布描述符）
const HOME3 = path.join(tmpRoot, "home3"); // 旧宿主：仅返回 404
const HOME4 = path.join(tmpRoot, "home4"); // 无描述符（写服务未起）
const PROJ = path.join(tmpRoot, "proj");
for (const d of [HOME, HOME3, HOME4, PROJ]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(PROJ, ".工作台", "work"), { recursive: true });
process.env.TATAI_HOME = HOME;
process.env.TATAI_NO_AUTOSTART = "1";

const registry = await loadSrc<any>("src/server/registry.ts");
const workHostMod = await loadSrc<any>("src/server/workHost.ts");
const serviceMod = await loadSrc<any>("src/server/work/service.ts");
const nowIsoMod = await loadSrc<any>("src/server/time.ts");
const doctorMod = await loadSrc<any>("src/mcp/tools/doctor.ts");

const PID = "v0969-mcp-fixture";
registry.addProject({ id: PID, name: "运行诊断 MCP 夹具", path: PROJ, kind: "backend" }, HOME);

interface Res {
  status: number;
  json: any;
}
const request = (port: number, method: string, p: string, opts: { token?: string } = {}): Promise<Res> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: opts.token ? { "x-tatai-work-token": opts.token } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = text === "" ? null : JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

async function callTool(tool: any, args: Record<string, unknown>): Promise<{ isError: boolean; json: any }> {
  const out = await tool.handler(args, undefined);
  const text = out.content?.[0]?.text ?? "";
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: out.isError === true, json };
}

const strip = (o: any): any => {
  const c = JSON.parse(JSON.stringify(o));
  delete c.generated_at;
  return c;
};

async function main(): Promise<void> {
  info(`隔离 HOME=${HOME}｜旧宿主 HOME3=${HOME3}｜无描述符 HOME4=${HOME4}`);
  const doctorTool = doctorMod.createDoctorTool();

  // ── 真宿主 ──
  const host = workHostMod.createWorkHost(HOME, {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void host.handle(req, res, url.pathname).then((handled: boolean) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number; address: string };
  host.publish(addr.port, "127.0.0.1");

  try {
    console.log("\n[verify] ═══ A doctor 默认附 runtime 段（同源）═══");
    const dflt = await callTool(doctorTool, {});
    const defRun = dflt.json?.runtime;
    ok(dflt.isError === false && defRun != null && defRun.schema === "runtime-diagnostics-v1", "A doctor 默认输出含 runtime 段（schema=runtime-diagnostics-v1）", defRun?.schema);
    ok(defRun?.status === "unknown" && defRun?.reasons?.some((r: any) => r.code === "NO_EVIDENCE"), "A runtime 段：描述符在场但尚无成功观测 ⇒ unknown + NO_EVIDENCE（冷启动不猜 healthy，R69-03）", { status: defRun?.status, reasons: defRun?.reasons });
    ok(dflt.json?.service != null && dflt.json?.event_surface != null, "A 既有五段仍在（向后兼容）", Object.keys(dflt.json ?? {}));
    const hostRoute = await request(addr.port, "GET", "/api/work/diagnostics", { token: host.token });
    ok(hostRoute.status === 200 && hostRoute.json?.ok === true, "A 宿主 tokened 读口可达", hostRoute.status);
    ok(JSON.stringify(strip(defRun)) === JSON.stringify(strip(hostRoute.json)), "A/F doctor.runtime **同源**（与宿主 HTTP 除 generated_at 逐字段相等）", null);

    console.log("\n[verify] ═══ B runtime_only 轻量模式 ═══");
    const ro = await callTool(doctorTool, { runtime_only: true });
    ok(ro.isError === false && ro.json?.runtime_only === true, "B runtime_only=true 回执带 runtime_only 标记", ro.json?.runtime_only);
    ok(ro.json?.runtime?.status === "unknown" && ro.json?.runtime?.reasons?.some((r: any) => r.code === "NO_EVIDENCE"), "B 轻量模式仍读到运行诊断（冷启动 ⇒ unknown + NO_EVIDENCE）", ro.json?.runtime?.status);
    ok(
      ro.json?.service === undefined && ro.json?.baseline === undefined && ro.json?.migration === undefined && ro.json?.event_surface === undefined,
      "B 轻量模式**不跑**其余重段（无 service/baseline/migration/event_surface）",
      Object.keys(ro.json ?? {}),
    );
    ok(ro.json?.heal?.attempted === false && typeof ro.json?.heal?.note === "string", "B 轻量模式不触发自愈（heal.attempted=false）", ro.json?.heal);
    ok(JSON.stringify(strip(ro.json?.runtime)) === JSON.stringify(strip(hostRoute.json)), "B/F runtime_only 的 runtime 与宿主读口**同源同判据**", null);

    console.log("\n[verify] ═══ E 输入语义 ═══");
    const bad = await callTool(doctorTool, { runtime_only: true, runtime: false });
    ok(bad.isError === true || bad.json?.ok === false, "E runtime_only 与 runtime:false 互斥 ⇒ INVALID_INPUT", bad.json);

    console.log("\n[verify] ═══ C 不拉 daemon（无描述符的宿主）═══");
    process.env.TATAI_HOME = HOME4;
    const descPath4 = path.join(HOME4, "work-service.json");
    const filesBefore = fs.existsSync(HOME4) ? fs.readdirSync(HOME4).sort() : [];
    const roNoHost = await callTool(doctorTool, { runtime_only: true, heal: true });
    ok(roNoHost.json?.runtime?.status === "unavailable", "C 无描述符 ⇒ runtime 报 unavailable（明确不可达）", roNoHost.json?.runtime?.status);
    ok(roNoHost.json?.heal?.attempted === false, "C 即使显式 heal:true，runtime_only 也**不**自愈（只读）", roNoHost.json?.heal);
    ok(!fs.existsSync(descPath4), "C runtime_only 不写描述符（**不拉 daemon**）", fs.existsSync(descPath4));
    ok(JSON.stringify(fs.readdirSync(HOME4).sort()) === JSON.stringify(filesBefore), "C 数据目录不新增任何文件", fs.readdirSync(HOME4));
    process.env.TATAI_HOME = HOME;

    console.log("\n[verify] ═══ D 旧宿主不支持（404）⇒ unknown + unsupported ═══");
    // 伪旧宿主：只回 404
    const legacy = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => legacy.listen(0, "127.0.0.1", () => r()));
    const lAddr = legacy.address() as { port: number };
    serviceMod.writeServiceDescriptor(HOME3, {
      schema_version: 2,
      pid: process.pid,
      host: "127.0.0.1",
      port: lAddr.port,
      token: "legacy-token",
      started_at: nowIsoMod.nowIso(),
      url: `http://127.0.0.1:${lAddr.port}`,
    });
    process.env.TATAI_HOME = HOME3;
    const legacyRun = await callTool(doctorTool, { runtime_only: true });
    ok(legacyRun.json?.runtime?.status === "unknown", "D 旧宿主不支持 ⇒ runtime status=unknown（**不**猜成 healthy/unavailable）", legacyRun.json?.runtime?.status);
    ok(
      Array.isArray(legacyRun.json?.runtime?.unsupported) && legacyRun.json.runtime.unsupported.includes("runtime_diagnostics"),
      "D runtime.unsupported 点名 runtime_diagnostics（不回退写路由）",
      legacyRun.json?.runtime?.unsupported,
    );
    ok(legacyRun.json?.runtime?.reasons?.some((r: any) => r.code === "UNSUPPORTED"), "D reasons 点名 UNSUPPORTED", legacyRun.json?.runtime?.reasons);
    process.env.TATAI_HOME = HOME;
    legacy.close();
  } finally {
    host.unpublish();
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n[verify] 小结：${pass} 条 PASS，${fails.length} 条 FAIL`);
  if (fails.length > 0) {
    console.error(`[verify] 失败：\n- ${fails.join("\n- ")}`);
    process.exitCode = 1;
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error("[verify] 运行失败：", e);
  process.exit(1);
});
