import fs from "node:fs";
import path from "node:path";
import { sanitizeErrorMessage } from "./redact";
import {
  addProject,
  listProjects,
  type ProjectKind,
  type ProjectRecord,
} from "./registry";

// 项目接入模块（R2）：目录校验 + kind 判定 + .gitignore 提示。
// 全程只读被接入项目的目录，不在对方目录里写任何东西（红线）。

/** kind 判定结果：值 + 可解释理由（DoD② 要求判定依据可解释） */
export interface KindDetection {
  kind: ProjectKind;
  reasons: string[];
}

/** .gitignore 检查结果（DESIGN.md §8.2：缺 `.工作台/` 行只提示，不擅自改） */
export interface GitignoreCheck {
  /** .gitignore 是否存在 */
  exists: boolean;
  /** 是否已含 `.工作台/` 一行 */
  has_workbench_line: boolean;
  /** 缺行时的提示文案；不缺则为 null */
  hint: string | null;
}

export interface OnboardOk {
  ok: true;
  record: ProjectRecord;
  /** true = 注册表里已有同 id/同路径记录，本次未重复写入（幂等） */
  already_registered: boolean;
  detected: KindDetection;
  gitignore: GitignoreCheck;
}

/** 结构化错误（DoD①：明确错误信息，不抛裸栈） */
export interface OnboardErr {
  ok: false;
  error: {
    code:
      | "PATH_NOT_FOUND"
      | "NOT_A_DIRECTORY"
      | "NOT_READABLE"
      | "NOT_WRITABLE"
      | "INVALID_INPUT";
    message: string;
  };
}

export type OnboardResult = OnboardOk | OnboardErr;

export interface OnboardInput {
  path: string;
  /** 不传则取目录 basename */
  id?: string;
  name?: string;
  self_managed?: boolean;
}

const WORKBENCH_GITIGNORE_LINE = ".工作台/";

/** 目录校验：存在、是目录、可读可写；失败返回结构化错误 */
function validateDir(
  absPath: string,
): { ok: true } | { ok: false; error: OnboardErr["error"] } {
  const fail = (code: OnboardErr["error"]["code"], message: string) =>
    ({ ok: false as const, error: { code, message } });
  if (!fs.existsSync(absPath)) {
    return fail("PATH_NOT_FOUND", `路径不存在: ${absPath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    // Q102（2026-09-18 审计）：这条原文直接进 API 响应（`POST /api/projects` 的 error.message），
    // 而 fs 级异常的原文里常带本机绝对路径（ENOENT 的 `stat 'C:\Users\…'`）——走一遍消息级脱敏
    // （redact.ts 是全仓唯一出处，同族调用点 index.ts / flash.ts / watcher.ts 早已如此）。
    return fail(
      "NOT_READABLE",
      `无法读取路径信息: ${sanitizeErrorMessage((e as Error).message)}`,
    );
  }
  if (!stat.isDirectory()) {
    return fail("NOT_A_DIRECTORY", `路径不是目录: ${absPath}`);
  }
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
  } catch {
    return fail("NOT_READABLE", `目录不可读: ${absPath}`);
  }
  try {
    fs.accessSync(absPath, fs.constants.W_OK);
  } catch {
    return fail("NOT_WRITABLE", `目录不可写: ${absPath}`);
  }
  return { ok: true };
}

/** 前端信号依赖：出现即视为"有前端" */
const FRONTEND_DEPS = [
  "react",
  "react-dom",
  "vue",
  "svelte",
  "@angular/core",
  "solid-js",
  "next",
  "nuxt",
];

/** 后端信号依赖：出现即视为"有后端" */
const BACKEND_DEPS = [
  "express",
  "koa",
  "fastify",
  "@nestjs/core",
  "hono",
  "@modelcontextprotocol/sdk",
];

/** 后端入口目录：存在即视为"有后端"（无框架的 node:http 服务也算） */
const BACKEND_DIRS = ["src/server", "server"];

function readPkgDeps(dir: string): { names: string[]; hasPkg: boolean } {
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) return { names: [], hasPkg: false };
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    return {
      names: [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ],
      hasPkg: true,
    };
  } catch {
    return { names: [], hasPkg: true };
  }
}

/**
 * kind 自动判定（DESIGN.md §2.3.1 四值）。
 * 启发式优先级：静态站标记（Astro / 无 package.json 的纯 HTML）→
 * 前端信号 + 后端信号组合 → Python 后端标记 → 兜底 backend。
 */
export function detectKind(dir: string): KindDetection {
  const reasons: string[] = [];
  const { names: deps, hasPkg } = readPkgDeps(dir);

  // 静态站：astro.config.* 或 astro 依赖（Astro 静态站型，DESIGN.md §11.5）
  const astroConfig = fs
    .readdirSync(dir)
    .find((f) => /^astro\.config\.(mjs|js|ts|mts)$/.test(f));
  if (astroConfig || deps.includes("astro")) {
    if (astroConfig) reasons.push(`含 ${astroConfig}`);
    if (deps.includes("astro")) reasons.push("package.json 依赖 astro");
    reasons.push("Astro 内容站 → 静态站");
    return { kind: "static", reasons };
  }

  if (!hasPkg) {
    // 无 package.json：Python 工程 → 纯后端；纯 HTML → 静态站
    const pyMarkers = ["pyproject.toml", "requirements.txt", "setup.py"].filter(
      (f) => fs.existsSync(path.join(dir, f)),
    );
    if (pyMarkers.length > 0) {
      reasons.push(`无 package.json，含 ${pyMarkers.join("、")}`);
      reasons.push("Python 工程，无界面 → 纯后端");
      return { kind: "backend", reasons };
    }
    if (fs.existsSync(path.join(dir, "index.html"))) {
      reasons.push("无 package.json，根目录含 index.html");
      reasons.push("纯 HTML 站点 → 静态站");
      return { kind: "static", reasons };
    }
    reasons.push("无 package.json，也无前端/静态站标记，按纯后端兜底");
    return { kind: "backend", reasons };
  }

  const hitFront = FRONTEND_DEPS.filter((d) => deps.includes(d));
  const hitBackDeps = BACKEND_DEPS.filter((d) => deps.includes(d));
  const hitBackDirs = BACKEND_DIRS.filter((d) => {
    const p = path.join(dir, d);
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  });
  const hasFront = hitFront.length > 0;
  const hasBack = hitBackDeps.length > 0 || hitBackDirs.length > 0;

  if (hasFront) reasons.push(`package.json 依赖前端框架: ${hitFront.join("、")}`);
  if (hitBackDeps.length > 0)
    reasons.push(`package.json 依赖后端框架: ${hitBackDeps.join("、")}`);
  if (hitBackDirs.length > 0)
    reasons.push(`含后端入口目录: ${hitBackDirs.join("、")}`);

  if (hasFront && hasBack) {
    reasons.push("前后端信号俱全 → 前后端");
    return { kind: "fullstack", reasons };
  }
  if (hasFront) {
    reasons.push("只有前端信号 → 纯前端");
    return { kind: "frontend", reasons };
  }
  if (hasBack) {
    reasons.push("只有后端信号 → 纯后端");
    return { kind: "backend", reasons };
  }
  reasons.push("有 package.json 但无前后端信号，按纯后端兜底");
  return { kind: "backend", reasons };
}

/**
 * .gitignore 检查（DESIGN.md §8.2）：被纳管项目建议 gitignore 含 `.工作台/` 一行。
 * 只检查与提示，绝不替对方改文件。
 */
export function checkGitignore(dir: string): GitignoreCheck {
  const file = path.join(dir, ".gitignore");
  if (!fs.existsSync(file)) {
    return {
      exists: false,
      has_workbench_line: false,
      hint:
        `该项目没有 .gitignore。建议新建并加入一行 \`${WORKBENCH_GITIGNORE_LINE}\`，` +
        "避免塔台私有数据（.工作台/）被提交（DESIGN.md §8.2）。",
    };
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const has = lines.some((l) => l.trim() === WORKBENCH_GITIGNORE_LINE);
  return {
    exists: true,
    has_workbench_line: has,
    hint: has
      ? null
      : `该项目的 .gitignore 缺少一行 \`${WORKBENCH_GITIGNORE_LINE}\`，` +
        "建议补上，避免塔台私有数据（.工作台/）被提交（DESIGN.md §8.2）。",
  };
}

/**
 * 接入项目：校验目录 → 判定 kind → 检查 .gitignore → 写入注册表。
 * 幂等：注册表已有同 id 或同路径记录时不重复写入，返回已有记录。
 */
export function onboardProject(
  input: OnboardInput,
  dataDir?: string,
): OnboardResult {
  const err = (code: OnboardErr["error"]["code"], message: string): OnboardErr => ({
    ok: false,
    error: { code, message },
  });
  if (typeof input.path !== "string" || input.path.trim() === "") {
    return err("INVALID_INPUT", "path 不能为空");
  }
  const absPath = path.resolve(input.path.trim());

  const check = validateDir(absPath);
  if (!check.ok) return { ok: false, error: check.error };

  const detected = detectKind(absPath);
  const gitignore = checkGitignore(absPath);

  const id = (input.id ?? path.basename(absPath)).trim();
  if (id === "") return err("INVALID_INPUT", "id 不能为空");
  const name = (input.name ?? id).trim();

  // 幂等：同 id 或同路径已登记则直接返回（不重复写、不改原记录）
  // 补修 A（2026-09-20）：这里**不再**把"注册表读不出来"当成"没有已登记记录"——
  // 那等于用一次普通登记动作把历史缺失掩盖掉（旧口径还把坏表静默清空重建）。
  // 读不出来就让 `RegistryStateError` 照原样抛出去，由 HTTP 层报结构化错误 + 恢复入口；
  // 想重新登记，先走 `POST /api/registry/recover` 把现场留档、把表恢复好。
  const existing: ProjectRecord | undefined = listProjects(dataDir).find(
    (p) => p.id === id || path.resolve(p.path) === absPath,
  );
  if (existing) {
    return { ok: true, record: existing, already_registered: true, detected, gitignore };
  }

  const record = addProject(
    {
      id,
      name,
      path: absPath,
      kind: detected.kind,
      ...(input.self_managed ? { self_managed: true } : {}),
    },
    dataDir,
  );
  return { ok: true, record, already_registered: false, detected, gitignore };
}
