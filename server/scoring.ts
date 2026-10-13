import type { Entrant } from "./store";

/**
 * Entrant scoring, in priority order:
 *   1. did verification pass (tests/typecheck/lint)
 *   2. did the agent actually change anything
 *   3. lower review risk
 *   4. smaller diff (less to review, less to break)
 */
export function scoreEntrant(e: Entrant): number {
  if (!e.files) return -1000; // no work produced
  let s = 0;
  if (e.verify?.passed) s += 1000;
  if (e.exitCode != null && e.exitCode !== 0) s -= 100;
  s -= (e.risk ?? 0) * 3;
  s -= Math.min(300, (e.churn ?? 0) / 2);
  return Math.round(s);
}

export function rankEntrants(entrants: Entrant[]): Entrant[] {
  return entrants
    .map((e) => ({ ...e, score: scoreEntrant(e) }))
    .sort((a, b) => b.score! - a.score!);
}
