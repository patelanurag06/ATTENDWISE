import { validateAttendance, validateTarget } from "./attendance.js";

const HEADERS = [
  "subject_id",
  "subject_name",
  "attended",
  "total",
  "target",
  "history_date",
  "history_attended",
  "history_missed",
];

function escapeCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportCsv(subjects) {
  const rows = [HEADERS];
  subjects.forEach((subject) => {
    const records = subject.history?.length ? subject.history : [null];
    records.forEach((record) => {
      rows.push([
        subject.id,
        subject.name,
        subject.attended,
        subject.total,
        subject.target,
        record?.date ?? "",
        record?.attended ?? "",
        record?.missed ?? "",
      ]);
    });
  });
  return rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function parseNonNegativeInteger(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a non-negative whole number.`);
  return Number(value);
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("The CSV file is empty.");
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  const required = HEADERS.filter((header) => !headers.includes(header));
  if (required.length) throw new Error(`Missing CSV columns: ${required.join(", ")}.`);
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
  const imported = new Map();
  rows.slice(1).forEach((row, rowIndex) => {
    if (row.length !== headers.length) throw new Error(`CSV row ${rowIndex + 2} has the wrong number of columns.`);
    const get = (name) => row[indexes[name]] ?? "";
    const id = get("subject_id").trim();
    const name = get("subject_name").trim();
    if (!id || !name) throw new Error(`CSV row ${rowIndex + 2} needs a subject ID and name.`);
    const { attended, total } = validateAttendance(get("attended"), get("total"));
    const target = validateTarget(get("target"));
    let subject = imported.get(id);
    if (!subject) {
      subject = { id, name, attended, total, target, history: [] };
      imported.set(id, subject);
    } else if (
      subject.name !== name ||
      subject.attended !== attended ||
      subject.total !== total ||
      subject.target !== target
    ) {
      throw new Error(`CSV row ${rowIndex + 2} conflicts with an earlier row for ${name}.`);
    }
    const date = get("history_date").trim();
    const historyAttended = get("history_attended").trim();
    const historyMissed = get("history_missed").trim();
    if (date || historyAttended || historyMissed) {
      if (!isValidDate(date)) {
        throw new Error(`CSV row ${rowIndex + 2} needs a valid history date (YYYY-MM-DD).`);
      }
      const attendedRecord = parseNonNegativeInteger(historyAttended, "History attended count");
      const missedRecord = parseNonNegativeInteger(historyMissed, "History missed count");
      if (attendedRecord + missedRecord < 1) throw new Error(`CSV row ${rowIndex + 2} has an empty history record.`);
      subject.history.push({ date, attended: attendedRecord, missed: missedRecord });
    }
  });
  if (!imported.size) throw new Error("The CSV contains no subjects.");
  return Array.from(imported.values());
}
