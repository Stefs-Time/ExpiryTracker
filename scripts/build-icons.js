/**
 * Builds public/icons.svg — an SVG <symbol> sprite containing only the Lucide
 * icons the UI uses (ISC licence, see node_modules/lucide-static/LICENSE).
 * Run after changing the ICONS list: npm run icons   (requires dev dependencies)
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules', 'lucide-static', 'icons');

const ICONS = [
  'shield-check', 'file-text', 'plus', 'circle-alert', 'arrow-up-right', 'layers', 'triangle-alert', 'clock',
  'circle-check', 'search', 'folder-search', 'calendar-plus', 'x', 'clipboard-check', 'copy', 'car', 'id-card',
  'crosshair', 'credit-card', 'globe', 'file-badge', 'umbrella', 'heart-pulse', 'repeat', 'rotate-cw', 'pencil',
  'trash-2', 'sun', 'moon', 'monitor', 'log-out', 'settings', 'download', 'calendar', 'user', 'mail', 'lock',
  'eye', 'eye-off', 'history', 'wifi-off', 'refresh-cw', 'arrow-left', 'printer', 'link', 'file-spreadsheet',
  'calendar-sync', 'upload', 'users', 'user-x', 'user-check', 'key-round', 'lock-open', 'shield-user',
  'scroll-text', 'chevron-left', 'chevron-right', 'camera', 'image', 'sparkles', 'loader-circle',
];

const symbols = [];
for (const name of ICONS) {
  const svg = await readFile(path.join(SRC, `${name}.svg`), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\n\s*/g, '');
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`);
}
const out = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><!-- Lucide icons (ISC) https://lucide.dev -->${symbols.join('')}</svg>\n`;
await writeFile(path.join(ROOT, 'public', 'icons.svg'), out);
console.log(`Wrote public/icons.svg with ${ICONS.length} icons`);
