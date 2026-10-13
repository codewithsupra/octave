import type { FileChange } from "./git";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskReason {
  points: number;
  label: string;
}

export interface RiskReport {
  score: number; // 0-100
  level: RiskLevel;
  reasons: RiskReason[];
  stats: { files: number; added: number; deleted: number };
}

const SENSITIVE: Array<[RegExp, string, number]> = [
  [/(^|\/)(auth|security|permissions?|session|crypto|oauth|jwt)[^/]*(\/|$)/i, "auth/security code", 14],
  [/(^|\/)(migrations?|schema\.(sql|prisma)|.*\.sql$)/i, "database schema/migration", 16],
  [/(^|\/)(\.github\/workflows|\.gitlab-ci|\.circleci|Jenkinsfile|azure-pipelines)/i, "CI pipeline", 12],
  [/(^|\/)(Dockerfile|docker-compose|terraform|.*\.tf$|k8s|helm|infra)/i, "infrastructure", 12],
  [/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$/, "dependency lockfile", 8],
  [/(^|\/)(package\.json|requirements.*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile)$/, "dependency manifest", 6],
  [/(^|\/)(\.env[^/]*|.*secret[^/]*|.*credential[^/]*|.*\.pem|.*\.key)$/i, "secrets/credentials file", 25],
  [/(^|\/)(payment|billing|checkout|stripe)[^/]*(\/|$)/i, "payments/billing code", 14],
];

const TEST_RE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const DOC_RE = /\.(md|mdx|txt|rst)$|(^|\/)docs?\//i;

export function isTest(p: string): boolean {
  return TEST_RE.test(p);
}

/**
 * Explainable risk score for a diff. Every point comes with a reason, so the
 * reviewer sees *why* something is at the top of the queue.
 */
export interface RiskExtras {
  /** Files whose added lines contain destructive SQL (DROP/TRUNCATE/DELETE FROM). */
  destructiveSql?: string[];
}

const DESTRUCTIVE_SQL = /^\+(?!\+\+).*\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE)|TRUNCATE\b|DELETE\s+FROM)/im;

/** Scan a unified patch for destructive SQL on added lines. */
export function hasDestructiveSql(patch: string): boolean {
  return DESTRUCTIVE_SQL.test(patch);
}

export const SQL_FILE = /\.sql$|(^|\/)migrations?\//i;

export function scoreDiff(files: FileChange[], extras: RiskExtras = {}): RiskReport {
  const reasons: RiskReason[] = [];
  const add = (points: number, label: string) => {
    if (points > 0) reasons.push({ points: Math.round(points), label });
  };

  const added = files.reduce((s, f) => s + f.added, 0);
  const deleted = files.reduce((s, f) => s + f.deleted, 0);
  const churn = added + deleted;
  const stats = { files: files.length, added, deleted };

  if (files.length === 0) return { score: 0, level: "low", reasons: [], stats };

  // Size: log-scaled so a 2000-line diff isn't 10x a 200-line one.
  if (churn > 20) add(Math.min(25, 6 * Math.log10(churn / 20 + 1) * 3), `${churn} lines changed`);
  if (files.length > 8) add(Math.min(12, files.length - 8), `${files.length} files touched`);

  // Deletions are harder to review than additions.
  const deletedFiles = files.filter((f) => f.status === "D").length;
  if (deletedFiles) add(Math.min(15, deletedFiles * 5), `${deletedFiles} file(s) deleted`);
  if (deleted > 50 && deleted > added) add(8, "net code removal");

  // Sensitive paths: count each category once at its full weight.
  const hits = new Map<string, { points: number; paths: string[] }>();
  for (const f of files) {
    for (const [re, label, pts] of SENSITIVE) {
      if (re.test(f.path)) {
        const h = hits.get(label) ?? { points: pts, paths: [] };
        h.paths.push(f.path);
        hits.set(label, h);
      }
    }
  }
  for (const [label, h] of hits) add(h.points, `${label}: ${h.paths.slice(0, 2).join(", ")}${h.paths.length > 2 ? ` +${h.paths.length - 2}` : ""}`);

  if (extras.destructiveSql?.length) {
    add(22, `destructive SQL (DROP/TRUNCATE/DELETE): ${extras.destructiveSql.slice(0, 2).join(", ")}`);
  }

  // Source changed without tests changing alongside it.
  const src = files.filter((f) => !isTest(f.path) && !DOC_RE.test(f.path) && !f.binary);
  const tests = files.filter((f) => isTest(f.path));
  const srcChurn = src.reduce((s, f) => s + f.added + f.deleted, 0);
  if (src.length && tests.length === 0 && srcChurn > 15) add(12, "source changed with no test changes");

  const binaries = files.filter((f) => f.binary).length;
  if (binaries) add(Math.min(8, binaries * 3), `${binaries} binary file(s)`);

  const raw = reasons.reduce((s, r) => s + r.points, 0);
  // Mitigation: docs-only or test-only diffs are low-risk by nature.
  let score = raw;
  if (src.length === 0) {
    score = Math.min(score, 15);
    reasons.push({ points: 0, label: tests.length ? "tests/docs only" : "docs only" });
  } else if (tests.length > 0) {
    score -= 6;
    reasons.push({ points: -6, label: "includes test changes" });
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  reasons.sort((a, b) => b.points - a.points);
  const level: RiskLevel = score >= 45 ? "high" : score >= 20 ? "medium" : "low";
  return { score, level, reasons, stats };
}

export interface TriageItem<T> {
  item: T;
  risk: RiskReport;
}

/**
 * Review order: highest-risk first among finished work, then by size.
 * Empty diffs sink to the bottom; they have nothing to review.
 */
export function triageOrder<T>(items: TriageItem<T>[]): TriageItem<T>[] {
  return [...items].sort((a, b) => {
    const ae = a.risk.stats.files === 0 ? 1 : 0;
    const be = b.risk.stats.files === 0 ? 1 : 0;
    if (ae !== be) return ae - be;
    if (b.risk.score !== a.risk.score) return b.risk.score - a.risk.score;
    return (b.risk.stats.added + b.risk.stats.deleted) - (a.risk.stats.added + a.risk.stats.deleted);
  });
}
