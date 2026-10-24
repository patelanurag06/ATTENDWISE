import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownWideNarrow,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  Edit3,
  FileUp,
  LayoutDashboard,
  Menu,
  Moon,
  Plus,
  Search,
  School,
  Settings2,
  ShieldAlert,
  Sun,
  Target,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import {
  aggregateSubjects,
  attendanceStatus,
  calculateResult,
  currentAttendance,
  projectAttendanceScenarios,
  requiredClasses,
  safeAbsences,
  validateAttendance,
  validateCount,
  validateTarget,
} from "./utils/attendance.js";
import { exportCsv, importCsv } from "./utils/csv.js";
import { createEmptyData, loadData, saveData } from "./utils/storage.js";
import PortalPage from "./PortalPage.jsx";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "subjects", label: "Subjects", icon: BookOpen },
  { id: "predictor", label: "Predictor", icon: TrendingUp },
  { id: "history", label: "Attendance History", icon: CalendarDays },
  { id: "portal", label: "Institution Portal", icon: School },
  { id: "settings", label: "Settings", icon: Settings2 },
];

const PRESETS = [65, 70, 75, 80, 85, 90];
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const isValidIsoDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};
const formatPct = (value) => `${Number(value).toFixed(2)}%`;
const plural = (count, singular, many = singular === "class" ? "classes" : `${singular}s`) =>
  `${count} ${count === 1 ? singular : many}`;

function App() {
  const portalPath = window.location.pathname;
  const isPortalRoute = portalPath === "/" || [
    "/login/student",
    "/login/teacher",
    "/login/admin",
    "/student/dashboard",
    "/teacher/dashboard",
    "/admin/dashboard",
  ].includes(portalPath);
  return isPortalRoute ? <PortalPage /> : <LocalTracker />;
}

function LocalTracker() {
  const initial = useMemo(() => loadData(), []);
  const [data, setData] = useState(initial.data);
  const [page, setPage] = useState("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [storageWarning, setStorageWarning] = useState(initial.warning);
  const [storageError, setStorageError] = useState("");
  const [editingSubject, setEditingSubject] = useState(null);
  const fileInput = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = data.settings.theme;
  }, [data.settings.theme]);

  function commit(next) {
    setData(next);
    if (storageWarning) return;
    try {
      saveData(next);
      setStorageError("");
    } catch (error) {
      setStorageError(`Could not save your changes: ${error.message}`);
    }
  }

  function updateSettings(settings) {
    commit({ ...data, settings: { ...data.settings, ...settings } });
  }

  function addSubject(values) {
    const subject = {
      id: newId(),
      ...values,
      history: [],
    };
    commit({ ...data, subjects: [...data.subjects, subject] });
    setEditingSubject(null);
  }

  function updateSubject(values) {
    commit({
      ...data,
      subjects: data.subjects.map((subject) =>
        subject.id === editingSubject.id ? { ...subject, ...values } : subject,
      ),
    });
    setEditingSubject(null);
  }

  function deleteSubject(subject) {
    if (!window.confirm(`Delete ${subject.name} and its attendance history? This cannot be undone.`)) return;
    commit({ ...data, subjects: data.subjects.filter((item) => item.id !== subject.id) });
  }

  function addAttendanceRecord(subjectId, record) {
    commit({
      ...data,
      subjects: data.subjects.map((subject) =>
        subject.id === subjectId
          ? {
              ...subject,
              attended: subject.attended + record.attended,
              total: subject.total + record.attended + record.missed,
              history: [...subject.history, record].sort((a, b) => a.date.localeCompare(b.date)),
            }
          : subject,
      ),
    });
  }

  function editHistoryRecord(subject, recordIndex) {
    const record = subject.history[recordIndex];
    const date = window.prompt("Record date (YYYY-MM-DD):", record.date);
    if (date === null) return;
    const attendedText = window.prompt("Classes attended in this record:", String(record.attended));
    if (attendedText === null) return;
    const missedText = window.prompt("Classes missed in this record:", String(record.missed));
    if (missedText === null) return;
    try {
      if (!isValidIsoDate(date)) {
        throw new Error("Date must use YYYY-MM-DD.");
      }
      const attended = validateCount(attendedText, "Attended classes");
      const missed = validateCount(missedText, "Missed classes");
      if (attended + missed < 1) throw new Error("A history record must include at least one class.");
      const nextHistory = subject.history.map((item, index) =>
        index === recordIndex ? { date, attended, missed } : item,
      ).sort((a, b) => a.date.localeCompare(b.date));
      const attendedTotal = subject.attended - record.attended + attended;
      const totalClasses = subject.total - record.attended - record.missed + attended + missed;
      if (attendedTotal > totalClasses) throw new Error("Updated attended classes cannot exceed total classes.");
      commit({
        ...data,
        subjects: data.subjects.map((item) =>
          item.id === subject.id
            ? { ...item, attended: attendedTotal, total: totalClasses, history: nextHistory }
            : item,
        ),
      });
    } catch (error) {
      window.alert(error.message);
    }
  }

  function deleteHistoryRecord(subject, recordIndex) {
    const record = subject.history[recordIndex];
    if (!window.confirm(`Delete the ${record.date} attendance record?`)) return;
    const nextAttended = subject.attended - record.attended;
    const nextTotal = subject.total - record.attended - record.missed;
    if (nextTotal < 1) {
      window.alert("This is the only class record for the subject. Delete the subject instead.");
      return;
    }
    commit({
      ...data,
      subjects: data.subjects.map((item) =>
        item.id === subject.id
          ? {
              ...item,
              attended: nextAttended,
              total: nextTotal,
              history: item.history.filter((_, index) => index !== recordIndex),
            }
          : item,
      ),
    });
  }

  function downloadCsv() {
    const content = `\uFEFF${exportCsv(data.subjects)}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "attendwise-attendance.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleCsvImport(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const subjects = importCsv(await file.text());
      if (!window.confirm(`Import ${subjects.length} subject(s)? This replaces all current subjects and history.`)) {
        return;
      }
      commit({ ...data, subjects });
    } catch (error) {
      setStorageError(`Import failed: ${error.message}`);
    }
  }

  function resetData() {
    if (!window.confirm("Reset all subjects, history, and preferences? This cannot be undone.")) return;
    const empty = createEmptyData();
    if (storageWarning && !window.confirm("The saved data was unreadable. Replace it with a clean AttendWise file?")) return;
    setStorageWarning("");
    setData(empty);
    try {
      saveData(empty);
      setStorageError("");
    } catch (error) {
      setStorageError(`Could not reset saved data: ${error.message}`);
    }
  }

  function discardCorruptedData() {
    if (!window.confirm("Replace unreadable saved data with a new empty AttendWise profile?")) return;
    const empty = createEmptyData();
    try {
      saveData(empty);
      setData(empty);
      setStorageWarning("");
      setStorageError("");
    } catch (error) {
      setStorageError(`Could not initialize storage: ${error.message}`);
    }
  }

  const title = NAV_ITEMS.find((item) => item.id === page)?.label ?? "Dashboard";

  return (
    <div className="app-shell">
      <aside id="attendwise-navigation" className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`} aria-label="Main navigation">
        <a className="brand" href="#dashboard" onClick={(event) => { event.preventDefault(); setPage("dashboard"); setMobileOpen(false); }}>
          <span className="brand-mark"><Activity size={22} strokeWidth={2.5} /></span>
          <span><strong>AttendWise</strong><small>YOUR ATTENDANCE, CLEARLY</small></span>
        </a>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="side-nav">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              className={`nav-item ${page === id ? "active" : ""}`}
              key={id}
              type="button"
              aria-current={page === id ? "page" : undefined}
              onClick={() => { setPage(id); setMobileOpen(false); }}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
              {id === "subjects" && data.subjects.length > 0 && <span className="nav-count">{data.subjects.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <div className="tip-icon"><CircleHelp size={17} /></div>
            <strong>Small steps add up.</strong>
            <p>Build a steady attendance habit, one class at a time.</p>
          </div>
          <div className="local-note"><span className="local-dot" /> Saved on this device</div>
        </div>
      </aside>
      {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}

      <div className="main-column">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            aria-controls="attendwise-navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb"><span>AttendWise</span><span className="breadcrumb-slash">/</span><strong>{title}</strong></div>
          <div className="topbar-actions">
            <button
              className="icon-button theme-toggle"
              type="button"
              aria-label={`Switch to ${data.settings.theme === "dark" ? "light" : "dark"} theme`}
              onClick={() => updateSettings({ theme: data.settings.theme === "dark" ? "light" : "dark" })}
            >
              {data.settings.theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="profile-chip" aria-label="Local student profile"><span className="avatar">S</span><span className="profile-name">Student</span><ChevronDown size={14} /></div>
          </div>
        </header>

        <main className="content-wrap">
          {storageWarning && (
            <div className="notice notice-warning" role="alert">
              <ShieldAlert size={18} />
              <div><strong>Saved data needs attention</strong><p>{storageWarning}</p></div>
              <button className="button button-small" type="button" onClick={discardCorruptedData}>Start fresh</button>
            </div>
          )}
          {storageError && <div className="notice notice-error" role="alert"><ShieldAlert size={18} /><span>{storageError}</span><button className="notice-dismiss" type="button" aria-label="Dismiss notification" onClick={() => setStorageError("")}><X size={16} /></button></div>}

          {page === "dashboard" && <Dashboard data={data} onNavigate={setPage} onAddSubject={() => setEditingSubject({})} />}
          {page === "subjects" && <SubjectsPage data={data} onAdd={() => setEditingSubject({})} onEdit={setEditingSubject} onDelete={deleteSubject} />}
          {page === "predictor" && <PredictorPage data={data} />}
          {page === "history" && <HistoryPage data={data} onRecord={addAttendanceRecord} onEdit={editHistoryRecord} onDelete={deleteHistoryRecord} />}
          {page === "portal" && <PortalPage />}
          {page === "settings" && (
            <SettingsPage
              data={data}
              onSettings={updateSettings}
              onReset={resetData}
              onExport={downloadCsv}
              onImport={() => fileInput.current?.click()}
              warning={Boolean(storageWarning)}
            />
          )}
          <input ref={fileInput} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={handleCsvImport} aria-label="Choose AttendWise CSV file" />
          <footer className="app-footer"><span>AttendWise</span><span>Private by design · Your data stays on this device</span></footer>
        </main>
      </div>
      {editingSubject && (
        <SubjectModal
          subject={editingSubject.id ? editingSubject : null}
          defaultTarget={data.settings.target}
          onClose={() => setEditingSubject(null)}
          onSave={editingSubject.id ? updateSubject : addSubject}
        />
      )}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="page-heading">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>
      {action && <div className="heading-action">{action}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  return <span className={`status-badge status-${status.toLowerCase().replaceAll(" ", "-")}`}><span className="status-dot" />{status}</span>;
}

function MetricCard({ icon: Icon, label, value, detail, tone = "blue" }) {
  return (
    <article className="metric-card">
      <div className={`metric-icon icon-${tone}`}><Icon size={19} /></div>
      <div className="metric-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </article>
  );
}

function CircularProgress({ value, target, warningMargin }) {
  const safeValue = Math.max(0, Math.min(value, 100));
  const color = value < target ? "var(--red)" : value <= target + warningMargin ? "var(--amber)" : "var(--green)";
  return (
    <div
      className="progress-ring"
      style={{ "--progress": `${safeValue}%`, "--ring-color": color }}
      role="img"
      aria-label={`Current attendance ${formatPct(value)}. Target ${formatPct(target)}.`}
    >
      <div className="progress-ring-inner"><strong>{formatPct(value)}</strong><span>current</span></div>
    </div>
  );
}

function Dashboard({ data, onNavigate, onAddSubject }) {
  const aggregate = aggregateSubjects(data.subjects);
  const current = aggregate?.percentage ?? 0;
  const target = data.settings.target;
  const status = aggregate ? attendanceStatus(aggregate.attended, aggregate.total, target, data.settings.warningMargin) : "Below Target";
  const required = aggregate ? requiredClasses(aggregate.attended, aggregate.total, target) : 0;
  const belowCount = data.subjects.filter((subject) =>
    attendanceStatus(subject.attended, subject.total, subject.target, data.settings.warningMargin) === "Below Target",
  ).length;

  return (
    <>
      <PageHeading eyebrow="YOUR STUDENT OVERVIEW" title="Good to see you." description="A clear view of your attendance, goals, and the classes ahead." action={<button className="button button-primary" type="button" onClick={onAddSubject}><Plus size={17} /> Add subject</button>} />
      {aggregate && (
        <div className={`notice ${status === "Below Target" ? "notice-error" : status === "At Risk" ? "notice-warning" : "notice-success"}`} role="status">
          {status === "Below Target" ? <ShieldAlert size={18} /> : status === "At Risk" ? <Target size={18} /> : <Check size={18} />}
          <div><strong>{status === "Below Target" ? "Your attendance is below your target." : status === "At Risk" ? "You’re close to your minimum attendance limit." : "You’re comfortably above your target."}</strong><p>{status === "Below Target" ? (required === null ? "A 100% target cannot be recovered after an absence." : `Attend the next ${required} ${required === 1 ? "class" : "classes"} to reach your target.`) : status === "At Risk" ? `Your target is ${formatPct(target)}. Try to attend your upcoming classes.` : "Keep building your consistent attendance habit."}</p></div>
        </div>
      )}
      <section className="metric-grid" aria-label="Attendance summary">
        <MetricCard icon={Activity} label="Overall attendance" value={aggregate ? formatPct(current) : "—"} detail={aggregate ? `${formatPct(target)} target` : "Add a subject to get started"} tone="blue" />
        <MetricCard icon={BookOpen} label="Classes conducted" value={aggregate?.total ?? "0"} detail="Across all subjects" tone="violet" />
        <MetricCard icon={Check} label="Classes attended" value={aggregate?.attended ?? "0"} detail="Recorded to date" tone="green" />
        <MetricCard icon={TrendingUp} label="Classes to target" value={aggregate ? (required === null ? "—" : required) : "—"} detail={aggregate ? (required === 0 ? "You’re meeting your target" : required === null ? "100% target unreachable" : "Attend consecutively") : "Waiting for attendance"} tone="cyan" />
        <MetricCard icon={ShieldAlert} label="Subjects below target" value={belowCount} detail={belowCount ? "Needs your attention" : "You’re in a good place"} tone={belowCount ? "red" : "amber"} />
      </section>

      <div className="dashboard-grid">
        <section className="panel overview-panel">
          <div className="panel-heading"><div><h2>Attendance overview</h2><p>Overall progress against your target</p></div><button className="text-button" type="button" onClick={() => onNavigate("subjects")}>View subjects <ArrowUpRight size={15} /></button></div>
          {aggregate ? (
            <div className="overview-content">
              <div className="ring-column"><CircularProgress value={current} target={target} warningMargin={data.settings.warningMargin} /><StatusBadge status={status} /><div className="target-caption"><span className="target-line" /> Target {formatPct(target)}</div></div>
              <div className="overview-stats"><div><span>Classes attended</span><strong>{aggregate.attended}<small> / {aggregate.total}</small></strong></div><div><span>Margin to target</span><strong className={current < target ? "text-red" : "text-green"}>{current >= target ? "+" : ""}{(current - target).toFixed(2)}<small> pp</small></strong></div><div><span>{current < target ? "Recovery plan" : "Safe absences"}</span><strong>{current < target ? (required === null ? "Not possible" : plural(required, "class")) : plural(safeAbsences(aggregate.attended, aggregate.total, target), "class")}</strong></div></div>
            </div>
          ) : <EmptyState icon={Activity} title="Your overview starts here" body="Add a subject to see your combined attendance and target progress." action={<button className="button button-primary" type="button" onClick={onAddSubject}><Plus size={16} /> Add your first subject</button>} />}
        </section>
        <CalculatorCard defaultTarget={target} warningMargin={data.settings.warningMargin} />
      </div>

      <section className="panel chart-panel">
        <div className="panel-heading"><div><h2>Subject comparison</h2><p>Current attendance compared with each subject target</p></div><div className="chart-legend"><span><i className="legend-current" /> Current</span><span><i className="legend-target" /> Target</span></div></div>
        {data.subjects.length ? <SubjectChart subjects={data.subjects} /> : <EmptyState icon={BookOpen} title="No subject data yet" body="Add your classes to see how you’re progressing in each one." action={<button className="text-button" type="button" onClick={() => onNavigate("subjects")}>Go to subjects <ArrowUpRight size={15} /></button>} />}
      </section>
      {data.subjects.length > 0 && <section className="panel subject-preview"><div className="panel-heading"><div><h2>Subject snapshot</h2><p>Your latest attendance by subject</p></div><button className="text-button" type="button" onClick={() => onNavigate("subjects")}>Manage subjects <ArrowUpRight size={15} /></button></div><div className="preview-list">{data.subjects.slice(0, 4).map((subject) => <SubjectRow key={subject.id} subject={subject} margin={data.settings.warningMargin} onEdit={() => onNavigate("subjects")} />)}</div></section>}
    </>
  );
}

function SubjectChart({ subjects }) {
  const rows = subjects.map((subject) => ({
    name: subject.name,
    current: currentAttendance(subject.attended, subject.total),
    target: subject.target,
  }));
  return (
    <div className="chart-wrap" role="img" aria-label={rows.map((row) => `${row.name}: ${formatPct(row.current)} attendance, ${formatPct(row.target)} target`).join("; ")}>
      <div className="chart-axis"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
      <div className="chart-rows">{rows.map((row) => <div className="chart-row" key={row.name}><span className="chart-name" title={row.name}>{row.name}</span><div className="chart-track"><div className="chart-gridline" /><div className="chart-current" style={{ width: `${row.current}%` }} /><div className="chart-target-marker" style={{ left: `${row.target}%` }} title={`Target: ${formatPct(row.target)}`} /></div><span className="chart-value">{formatPct(row.current)}</span></div>)}</div>
    </div>
  );
}

function CalculatorCard({ defaultTarget, warningMargin }) {
  const [values, setValues] = useState({ attended: "42", total: "50", target: String(defaultTarget) });
  const [result, setResult] = useState(() => calculateResult(42, 50, defaultTarget, warningMargin));
  const [error, setError] = useState("");
  useEffect(() => {
    const next = { ...values, target: String(defaultTarget) };
    setValues(next);
    try {
      setResult(calculateResult(next.attended, next.total, next.target, warningMargin));
      setError("");
    } catch (problem) {
      setResult(null);
      setError(problem.message);
    }
  }, [defaultTarget, warningMargin]);
  function update(key, value) {
    const next = { ...values, [key]: value };
    setValues(next);
    try {
      setResult(calculateResult(next.attended, next.total, next.target, warningMargin));
      setError("");
    } catch (problem) {
      setResult(null);
      setError(problem.message);
    }
  }
  return (
    <section className="panel calculator-panel">
      <div className="panel-heading"><div><h2>Quick calculator</h2><p>Try a target and get your next step</p></div><span className="soft-icon"><Target size={17} /></span></div>
      <div className="field-grid calculator-fields">
        <NumberField label="Classes attended" value={values.attended} onChange={(value) => update("attended", value)} min="0" />
        <NumberField label="Classes held" value={values.total} onChange={(value) => update("total", value)} min="1" />
      </div>
      <label className="field-label target-label" htmlFor="calc-target">Target attendance</label>
      <div className="preset-row" aria-label="Target attendance presets">{PRESETS.map((preset) => <button type="button" key={preset} className={`preset-chip ${Number(values.target) === preset ? "selected" : ""}`} aria-pressed={Number(values.target) === preset} onClick={() => update("target", String(preset))}>{preset}%</button>)}<div className="custom-target"><input id="calc-target" type="number" min="0.01" max="100" step="any" value={values.target} onChange={(event) => update("target", event.target.value)} aria-label="Custom target attendance" /><span>%</span></div></div>
      {error ? <p className="inline-error" role="alert">{error}</p> : result && <div className={`calculator-result result-${result.status.toLowerCase().replaceAll(" ", "-")}`} aria-live="polite"><div className="result-top"><StatusBadge status={result.status} /><strong>{formatPct(result.current)}</strong></div><p className="result-context">Target {formatPct(result.target)} · Margin {result.margin >= 0 ? "+" : ""}{result.margin.toFixed(2)} pp</p><p>{result.current < result.target ? result.required === null ? "A 100% target cannot be recovered after missed classes." : `Attend ${plural(result.required, "class")} in a row to meet your target.` : `You can miss ${plural(result.safeMisses, "class")} and stay at or above your target.`}</p></div>}
      <p className="form-footnote">Calculations use exact class counts. Percentages are rounded for display.</p>
    </section>
  );
}

function NumberField({ label, value, onChange, min = "0", step = "1", required = false, error }) {
  const id = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <div className="field"><label className="field-label" htmlFor={id}>{label}</label><input id={id} type="number" min={min} step={step} value={value} required={required} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => onChange(event.target.value)} />{error && <span className="field-error" id={`${id}-error`}>{error}</span>}</div>;
}

function EmptyState({ icon: Icon, title, body, action }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={22} /></div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

function SubjectRow({ subject, margin, onEdit, onDelete }) {
  const current = currentAttendance(subject.attended, subject.total);
  const status = attendanceStatus(subject.attended, subject.total, subject.target, margin);
  return (
    <div className="subject-row">
      <div className="subject-mark">{subject.name.trim().slice(0, 1).toUpperCase()}</div>
      <div className="subject-main"><strong>{subject.name}</strong><span>{subject.attended} attended of {subject.total} classes</span></div>
      <div className="subject-progress-cell"><div className="mini-progress" aria-label={`${formatPct(current)} attendance`}><span style={{ width: `${Math.min(100, current)}%` }} /></div><span>{formatPct(current)}</span></div>
      <StatusBadge status={status} />
      <div className="row-actions">{onEdit && <button className="icon-button" type="button" aria-label={`Edit ${subject.name}`} onClick={onEdit}><Edit3 size={16} /></button>}{onDelete && <button className="icon-button danger-icon" type="button" aria-label={`Delete ${subject.name}`} onClick={onDelete}><Trash2 size={16} /></button>}</div>
    </div>
  );
}

function SubjectsPage({ data, onAdd, onEdit, onDelete }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("name");
  const filtered = data.subjects
    .filter((subject) => subject.name.toLowerCase().includes(search.toLowerCase()))
    .filter((subject) => filter === "All" || attendanceStatus(subject.attended, subject.total, subject.target, data.settings.warningMargin) === filter)
    .sort((a, b) => sort === "attendance" ? currentAttendance(a.attended, a.total) - currentAttendance(b.attended, b.total) : a.name.localeCompare(b.name));

  return (
    <>
      <PageHeading eyebrow="YOUR CLASSES" title="Subjects" description="Keep track of attendance and goals for every subject." action={<button className="button button-primary" type="button" onClick={onAdd}><Plus size={17} /> Add subject</button>} />
      <section className="panel subject-list-panel">
        <div className="list-toolbar"><div className="search-field"><Search size={17} /><input type="search" placeholder="Search subjects…" aria-label="Search subjects" value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className="toolbar-actions"><label className="sr-only" htmlFor="subject-filter">Filter by status</label><select id="subject-filter" value={filter} onChange={(event) => setFilter(event.target.value)}><option>All</option><option>On Target</option><option>At Risk</option><option>Below Target</option></select><button className="button button-secondary" type="button" onClick={() => setSort(sort === "name" ? "attendance" : "name")}><ArrowDownWideNarrow size={16} /> {sort === "name" ? "Sort by attendance" : "Sort by name"}</button></div></div>
        {filtered.length ? <div className="subject-list">{filtered.map((subject) => <SubjectRow key={subject.id} subject={subject} margin={data.settings.warningMargin} onEdit={() => onEdit(subject)} onDelete={() => onDelete(subject)} />)}</div> : <EmptyState icon={search || filter !== "All" ? Search : BookOpen} title={search || filter !== "All" ? "No subjects found" : "No subjects added yet"} body={search || filter !== "All" ? "Try changing your search or filter." : "Add your subjects to start tracking attendance."} action={!search && filter === "All" && <button className="button button-primary" type="button" onClick={onAdd}><Plus size={16} /> Add a subject</button>} />}
      </section>
      <div className="helper-line"><CircleHelp size={15} /> Overall attendance is calculated from the total attended and total conducted classes, not an average of subject percentages.</div>
    </>
  );
}

function SubjectModal({ subject, defaultTarget, onClose, onSave }) {
  const [name, setName] = useState(subject?.name ?? "");
  const [attended, setAttended] = useState(String(subject?.attended ?? ""));
  const [total, setTotal] = useState(String(subject?.total ?? ""));
  const [target, setTarget] = useState(String(subject?.target ?? defaultTarget));
  const [errors, setErrors] = useState({});
  function submit(event) {
    event.preventDefault();
    const nextErrors = {};
    try {
      if (!name.trim()) throw new Error("Enter a subject name.");
      const counts = validateAttendance(attended, total);
      const validTarget = validateTarget(target);
      onSave({ name: name.trim(), ...counts, target: validTarget });
    } catch (error) {
      if (error.message === "Enter a subject name.") nextErrors.name = error.message;
      else if (error.field === "Total classes") nextErrors.total = error.message;
      else if (error.field === "Target attendance") nextErrors.target = error.message;
      else nextErrors.attended = error.message;
      setErrors(nextErrors);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="subject-modal-title" onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key === "Tab") {
          const focusable = Array.from(
            event.currentTarget.querySelectorAll(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          );
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}>
        <div className="modal-heading"><div><p className="eyebrow">{subject ? "SUBJECT DETAILS" : "GET STARTED"}</p><h2 id="subject-modal-title">{subject ? "Edit subject" : "Add a subject"}</h2></div><button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>
        <form onSubmit={submit} noValidate>
          <div className="field"><label className="field-label" htmlFor="subject-name">Subject name</label><input id="subject-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(errors.name)} />{errors.name && <span className="field-error">{errors.name}</span>}</div>
          <div className="field-grid"><NumberField label="Classes attended" value={attended} onChange={setAttended} error={errors.attended} /><NumberField label="Total classes" value={total} onChange={setTotal} min="1" error={errors.total} /></div>
          <NumberField label="Target attendance (%)" value={target} onChange={setTarget} min="0.01" step="any" error={errors.target} />
          <p className="form-footnote">Counts must be whole numbers. Your subject data is saved locally in this browser.</p>
          <div className="modal-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit"><Check size={16} /> {subject ? "Save changes" : "Add subject"}</button></div>
        </form>
      </section>
    </div>
  );
}

function PredictorPage({ data }) {
  const [subjectId, setSubjectId] = useState(data.subjects[0]?.id ?? "overall");
  const [remainingClasses, setRemainingClasses] = useState("");
  const [expectedAttendance, setExpectedAttendance] = useState("");
  const [conservativeAttendance, setConservativeAttendance] = useState("");
  const [customTarget, setCustomTarget] = useState(String(data.settings.target));
  const subject = data.subjects.find((item) => item.id === subjectId);
  const counts = subject ? { attended: subject.attended, total: subject.total, target: subject.target, name: subject.name } : aggregateSubjects(data.subjects) && { ...aggregateSubjects(data.subjects), target: data.settings.target, name: "Overall" };
  let error = "";
  let forecast = null;
  const hasScenarioInputs = [
    remainingClasses,
    expectedAttendance,
    conservativeAttendance,
  ].every((value) => value.trim() !== "");
  if (counts && hasScenarioInputs) {
    try {
      const target = validateTarget(customTarget);
      forecast = projectAttendanceScenarios(
        counts.attended,
        counts.total,
        remainingClasses,
        target,
        expectedAttendance,
        conservativeAttendance,
      );
    } catch (problem) {
      error = problem.message;
    }
  }

  return (
    <>
      <PageHeading eyebrow="PLAN AHEAD" title="Attendance predictor" description="Compare possible end-of-term outcomes using your own schedule assumptions." />
      {!counts ? <section className="panel"><EmptyState icon={TrendingUp} title="Add a subject to predict ahead" body="A prediction needs current attendance data first." /></section> : (
        <div className="predictor-grid">
          <section className="panel predictor-controls">
            <div className="panel-heading"><div><h2>Set your assumptions</h2><p>Forecasts update as you enter your estimates</p></div><span className="soft-icon"><Activity size={17} /></span></div>
            <div className="field"><label className="field-label" htmlFor="predict-subject">Attendance record</label><select id="predict-subject" value={subjectId} onChange={(event) => setSubjectId(event.target.value)}><option value="overall">Overall attendance</option>{data.subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
            <div className="field"><label className="field-label" htmlFor="predict-target">Target attendance (%)</label><input id="predict-target" type="number" min="0.01" max="100" step="any" value={customTarget} onChange={(event) => setCustomTarget(event.target.value)} /></div>
            <NumberField label="Remaining scheduled classes" value={remainingClasses} onChange={setRemainingClasses} />
            <div className="field-grid">
              <NumberField label="Expected classes to attend" value={expectedAttendance} onChange={setExpectedAttendance} />
              <NumberField label="Conservative classes to attend" value={conservativeAttendance} onChange={setConservativeAttendance} />
            </div>
            <p className="form-footnote">Use your timetable if available. These are estimates you enter, not a connected schedule.</p>
            <div className="projection-current"><span>Current for {counts.name}</span><strong>{formatPct(currentAttendance(counts.attended, counts.total))}</strong><small>{counts.attended} attended of {counts.total} classes</small></div>
          </section>
          <section className="panel projection-panel">
            <div className="panel-heading"><div><h2>Semester outlook</h2><p>Each outcome uses the same remaining class count</p></div><span className="soft-icon"><TrendingUp size={17} /></span></div>
            {error ? <div className="inline-error" role="alert">{error}</div> : forecast ? (
              <>
                <div className={`forecast-message ${forecast.reachable ? "message-positive" : "message-danger"}`} role="status">
                  <strong>{forecast.reachable ? "Your target is mathematically reachable." : "Your target is not reachable in the remaining classes."}</strong>
                  <p>{forecast.reachable ? "The best-case projection assumes attendance at every remaining class." : "Even attending every remaining class would leave you below your target."}</p>
                </div>
                <div className="twin-scenarios" aria-label="Attendance outcome comparison">
                  {forecast.scenarios.map((scenario) => (
                    <article className="twin-scenario" key={scenario.id}>
                      <div className="twin-scenario-heading">
                        <strong>{scenario.label}</strong>
                        <span className={scenario.meetsTarget ? "text-green" : "text-red"}>{formatPct(scenario.projected)}</span>
                      </div>
                      <div className="forecast-track" role="img" aria-label={`${scenario.label}: ${formatPct(scenario.projected)}, target ${formatPct(forecast.target)}`}>
                        <span className="forecast-fill" style={{ width: `${Math.max(0, Math.min(100, scenario.projected))}%` }} />
                        <i style={{ left: `${forecast.target}%` }} />
                      </div>
                      <p>Attend {scenario.attended} · miss {scenario.missed} of {forecast.remaining} classes</p>
                      <span className="twin-result">{scenario.meetsTarget ? "Meets target" : "Below target"}</span>
                    </article>
                  ))}
                </div>
                <div className="forecast-legend"><span><i className="legend-current" /> Projected</span><span><i className="legend-target" /> Target {formatPct(forecast.target)}</span></div>
                <div className="projection-formula"><span>Projection formula</span><code>(classes attended + assumed future attendance) ÷ (classes conducted + remaining scheduled classes)</code></div>
              </>
            ) : <EmptyState icon={TrendingUp} title="Enter your schedule assumptions" body="Add the remaining class count and expected attendance estimates to compare three end-of-term outcomes." />}
          </section>
        </div>
      )}
    </>
  );
}

function HistoryPage({ data, onRecord, onEdit, onDelete }) {
  const [subjectId, setSubjectId] = useState(data.subjects[0]?.id ?? "");
  const [date, setDate] = useState(localDateString());
  const [attended, setAttended] = useState("1");
  const [missed, setMissed] = useState("0");
  const [error, setError] = useState("");
  const subject = data.subjects.find((item) => item.id === subjectId);
  const running = [];
  if (subject) {
    let totalAttended = 0;
    let totalClasses = 0;
    subject.history.forEach((record) => {
      totalAttended += record.attended;
      totalClasses += record.attended + record.missed;
      running.push({ ...record, percentage: (totalAttended / totalClasses) * 100 });
    });
  }
  function submit(event) {
    event.preventDefault();
    try {
      if (!isValidIsoDate(date)) throw new Error("Enter a valid date.");
      const attendedValue = validateCount(attended, "Classes attended");
      const missedValue = validateCount(missed, "Classes missed");
      if (attendedValue + missedValue < 1) throw new Error("Record at least one attended or missed class.");
      onRecord(subjectId, { date, attended: attendedValue, missed: missedValue });
      setError("");
    } catch (problem) {
      setError(problem.message);
    }
  }
  return (
    <>
      <PageHeading eyebrow="YOUR RECORDS" title="Attendance history" description="Log classes and follow your progress over time." />
      {!data.subjects.length ? <section className="panel"><EmptyState icon={CalendarDays} title="No history yet" body="Add a subject before you start recording attendance." /></section> : <>
        <section className="panel history-entry">
          <div className="panel-heading"><div><h2>Record classes</h2><p>Each entry updates the subject’s attendance totals</p></div><span className="soft-icon"><Plus size={17} /></span></div>
          <form className="history-form" onSubmit={submit}>
            <div className="field"><label className="field-label" htmlFor="history-subject">Subject</label><select id="history-subject" value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>{data.subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
            <div className="field"><label className="field-label" htmlFor="history-date">Date</label><input id="history-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></div>
            <NumberField label="Attended" value={attended} onChange={setAttended} />
            <NumberField label="Missed" value={missed} onChange={setMissed} />
            <button className="button button-primary history-submit" type="submit"><Plus size={16} /> Record attendance</button>
          </form>
          {error && <p className="inline-error" role="alert">{error}</p>}
        </section>
        <section className="panel history-list-panel">
          <div className="panel-heading"><div><h2>Class records</h2><p>{subject ? `${subject.name} · ${subject.attended} attended of ${subject.total} total` : "Select a subject to view its records"}</p></div>{data.subjects.length > 1 && <div className="field"><label className="sr-only" htmlFor="history-subject-view">Subject history</label><select id="history-subject-view" value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>{data.subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>}</div>
          {subject?.history.length ? <div className="history-table-wrap"><table className="history-table"><thead><tr><th>Date</th><th>Attended</th><th>Missed</th><th>History attendance</th><th className="actions-head">Actions</th></tr></thead><tbody>{running.map((record, index) => <tr key={`${record.date}-${index}`}><td>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${record.date}T00:00:00Z`))}</td><td>{record.attended}</td><td>{record.missed}</td><td>{formatPct(record.percentage)}</td><td className="row-actions"><button className="icon-button" type="button" aria-label={`Edit attendance record for ${record.date}`} onClick={() => onEdit(subject, index)}><Edit3 size={15} /></button><button className="icon-button danger-icon" type="button" aria-label={`Delete attendance record for ${record.date}`} onClick={() => onDelete(subject, index)}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div> : <EmptyState icon={CalendarDays} title="No class records yet" body="Use the form above to record your first set of attended or missed classes." />}
        </section>
      </>}
    </>
  );
}

function localDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function SettingsPage({ data, onSettings, onReset, onExport, onImport, warning }) {
  const [targetDraft, setTargetDraft] = useState(String(data.settings.target));
  const [marginDraft, setMarginDraft] = useState(String(data.settings.warningMargin));
  const [targetError, setTargetError] = useState("");
  const [marginError, setMarginError] = useState("");
  useEffect(() => setTargetDraft(String(data.settings.target)), [data.settings.target]);
  useEffect(() => setMarginDraft(String(data.settings.warningMargin)), [data.settings.warningMargin]);

  function saveTargetDraft() {
    try {
      onSettings({ target: validateTarget(targetDraft) });
      setTargetError("");
    } catch (error) {
      setTargetError(error.message);
      setTargetDraft(String(data.settings.target));
    }
  }

  function saveMarginDraft() {
    const value = Number(marginDraft);
    if (!marginDraft.trim() || !Number.isFinite(value) || value < 0 || value > 100) {
      setMarginError("Warning margin must be between 0 and 100.");
      setMarginDraft(String(data.settings.warningMargin));
      return;
    }
    onSettings({ warningMargin: value });
    setMarginError("");
  }

  return (
    <>
      <PageHeading eyebrow="MAKE IT YOURS" title="Settings" description="Set your attendance preferences and manage your local data." />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="panel-heading"><div><h2>Attendance preferences</h2><p>Used as the default when creating a subject</p></div><span className="soft-icon"><Target size={17} /></span></div>
          <div className="setting-row"><label htmlFor="setting-target"><span><strong>Default target</strong><small>Attendance goal for new subjects</small></span></label><span className="setting-input"><input id="setting-target" type="number" min="0.01" max="100" step="any" value={targetDraft} aria-invalid={Boolean(targetError)} onChange={(event) => setTargetDraft(event.target.value)} onBlur={saveTargetDraft} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><b>%</b></span></div>
          {targetError && <p className="field-error" role="alert">{targetError}</p>}
          <div className="setting-row"><label htmlFor="setting-margin"><span><strong>At-risk warning margin</strong><small>Flag attendance within this many points above target</small></span></label><span className="setting-input"><input id="setting-margin" type="number" min="0" max="100" step="any" value={marginDraft} aria-invalid={Boolean(marginError)} onChange={(event) => setMarginDraft(event.target.value)} onBlur={saveMarginDraft} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><b>pp</b></span></div>
          {marginError && <p className="field-error" role="alert">{marginError}</p>}
          <p className="form-footnote">Changes save automatically. Target must be greater than 0% and no more than 100%.</p>
        </section>
        <section className="panel settings-panel">
          <div className="panel-heading"><div><h2>Appearance</h2><p>Choose how AttendWise looks on this device</p></div><span className="soft-icon">{data.settings.theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}</span></div>
          <div className="theme-options" role="group" aria-label="Color theme"><button className={`theme-option ${data.settings.theme === "dark" ? "selected" : ""}`} type="button" aria-pressed={data.settings.theme === "dark"} onClick={() => onSettings({ theme: "dark" })}><Moon size={18} /><span><strong>Dark</strong><small>Easy on the eyes</small></span>{data.settings.theme === "dark" && <Check size={16} />}</button><button className={`theme-option ${data.settings.theme === "light" ? "selected" : ""}`} type="button" aria-pressed={data.settings.theme === "light"} onClick={() => onSettings({ theme: "light" })}><Sun size={18} /><span><strong>Light</strong><small>Bright and clear</small></span>{data.settings.theme === "light" && <Check size={16} />}</button></div>
        </section>
        <section className="panel settings-panel data-panel">
          <div className="panel-heading"><div><h2>Your data</h2><p>Download a backup or import your AttendWise CSV</p></div><span className="soft-icon"><Download size={17} /></span></div>
          <div className="data-action-row"><div className="data-action-icon"><Download size={18} /></div><div><strong>Export attendance</strong><p>Download subjects and history as a CSV file.</p></div><button className="button button-secondary" type="button" onClick={onExport}><Download size={16} /> Export CSV</button></div>
          <div className="data-action-row"><div className="data-action-icon"><FileUp size={18} /></div><div><strong>Import attendance</strong><p>Validated imports replace current subjects after confirmation.</p></div><button className="button button-secondary" type="button" onClick={onImport}><FileUp size={16} /> Import CSV</button></div>
          <div className="privacy-callout"><ShieldAlert size={16} /><span>Attendance data is stored only in this browser. It is not synced to the cloud.</span></div>
        </section>
        <section className="panel settings-panel reset-panel">
          <div><h2>Reset data</h2><p>Remove all subjects, attendance history, and restore default preferences.</p></div>
          <button className="button button-danger" type="button" onClick={onReset}>{warning ? "Replace saved data" : "Reset all data"}</button>
        </section>
      </div>
    </>
  );
}

export default App;
