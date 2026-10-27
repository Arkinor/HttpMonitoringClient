"""Allow `python -m servicemonitor`."""

from servicemonitor.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
