import json
import os
import re
import secrets
import sqlite3
import time
from datetime import date
from http import HTTPStatus
from http.cookies import CookieError
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .attendance import AttendanceInputError, current_percentage, required_classes, validate_target
from .database import audit, connect
from .security import (
    hash_password,
    hash_session_token,
    new_session_token,
    validate_password,
    verify_password,
)


SESSION_SECONDS = 8 * 60 * 60
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_ATTEMPTS = 5
MAX_BODY_BYTES = 1_000_000
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,40}$")
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ApiError(Exception):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status


class AttendWiseServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], database_path: str | Path) -> None:
        super().__init__(address, AttendWiseHandler)
        self.database_path = Path(database_path)
        self.login_attempts: dict[str, list[float]] = {}
        self.secure_cookie = os.environ.get("ATTENDWISE_COOKIE_SECURE", "").lower() in {
            "1",
            "true",
            "yes",
        }


class AttendWiseHandler(BaseHTTPRequestHandler):
    server: AttendWiseServer

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def _dispatch(self, method: str) -> None:
        try:
            path = urlsplit(self.path)
            if method == "GET" and path.path == "/api/health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
                return
            if method == "POST" and path.path == "/api/auth/login":
                self._login()
                return

            write = method != "GET"
            user, csrf_token = self._authenticate(write=write)
            if method == "GET" and path.path == "/api/auth/me":
                self._send_json(HTTPStatus.OK, {"user": self._public_user(user), "csrfToken": csrf_token})
                return
            if method == "POST" and path.path == "/api/auth/logout":
                self._logout(user)
                return
            if method == "GET" and path.path == "/api/dashboard":
                self._send_json(HTTPStatus.OK, self._dashboard(user))
                return
            if method == "GET" and path.path == "/api/subjects":
                self._send_json(HTTPStatus.OK, {"subjects": self._subjects(user)})
                return
            if method == "POST" and path.path == "/api/subjects":
                self._create_subject(user)
                return
            if method == "GET" and path.path == "/api/users":
                self._send_json(HTTPStatus.OK, {"users": self._users(user, parse_qs(path.query))})
                return
            if method == "POST" and path.path == "/api/users":
                self._create_user(user)
                return
            assignment_match = re.fullmatch(r"/api/subjects/(\d+)/(teachers|enrollments)", path.path)
            if method == "POST" and assignment_match:
                self._assign_relationship(
                    user,
                    int(assignment_match.group(1)),
                    assignment_match.group(2),
                )
                return
            roster_match = re.fullmatch(r"/api/subjects/(\d+)/students", path.path)
            if method == "GET" and roster_match:
                self._send_json(
                    HTTPStatus.OK,
                    {"students": self._roster(user, int(roster_match.group(1)))},
                )
                return
            if method == "GET" and path.path == "/api/sessions":
                self._send_json(
                    HTTPStatus.OK,
                    {"sessions": self._sessions(user, parse_qs(path.query))},
                )
                return
            if method == "POST" and path.path == "/api/sessions":
                self._create_session(user)
                return
            attendance_match = re.fullmatch(r"/api/sessions/(\d+)/attendance", path.path)
            if method == "PUT" and attendance_match:
                self._submit_attendance(user, int(attendance_match.group(1)))
                return
            if method == "GET" and path.path == "/api/attendance":
                self._send_json(HTTPStatus.OK, {"records": self._attendance(user, parse_qs(path.query))})
                return
            if method == "GET" and path.path == "/api/alerts":
                self._send_json(HTTPStatus.OK, {"alerts": self._alerts(user)})
                return
            if method == "GET" and path.path == "/api/notifications":
                self._send_json(HTTPStatus.OK, {"notifications": self._notifications(user)})
                return
            notification_match = re.fullmatch(r"/api/notifications/(\d+)/read", path.path)
            if method == "POST" and notification_match:
                self._mark_notification_read(user, int(notification_match.group(1)))
                return
            raise ApiError(HTTPStatus.NOT_FOUND, "Endpoint not found.")
        except ApiError as error:
            self._send_json(error.status, {"error": str(error)})
        except AttendanceInputError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except sqlite3.IntegrityError:
            self._send_json(HTTPStatus.CONFLICT, {"error": "The requested record conflicts with existing data."})
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Request body must be valid JSON."})
        except (UnicodeDecodeError, ValueError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def _send_json(self, status: HTTPStatus, payload: dict[str, object], cookie: str | None = None) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, object]:
        if self.headers.get_content_type() != "application/json":
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length is invalid.") from error
        if length < 1 or length > MAX_BODY_BYTES:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body is empty or too large.")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object.")
        return payload

    def _cookie_token(self) -> str:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError as error:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "Sign in to continue.") from error
        morsel = cookie.get("attendwise_session")
        return morsel.value if morsel else ""

    def _authenticate(self, write: bool = False) -> tuple[sqlite3.Row, str]:
        token = self._cookie_token()
        if not token:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "Sign in to continue.")
        now = int(time.time())
        with connect(self.server.database_path) as connection:
            session = connection.execute(
                """
                SELECT s.csrf_token, u.*
                FROM auth_sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
                """,
                (hash_session_token(token), now),
            ).fetchone()
        if session is None:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "Your session has expired. Sign in again.")
        if write and not secrets.compare_digest(
            self.headers.get("X-CSRF-Token", ""), session["csrf_token"]
        ):
            raise ApiError(HTTPStatus.FORBIDDEN, "CSRF validation failed.")
        return session, session["csrf_token"]

    @staticmethod
    def _public_user(user: sqlite3.Row) -> dict[str, object]:
        return {
            "id": user["id"],
            "email": user["email"],
            "username": user["username"],
            "displayName": user["display_name"],
            "role": user["role"],
            "institutionId": user["institution_id"],
        }

    def _login(self) -> None:
        client = self.client_address[0]
        now = time.time()
        attempts = [
            attempt
            for attempt in self.server.login_attempts.get(client, [])
            if now - attempt < LOGIN_WINDOW_SECONDS
        ]
        if len(attempts) >= LOGIN_MAX_ATTEMPTS:
            self.server.login_attempts[client] = attempts
            raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, "Too many sign-in attempts. Try again later.")
        self.server.login_attempts[client] = attempts

        payload = self._read_json()
        email = payload.get("email")
        password = payload.get("password")
        if not isinstance(email, str) or not isinstance(password, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Email and password are required.")
        if len(email) > 254 or len(password) > 1024:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Email or password exceeds the allowed length.")
        with connect(self.server.database_path) as connection:
            user = connection.execute(
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
                (email.strip().lower(),),
            ).fetchone()
        if user is None or not user["active"] or not verify_password(password, user["password_hash"]):
            attempts.append(now)
            self.server.login_attempts[client] = attempts
            raise ApiError(HTTPStatus.UNAUTHORIZED, "Email or password is incorrect.")

        self.server.login_attempts.pop(client, None)
        token = new_session_token()
        csrf_token = secrets.token_urlsafe(32)
        expires = int(now) + SESSION_SECONDS
        with connect(self.server.database_path) as connection:
            connection.execute(
                "INSERT INTO auth_sessions(token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)",
                (hash_session_token(token), user["id"], csrf_token, expires),
            )
        attributes = [
            f"attendwise_session={token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Strict",
            f"Max-Age={SESSION_SECONDS}",
        ]
        if self.server.secure_cookie:
            attributes.append("Secure")
        self._send_json(
            HTTPStatus.OK,
            {"user": self._public_user(user)},
            "; ".join(attributes),
        )

    def _logout(self, user: sqlite3.Row) -> None:
        token = self._cookie_token()
        with connect(self.server.database_path) as connection:
            connection.execute(
                "DELETE FROM auth_sessions WHERE token_hash = ?",
                (hash_session_token(token),),
            )
        self._send_json(
            HTTPStatus.OK,
            {"status": "signed_out"},
            "attendwise_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
            + ("; Secure" if self.server.secure_cookie else ""),
        )

    def _require_role(self, user: sqlite3.Row, *roles: str) -> None:
        if user["role"] not in roles:
            raise ApiError(HTTPStatus.FORBIDDEN, "You do not have permission to perform this action.")

    def _create_user(self, actor: sqlite3.Row) -> None:
        self._require_role(actor, "admin")
        payload = self._read_json()
        email = payload.get("email")
        username = payload.get("username")
        password = payload.get("password")
        role = payload.get("role")
        display_name = payload.get("displayName")
        if not all(isinstance(value, str) for value in (email, username, password, role, display_name)):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Email, username, password, role and display name are required.")
        email = email.strip().lower()
        username = username.strip()
        display_name = display_name.strip()
        if len(email) > 254 or not EMAIL_PATTERN.fullmatch(email):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Enter a valid email address.")
        if not USERNAME_PATTERN.fullmatch(username):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Username must be 3-40 letters, numbers, dots, dashes or underscores.")
        if not display_name or len(display_name) > 100:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Display name must be between 1 and 100 characters.")
        if role not in ("teacher", "student"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "New accounts must have the teacher or student role.")
        validate_password(password)
        if len(password) > 1024:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Password must not exceed 1024 characters.")
        password_hash = hash_password(password)
        with connect(self.server.database_path) as connection:
            connection.execute(
                """
                INSERT INTO users
                    (institution_id, email, username, display_name, role, password_hash)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (actor["institution_id"], email, username, display_name, role, password_hash),
            )
            user_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]
            audit(connection, actor["institution_id"], actor["id"], "user.created", "user", user_id, {"role": role})
            created = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        self._send_json(HTTPStatus.CREATED, {"user": self._public_user(created)})

    def _users(self, actor: sqlite3.Row, query: dict[str, list[str]]) -> list[dict[str, object]]:
        self._require_role(actor, "admin")
        role = query.get("role", [None])[0]
        parameters: list[object] = [actor["institution_id"]]
        role_clause = ""
        if role is not None:
            if role not in ("admin", "teacher", "student", "parent"):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Unknown user role.")
            role_clause = "AND role = ?"
            parameters.append(role)
        with connect(self.server.database_path) as connection:
            rows = connection.execute(
                f"""
                SELECT id, email, username, display_name, role, active
                FROM users WHERE institution_id = ? {role_clause}
                ORDER BY role, display_name LIMIT 1000
                """,
                parameters,
            ).fetchall()
        return [
            {
                "id": row["id"],
                "email": row["email"],
                "username": row["username"],
                "displayName": row["display_name"],
                "role": row["role"],
                "active": bool(row["active"]),
            }
            for row in rows
        ]

    def _create_subject(self, actor: sqlite3.Row) -> None:
        self._require_role(actor, "admin")
        payload = self._read_json()
        name = payload.get("name")
        code = payload.get("code")
        target = validate_target(payload.get("target", 75))
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Subject name must be between 1 and 120 characters.")
        if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,30}", code.strip()):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Subject code must use 1-30 letters, numbers, dashes or underscores.")
        with connect(self.server.database_path) as connection:
            connection.execute(
                "INSERT INTO subjects(institution_id, name, code, target) VALUES (?, ?, ?, ?)",
                (actor["institution_id"], name.strip(), code.strip().upper(), target),
            )
            subject_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]
            audit(connection, actor["institution_id"], actor["id"], "subject.created", "subject", subject_id, {})
        self._send_json(HTTPStatus.CREATED, {"id": subject_id})

    def _subjects(self, user: sqlite3.Row) -> list[dict[str, object]]:
        with connect(self.server.database_path) as connection:
            if user["role"] == "student":
                rows = connection.execute(
                    """
                    SELECT s.id, s.name, s.code, s.target, COUNT(DISTINCT cs.id) AS total,
                        SUM(CASE WHEN ar.status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS attended
                    FROM subjects s
                    JOIN student_enrollments e ON e.subject_id = s.id AND e.student_id = ?
                    LEFT JOIN class_sessions cs ON cs.subject_id = s.id AND cs.submitted_at IS NOT NULL
                    LEFT JOIN attendance_records ar ON ar.session_id = cs.id AND ar.student_id = ?
                    WHERE s.institution_id = ?
                    GROUP BY s.id
                    ORDER BY s.name
                    """,
                    (user["id"], user["id"], user["institution_id"]),
                ).fetchall()
            elif user["role"] == "teacher":
                rows = connection.execute(
                    """
                    SELECT s.id, s.name, s.code, s.target,
                        COUNT(DISTINCT e.student_id) AS enrolled
                    FROM subjects s
                    JOIN teacher_subject_assignments a ON a.subject_id = s.id AND a.teacher_id = ?
                    LEFT JOIN student_enrollments e ON e.subject_id = s.id
                    WHERE s.institution_id = ?
                    GROUP BY s.id
                    ORDER BY s.name
                    """,
                    (user["id"], user["institution_id"]),
                ).fetchall()
            elif user["role"] == "admin":
                rows = connection.execute(
                    "SELECT id, name, code, target FROM subjects WHERE institution_id = ? ORDER BY name",
                    (user["institution_id"],),
                ).fetchall()
            else:
                return []
        return [dict(row) for row in rows]

    def _dashboard(self, user: sqlite3.Row) -> dict[str, object]:
        subjects = self._subjects(user)
        if user["role"] == "student":
            total = sum(int(subject.get("total", 0) or 0) for subject in subjects)
            attended = sum(int(subject.get("attended", 0) or 0) for subject in subjects)
            return {
                "role": "student",
                "overall": {
                    "attended": attended,
                    "total": total,
                    "percentage": current_percentage(attended, total),
                },
                "subjects": [
                    {
                        **subject,
                        "percentage": current_percentage(
                            subject.get("attended", 0) or 0, subject.get("total", 0) or 0
                        ),
                        "required": required_classes(
                            subject.get("attended", 0) or 0,
                            subject.get("total", 0) or 0,
                            subject["target"],
                        ),
                    }
                    for subject in subjects
                ],
                "notifications": self._notifications(user),
            }
        if user["role"] == "teacher":
            with connect(self.server.database_path) as connection:
                assigned = connection.execute(
                    """
                    SELECT COUNT(DISTINCT e.student_id) AS enrolled_students
                    FROM teacher_subject_assignments a
                    LEFT JOIN student_enrollments e ON e.subject_id = a.subject_id
                    WHERE a.teacher_id = ?
                    """,
                    (user["id"],),
                ).fetchone()
                awaiting = connection.execute(
                    """
                    SELECT COUNT(*) AS awaiting_attendance
                    FROM class_sessions cs
                    JOIN teacher_subject_assignments a ON a.subject_id = cs.subject_id
                    WHERE a.teacher_id = ? AND cs.submitted_at IS NULL
                    """,
                    (user["id"],),
                ).fetchone()
                recent_sessions = connection.execute(
                    """
                    SELECT cs.id, cs.session_date, cs.label, cs.submitted_at,
                        s.name AS subject, s.code
                    FROM class_sessions cs
                    JOIN subjects s ON s.id = cs.subject_id
                    JOIN teacher_subject_assignments a ON a.subject_id = cs.subject_id
                    WHERE a.teacher_id = ?
                    ORDER BY cs.session_date DESC, cs.id DESC LIMIT 8
                    """,
                    (user["id"],),
                ).fetchall()
            return {
                "role": "teacher",
                "subjects": subjects,
                "alerts": self._alerts(user),
                "enrolledStudents": assigned["enrolled_students"] or 0,
                "awaitingAttendance": awaiting["awaiting_attendance"] or 0,
                "recentSessions": [dict(row) for row in recent_sessions],
            }
        if user["role"] == "admin":
            with connect(self.server.database_path) as connection:
                counts = connection.execute(
                    """
                    SELECT
                        SUM(CASE WHEN role = 'student' AND active = 1 THEN 1 ELSE 0 END) AS students,
                        SUM(CASE WHEN role = 'teacher' AND active = 1 THEN 1 ELSE 0 END) AS teachers
                    FROM users WHERE institution_id = ?
                    """,
                    (user["institution_id"],),
                ).fetchone()
            return {
                "role": "admin",
                "students": counts["students"] or 0,
                "teachers": counts["teachers"] or 0,
                "subjects": subjects,
            }
        raise ApiError(HTTPStatus.FORBIDDEN, "This account role does not have a dashboard.")

    def _subject_authorized(self, connection: sqlite3.Connection, user: sqlite3.Row, subject_id: int) -> bool:
        if user["role"] == "admin":
            return connection.execute(
                "SELECT 1 FROM subjects WHERE id = ? AND institution_id = ?",
                (subject_id, user["institution_id"]),
            ).fetchone() is not None
        if user["role"] == "teacher":
            return connection.execute(
                """
                SELECT 1 FROM teacher_subject_assignments a
                JOIN subjects s ON s.id = a.subject_id
                WHERE a.subject_id = ? AND a.teacher_id = ? AND s.institution_id = ?
                """,
                (subject_id, user["id"], user["institution_id"]),
            ).fetchone() is not None
        return connection.execute(
            """
            SELECT 1 FROM student_enrollments e
            JOIN subjects s ON s.id = e.subject_id
            WHERE e.subject_id = ? AND e.student_id = ? AND s.institution_id = ?
            """,
            (subject_id, user["id"], user["institution_id"]),
        ).fetchone() is not None

    def _assign_relationship(self, user: sqlite3.Row, subject_id: int, kind: str) -> None:
        self._require_role(user, "admin")
        payload = self._read_json()
        person_id = payload.get("userId")
        if isinstance(person_id, bool) or not isinstance(person_id, int) or person_id < 1:
            raise ApiError(HTTPStatus.BAD_REQUEST, "A valid userId is required.")
        role = "teacher" if kind == "teachers" else "student"
        table = "teacher_subject_assignments" if kind == "teachers" else "student_enrollments"
        with connect(self.server.database_path) as connection:
            person = connection.execute(
                "SELECT id, role FROM users WHERE id = ? AND institution_id = ? AND active = 1",
                (person_id, user["institution_id"]),
            ).fetchone()
            subject = connection.execute(
                "SELECT id FROM subjects WHERE id = ? AND institution_id = ?",
                (subject_id, user["institution_id"]),
            ).fetchone()
            if person is None or person["role"] != role or subject is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "User or subject not found.")
            connection.execute(
                f"INSERT INTO {table}(subject_id, {'teacher_id' if role == 'teacher' else 'student_id'}) VALUES (?, ?)",
                (subject_id, person_id),
            )
            audit(
                connection, user["institution_id"], user["id"],
                f"subject.{kind}.assigned", "subject", subject_id,
                {"userId": person_id},
            )
        self._send_json(HTTPStatus.CREATED, {"status": "assigned"})

    def _roster(self, user: sqlite3.Row, subject_id: int) -> list[dict[str, object]]:
        if user["role"] == "student":
            raise ApiError(HTTPStatus.FORBIDDEN, "Student roster access is not permitted.")
        with connect(self.server.database_path) as connection:
            if not self._subject_authorized(connection, user, subject_id):
                raise ApiError(HTTPStatus.NOT_FOUND, "Subject not found.")
            rows = connection.execute(
                """
                SELECT u.id, u.username, u.display_name
                FROM student_enrollments e JOIN users u ON u.id = e.student_id
                WHERE e.subject_id = ? AND u.institution_id = ? AND u.active = 1
                ORDER BY u.display_name
                """,
                (subject_id, user["institution_id"]),
            ).fetchall()
        return [dict(row) for row in rows]

    def _sessions(self, user: sqlite3.Row, query: dict[str, list[str]]) -> list[dict[str, object]]:
        subject_id = None
        if query.get("subject_id"):
            try:
                subject_id = int(query["subject_id"][0])
            except ValueError as error:
                raise ApiError(HTTPStatus.BAD_REQUEST, "subject_id must be a whole number.") from error
        with connect(self.server.database_path) as connection:
            if subject_id and not self._subject_authorized(connection, user, subject_id):
                raise ApiError(HTTPStatus.NOT_FOUND, "Subject not found.")
            clauses = ["s.institution_id = ?"]
            parameters: list[object] = [user["institution_id"]]
            if subject_id:
                clauses.append("cs.subject_id = ?")
                parameters.append(subject_id)
            if user["role"] == "teacher":
                clauses.append(
                    "EXISTS (SELECT 1 FROM teacher_subject_assignments a WHERE a.subject_id = cs.subject_id AND a.teacher_id = ?)"
                )
                parameters.append(user["id"])
            elif user["role"] == "student":
                clauses.append(
                    "EXISTS (SELECT 1 FROM student_enrollments e WHERE e.subject_id = cs.subject_id AND e.student_id = ?)"
                )
                parameters.append(user["id"])
            elif user["role"] != "admin":
                return []
            rows = connection.execute(
                f"""
                SELECT cs.id, cs.subject_id, s.name AS subject_name, s.code,
                    cs.session_date, cs.label, cs.submitted_at, u.display_name AS teacher
                FROM class_sessions cs
                JOIN subjects s ON s.id = cs.subject_id
                JOIN users u ON u.id = cs.created_by
                WHERE {' AND '.join(clauses)}
                ORDER BY cs.session_date DESC, cs.id DESC LIMIT 200
                """,
                parameters,
            ).fetchall()
        return [dict(row) for row in rows]

    def _create_session(self, user: sqlite3.Row) -> None:
        self._require_role(user, "teacher", "admin")
        payload = self._read_json()
        subject_id = payload.get("subjectId")
        session_date = payload.get("date")
        label = payload.get("label", "Class")
        if isinstance(subject_id, bool) or not isinstance(subject_id, int) or subject_id < 1:
            raise ApiError(HTTPStatus.BAD_REQUEST, "A valid subjectId is required.")
        if not isinstance(session_date, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "A valid session date is required.")
        try:
            if date.fromisoformat(session_date).isoformat() != session_date:
                raise ValueError
        except ValueError as error:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Date must use YYYY-MM-DD.") from error
        if not isinstance(label, str) or not label.strip() or len(label.strip()) > 80:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Session label must be between 1 and 80 characters.")
        with connect(self.server.database_path) as connection:
            if not self._subject_authorized(connection, user, subject_id):
                raise ApiError(HTTPStatus.NOT_FOUND, "Subject not found.")
            enrolled_count = connection.execute(
                "SELECT COUNT(*) FROM student_enrollments WHERE subject_id = ?",
                (subject_id,),
            ).fetchone()[0]
            if enrolled_count == 0:
                raise ApiError(HTTPStatus.CONFLICT, "Enroll students in this subject before creating a session.")
            connection.execute(
                "INSERT INTO class_sessions(subject_id, session_date, label, created_by) VALUES (?, ?, ?, ?)",
                (subject_id, session_date, label.strip(), user["id"]),
            )
            session_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]
            audit(connection, user["institution_id"], user["id"], "session.created", "session", session_id, {})
        self._send_json(HTTPStatus.CREATED, {"id": session_id})

    def _submit_attendance(self, user: sqlite3.Row, session_id: int) -> None:
        self._require_role(user, "teacher", "admin")
        payload = self._read_json()
        entries = payload.get("records")
        if not isinstance(entries, list):
            raise ApiError(HTTPStatus.BAD_REQUEST, "records must be an array.")
        with connect(self.server.database_path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute(
                """
                SELECT cs.*, s.institution_id
                FROM class_sessions cs JOIN subjects s ON s.id = cs.subject_id
                WHERE cs.id = ? AND s.institution_id = ?
                """,
                (session_id, user["institution_id"]),
            ).fetchone()
            if session is None or not self._subject_authorized(connection, user, session["subject_id"]):
                raise ApiError(HTTPStatus.NOT_FOUND, "Session not found.")
            if session["submitted_at"]:
                raise ApiError(HTTPStatus.CONFLICT, "Attendance has already been submitted for this session.")
            roster = {
                row["student_id"]
                for row in connection.execute(
                    "SELECT student_id FROM student_enrollments WHERE subject_id = ?",
                    (session["subject_id"],),
                )
            }
            normalized: dict[int, str] = {}
            for entry in entries:
                if not isinstance(entry, dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Each attendance record must be an object.")
                student_id = entry.get("studentId")
                status = entry.get("status")
                if isinstance(student_id, bool) or not isinstance(student_id, int) or student_id < 1:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Each attendance record needs a valid studentId.")
                if status not in ("Present", "Absent", "Late"):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Attendance status must be Present, Absent or Late.")
                if student_id in normalized:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "A student can only be recorded once per session.")
                if student_id not in roster:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Attendance includes a student not enrolled in this subject.")
                normalized[student_id] = status
            if set(normalized) != roster:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Submit one attendance status for every enrolled student.")
            connection.executemany(
                """
                INSERT INTO attendance_records(session_id, student_id, status, recorded_by)
                VALUES (?, ?, ?, ?)
                """,
                [(session_id, student_id, status, user["id"]) for student_id, status in normalized.items()],
            )
            connection.execute(
                "UPDATE class_sessions SET submitted_at = CURRENT_TIMESTAMP WHERE id = ?",
                (session_id,),
            )
            audit(
                connection, user["institution_id"], user["id"],
                "attendance.submitted", "session", session_id,
                {"recordCount": len(normalized)},
            )
            self._create_low_attendance_notifications(connection, session["subject_id"])
        self._send_json(HTTPStatus.OK, {"status": "submitted", "recordCount": len(normalized)})

    @staticmethod
    def _create_low_attendance_notifications(connection: sqlite3.Connection, subject_id: int) -> None:
        subject = connection.execute(
            "SELECT name, target FROM subjects WHERE id = ?", (subject_id,)
        ).fetchone()
        rows = connection.execute(
            """
            SELECT ar.student_id,
                SUM(CASE WHEN ar.status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS attended,
                COUNT(*) AS total
            FROM attendance_records ar
            JOIN class_sessions cs ON cs.id = ar.session_id
            WHERE cs.subject_id = ? AND cs.submitted_at IS NOT NULL
            GROUP BY ar.student_id
            """,
            (subject_id,),
        ).fetchall()
        for row in rows:
            percentage = current_percentage(row["attended"], row["total"])
            if percentage is None or percentage >= subject["target"]:
                continue
            recent = connection.execute(
                """
                SELECT 1 FROM notifications
                WHERE user_id = ? AND subject_id = ? AND kind = 'low_attendance'
                    AND created_at >= datetime('now', '-7 days')
                LIMIT 1
                """,
                (row["student_id"], subject_id),
            ).fetchone()
            if recent is None:
                connection.execute(
                    """
                    INSERT INTO notifications(user_id, subject_id, kind, message)
                    VALUES (?, ?, 'low_attendance', ?)
                    """,
                    (
                        row["student_id"], subject_id,
                        f"Attendance in {subject['name']} is below the configured {subject['target']:g}% target.",
                    ),
                )

    def _attendance(self, user: sqlite3.Row, query: dict[str, list[str]]) -> list[dict[str, object]]:
        requested_student = None
        if query.get("student_id"):
            try:
                requested_student = int(query["student_id"][0])
            except ValueError as error:
                raise ApiError(HTTPStatus.BAD_REQUEST, "student_id must be a whole number.") from error
        if user["role"] == "student" and requested_student not in (None, user["id"]):
            raise ApiError(HTTPStatus.FORBIDDEN, "You can only view your own attendance.")
        with connect(self.server.database_path) as connection:
            clauses = ["s.institution_id = ?", "cs.submitted_at IS NOT NULL"]
            parameters: list[object] = [user["institution_id"]]
            if user["role"] == "student":
                clauses.append("ar.student_id = ?")
                parameters.append(user["id"])
            elif user["role"] == "teacher":
                clauses.append(
                    "EXISTS (SELECT 1 FROM teacher_subject_assignments a WHERE a.subject_id = s.id AND a.teacher_id = ?)"
                )
                parameters.append(user["id"])
                if requested_student is not None:
                    clauses.append("ar.student_id = ?")
                    parameters.append(requested_student)
            elif user["role"] == "admin":
                if requested_student is not None:
                    clauses.append("ar.student_id = ?")
                    parameters.append(requested_student)
            else:
                return []
            rows = connection.execute(
                f"""
                SELECT ar.id, ar.student_id, u.display_name AS student_name,
                    ar.status, cs.session_date AS date, cs.label AS session,
                    s.id AS subject_id, s.name AS subject, s.code,
                    teacher.display_name AS recorded_by
                FROM attendance_records ar
                JOIN users u ON u.id = ar.student_id
                JOIN class_sessions cs ON cs.id = ar.session_id
                JOIN subjects s ON s.id = cs.subject_id
                JOIN users teacher ON teacher.id = ar.recorded_by
                WHERE {' AND '.join(clauses)}
                ORDER BY cs.session_date DESC, ar.id DESC LIMIT 500
                """,
                parameters,
            ).fetchall()
        return [dict(row) for row in rows]

    def _alerts(self, user: sqlite3.Row) -> list[dict[str, object]]:
        self._require_role(user, "teacher", "admin")
        clauses = ["s.institution_id = ?"]
        parameters: list[object] = [user["institution_id"]]
        if user["role"] == "teacher":
            clauses.append(
                "EXISTS (SELECT 1 FROM teacher_subject_assignments a WHERE a.subject_id = s.id AND a.teacher_id = ?)"
            )
            parameters.append(user["id"])
        with connect(self.server.database_path) as connection:
            rows = connection.execute(
                f"""
                SELECT u.id AS student_id, u.display_name AS student_name,
                    s.id AS subject_id, s.name AS subject, s.code, s.target,
                    SUM(CASE WHEN ar.status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS attended,
                    COUNT(*) AS total
                FROM attendance_records ar
                JOIN users u ON u.id = ar.student_id
                JOIN class_sessions cs ON cs.id = ar.session_id AND cs.submitted_at IS NOT NULL
                JOIN subjects s ON s.id = cs.subject_id
                WHERE {' AND '.join(clauses)}
                GROUP BY u.id, s.id
                HAVING (attended * 100.0 / total) < s.target
                ORDER BY (attended * 1.0 / total), u.display_name
                LIMIT 500
                """,
                parameters,
            ).fetchall()
            alerts = []
            for row in rows:
                item = dict(row)
                item["percentage"] = current_percentage(item["attended"], item["total"])
                item["required"] = required_classes(item["attended"], item["total"], item["target"])
                alerts.append(item)
        return alerts

    def _notifications(self, user: sqlite3.Row) -> list[dict[str, object]]:
        if user["role"] != "student":
            return []
        with connect(self.server.database_path) as connection:
            rows = connection.execute(
                """
                SELECT n.id, n.kind, n.message, n.created_at, n.read_at,
                    s.name AS subject
                FROM notifications n LEFT JOIN subjects s ON s.id = n.subject_id
                WHERE n.user_id = ?
                ORDER BY n.created_at DESC LIMIT 100
                """,
                (user["id"],),
            ).fetchall()
        return [dict(row) for row in rows]

    def _mark_notification_read(self, user: sqlite3.Row, notification_id: int) -> None:
        if user["role"] != "student":
            raise ApiError(HTTPStatus.FORBIDDEN, "Notifications are not available for this account.")
        with connect(self.server.database_path) as connection:
            updated = connection.execute(
                "UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
                (notification_id, user["id"]),
            ).rowcount
        if not updated:
            raise ApiError(HTTPStatus.NOT_FOUND, "Notification not found.")
        self._send_json(HTTPStatus.OK, {"status": "read"})


def create_server(host: str, port: int, database_path: str | Path) -> AttendWiseServer:
    return AttendWiseServer((host, port), database_path)
