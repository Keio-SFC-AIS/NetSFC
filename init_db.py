import sqlite3
import os
import json
from dotenv import load_dotenv
from loguru import logger
from typing import TypedDict, List, Any, cast

load_dotenv()


class Facility(TypedDict):
    id: int
    layer_type: str
    name: str
    alias: str | None
    building: str | None
    floor: str | None
    coords: List[Any]
    floor_images: dict[str, str] | None
    details: dict[str, Any] | None


def load_facilities_json() -> list[Facility]:
    file_path = os.path.join(os.path.dirname(__file__), "data", "facilities.json")
    if not os.path.exists(file_path):
        logger.warning("Facilities JSON file not found: %s", file_path)
        return []

    with open(file_path, "r", encoding="utf-8") as file:
        facilities = cast(list[dict[str, Any]], json.load(file))

    cleaned: List[Facility] = []

    for item in facilities:
        item: dict[str, Any]

        id_value = item.get("id")
        type_value = item.get("layer_type")
        name_value = item.get("name")
        coords = item.get("coords")

        if (
            not isinstance(id_value, int)
            or not isinstance(type_value, str)
            or not isinstance(name_value, str)
            or (coords is not None and not isinstance(coords, list))
        ):
            logger.warning(f"Skipping invalid facility: {item}")
            continue

        cleaned.append({
            "id": id_value,
            "layer_type": type_value,
            "name": name_value,
            "alias": item.get("alias"),
            "building": item.get("building"),
            "floor": item.get("floor"),
            "coords": coords if isinstance(coords, list) else [],
            "floor_images": item.get("floor_images"),
            "details": item.get("details"),
        })

    return cleaned


def ensure_column(
    cursor: sqlite3.Cursor,
    table: str,
    column: str,
    definition: str
) -> None:
    cursor.execute(f"PRAGMA table_info({table})")
    existing = [row[1] for row in cursor.fetchall()]
    if column not in existing:
        cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db(db_name: str) -> None:
    conn = sqlite3.connect(db_name)
    cursor = conn.cursor()

    logger.info(f"Initializing database: {db_name}...")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS wifi_measurements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            signal_strength INTEGER NOT NULL,
            ping_ms REAL NOT NULL,
            bandwidth REAL DEFAULT 0.0,
            coords TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS campus_pois (
            id INTEGER PRIMARY KEY,
            layer_type TEXT NOT NULL,
            name TEXT NOT NULL,
            alias TEXT,
            building TEXT,
            floor TEXT,
            coords TEXT NOT NULL,
            floor_images TEXT,
            details TEXT
        )
    """)

    ensure_column(cursor, 'campus_pois', 'building', 'TEXT')
    ensure_column(cursor, 'campus_pois', 'floor', 'TEXT')
    ensure_column(cursor, 'campus_pois', 'alias', 'TEXT')
    ensure_column(cursor, 'campus_pois', 'coords', 'TEXT DEFAULT "[]"')
    ensure_column(cursor, 'campus_pois', 'floor_images', 'TEXT DEFAULT "{}"')
    ensure_column(cursor, 'campus_pois', 'details', 'TEXT DEFAULT "{}"')

    RUNTIME: str | None = os.getenv("RUNTIME")
    if RUNTIME and RUNTIME.upper() == "DEBUG":
        cursor.execute("DELETE FROM campus_pois")
    facilities = load_facilities_json()

    for facility in facilities:
        cursor.execute("""
            INSERT OR REPLACE INTO campus_pois 
            (id, layer_type, name, alias, building, floor, coords, floor_images, details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            facility["id"],
            facility["layer_type"],
            facility["name"],
            facility.get("alias"),
            facility["building"],
            facility["floor"],
            json.dumps(facility["coords"], ensure_ascii=False),
            json.dumps(facility.get("floor_images") or {}, ensure_ascii=False),
            json.dumps(facility.get("details") or {}, ensure_ascii=False),
        ))

    conn.commit()
    conn.close()
    logger.info("Database initialization completed!")


if __name__ == "__main__":
    db_name: str | None = os.getenv("DB_NAME")
    if not db_name:
        logger.error("Database name is not set in the environment variables.")
        raise ValueError("Database name is not set in the environment variables.")

    init_db(db_name)