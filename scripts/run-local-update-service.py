"""Serve one generated release through the real N.E.K.O.-Update FastAPI app.

The direct Settings construction deliberately permits HTTP loopback URLs. Production
configuration still validates HTTPS URLs; this file is only an offline test harness.
"""

from __future__ import annotations

import argparse
import mimetypes
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPDATE_SOURCE = ROOT.parent / "N.E.K.O.-Update"
VERSION_RE = re.compile(r"^N\.E\.K\.O_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_win_manifest\.json$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a generated Portable test release locally")
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--update-source", type=Path, default=Path(os.getenv("NEKO_UPDATE_SOURCE_DIR", DEFAULT_UPDATE_SOURCE)))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    release_dir = args.release_dir.resolve()
    source = args.update_source.resolve()
    if not release_dir.is_dir(): raise SystemExit(f"Release directory not found: {release_dir}")
    if not (source / "app" / "main.py").is_file(): raise SystemExit(f"N.E.K.O.-Update source not found: {source}")
    sys.path.insert(0, str(source))

    import uvicorn
    from fastapi.staticfiles import StaticFiles
    from app.config import Channel, Mirror, Product, Settings
    from app.main import create_app

    manifests = [item for item in release_dir.iterdir() if VERSION_RE.match(item.name)]
    if len(manifests) != 1: raise SystemExit("Expected exactly one N.E.K.O_<version>_win_manifest.json")
    version = VERSION_RE.match(manifests[0].name).group(1)
    base = f"http://127.0.0.1:{args.port}"
    settings = Settings(
        database_path=ROOT / ".local-update-data" / f"{version}.db",
        public_base_url=base,
        admin_token="",
        github_token=None,
        country_headers=(),
        products={"N.E.K.O": Product(github_repository="local/electron-portable-update-test", asset_prefix="N.E.K.O", channels={"stable": Channel()})},
        mirrors={"local": Mirror(id="local", base_url=f"{base}/assets", path_template="{name}")},
    )
    app = create_app(settings)
    store = app.state.store
    store.initialize()
    assets = []
    for item in sorted(release_dir.iterdir()):
        if not item.is_file() or not item.name.startswith("N.E.K.O_"): continue
        assets.append({
            "name": item.name,
            "size": item.stat().st_size,
            "content_type": mimetypes.guess_type(item.name)[0] or "application/octet-stream",
            "source_url": f"https://offline.example.invalid/{item.name}",
            "sha256": None,
            "mirrors": ["local"],
        })
    store.upsert_release(product="N.E.K.O", channel="stable", source="local-test", release={
        "version": version,
        "tag": f"v{version}",
        "name": f"Portable update test {version}",
        "body": f"Local end-to-end Portable update test for {version}.",
        "html_url": "https://offline.example.invalid/releases",
        "published_at": datetime.now(timezone.utc),
        "prerelease": False,
        "draft": False,
        "assets": assets,
    })
    app.mount("/assets", StaticFiles(directory=release_dir), name="assets")
    print(f"Serving N.E.K.O v{version} through N.E.K.O.-Update at {base}")
    print(f"Release endpoint: {base}/v1/compat/github/N.E.K.O/stable/releases/latest")
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
