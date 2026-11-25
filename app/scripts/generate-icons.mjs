// Generates PWA icons from the RGCI emblem (brand/rgci-logo.svg). Run: npm run icons
import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const TOP = '#7136de';
const BOTTOM = '#3f1f7c';
const GOLD = '#ecc86a';
const src = readFileSync(new URL('../brand/rgci-logo.svg', import.meta.url), 'utf8');
// Inner markup of the 64×64 emblem: globe in white, cross in gold.
const inner = (cross) =>
  src
    .slice(src.indexOf('>') + 1, src.lastIndexOf('</svg>'))
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<path d="M32 4v56[^>]*stroke=")currentColor/, `$1${cross}`)
    .replace(/currentColor/g, '#ffffff');

const icon = (size, scale, rounded, cross = GOLD) => {
  const w = size * scale;
  const x = (size - w) / 2;
  const r = rounded ? size * 0.22 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${TOP}"/><stop offset="1" stop-color="${BOTTOM}"/></linearGradient></defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
  <g transform="translate(${x} ${x}) scale(${w / 64})" fill="none">${inner(cross)}</g></svg>`;
};
// Monochrome badge for the Android status bar (white on transparent).
const badge = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="translate(${size * 0.06} ${size * 0.06}) scale(${(size * 0.88) / 64})" fill="none">${inner('#ffffff')}</g></svg>`;

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const jobs = [
  ['icon-192.png', icon(192, 0.66, false)],
  ['icon-512.png', icon(512, 0.66, false)],
  ['maskable-192.png', icon(192, 0.5, false)],
  ['maskable-512.png', icon(512, 0.5, false)],
  ['apple-touch-icon.png', icon(180, 0.62, false)],
  ['favicon-32.png', icon(32, 0.8, true)],
  ['badge-96.png', badge(96)],
];
for (const [name, svg] of jobs) {
  await sharp(Buffer.from(svg)).png().toFile(new URL(name, out).pathname);
  console.log('icon', name);
}
writeFileSync(new URL('../public/favicon.svg', import.meta.url), icon(64, 0.8, true));
writeFileSync(new URL('../public/rgci-logo.svg', import.meta.url), src);
console.log('favicon.svg, rgci-logo.svg');
