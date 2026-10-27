"""Build a Windows icon for PyInstaller."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from servicemonitor.desktop import icon


def main() -> None:
    root = ROOT
    assets = root / "assets"
    assets.mkdir(parents=True, exist_ok=True)

    image = icon.create_icon(256, status="ok")
    image.save(assets / "icon.png")
    image.save(
        assets / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"Icon written to {assets / 'icon.ico'}")


if __name__ == "__main__":
    main()
