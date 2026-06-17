// Shared contract for all runners and the report generator.
//
// Every runner is an async function: run(ctx) => CategoryResult
//
//   CategoryResult = {
//     id:        string   // stable category id, e.g. "accessibility"
//     title:     string   // human title, e.g. "Accessibility (WCAG 2.1 AA)"
//     icon:      string   // emoji shown in the report header
//     summary:   string   // one-line plain-English status for the PM
//     findings:  Finding[]
//     stats?:    object   // optional key/value facts rendered as a small table
//     error?:    string   // set if the runner failed; category is shown degraded
//   }
//
//   Finding = {
//     title:          string
//     severity:       "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "PASS"
//     location:       string   // URL and/or CSS selector — where to look
//     description:    string   // plain English: what's wrong and why it matters
//     recommendation: string   // plain English: how to fix it
//     reference?:     { label: string, url: string }  // WCAG/OWASP/Google doc
//   }

export const SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  PASS: 'PASS',
};

export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'PASS'];

// Points subtracted from a category's 100 baseline per finding.
const SEVERITY_PENALTY = { CRITICAL: 40, HIGH: 18, MEDIUM: 7, LOW: 2, PASS: 0 };

// Weight of each category in the overall 0-100 score (must sum to 100).
export const CATEGORY_WEIGHTS = {
  links: 12,
  performance: 14,
  accessibility: 14,
  security: 12,
  seo: 12,
  responsive: 10,
  browsers: 8,
  content: 8,
  mobile: 6,
  tracking: 4,
};

export function makeFinding(f) {
  if (!SEVERITY[f.severity]) throw new Error(`bad severity: ${f.severity}`);
  return {
    title: f.title,
    severity: f.severity,
    location: f.location || '',
    description: f.description || '',
    recommendation: f.recommendation || '',
    reference: f.reference || null,
  };
}

// Score a category 0-100 from its findings. PASS findings never reduce score;
// they're shown as green confirmations. Repeated low-severity issues are
// dampened so a page with 50 missing-alt images doesn't tank a whole category
// past what the cap already enforces.
export function scoreCategory(findings) {
  let penalty = 0;
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) {
    if (f.severity === 'PASS') continue;
    counts[f.severity]++;
    // diminishing penalty: 1st full, then 70%, 49%, ... so volume still hurts
    // but a single category can't go infinitely negative.
    const n = counts[f.severity];
    penalty += SEVERITY_PENALTY[f.severity] * Math.pow(0.7, n - 1);
  }
  return Math.max(0, Math.round(100 - penalty));
}

export function overallScore(categories) {
  let weighted = 0;
  let totalWeight = 0;
  for (const c of categories) {
    const w = CATEGORY_WEIGHTS[c.id] ?? 0;
    if (!w) continue;
    totalWeight += w;
    weighted += w * (typeof c.score === 'number' ? c.score : 0);
  }
  return totalWeight ? Math.round(weighted / totalWeight) : 0;
}

export function countBySeverity(categories) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, PASS: 0 };
  for (const c of categories) {
    for (const f of c.findings || []) counts[f.severity]++;
  }
  return counts;
}

export function scoreGrade(score) {
  if (score >= 90) return { label: 'Excellent', band: 'pass' };
  if (score >= 75) return { label: 'Good', band: 'good' };
  if (score >= 50) return { label: 'Needs work', band: 'medium' };
  if (score >= 30) return { label: 'Poor', band: 'high' };
  return { label: 'Critical', band: 'critical' };
}
