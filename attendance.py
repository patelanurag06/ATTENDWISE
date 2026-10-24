from decimal import Decimal, InvalidOperation, ROUND_CEILING


class AttendanceInputError(ValueError):
    pass


def _count(value: object, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool):
        raise AttendanceInputError(f"{label} must be a whole number.")
    try:
        count = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as error:
        raise AttendanceInputError(f"{label} must be a whole number.") from error
    if str(count) != str(value).strip() or count < minimum or count > 2**63 - 1:
        raise AttendanceInputError(f"{label} must be a whole number of at least {minimum}.")
    return count


def validate_target(value: object) -> float:
    if isinstance(value, bool):
        raise AttendanceInputError("Target attendance must be greater than 0% and at most 100%.")
    try:
        target = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as error:
        raise AttendanceInputError(
            "Target attendance must be greater than 0% and at most 100%."
        ) from error
    if not target.is_finite() or not 0 < target <= 100:
        raise AttendanceInputError(
            "Target attendance must be greater than 0% and at most 100%."
        )
    normalized = float(target)
    if normalized == 0:
        raise AttendanceInputError(
            "Target attendance is too small to calculate accurately."
        )
    return normalized


def current_percentage(attended: object, total: object) -> float | None:
    classes_attended = _count(attended, "Classes attended")
    classes_total = _count(total, "Total classes")
    if classes_attended > classes_total:
        raise AttendanceInputError("Classes attended cannot exceed total classes.")
    if classes_total == 0:
        return None
    return classes_attended / classes_total * 100


def required_classes(attended: object, total: object, target: object) -> int | None:
    classes_attended = _count(attended, "Classes attended")
    classes_total = _count(total, "Total classes")
    goal = validate_target(target)
    if classes_attended > classes_total:
        raise AttendanceInputError("Classes attended cannot exceed total classes.")
    goal_decimal = Decimal(str(goal))
    if classes_total and Decimal(classes_attended) * 100 >= goal_decimal * classes_total:
        return 0
    if goal == 100:
        return None
    needed = (
        goal_decimal * classes_total - Decimal(100 * classes_attended)
    ) / (Decimal(100) - goal_decimal)
    return max(0, int(needed.to_integral_value(rounding=ROUND_CEILING)))


def project_remaining(
    attended: object, total: object, remaining: object, target: object
) -> dict[str, float | int | bool | None]:
    classes_attended = _count(attended, "Classes attended")
    classes_total = _count(total, "Total classes")
    remaining_classes = _count(remaining, "Remaining classes")
    goal = validate_target(target)
    if classes_attended > classes_total:
        raise AttendanceInputError("Classes attended cannot exceed total classes.")
    projected = (
        (classes_attended + remaining_classes) / (classes_total + remaining_classes) * 100
        if classes_total + remaining_classes
        else None
    )
    final_total = classes_total + remaining_classes
    reachable = (
        final_total > 0
        and Decimal(classes_attended + remaining_classes) * 100
        >= Decimal(str(goal)) * final_total
    )
    needed = required_classes(classes_attended, classes_total, goal)
    return {
        "projected": projected,
        "required": needed,
        "reachable": reachable,
    }
