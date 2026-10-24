import { describe, expect, it } from "vitest";
import { exportCsv, importCsv } from "./csv.js";

describe("attendance CSV import/export", () => {
  const subjects = [
    {
      id: "math-1",
      name: 'Math, "advanced"',
      attended: 8,
      total: 10,
      target: 75,
      history: [
        { date: "2026-10-18", attended: 2, missed: 1 },
        { date: "2026-10-20", attended: 1, missed: 0 },
      ],
    },
    {
      id: "history-empty",
      name: "Physics",
      attended: 0,
      total: 2,
      target: 80,
      history: [],
    },
  ];

  it("round trips commas, escaped quotes, subjects, and history", () => {
    expect(importCsv(exportCsv(subjects))).toEqual(subjects);
  });

  it("rejects missing columns, inconsistent rows, and invalid history dates", () => {
    expect(() => importCsv("name\nMath")).toThrow(/Missing CSV columns/);
    const brokenRows = exportCsv(subjects).replace("2026-10-18", "2026-02-31");
    expect(() => importCsv(brokenRows)).toThrow(/valid history date/);
  });
});
