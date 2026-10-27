"""Entry point used by PyInstaller and `python run.py`."""

from servicemonitor.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
