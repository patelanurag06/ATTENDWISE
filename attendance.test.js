import { describe, expect, it } from "vitest";
import {
  aggregateSubjects,
  attendanceStatus,
  currentAttendance,
  projectAttendanceScenarios,
  projectedAttendance,
  requiredClasses,
  safeAbsences,
  validateAttendance,
  validateCount,
} from "./attendance.js";

describe("attendance calculations", () => {
  it("calculates current attendance and safe absences for 42 of 50 at 75%", () => {
    expect(currentAttendance(42, 50)).toBe(84);
    expect(requiredClasses(42, 50, 75)).toBe(0);
    expect(safeAbsences(42, 50, 75)).toBe(6);
  });

  it("calculates 30 classes needed from 30 of 50 at a 75% target", () => {
    expect(requiredClasses(30, 50, 75)).toBe(30);
  });

  it("handles zero attendance, full attendance, and exact target boundaries", () => {
    expect(currentAttendance(0, 8)).toBe(0);
    expect(requiredClasses(0, 8, 75)).toBe(24);
    expect(currentAttendance(5, 5)).toBe(100);
    expect(requiredClasses(3, 4, 75)).toBe(0);
    expect(safeAbsences(3, 4, 75)).toBe(0);
  });

  it("treats a 100% target without dividing by zero", () => {
    expect(requiredClasses(5, 5, 100)).toBe(0);
    expect(requiredClasses(4, 5, 100)).toBeNull();
    expect(safeAbsences(5, 5, 100)).toBe(0);
  });

  it("projects attended and missed classes", () => {
    expect(projectedAttendance(30, 50, 10, 0)).toBeCloseTo(66.6667, 3);
    expect(projectedAttendance(42, 50, 0, 3)).toBeCloseTo(79.2453, 3);
  });

  it("compares best, expected, and conservative projections against a fixed schedule", () => {
    const result = projectAttendanceScenarios(6, 10, 10, 75, 8, 5);
    expect(result.reachable).toBe(true);
    expect(result.scenarios).toEqual([
      { id: "best", label: "Best case", attended: 10, missed: 0, projected: 80, meetsTarget: true },
      { id: "expected", label: "Expected", attended: 8, missed: 2, projected: 70, meetsTarget: false },
      { id: "conservative", label: "Conservative", attended: 5, missed: 5, projected: 55, meetsTarget: false },
    ]);
  });

  it("reports a target unreachable when even attending every remaining class is insufficient", () => {
    const result = projectAttendanceScenarios(2, 10, 2, 75, 1, 0);
    expect(result.reachable).toBe(false);
    expect(result.scenarios[0].projected).toBeCloseTo(33.3333, 3);
  });

  it("handles an empty remaining schedule without division errors", () => {
    const result = projectAttendanceScenarios(3, 4, 0, 75, 0, 0);
    expect(result.reachable).toBe(true);
    expect(result.scenarios.every((scenario) => scenario.projected === 75)).toBe(true);

    const belowTarget = projectAttendanceScenarios(2, 4, 0, 75, 0, 0);
    expect(belowTarget.reachable).toBe(false);
    expect(belowTarget.scenarios.every((scenario) => scenario.projected === 50)).toBe(true);
  });

  it("recognizes a target reachable exactly on the last scheduled class", () => {
    const result = projectAttendanceScenarios(1, 2, 2, 75, 2, 0);
    expect(result.reachable).toBe(true);
    expect(result.scenarios[0].projected).toBe(75);
    expect(result.scenarios[1].projected).toBe(75);
    expect(result.scenarios[2].projected).toBe(25);
  });

  it("handles 100% targets with and without previously missed classes", () => {
    expect(projectAttendanceScenarios(5, 5, 3, 100, 3, 2).reachable).toBe(true);
    expect(projectAttendanceScenarios(4, 5, 10, 100, 10, 10).reachable).toBe(false);
    expect(() => projectAttendanceScenarios(4, 5, 10, 0, 10, 10)).toThrow(/Target attendance/);
  });

  it("rejects scenario attendance counts outside the remaining schedule or out of order", () => {
    expect(() => projectAttendanceScenarios(6, 10, 5, 75, 6, 3)).toThrow(/cannot exceed/);
    expect(() => projectAttendanceScenarios(6, 10, 5, 75, 3, 4)).toThrow(/cannot exceed expected/);
    expect(() => projectAttendanceScenarios(6, 10, -1, 75, 0, 0)).toThrow();
    expect(() => projectAttendanceScenarios(6, 10, 5, 75, "", 0)).toThrow(/required/);
  });

  it("aggregates subject attendance by class counts, not by average", () => {
    expect(
      aggregateSubjects([
        { attended: 9, total: 10 },
        { attended: 10, total: 20 },
      ]),
    ).toEqual({ attended: 19, total: 30, percentage: (19 / 30) * 100 });
  });

  it("labels threshold statuses", () => {
    expect(attendanceStatus(3, 5, 75)).toBe("Below Target");
    expect(attendanceStatus(4, 5, 75)).toBe("At Risk");
    expect(attendanceStatus(9, 10, 75)).toBe("On Target");
  });

  it("rejects invalid count values", () => {
    for (const [attended, total] of [[6, 5], [-1, 5], [1.5, 5], [0, 0]]) {
      expect(() => validateAttendance(attended, total)).toThrow();
    }
    expect(() => validateCount("", "Classes attended")).toThrow();
    expect(() => validateCount(Number.MAX_SAFE_INTEGER + 1, "Classes attended")).toThrow(/whole number/);
    expect(() => requiredClasses(4, 5, 0)).toThrow();
    expect(() => projectedAttendance(4, 5, -1, 0)).toThrow();
  });

  it("recovers on exact integer boundaries", () => {
    expect(requiredClasses(60, 100, 75)).toBe(60);
    expect(requiredClasses(42, 50, 75)).toBe(0);
  });
});
