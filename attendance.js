export class AttendanceInputError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "AttendanceInputError";
    this.field = field;
  }
}

export function validateCount(value, label, { minimum = 0 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new AttendanceInputError(`${label} is required.`, label);
  }
  const count = Number(text);
  if (!Number.isSafeInteger(count)) {
    throw new AttendanceInputError(`${label} must be a whole number.`, label);
  }
  if (count < minimum) {
    const limit = minimum === 0 ? "zero or more" : `at least ${minimum}`;
    throw new AttendanceInputError(`${label} must be ${limit}.`, label);
  }
  return count;
}

export function validateTarget(value, label = "Target attendance") {
  const text = String(value ?? "").trim();
  const target = Number(text);
  if (!text || !Number.isFinite(target) || target <= 0 || target > 100) {
    throw new AttendanceInputError(`${label} must be greater than 0% and at most 100%.`, label);
  }
  return target;
}

export function validateAttendance(attendedValue, totalValue) {
  const attended = validateCount(attendedValue, "Classes attended");
  const total = validateCount(totalValue, "Total classes", { minimum: 1 });
  if (attended > total) {
    throw new AttendanceInputError(
      "Classes attended cannot exceed total classes conducted.",
      "Classes attended",
    );
  }
  return { attended, total };
}

function normalizePercentage(value) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-10 ? rounded : value;
}

export function currentAttendance(attended, total) {
  const values = validateAttendance(attended, total);
  return normalizePercentage((values.attended / values.total) * 100);
}

function ceilWithTolerance(value) {
  return Math.ceil(value - Number.EPSILON * Math.max(1, Math.abs(value)) * 4);
}

function floorWithTolerance(value) {
  return Math.floor(value + Number.EPSILON * Math.max(1, Math.abs(value)) * 4);
}

export function requiredClasses(attended, total, target) {
  const values = validateAttendance(attended, total);
  const goal = validateTarget(target);
  if (currentAttendance(values.attended, values.total) >= goal) return 0;
  if (goal === 100) return null;
  return Math.max(
    0,
    ceilWithTolerance(
      (goal * values.total - values.attended * 100) / (100 - goal),
    ),
  );
}

export function safeAbsences(attended, total, target) {
  const values = validateAttendance(attended, total);
  const goal = validateTarget(target);
  if (currentAttendance(values.attended, values.total) < goal || goal === 100) return 0;
  return Math.max(
    0,
    floorWithTolerance((values.attended * 100 - goal * values.total) / goal),
  );
}

export function projectedAttendance(attended, total, futureAttended, futureMissed) {
  const values = validateAttendance(attended, total);
  const attendedNext = validateCount(futureAttended, "Upcoming classes to attend");
  const missedNext = validateCount(futureMissed, "Upcoming classes to miss");
  return normalizePercentage(((values.attended + attendedNext) / (values.total + attendedNext + missedNext)) * 100);
}

export function projectAttendanceScenarios(
  attended,
  total,
  remainingClasses,
  target,
  expectedAttendance,
  conservativeAttendance,
) {
  const values = validateAttendance(attended, total);
  const remaining = validateCount(remainingClasses, "Remaining scheduled classes");
  const goal = validateTarget(target);
  const expected = validateCount(expectedAttendance, "Expected classes to attend");
  const conservative = validateCount(conservativeAttendance, "Conservative classes to attend");

  if (expected > remaining) {
    throw new AttendanceInputError(
      "Expected classes to attend cannot exceed the remaining scheduled classes.",
      "Expected classes to attend",
    );
  }
  if (conservative > expected) {
    throw new AttendanceInputError(
      "Conservative classes to attend cannot exceed expected classes to attend.",
      "Conservative classes to attend",
    );
  }
  if (conservative > remaining) {
    throw new AttendanceInputError(
      "Conservative classes to attend cannot exceed the remaining scheduled classes.",
      "Conservative classes to attend",
    );
  }

  const needed = requiredClasses(values.attended, values.total, goal);
  return {
    remaining,
    target: goal,
    reachable: needed !== null && needed <= remaining,
    scenarios: [
      { id: "best", label: "Best case", attended: remaining },
      { id: "expected", label: "Expected", attended: expected },
      { id: "conservative", label: "Conservative", attended: conservative },
    ].map((scenario) => {
      const missed = remaining - scenario.attended;
      const projected = normalizePercentage(
        ((values.attended + scenario.attended) / (values.total + remaining)) * 100,
      );
      return {
        ...scenario,
        missed,
        projected,
        meetsTarget: projected >= goal,
      };
    }),
  };
}

export function attendanceStatus(attended, total, target, warningMargin = 5) {
  const current = currentAttendance(attended, total);
  const goal = validateTarget(target);
  const margin = Number(warningMargin);
  if (!Number.isFinite(margin) || margin < 0 || margin > 100) {
    throw new AttendanceInputError("Warning margin must be between 0 and 100%.", "Warning margin");
  }
  if (current < goal) return "Below Target";
  if (current <= goal + margin) return "At Risk";
  return "On Target";
}

export function aggregateSubjects(subjects) {
  if (!subjects.length) return null;
  const totals = subjects.reduce(
    (sum, subject) => {
      const values = validateAttendance(subject.attended, subject.total);
      return {
        attended: sum.attended + values.attended,
        total: sum.total + values.total,
      };
    },
    { attended: 0, total: 0 },
  );
  return { ...totals, percentage: normalizePercentage((totals.attended / totals.total) * 100) };
}

export function calculateResult(attended, total, target, warningMargin = 5) {
  const values = validateAttendance(attended, total);
  const goal = validateTarget(target);
  const current = currentAttendance(values.attended, values.total);
  return {
    ...values,
    current,
    target: goal,
    status: attendanceStatus(values.attended, values.total, goal, warningMargin),
    required: requiredClasses(values.attended, values.total, goal),
    safeMisses: safeAbsences(values.attended, values.total, goal),
    margin: current - goal,
  };
}
