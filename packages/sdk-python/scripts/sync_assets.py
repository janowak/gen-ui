"""Copies the built-in view bundles and tool input schemas into the package.

Build the TypeScript packages first (`pnpm --filter @genui/format --filter @genui/ui build`),
then run `uv run python scripts/sync_assets.py`.
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT.parent
TARGET = ROOT / "src" / "genui" / "_assets"

# The paths @genui/ui exports as `@genui/ui/views/<name>.html` (package.json "./views/*": "./dist/*").
SOURCES = {
    "form.html": PACKAGES / "ui" / "dist" / "form.html",
    "chart.html": PACKAGES / "ui" / "dist" / "chart.html",
    "form.schema.json": PACKAGES / "format" / "schemas" / "form.json",
    "chart.schema.json": PACKAGES / "format" / "schemas" / "chart.json",
    "recipe-input.schema.json": PACKAGES / "format" / "schemas" / "recipe-input.json",
}


def main() -> int:
    missing = [str(path) for path in SOURCES.values() if not path.exists()]
    if missing:
        print("Missing (build @genui/format and @genui/ui first):\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1
    TARGET.mkdir(parents=True, exist_ok=True)
    for name, path in SOURCES.items():
        shutil.copyfile(path, TARGET / name)
        print(f"{path.relative_to(PACKAGES)} -> {(TARGET / name).relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
