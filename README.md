# AttendWise

AttendWise is a responsive React/Vite attendance tracker with a Python/SQLite institution portal. The original browser-local tracker remains available; institution accounts use the backend API and are kept separate from local browser data. The app is in this folder and does not replace the portfolio in the parent folder.

## Requirements

- Python 3.11 or newer
- Node.js 22.12 or newer (or Node.js 24 or newer)
- npm

## Run the institution portal locally

From this directory, create the first administrator account. You will be prompted to enter and confirm a password; passwords must be at least 12 characters.

```bash
python -m server.main --create-admin admin@example.edu
```

If you forget an account password, reset it locally without changing the email:

```bash
python -m server.main --reset-password admin@example.edu
```

Enter and confirm a new password of at least 12 characters when prompted. This also signs that account out of any existing sessions.

Start the backend API in a terminal:

```bash
python -m server.main
```

In another terminal, start the React app. On Windows PowerShell, use `npm.cmd` if PowerShell blocks `npm.ps1`:

```bash
npm.cmd install
npm.cmd run dev
```

On macOS/Linux, the equivalent commands are `npm install` and `npm run dev`.

Open the local URL printed by Vite. Vite proxies `/api` requests to the API at `http://127.0.0.1:8000`. The VS Code task **AttendWise Platform** starts both servers; **AttendWise Backend Tests** runs the Python backend tests.

The application opens at `/` with a role-selection screen. Student, teacher, and administrator sign-in are separate at `/login/student`, `/login/teacher`, and `/login/admin`; verified sessions redirect to `/student/dashboard`, `/teacher/dashboard`, or `/admin/dashboard`. The selected card only controls the login presentation—the backend session role remains authoritative. The original browser-local tracker is still available on non-portal routes.

Keep both the backend and Vite processes running while using the Institution Portal. If the portal shows a network error, verify `http://127.0.0.1:8000/api/health` returns `{"status":"ok"}` and restart the backend if necessary.

To create and preview a production frontend build:

```bash
npm.cmd run build
npm.cmd run preview
```

The Python API reads configuration from environment variables; `.env.example` lists the supported names. Python does not automatically read that file. The database defaults to `server/data/attendwise.sqlite3` and is excluded from version control.

Create institution users, subjects, and assignments by signing into the Institution Portal as an administrator. Login is email-based and email addresses must be unique across institutions. Teacher and student accounts can only be created by an administrator.

The portal sign-in screen includes role selection, password visibility, loading feedback, and honest access/reset guidance. Public registration and email password resets are intentionally disabled because institution accounts are administrator-managed; use the administrator's **Create account** form to provision student and teacher accounts.

## Tests

Run the existing React utility tests:

```bash
npm test
```

Run the Python calculation and API tests:

```bash
python -m unittest server.test_attendance server.test_api -v
```

The Python API tests use temporary SQLite databases and do not send email or SMS.

## Features

- Weighted overall and per-subject attendance, recovery class and safe absence calculations
- Semester outlook comparing best-case, expected, and conservative attendance scenarios using a user-entered remaining-class estimate
- Attendance scenario validation and target-reachability calculations
- Separate local tracker and institution-managed portal
- Institution-scoped student, teacher, and administrator accounts
- HTTP-only, SameSite session cookies, CSRF-protected writes, password hashing, login throttling, and server-side role checks
- Admin account and subject provisioning, student enrollment, and teacher-subject assignments
- Teacher attendance sessions with complete-roster validation, transaction-safe submission, and audit records
- Student dashboards and history, teacher low-attendance alerts, and cooldown-limited in-app notifications
- Subject search, status filters, sorting, editing, and deletion
- Attendance history with running historical percentage
- Configurable target, warning margin, and light/dark themes
- Browser-local persistence, validated CSV import/export, and confirmed reset
- Responsive navigation, keyboard focus indicators, semantic labels, and non-color status text
- A built-in quick calculator with 65%, 70%, 75%, 80%, 85%, and 90% target presets

The local tracker saves information in this browser's LocalStorage. Institution data is stored in the local SQLite database. In this initial backend phase, `Present` and `Late` both count as attended, and each subject has a configurable target that defaults to 75%.

## Backend scope and deployment limitations

The backend currently supports student, teacher, and administrator login; institution-scoped users and subjects; enrollments and teacher assignments; attendance sessions and records; student dashboards and history; teacher alerts; in-app low-attendance notifications; and audit entries for administrative and attendance actions.

Parent accounts, password reset, correction requests, timetable management, configurable risk bands, scheduled notification jobs, email/SMS providers, and production deployment hardening are not implemented. In particular, Python's built-in HTTP server is intended for local development only. Keep the API bound to `127.0.0.1`; do not expose it directly to the internet. A production deployment needs a production-grade ASGI/WSGI server, HTTPS, secure secret/session operations, operational monitoring, and deployment-specific security review. Set `ATTENDWISE_COOKIE_SECURE=true` only when the browser reaches the API through HTTPS.