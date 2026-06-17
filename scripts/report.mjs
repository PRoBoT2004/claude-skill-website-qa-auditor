import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { scoreGrade, SEVERITY_ORDER, CATEGORY_WEIGHTS } from './lib/contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, '..', 'templates', 'report.html.ejs');

const SEV_COLOR = {
  CRITICAL: '#b91c1c',
  HIGH: '#c2410c',
  MEDIUM: '#a16207',
  LOW: '#475569',
  PASS: '#15803d',
};
const SEV_BG = {
  CRITICAL: '#fef2f2',
  HIGH: '#fff7ed',
  MEDIUM: '#fefce8',
  LOW: '#f8fafc',
  PASS: '#f0fdf4',
};

function scoreColor(score) {
  if (score >= 90) return '#15803d';
  if (score >= 75) return '#65a30d';
  if (score >= 50) return '#a16207';
  if (score >= 30) return '#c2410c';
  return '#b91c1c';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export async function generateReport(data) {
  const template = await fs.readFile(TEMPLATE, 'utf8');
  // sort findings within each category by severity for display
  for (const c of data.categories) {
    (c.findings || []).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    c.counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, PASS: 0 };
    for (const f of c.findings || []) c.counts[f.severity]++;
  }
  const grade = scoreGrade(data.overall);

  // pick representative thumbnails (mobile + desktop) from the responsive runner
  const responsive = data.categories.find((c) => c.id === 'responsive');
  const thumbs = (responsive?.screenshots || []).filter((s) => [375, 768, 1280, 1920].includes(s.width));

  const helpers = {
    esc,
    SEV_COLOR,
    SEV_BG,
    SEVERITY_ORDER,
    scoreColor,
    grade,
    thumbs,
    weights: CATEGORY_WEIGHTS,
    nl2br: (s) => esc(s).replace(/\n/g, '<br>'),
  };

  return ejs.render(template, { ...data, ...helpers }, { rmWhitespace: false });
}
