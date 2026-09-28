// 施工卡**单卡定义哈希**的跨层单一实现（浏览器安全：纯函数、零 node import、零 React）。
//
// 为什么单独放在 `src/shared/`：这张哈希有三个消费者——服务端写/读路径
// （`src/server/work/plan.ts` 的 `taskDefinitionHash` 原是唯一实现在那里）、
// 蓝图派生与校验侧（`src/arch/blueprint.ts` 的 plan_task 来源引用要烙本卡哈希、
// `src/arch/blueprintValidate.ts` 要按本卡哈希判 stale），以及状态投影层
// （`src/server/work/statusProjection.ts` 的分段失效复核）。把实现留在 `server/work/plan.ts`
// 会让纯解析侧与浏览器包沿 `node:crypto`/`node:fs` 那条链被拉进来（同 `shared/gateSteps.ts`、
// `shared/reconcileLinks.ts` 的先例）。**口径一个字节都不能变**：本文件的 canonical 与
// `sha256Hex(JSON.stringify(canonical))` 必须与迁移前 `plan.ts` 里的实现逐字一致，
// 否则全库既有 `definition_sha256` / 基线 / 证据绑定会整体对不上。
//
// 哈希口径（DESIGN.md §2.6 / §2.9 硬口径）：只覆盖目标、范围、依赖、接口与验收内容，
// **不含**派生状态（表格「状态」列）、时间戳、执行备注（「施工备注」段）、勾选位与定义修订号；
// 绑定信息（plan_revision / design_revision）也不进哈希。

/**
 * 单卡定义哈希覆盖的字段（与 `server/work/plan.ts` 的 `TaskDefinition` **结构兼容**的
 * 最小子集）。这里只描述"哈希吃什么"，用结构类型声明，避免 shared 反向依赖 server/work。
 */
export interface PlanCardDefinitionLike {
  task_id: string;
  stable_key: string;
  change_id: string | null;
  requirement_ids: string[] | null;
  base_commit: string | null;
  goal: string | null;
  dependency_ids: readonly string[];
  dependency_notes: readonly string[];
  dependency_evidence: readonly { dependency_id: string; present: boolean; evidence: string | null }[];
  inputs: string | null;
  allowed_paths: readonly string[];
  forbidden: string | null;
  acceptance: { checks: readonly { text: string }[]; deliverables: string | null } | null;
  risk: string | null;
  deliverables: readonly string[] | null;
  owner_role: string | null;
  priority: string | null;
  design_refs: readonly string[];
  evidence_requirement: string | null;
}

/**
 * 定义哈希的规范化内容：只覆盖目标/范围/依赖/接口/验收，**排除** plan_revision、
 * design_revision、revision（定义修订号）、勾选位与任何时间戳/执行备注。
 * 键序即 JSON 序列化顺序，**不许重排**（重排会整体改变哈希）。
 */
export function definitionCanonical(def: PlanCardDefinitionLike): unknown {
  // 2026-09-28 补：对缺字段的"部分定义"有确定行为（不崩）——夹具/迁移期会构造只填部分字段的卡
  // （实测 verify:v08-03/v08-05/v09-01 的夹具卡没有 dependency_evidence）。缺一律归一为空，
  // **完整卡的哈希值不变**（`?? 空值` 只在 undefined 时生效，已过 verify:plan-segment-binding 的对照）。
  return {
    task_id: def.task_id,
    stable_key: def.stable_key,
    change_id: def.change_id,
    requirement_ids: def.requirement_ids,
    base_commit: def.base_commit,
    goal: def.goal,
    dependency_ids: def.dependency_ids,
    dependency_notes: def.dependency_notes,
    dependency_evidence: (def.dependency_evidence ?? []).map((e) => [e.dependency_id, e.present, e.evidence]),
    inputs: def.inputs,
    allowed_paths: def.allowed_paths,
    forbidden: def.forbidden,
    acceptance:
      def.acceptance == null
        ? null
        : { checks: (def.acceptance.checks ?? []).map((c) => c.text), deliverables: def.acceptance.deliverables ?? [] },
    risk: def.risk,
    deliverables: def.deliverables,
    owner_role: def.owner_role,
    priority: def.priority,
    design_refs: def.design_refs,
    evidence_requirement: def.evidence_requirement,
  };
}

/** 单个任务的定义哈希（同一份定义在任何进程里算出同一个值） */
export function taskDefinitionHash(def: PlanCardDefinitionLike): string {
  return sha256Hex(JSON.stringify(definitionCanonical(def)));
}

// ── SHA-256（FIPS 180-4）──
//
// 为什么在 shared 里**自带**一份而不是 import `server/work/*` 的 `sha256Hex`：那一份包的是
// `node:crypto`，浏览器包一旦沿它 import 就会在 vite 构建期报
// `"createHash" is not exported by "__vite-browser-external"`（`shared/gateSteps.ts` 记过同类坑）。
// 本实现是纯 JS、零 import，取值与 `node:crypto` 的 utf8 sha256 **逐位相同**——
// 验证脚本 `verify-plan-segment-binding.ts` 用真实卡定义对两者逐条对照钉住这条不变量。

/** SHA-256 轮常量（FIPS 180-4 §4.2.2） */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

/** 字符串 → UTF-8 字节（等价 `Buffer.from(text, "utf8")`；不 import 任何 node）
 *  注意：孤立代理项按 UTF-8 的三字节编码写出，与 Node 的 U+FFFD 替换口径不同——
 *  卡定义是 Markdown 正文，不含孤立代理项，这条边界对哈希取值无影响。 */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

/** UTF-8 字符串的 sha256（小写 hex），纯 JS、与 `node:crypto` 取值一致 */
export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLen = bytes.length * 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  // 补位：0x80 + 若干 0 + 8 字节大端长度，长度按 64 字节对齐
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, hi, false);
  dv.setUint32(padded.length - 4, lo, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  let out = "";
  for (const x of [h0, h1, h2, h3, h4, h5, h6, h7]) out += x.toString(16).padStart(8, "0");
  return out;
}
