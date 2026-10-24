import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from .app import create_server
from .database import connect, initialize_database
from .security import hash_password


class AttendWiseApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_directory.name) / "attendwise.sqlite3"
        initialize_database(self.database_path)
        with connect(self.database_path) as connection:
            institution_id = connection.execute(
                "INSERT INTO institutions(name) VALUES ('Test College')"
            ).lastrowid
            other_institution_id = connection.execute(
                "INSERT INTO institutions(name) VALUES ('Other College')"
            ).lastrowid
            password_hash = hash_password("correct horse battery staple")
            self.admin_id = self._add_user(
                connection, institution_id, "admin@test.example", "admin", "Admin", password_hash
            )
            self.teacher_id = self._add_user(
                connection, institution_id, "teacher@test.example", "teacher", "Teacher", password_hash
            )
            self.student_id = self._add_user(
                connection, institution_id, "student@test.example", "student", "Student", password_hash
            )
            self.other_student_id = self._add_user(
                connection, institution_id, "other@test.example", "otherstudent", "Other Student", password_hash
            )
            self.other_institution_student_id = self._add_user(
                connection, other_institution_id, "foreign@test.example", "foreign", "Foreign Student", password_hash
            )
            self.subject_id = connection.execute(
                "INSERT INTO subjects(institution_id, name, code, target) VALUES (?, 'Mathematics', 'MATH', 75)",
                (institution_id,),
            ).lastrowid
            self.foreign_subject_id = connection.execute(
                "INSERT INTO subjects(institution_id, name, code) VALUES (?, 'Foreign', 'FOREIGN')",
                (other_institution_id,),
            ).lastrowid
            connection.execute(
                "INSERT INTO teacher_subject_assignments(teacher_id, subject_id) VALUES (?, ?)",
                (self.teacher_id, self.subject_id),
            )
            connection.executemany(
                "INSERT INTO student_enrollments(student_id, subject_id) VALUES (?, ?)",
                [(self.student_id, self.subject_id), (self.other_student_id, self.subject_id)],
            )

        self.server = create_server("127.0.0.1", 0, self.database_path)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = self.server.server_address
        self.sessions: dict[str, dict[str, str]] = {}

    @staticmethod
    def _add_user(
        connection: sqlite3.Connection,
        institution_id: int,
        email: str,
        username: str,
        display_name: str,
        password_hash: str,
    ) -> int:
        role = {"admin": "admin", "teacher": "teacher"}.get(username, "student")
        return connection.execute(
            """
            INSERT INTO users(institution_id, email, username, display_name, role, password_hash)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (institution_id, email, username, display_name, role, password_hash),
        ).lastrowid

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp_directory.cleanup()

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, object] | None = None,
        session: str | None = None,
    ) -> tuple[int, dict[str, object], dict[str, str]]:
        connection = http.client.HTTPConnection(*self.base_url)
        headers = {}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if session and session in self.sessions:
            headers["Cookie"] = self.sessions[session]["cookie"]
            if method != "GET":
                headers["X-CSRF-Token"] = self.sessions[session]["csrf"]
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        response_body = json.loads(response.read().decode("utf-8"))
        connection.close()
        return response.status, response_body, response_headers

    def login(self, email: str, key: str) -> dict[str, object]:
        status, body, headers = self.request(
            "POST",
            "/api/auth/login",
            {"email": email, "password": "correct horse battery staple"},
        )
        self.assertEqual(status, 200)
        cookie = headers["set-cookie"].split(";", 1)[0]
        self.assertIn("httponly", headers["set-cookie"].lower())
        self.assertIn("samesite=strict", headers["set-cookie"].lower())
        self.sessions[key] = {"cookie": cookie, "csrf": ""}
        status, current, _ = self.request("GET", "/api/auth/me", session=key)
        self.assertEqual(status, 200)
        self.sessions[key]["csrf"] = str(current["csrfToken"])
        return body

    def test_requires_authentication_and_csrf_for_writes(self) -> None:
        status, body, _ = self.request("GET", "/api/dashboard")
        self.assertEqual(status, 401)
        self.login("admin@test.example", "admin")
        self.sessions["admin"]["csrf"] = ""
        status, body, _ = self.request(
            "POST", "/api/users",
            {
                "email": "new@test.example",
                "username": "newuser",
                "displayName": "New User",
                "role": "student",
                "password": "long enough password",
            },
            "admin",
        )
        self.assertEqual(status, 403)

    def test_login_throttles_repeated_unknown_account_attempts(self) -> None:
        for _ in range(5):
            status, _, _ = self.request(
                "POST",
                "/api/auth/login",
                {"email": "missing@test.example", "password": "incorrect password"},
            )
            self.assertEqual(status, 401)
        status, _, _ = self.request(
            "POST",
            "/api/auth/login",
            {"email": "missing@test.example", "password": "incorrect password"},
        )
        self.assertEqual(status, 429)

    def test_role_aware_user_creation_and_institution_scope(self) -> None:
        self.login("admin@test.example", "admin")
        status, created, _ = self.request(
            "POST",
            "/api/users",
            {
                "email": "newstudent@test.example",
                "username": "newstudent",
                "displayName": "New Student",
                "role": "student",
                "password": "long enough password",
            },
            "admin",
        )
        self.assertEqual(status, 201)
        self.assertEqual(created["user"]["role"], "student")
        self.login("teacher@test.example", "teacher")
        status, _, _ = self.request(
            "POST", "/api/subjects",
            {"name": "Not Allowed", "code": "NOPE"},
            "teacher",
        )
        self.assertEqual(status, 403)

    def test_teacher_marks_a_full_roster_atomically_and_student_gets_alert(self) -> None:
        self.login("teacher@test.example", "teacher")
        status, created, _ = self.request(
            "POST",
            "/api/sessions",
            {"subjectId": self.subject_id, "date": "2026-10-23", "label": "Morning"},
            "teacher",
        )
        self.assertEqual(status, 201)
        session_id = created["id"]
        status, _, _ = self.request(
            "POST",
            "/api/sessions",
            {"subjectId": self.subject_id, "date": "2026-10-23", "label": "Morning"},
            "teacher",
        )
        self.assertEqual(status, 409)
        status, _, _ = self.request(
            "PUT",
            f"/api/sessions/{session_id}/attendance",
            {"records": [{"studentId": self.student_id, "status": "Present"}]},
            "teacher",
        )
        self.assertEqual(status, 400)
        with connect(self.database_path) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM attendance_records WHERE session_id = ?", (session_id,)
                ).fetchone()[0],
                0,
            )
        status, result, _ = self.request(
            "PUT",
            f"/api/sessions/{session_id}/attendance",
            {
                "records": [
                    {"studentId": self.student_id, "status": "Present"},
                    {"studentId": self.other_student_id, "status": "Absent"},
                ]
            },
            "teacher",
        )
        self.assertEqual(status, 200)
        self.assertEqual(result["recordCount"], 2)
        status, _, _ = self.request(
            "PUT",
            f"/api/sessions/{session_id}/attendance",
            {"records": []},
            "teacher",
        )
        self.assertEqual(status, 409)
        status, followup, _ = self.request(
            "POST",
            "/api/sessions",
            {"subjectId": self.subject_id, "date": "2026-10-23", "label": "Afternoon"},
            "teacher",
        )
        self.assertEqual(status, 201)
        status, _, _ = self.request(
            "PUT",
            f"/api/sessions/{followup['id']}/attendance",
            {
                "records": [
                    {"studentId": self.student_id, "status": "Present"},
                    {"studentId": self.other_student_id, "status": "Absent"},
                ]
            },
            "teacher",
        )
        self.assertEqual(status, 200)
        status, alerts, _ = self.request("GET", "/api/alerts", session="teacher")
        self.assertEqual(status, 200)
        self.assertEqual(len(alerts["alerts"]), 1)

        self.login("student@test.example", "student")
        status, dashboard, _ = self.request("GET", "/api/dashboard", session="student")
        self.assertEqual(status, 200)
        self.assertEqual(dashboard["overall"]["percentage"], 100)
        status, history, _ = self.request("GET", "/api/attendance", session="student")
        self.assertEqual(status, 200)
        self.assertEqual(len(history["records"]), 2)
        status, _, _ = self.request(
            "GET", f"/api/attendance?student_id={self.other_student_id}", session="student"
        )
        self.assertEqual(status, 403)
        status, notifications, _ = self.request("GET", "/api/notifications", session="student")
        self.assertEqual(status, 200)
        self.assertEqual(len(notifications["notifications"]), 0)

        self.login("other@test.example", "other")
        status, notifications, _ = self.request("GET", "/api/notifications", session="other")
        self.assertEqual(status, 200)
        self.assertEqual(len(notifications["notifications"]), 1)
        notification_id = notifications["notifications"][0]["id"]
        status, _, _ = self.request(
            "POST",
            f"/api/notifications/{notification_id}/read",
            {},
            "student",
        )
        self.assertEqual(status, 404)

    def test_teacher_cannot_access_unassigned_or_cross_institution_subject(self) -> None:
        self.login("teacher@test.example", "teacher")
        status, _, _ = self.request(
            "POST",
            "/api/sessions",
            {"subjectId": self.foreign_subject_id, "date": "2026-10-23", "label": "Unauthorized"},
            "teacher",
        )
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
