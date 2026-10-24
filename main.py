import argparse
import getpass
import os
import re
from pathlib import Path

from .app import create_server
from .database import connect, initialize_database
from .security import hash_password, validate_password


def create_admin(database_path: Path, email: str, institution: str) -> None:
    normalized_email = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized_email):
        raise ValueError("Enter a valid email address.")
    password = getpass.getpass("Admin password (at least 12 characters): ")
    confirmation = getpass.getpass("Confirm admin password: ")
    if password != confirmation:
        raise ValueError("Passwords do not match.")
    validate_password(password)
    password_hash = hash_password(password)
    initialize_database(database_path)
    with connect(database_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "INSERT OR IGNORE INTO institutions(name) VALUES (?)", (institution.strip(),)
        )
        institution_row = connection.execute(
            "SELECT id FROM institutions WHERE name = ?", (institution.strip(),)
        ).fetchone()
        if institution_row is None:
            raise RuntimeError("Could not initialize the institution.")
        existing = connection.execute(
            "SELECT 1 FROM users WHERE institution_id = ? AND email = ?",
            (institution_row["id"], normalized_email),
        ).fetchone()
        if existing:
            raise ValueError("An account with this email already exists in the institution.")
        username = normalized_email.split("@", 1)[0][:40]
        connection.execute(
            """
            INSERT INTO users
                (institution_id, email, username, display_name, role, password_hash)
            VALUES (?, ?, ?, ?, 'admin', ?)
            """,
            (
                institution_row["id"],
                normalized_email,
                username,
                "Institution Administrator",
                password_hash,
            ),
        )
    print(f"Administrator created for {normalized_email}.")


def reset_password(database_path: Path, email: str) -> None:
    normalized_email = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized_email):
        raise ValueError("Enter a valid email address.")
    password = getpass.getpass("New password (at least 12 characters): ")
    confirmation = getpass.getpass("Confirm new password: ")
    if password != confirmation:
        raise ValueError("Passwords do not match.")
    validate_password(password)
    initialize_database(database_path)
    with connect(database_path) as connection:
        user = connection.execute(
            "SELECT id FROM users WHERE email = ? COLLATE NOCASE",
            (normalized_email,),
        ).fetchone()
        if user is None:
            raise ValueError("No account exists with that email address.")
        connection.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(password), user["id"]),
        )
        connection.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user["id"],))
    print(f"Password reset for {normalized_email}.")


def main() -> None:
    parser = argparse.ArgumentParser(description="AttendWise local API server")
    parser.add_argument(
        "--database",
        type=Path,
        default=Path(os.environ.get("ATTENDWISE_DATABASE", "server/data/attendwise.sqlite3")),
    )
    account_action = parser.add_mutually_exclusive_group()
    account_action.add_argument("--create-admin", metavar="EMAIL")
    account_action.add_argument("--reset-password", metavar="EMAIL")
    parser.add_argument("--institution", default=os.environ.get("ATTENDWISE_INSTITUTION", "AttendWise"))
    parser.add_argument("--host", default=os.environ.get("ATTENDWISE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ATTENDWISE_PORT", "8000")))
    arguments = parser.parse_args()
    if arguments.create_admin:
        create_admin(arguments.database, arguments.create_admin, arguments.institution)
        return
    if arguments.reset_password:
        reset_password(arguments.database, arguments.reset_password)
        return
    initialize_database(arguments.database)
    server = create_server(arguments.host, arguments.port, arguments.database)
    print(f"AttendWise API listening on http://{arguments.host}:{arguments.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping AttendWise API.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
