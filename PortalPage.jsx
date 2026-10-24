import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CalendarDays,
  Check,
  Eye,
  EyeOff,
  GraduationCap,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import { apiGet, apiPost, apiPut, getPortalSession, signIn, signOut } from "./utils/api.js";

const TODAY = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
})();

const ROLE_DETAILS = {
  student: {
    label: "Student",
    description: "Track your attendance, predict your percentage, and plan your recovery.",
    heading: "Your attendance, clearly.",
    supporting: "See your official records, understand your target, and make a plan for the classes ahead.",
    path: "/login/student",
  },
  teacher: {
    label: "Teacher",
    description: "Manage classes, mark attendance, identify at-risk students, and send alerts.",
    heading: "Lead every class with confidence.",
    supporting: "Manage your assigned subjects, record attendance securely, and support students before they fall behind.",
    path: "/login/teacher",
  },
  admin: {
    label: "Administrator",
    description: "Manage institution accounts, subjects, and attendance access.",
    heading: "Keep your institution on track.",
    supporting: "Create approved accounts, configure subjects, and oversee attendance activity from one secure portal.",
    path: "/login/admin",
  },
};

function dashboardPath(role) {
  return role === "teacher" ? "/teacher/dashboard" : role === "student" ? "/student/dashboard" : "/admin/dashboard";
}

function navigateTo(path, replace = false) {
  if (window.location.pathname !== path) {
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

function percent(value) {
  return value === null || value === undefined ? "—" : `${Number(value).toFixed(2)}%`;
}

function Panel({ title, description, children, action }) {
  return (
    <section className="panel portal-panel">
      <div className="panel-heading">
        <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <p className="portal-empty">{children}</p>;
}

export default function PortalPage() {
  const [path, setPath] = useState(window.location.pathname);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [showPassword, setShowPassword] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [users, setUsers] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestedRole = path === "/login/teacher" || path === "/teacher/dashboard"
    ? "teacher"
    : path === "/login/admin" || path === "/admin/dashboard"
      ? "admin"
      : "student";

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const refresh = useCallback(async (currentUser = user) => {
    if (!currentUser) return;
    const data = await apiGet("/api/dashboard");
    setDashboard(data);
    if (currentUser.role === "admin") {
      const accountData = await apiGet("/api/users");
      setUsers(accountData.users);
    }
    if (currentUser.role === "student") {
      const attendanceData = await apiGet("/api/attendance");
      setHistory(attendanceData.records);
    }
  }, [user]);

  useEffect(() => {
    let active = true;
    async function loadSession() {
      try {
        const currentUser = await getPortalSession();
        if (!active) return;
        setUser(currentUser);
        const destination = dashboardPath(currentUser.role);
        if (path !== destination) navigateTo(destination, true);
        const data = await apiGet("/api/dashboard");
        if (!active) return;
        setDashboard(data);
        if (currentUser.role === "admin") {
          const accountData = await apiGet("/api/users");
          if (active) setUsers(accountData.users);
        }
        if (currentUser.role === "student") {
          const attendanceData = await apiGet("/api/attendance");
          if (active) setHistory(attendanceData.records);
        }
      } catch (problem) {
        if (problem.status !== 401 && active) setError(problem.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadSession();
    return () => { active = false; };
  }, [path]);

  async function handleSignIn(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    setAuthBusy(true);
    try {
      const signedInUser = await signIn(email.trim(), password);
      if (signedInUser.role !== requestedRole) {
        await signOut();
        throw new Error(`This account is registered as ${signedInUser.role}. Use the ${signedInUser.role} sign-in.`);
      }
      setPassword("");
      await refresh(signedInUser);
      setUser(signedInUser);
      navigateTo(dashboardPath(signedInUser.role), true);
    } catch (problem) {
      setMessage("");
      setError(problem.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    setError("");
    try {
      await signOut();
      setUser(null);
      setDashboard(null);
      setUsers([]);
      setHistory([]);
      setMessage("");
      navigateTo("/", true);
    } catch (problem) {
      setError(problem.message);
    }
  }

  async function runAction(action, successMessage, after = refresh) {
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(successMessage);
      await after();
    } catch (problem) {
      setMessage("");
      setError(problem.message);
    }
  }

  if (loading) {
    return <PortalFrame><PageHeading /><section className="panel"><Empty>Checking your institution account…</Empty></section></PortalFrame>;
  }

  if (!user) {
    if (path === "/") {
      return <RoleSelection />;
    }
    return (
      <PortalFrame>
        <div className="role-login-heading">
          <button className="auth-link" type="button" onClick={() => navigateTo("/")}>← Choose a different account type</button>
        </div>
        <div className="portal-login-layout auth-layout">
          <section className="portal-welcome auth-branding">
            <div className="auth-brand-mark"><GraduationCap size={23} /></div>
            <p className="eyebrow">ATTENDWISE · {requestedRole.toUpperCase()} PORTAL</p>
            <h2>{ROLE_DETAILS[requestedRole].heading}</h2>
            <p>{ROLE_DETAILS[requestedRole].supporting}</p>
            <div className="auth-preview" aria-label="Attendance preview">
              <div className="auth-preview-top"><span>Current attendance</span><strong>84%</strong></div>
              <div className="auth-progress"><span /></div>
              <div className="auth-preview-stats"><span><strong>42/50</strong> attended</span><span className="auth-good">Above target</span></div>
            </div>
            <small className="auth-brand-footer">Built for smarter student life.</small>
          </section>
          {authMode === "login" && (
            <form className="panel portal-login auth-card" onSubmit={handleSignIn}>
              <div className="panel-heading"><div><p className="eyebrow">{requestedRole.toUpperCase()} SIGN IN</p><h2>Welcome back</h2><p>Sign in to continue to your {requestedRole} dashboard.</p></div><span className="soft-icon">{requestedRole === "teacher" ? <Users size={17} /> : <GraduationCap size={17} />}</span></div>
              <label className="field"><span className="field-label">Institution email or approved identifier</span><span className="auth-input-wrap"><Mail size={15} /><input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></span></label>
              <label className="field"><span className="field-label">Password</span><span className="auth-input-wrap"><LockKeyhole size={15} /><input type={showPassword ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /><button className="auth-visibility" type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></span></label>
              <div className="auth-options"><span /><button className="text-button" type="button" onClick={() => { setAuthMode("forgot"); setError(""); setMessage(""); }}>Forgot password?</button></div>
              {error && <p className="inline-error" role="alert">{error}</p>}
              <button className="button button-primary portal-submit" type="submit" disabled={authBusy}>{authBusy ? "Signing in…" : <><LogIn size={16} /> Sign in</>}</button>
              <div className="auth-divider"><span>ACCOUNT ACCESS</span></div>
              <p className="form-footnote">Accounts are created by your institution administrator.</p>
              <button className="auth-link" type="button" onClick={() => { setAuthMode("signup"); setError(""); setMessage(""); }}>Need an account? Learn how to get access</button>
            </form>
          )}
          {authMode === "signup" && (
            <section className="panel portal-login auth-card">
              <div className="panel-heading"><div><h2>Create your access</h2><p>AttendWise institution accounts are managed securely by administrators.</p></div><span className="soft-icon"><ShieldCheck size={17} /></span></div>
              <div className="auth-info"><ShieldCheck size={18} /><p>Public registration is disabled so student and teacher records remain connected to the correct institution.</p></div>
              <ol className="auth-steps"><li>Contact your institution administrator.</li><li>They create your student or teacher account.</li><li>Return here and sign in with the provided credentials.</li></ol>
              <button className="button button-primary portal-submit" type="button" onClick={() => setAuthMode("login")}><LogIn size={16} /> Back to sign in</button>
            </section>
          )}
          {authMode === "forgot" && (
            <section className="panel portal-login auth-card">
              <div className="panel-heading"><div><h2>Reset your password</h2><p>Password resets are handled by your institution administrator.</p></div><span className="soft-icon"><LockKeyhole size={17} /></span></div>
              <div className="auth-info"><Mail size={18} /><p>No reset email is sent because this local deployment has no email provider configured. Ask an administrator to issue a new temporary password.</p></div>
              <button className="button button-primary portal-submit" type="button" onClick={() => setAuthMode("login")}><LogIn size={16} /> Back to sign in</button>
            </section>
          )}
        </div>
      </PortalFrame>
    );
  }

  return (
    <PortalFrame>
      <div className="portal-heading-row">
        <PageHeading user={user} />
        <div className="portal-account-actions"><span className="portal-role-label">{user.role === "teacher" ? "Teacher Portal" : user.role === "student" ? "Student Portal" : "Admin Portal"}</span><button className="button button-secondary" type="button" onClick={handleSignOut}><LogOut size={16} /> Sign out</button></div>
      </div>
      {error && <div className="notice notice-error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
      {message && <div className="notice notice-success" role="status"><Check size={18} /><span>{message}</span></div>}
      {dashboard && user.role === "student" && <StudentDashboard dashboard={dashboard} history={history} refresh={() => refresh(user)} runAction={runAction} />}
      {dashboard && user.role === "teacher" && <TeacherDashboard dashboard={dashboard} runAction={runAction} />}
      {dashboard && user.role === "admin" && <AdminDashboard dashboard={dashboard} users={users} runAction={runAction} refresh={() => refresh(user)} />}
    </PortalFrame>
  );
}

function PortalFrame({ children }) {
  return <div className="portal-route-shell"><main className="portal-route-content">{children}</main></div>;
}

function RoleSelection() {
  return (
    <PortalFrame>
      <section className="role-selection" aria-labelledby="role-selection-title">
        <div className="role-selection-brand">
          <span className="auth-brand-mark"><Activity size={23} strokeWidth={2.5} /></span>
          <span><strong>AttendWise</strong><small>ATTEND SMART. STAY ON TRACK.</small></span>
        </div>
        <p className="eyebrow">INSTITUTION PORTAL</p>
        <h1 id="role-selection-title">How would you like to sign in?</h1>
        <p className="role-selection-intro">Choose the experience that matches your institution account.</p>
        <div className="role-card-grid">
          {Object.entries(ROLE_DETAILS).map(([id, details]) => (
            <button className="role-card" type="button" key={id} onClick={() => {
              sessionStorage.setItem("attendwise.selectedRole", id);
              navigateTo(details.path);
            }}>
              <span className="role-card-icon">{id === "student" ? <GraduationCap size={25} /> : id === "teacher" ? <Users size={25} /> : <ShieldCheck size={25} />}</span>
              <span className="role-card-copy"><strong>{details.label}</strong><span>{details.description}</span></span>
              <span className="role-card-arrow" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
        <p className="role-selection-note"><ShieldCheck size={15} /> Your role is verified by your institution account after sign-in.</p>
      </section>
    </PortalFrame>
  );
}

function PageHeading({ user }) {
  return (
    <div className="page-heading portal-page-heading">
      <div>
        <p className="eyebrow">ATTENDWISE · INSTITUTION PORTAL</p>
        <h1>{user ? `Welcome, ${user.displayName}.` : "School attendance portal"}</h1>
        <p className="page-description">{user ? `${user.role[0].toUpperCase()}${user.role.slice(1)} account · ${user.email}` : "Sign in to access your institution-managed attendance records."}</p>
      </div>
    </div>
  );
}

function StudentDashboard({ dashboard, history, refresh, runAction }) {
  const overall = dashboard.overall;
  const belowTarget = dashboard.subjects.filter((subject) => subject.percentage !== null && subject.percentage < subject.target).length;
  return (
    <>
      <section className="metric-grid portal-metrics" aria-label="Institution attendance summary">
        <Metric icon={Activity} label="Overall attendance" value={percent(overall.percentage)} detail={`${overall.attended} attended of ${overall.total}`} />
        <Metric icon={BookOpen} label="Classes conducted" value={overall.total} detail={`${overall.attended} attended`} />
        <Metric icon={AlertTriangle} label="Classes missed" value={Math.max(0, overall.total - overall.attended)} detail="Official submitted records" />
        <Metric icon={AlertTriangle} label="Below target" value={belowTarget} detail={belowTarget ? "Review the subjects below" : "All subjects at target"} />
      </section>
      <Panel title="Subject attendance" description="Calculated from submitted class sessions">
        {dashboard.subjects.length ? <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Subject</th><th>Attended</th><th>Classes</th><th>Current</th><th>Target</th><th>Recovery</th></tr></thead><tbody>
          {dashboard.subjects.map((subject) => <tr key={subject.id}><td><strong>{subject.name}</strong><small>{subject.code}</small></td><td>{subject.attended ?? 0}</td><td>{subject.total ?? 0}</td><td>{percent(subject.percentage)}</td><td>{percent(subject.target)}</td><td>{subject.required === null ? "Not reachable at 100%" : subject.required ? `${subject.required} consecutive` : "On target"}</td></tr>)}
        </tbody></table></div> : <Empty>No subjects have been assigned to your account yet.</Empty>}
      </Panel>
      <Panel title="Recent attendance" description="Official records submitted by your teachers">
        {history.length ? <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Date</th><th>Subject</th><th>Session</th><th>Status</th><th>Recorded by</th></tr></thead><tbody>
          {history.slice(0, 12).map((record) => <tr key={record.id}><td>{record.date}</td><td>{record.subject}</td><td>{record.session}</td><td><span className={`portal-status portal-status-${record.status.toLowerCase()}`}>{record.status}</span></td><td>{record.recorded_by}</td></tr>)}
        </tbody></table></div> : <Empty>No submitted attendance records yet.</Empty>}
      </Panel>
      <Panel title="Notifications" description="In-app attendance alerts">
        {dashboard.notifications.length ? <div className="portal-notifications">{dashboard.notifications.map((notification) => <article key={notification.id} className={`portal-notification ${notification.read_at ? "" : "unread"}`}><div><strong>{notification.subject ?? "AttendWise alert"}</strong><p>{notification.message}</p><small>{notification.created_at}</small></div>{!notification.read_at && <button className="button button-secondary button-compact" type="button" onClick={() => runAction(() => apiPost(`/api/notifications/${notification.id}/read`, {}), "Notification marked as read.", refresh)}>Mark read</button>}</article>)}</div> : <Empty>You have no notifications.</Empty>}
      </Panel>
    </>
  );
}

function Metric({ icon: Icon, label, value, detail }) {
  return <article className="metric-card"><div className="metric-icon icon-blue"><Icon size={19} /></div><div className="metric-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>;
}

function TeacherDashboard({ dashboard, runAction }) {
  const [subjectId, setSubjectId] = useState("");
  const [roster, setRoster] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [rosterError, setRosterError] = useState("");
  const [sessionDate, setSessionDate] = useState(TODAY);
  const [sessionLabel, setSessionLabel] = useState("Class");
  const [sessionId, setSessionId] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!subjectId) {
      setRoster([]);
      setStatuses({});
      setRosterError("");
      return;
    }
    let active = true;
    setRosterError("");
    apiGet(`/api/subjects/${subjectId}/students`)
      .then((data) => {
        if (!active) return;
        setRoster(data.students);
        setStatuses(Object.fromEntries(data.students.map((student) => [student.id, ""])));
        setSessionId(null);
      })
      .catch((problem) => {
        if (active) {
          setRoster([]);
          setRosterError(problem.message);
        }
      });
    return () => { active = false; };
  }, [subjectId]);

  async function createSession(event) {
    event.preventDefault();
    if (!subjectId) return;
    await runAction(async () => {
      const data = await apiPost("/api/sessions", {
        subjectId: Number(subjectId),
        date: sessionDate,
        label: sessionLabel,
      });
      setSessionId(data.id);
      setStatuses(Object.fromEntries(roster.map((student) => [student.id, ""])));
    }, "Attendance session created.");
  }

  async function submitAttendance() {
    if (!sessionId || !roster.length || roster.some((student) => !statuses[student.id])) return;
    if (!window.confirm(`Submit attendance for all ${roster.length} enrolled students? Submitted records cannot be changed here.`)) return;
    setSaving(true);
    await runAction(
      () => apiPut(`/api/sessions/${sessionId}/attendance`, {
        records: roster.map((student) => ({ studentId: student.id, status: statuses[student.id] })),
      }).then(() => {
        setSessionId(null);
        setRoster([]);
        setStatuses({});
      }),
      "Attendance submitted and recorded.",
    );
    setSaving(false);
  }

  return (
    <>
      <section className="metric-grid portal-metrics">
        <Metric icon={BookOpen} label="Assigned subjects" value={dashboard.subjects.length} detail="Only classes assigned to you" />
        <Metric icon={Users} label="Enrolled students" value={dashboard.enrolledStudents} detail="Across assigned subjects" />
        <Metric icon={CalendarDays} label="Awaiting attendance" value={dashboard.awaitingAttendance} detail="Sessions not submitted" />
        <Metric icon={AlertTriangle} label="At-risk students" value={dashboard.alerts.length} detail="Below subject target" />
      </section>
      <Panel title="Attendance alerts" description="Students enrolled in your assigned subjects who are below target">
        {dashboard.alerts.length ? <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Student</th><th>Subject</th><th>Attended</th><th>Current</th><th>Target</th><th>Recovery</th></tr></thead><tbody>
          {dashboard.alerts.map((alert) => <tr key={`${alert.student_id}-${alert.subject_id}`}><td>{alert.student_name}</td><td>{alert.subject}</td><td>{alert.attended} / {alert.total}</td><td><span className="portal-status portal-status-absent">{percent(alert.percentage)}</span></td><td>{percent(alert.target)}</td><td>{alert.required === null ? "Not reachable" : `${alert.required} classes`}</td></tr>)}
        </tbody></table></div> : <Empty>No students are currently below target in your assigned subjects.</Empty>}
      </Panel>
      <Panel title="Recent attendance sessions" description="Sessions for your assigned subjects">
        {dashboard.recentSessions?.length ? <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Date</th><th>Subject</th><th>Session</th><th>Status</th></tr></thead><tbody>
          {dashboard.recentSessions.map((session) => <tr key={session.id}><td>{session.session_date}</td><td>{session.subject}<small>{session.code}</small></td><td>{session.label}</td><td><span className={`portal-status ${session.submitted_at ? "portal-status-present" : "portal-status-late"}`}>{session.submitted_at ? "Submitted" : "Awaiting attendance"}</span></td></tr>)}
        </tbody></table></div> : <Empty>No attendance sessions have been created for your assigned subjects.</Empty>}
      </Panel>
      <Panel title="Mark attendance" description="Create a session and submit one status for every enrolled student" action={<span className="soft-icon"><Check size={17} /></span>}>
        {!dashboard.subjects.length ? <Empty>No subjects have been assigned to your teacher account.</Empty> : (
          <>
            <form className="portal-session-form" onSubmit={createSession}>
              <label className="field"><span className="field-label">Subject</span><select required value={subjectId} onChange={(event) => { setSubjectId(event.target.value); setSessionId(null); }}><option value="">Choose a subject</option>{dashboard.subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name} · {subject.code}</option>)}</select></label>
              <label className="field"><span className="field-label">Date</span><input type="date" required value={sessionDate} onChange={(event) => setSessionDate(event.target.value)} /></label>
              <label className="field"><span className="field-label">Session label</span><input maxLength="80" required value={sessionLabel} onChange={(event) => setSessionLabel(event.target.value)} /></label>
              <button className="button button-secondary portal-session-action" type="submit"><Plus size={16} /> Create session</button>
            </form>
            {subjectId && <div className="portal-roster">
              {rosterError ? <p className="inline-error" role="alert">{rosterError}</p> : roster.length ? <>
                {roster.map((student) => <label className="portal-roster-row" key={student.id}><span><strong>{student.display_name}</strong><small>{student.username}</small></span><select aria-label={`Attendance for ${student.display_name}`} value={statuses[student.id] ?? ""} onChange={(event) => setStatuses((current) => ({ ...current, [student.id]: event.target.value }))}><option value="">Select status</option><option>Present</option><option>Absent</option><option>Late</option></select></label>)}
                {sessionId && <button className="button button-primary" type="button" disabled={saving || roster.some((student) => !statuses[student.id])} onClick={submitAttendance}><Check size={16} /> Submit attendance</button>}
              </> : <Empty>{sessionId ? "No active students are enrolled in this subject." : "Create a session to load its enrolled student roster."}</Empty>}
            </div>}
          </>
        )}
      </Panel>
    </>
  );
}

function AdminDashboard({ dashboard, users, runAction, refresh }) {
  const [account, setAccount] = useState({ displayName: "", username: "", email: "", password: "", role: "student" });
  const [subject, setSubject] = useState({ name: "", code: "", target: "75" });
  const [assignment, setAssignment] = useState({ userId: "", subjectId: "", role: "student" });

  async function createAccount(event) {
    event.preventDefault();
    await runAction(async () => {
      await apiPost("/api/users", { ...account, password: account.password });
      setAccount({ displayName: "", username: "", email: "", password: "", role: "student" });
    }, "Account created.", refresh);
  }

  async function createSubject(event) {
    event.preventDefault();
    await runAction(async () => {
      await apiPost("/api/subjects", { ...subject, target: Number(subject.target) });
      setSubject({ name: "", code: "", target: "75" });
    }, "Subject created.", refresh);
  }

  async function assignUser(event) {
    event.preventDefault();
    const path = assignment.role === "teacher" ? "teachers" : "enrollments";
    await runAction(() => apiPost(`/api/subjects/${assignment.subjectId}/${path}`, { userId: Number(assignment.userId) }), "Subject assignment saved.", refresh);
  }

  return (
    <>
      <section className="metric-grid portal-metrics">
        <Metric icon={Users} label="Active students" value={dashboard.students} detail="In this institution" />
        <Metric icon={Users} label="Active teachers" value={dashboard.teachers} detail="In this institution" />
        <Metric icon={BookOpen} label="Subjects" value={dashboard.subjects.length} detail="Institution catalogue" />
      </section>
      <div className="portal-admin-grid">
        <Panel title="Create account" description="Institution accounts only; no public registration">
          <form className="portal-form" onSubmit={createAccount}>
            <label className="field"><span className="field-label">Display name</span><input required maxLength="100" value={account.displayName} onChange={(event) => setAccount({ ...account, displayName: event.target.value })} /></label>
            <label className="field"><span className="field-label">Username</span><input required minLength="3" maxLength="40" value={account.username} onChange={(event) => setAccount({ ...account, username: event.target.value })} /></label>
            <label className="field"><span className="field-label">Email</span><input type="email" required value={account.email} onChange={(event) => setAccount({ ...account, email: event.target.value })} /></label>
            <label className="field"><span className="field-label">Temporary password (12+ characters)</span><input type="password" autoComplete="new-password" minLength="12" required value={account.password} onChange={(event) => setAccount({ ...account, password: event.target.value })} /></label>
            <label className="field"><span className="field-label">Role</span><select value={account.role} onChange={(event) => setAccount({ ...account, role: event.target.value })}><option value="student">Student</option><option value="teacher">Teacher</option></select></label>
            <button className="button button-primary" type="submit"><Plus size={16} /> Create account</button>
          </form>
        </Panel>
        <Panel title="Create subject" description="Set the attendance target for this subject">
          <form className="portal-form" onSubmit={createSubject}>
            <label className="field"><span className="field-label">Subject name</span><input required maxLength="120" value={subject.name} onChange={(event) => setSubject({ ...subject, name: event.target.value })} /></label>
            <label className="field"><span className="field-label">Subject code</span><input required maxLength="30" value={subject.code} onChange={(event) => setSubject({ ...subject, code: event.target.value })} /></label>
            <label className="field"><span className="field-label">Minimum attendance (%)</span><input type="number" min="0.01" max="100" step="any" required value={subject.target} onChange={(event) => setSubject({ ...subject, target: event.target.value })} /></label>
            <button className="button button-primary" type="submit"><Plus size={16} /> Create subject</button>
          </form>
        </Panel>
        <Panel title="Enroll or assign" description="Connect institution users to a subject">
          {!users.length || !dashboard.subjects.length ? <Empty>Create at least one user and one subject first.</Empty> : <form className="portal-form" onSubmit={assignUser}>
            <label className="field"><span className="field-label">User type</span><select value={assignment.role} onChange={(event) => setAssignment({ ...assignment, role: event.target.value, userId: "" })}><option value="student">Student enrollment</option><option value="teacher">Teacher assignment</option></select></label>
            <label className="field"><span className="field-label">User</span><select required value={assignment.userId} onChange={(event) => setAssignment({ ...assignment, userId: event.target.value })}><option value="">Choose a user</option>{users.filter((item) => item.role === assignment.role).map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.email}</option>)}</select></label>
            <label className="field"><span className="field-label">Subject</span><select required value={assignment.subjectId} onChange={(event) => setAssignment({ ...assignment, subjectId: event.target.value })}><option value="">Choose a subject</option>{dashboard.subjects.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}</select></label>
            <button className="button button-primary" type="submit"><Check size={16} /> Save assignment</button>
          </form>}
        </Panel>
        <Panel title="Institution subjects" description="Attendance threshold by subject">
          {dashboard.subjects.length ? <div className="portal-table-wrap"><table className="portal-table"><thead><tr><th>Subject</th><th>Code</th><th>Target</th></tr></thead><tbody>{dashboard.subjects.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.code}</td><td>{percent(item.target)}</td></tr>)}</tbody></table></div> : <Empty>No subjects configured.</Empty>}
        </Panel>
      </div>
    </>
  );
}
