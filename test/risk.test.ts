import { describe, it, expect } from "vitest";
import { scoreDiff, triageOrder, isTest } from "../server/risk";
import type { FileChange } from "../server/git";

const f = (path: string, added = 10, deleted = 0, status: FileChange["status"] = "M", binary = false): FileChange =>
  ({ path, added, deleted, status, binary });

describe("risk scoring", () => {
  it("empty diff is zero risk", () => {
    expect(scoreDiff([])).toMatchObject({ score: 0, level: "low" });
  });

  it("docs-only change stays low even when large", () => {
    const r = scoreDiff([f("README.md", 400), f("docs/guide.md", 300)]);
    expect(r.level).toBe("low");
    expect(r.score).toBeLessThanOrEqual(15);
  });

  it("migration + auth + no tests is high, with explanations", () => {
    const r = scoreDiff([
      f("db/migrations/0042_drop_users.sql", 5, 80),
      f("src/auth/session.ts", 120, 40),
      f("src/api/users.ts", 60, 10),
    ]);
    expect(r.level).toBe("high");
    const labels = r.reasons.map((x) => x.label).join(" | ");
    expect(labels).toContain("database schema/migration");
    expect(labels).toContain("auth/security code");
    expect(labels).toContain("no test changes");
  });

  it("same source change scores lower when tests accompany it", () => {
    const src = [f("src/lib/math.ts", 60, 10)];
    const without = scoreDiff(src).score;
    const withTests = scoreDiff([...src, f("src/lib/math.test.ts", 40)]).score;
    expect(withTests).toBeLessThan(without);
  });

  it("secrets file is flagged heavily", () => {
    const r = scoreDiff([f("config/.env.production", 3)]);
    expect(r.reasons[0].label).toContain("secrets");
  });

  it("score is clamped to 100", () => {
    const many = Array.from({ length: 60 }, (_, i) => f(`src/auth/m${i}/migrations/x${i}.sql`, 0, 900, "D"));
    expect(scoreDiff(many).score).toBe(100);
  });

  it("detects test files across ecosystems", () => {
    for (const p of ["a/b.test.ts", "x.spec.js", "tests/foo.py", "pkg/foo_test.go", "test_api.py", "__tests__/a.tsx"]) {
      expect(isTest(p), p).toBe(true);
    }
    expect(isTest("src/contest.ts")).toBe(false);
  });

  it("triage puts risky first and empty diffs last", () => {
    const items = [
      { item: "empty", risk: scoreDiff([]) },
      { item: "docs", risk: scoreDiff([f("README.md", 5)]) },
      { item: "risky", risk: scoreDiff([f("src/auth/x.ts", 200, 50), f("db/migrations/1.sql", 20)]) },
    ];
    expect(triageOrder(items).map((x) => x.item)).toEqual(["risky", "docs", "empty"]);
  });
});

describe("destructive SQL", () => {
  it("detects DROP/TRUNCATE/DELETE on added lines only", async () => {
    const { hasDestructiveSql } = await import("../server/risk");
    expect(hasDestructiveSql("@@ -0,0 +1 @@\n+ALTER TABLE s DROP COLUMN legacy;\n")).toBe(true);
    expect(hasDestructiveSql("+truncate audit_log;\n")).toBe(true);
    expect(hasDestructiveSql("-DROP TABLE old;\n+CREATE TABLE x (id int);\n")).toBe(false);
    expect(hasDestructiveSql("+++ b/db/drop_table.sql\n+SELECT 1;\n")).toBe(false);
  });

  it("pushes a migration + auth change into high risk", () => {
    const files = [f("db/migrations/002.sql", 2, 0, "A"), f("src/auth/session.js", 1, 1)];
    expect(scoreDiff(files).level).toBe("medium");
    const r = scoreDiff(files, { destructiveSql: ["db/migrations/002.sql"] });
    expect(r.level).toBe("high");
    expect(r.reasons[0].label).toContain("destructive SQL");
  });
});
