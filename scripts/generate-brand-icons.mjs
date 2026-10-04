/**
 * Regenerate the approved tower assets with the installed Tauri CLI:
 *   node scripts/generate-brand-icons.mjs
 * Geometry lives only in public/tatai-mark.svg. No raster tools or new dependencies.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'public/tatai-mark.svg'), 'utf8');
const viewBox = source.match(/viewBox="([^"]+)"/)?.[1];
const path = source.match(/<path\s+d="([^"]+)"\s*\/>/)?.[1];
const strokeWidth = source.match(/stroke-width="([^"]+)"/)?.[1];
if (viewBox !== '0 0 28 32' || !path || !strokeWidth || (source.match(/<path\b/g) ?? []).length !== 1) {
  throw new Error('Unexpected brand SVG structure; review the approved source before regenerating.');
}

// The frame gives the thin outline consistent contrast on light and dark system surfaces.
// Preserve the source coordinates, stroke width and proportions; change only presentation.
const framed = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">\n`
  + `  <rect x="1" y="1" width="62" height="62" rx="13" fill="#26322f" stroke="#a2b2a8" stroke-width="1"/>\n`
  + `  <g transform="translate(13.1 10.4) scale(1.35)" fill="none" stroke="#f5f6f4" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round">\n`
  + `    <path d="${path}"/>\n  </g>\n</svg>\n`;

const icons = join(root, 'src-tauri/icons');
const nativeNames = [
  '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png',
  'icon.png', 'icon.ico', 'icon.icns', 'StoreLogo.png',
  ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map(size => `Square${size}x${size}Logo.png`),
];
const temporary = await mkdtemp(join(tmpdir(), 'tatai-brand-'));
try {
  const input = join(temporary, 'tatai-app.svg');
  const generated = join(temporary, 'icons');
  await writeFile(input, framed, 'utf8');
  const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const run = args => {
    const result = spawnSync(process.execPath, [cli, 'icon', input, ...args], { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`Tauri icon generation failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    }
  };
  run(['--output', generated]);
  // Tauri emits ICNS resources from an unordered map. Canonicalize their order so
  // an unchanged source produces byte-identical assets instead of noisy diffs.
  const icnsPath = join(generated, 'icon.icns');
  const icns = await readFile(icnsPath);
  if (icns.toString('ascii', 0, 4) !== 'icns' || icns.readUInt32BE(4) !== icns.length) {
    throw new Error('Invalid generated ICNS header');
  }
  const resources = [];
  for (let offset = 8; offset < icns.length;) {
    if (offset + 8 > icns.length) throw new Error('Truncated ICNS resource header');
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) throw new Error('Invalid ICNS resource length');
    resources.push(icns.subarray(offset, offset + length));
    offset += length;
  }
  resources.sort((a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)));
  await writeFile(icnsPath, Buffer.concat([icns.subarray(0, 8), ...resources]));
  const small = join(temporary, 'small');
  run(['--output', small, '--png', '16']);
  // Check the complete output first, before replacing any committed asset.
  await Promise.all(nativeNames.map(name => readFile(join(generated, name))));
  await readFile(join(small, '16x16.png'));
  await mkdir(icons, { recursive: true });
  for (const name of nativeNames) await copyFile(join(generated, name), join(icons, name));
  await copyFile(join(small, '16x16.png'), join(icons, '16x16.png'));
  await writeFile(join(root, 'public/tatai-favicon.svg'), framed, 'utf8');
  process.stdout.write(`Generated ${nativeNames.length + 1} native icons and public/tatai-favicon.svg from public/tatai-mark.svg\n`);
} finally {
  if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !temporary.includes('tatai-brand-')) {
    throw new Error('Refusing cleanup outside the generated temporary directory.');
  }
  await rm(temporary, { recursive: true, force: true });
}
