"""Tiny FastAPI backend bundled with the Portable update test application."""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI


def _build_info() -> dict[str, str]:
    resource_dir = Path(os.getenv("PORTABLE_TEST_RESOURCE_DIR", ""))
    candidates = [
        resource_dir / "build-info.json",
        Path(__file__).with_name("build-info.json"),
    ]
    for candidate in candidates:
        try:
            return json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    return {"version": "development", "flavor": "Local development", "accent": "#5b8cff"}


app = FastAPI(title="Portable Update Test Backend")


@app.get("/api/status")
def status() -> dict[str, str]:
    return {"backend": "FastAPI online", **_build_info()}
