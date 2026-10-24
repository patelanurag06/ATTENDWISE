import { validateAttendance, validateTarget } from "./attendance.js";

export const STORAGE_KEY = "attendwise.v1";
export const DEFAULT_SETTINGS = {
  target: 75,
  warningMargin: 5,
  theme: "dark",
};

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function createEmptyData() {
  return { settings: { ...DEFAULT_SETTINGS }, subjects: [] };
}

export function validateData(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.subjects)) {
    throw new Error("The data must contain a subjects array.");
  }
  const settings = input.settings ?? {};
  const target = validateTarget(settings.target ?? DEFAULT_SETTINGS.target);
  const warningMargin = Number(settings.warningMargin ?? DEFAULT_SETTINGS.warningMargin);
  if (!Number.isFinite(warningMargin) || warningMargin < 0 || warningMargin > 100) {
    throw new Error("Warning margin must be between 0 and 100.");
  }
  const theme = settings.theme ?? DEFAULT_SETTINGS.theme;
  if (!["dark", "light"].includes(theme)) {
    throw new Error("Theme must be dark or light.");
  }
  const ids = new Set();
  const subjects = input.subjects.map((subject) => {
    if (!subject || typeof subject !== "object") throw new Error("A subject entry is invalid.");
    const name = String(subject.name ?? "").trim();
    if (!name) throw new Error("Every subject must have a name.");
    const { attended, total } = validateAttendance(subject.attended, subject.total);
    const subjectTarget = validateTarget(subject.target ?? target);
    const id = String(subject.id || createId());
    if (ids.has(id)) throw new Error("Subject IDs must be unique.");
    ids.add(id);
    const history = subject.history ?? [];
    if (!Array.isArray(history)) throw new Error(`History for ${name} must be a list.`);
    const cleanHistory = history.map((record) => {
      if (!record || typeof record !== "object") throw new Error(`An attendance record for ${name} is invalid.`);
      const date = String(record.date ?? "");
      if (!isValidDate(date)) {
        throw new Error(`An attendance record for ${name} has an invalid date.`);
      }
      const recordAttended = Number(record.attended);
      const recordMissed = Number(record.missed);
      if (
        !Number.isInteger(recordAttended) ||
        recordAttended < 0 ||
        !Number.isInteger(recordMissed) ||
        recordMissed < 0 ||
        recordAttended + recordMissed < 1
      ) {
        throw new Error(`Attendance history for ${name} must record one or more whole classes.`);
      }
      return { date, attended: recordAttended, missed: recordMissed };
    });
    return { id, name, attended, total, target: subjectTarget, history: cleanHistory };
  });
  return {
    settings: { target, warningMargin, theme },
    subjects,
  };
}

export function loadData(storage) {
  try {
    const browserStorage = storage ?? globalThis.localStorage;
    if (!browserStorage) throw new Error("Browser storage is unavailable.");
    const raw = browserStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return { data: createEmptyData(), warning: "" };
    return { data: validateData(JSON.parse(raw)), warning: "" };
  } catch (error) {
    return {
      data: createEmptyData(),
      warning: `Saved data could not be loaded: ${error.message}. It has not been overwritten.`,
    };
  }
}

export function saveData(data, storage) {
  const browserStorage = storage ?? globalThis.localStorage;
  if (!browserStorage) throw new Error("Browser storage is unavailable.");
  browserStorage.setItem(STORAGE_KEY, JSON.stringify(validateData(data)));
}
