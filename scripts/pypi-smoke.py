"""Smoke test of the wheels scripts/pypi-wheels.py wrote: installs `pykgdiff` into a fresh
virtual environment from <dir> alone (no package index, so pip has to pick the wheel whose
platform tag fits this machine: musllinux on Alpine, the exact architecture elsewhere), then runs
the `kgdiff` it installed on an example dataset, and checks that there is no `pykgdiff` module
(the name is kept for the Python API). Standard library only, any Python 3:

    python3 scripts/pypi-smoke.py target/pypi
"""

import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def fail(message: str) -> None:
    sys.exit(f"pypi-smoke: {message}")


def main() -> None:
    wheels = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "target" / "pypi").resolve()
    pyproject = (ROOT / "python" / "pyproject.toml").read_text("utf-8")
    version = re.search(r'^version = "([^"]+)"', pyproject, re.M).group(1)
    cli = json.loads((ROOT / "packages" / "cli" / "package.json").read_text("utf-8"))["version"]

    with tempfile.TemporaryDirectory(prefix="kgdiff-pypi-smoke-") as scratch:
        env_dir = Path(scratch) / "venv"
        venv.create(env_dir, with_pip=True)
        bin_dir = env_dir / ("Scripts" if os.name == "nt" else "bin")
        python = bin_dir / ("python.exe" if os.name == "nt" else "python")
        subprocess.run(
            [str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
             "--no-index", "--find-links", str(wheels), f"pykgdiff=={version}"],
            check=True,
        )
        kgdiff = bin_dir / ("kgdiff.exe" if os.name == "nt" else "kgdiff")
        if not kgdiff.is_file():
            fail(f"pip installed no {kgdiff.name} into {bin_dir}.")

        def run(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(
                [str(kgdiff), *args], cwd=scratch, capture_output=True, text=True,
                encoding="utf-8",
            )

        v = run("--version")
        if v.returncode != 0 or v.stdout.strip() != f"kgdiff {cli}":
            fail(f"kgdiff --version: exit {v.returncode}, {v.stdout + v.stderr!r}")
        data = ROOT / "examples" / "datasets" / "enterprise-kg"
        sides = [str(data / "before.json"), str(data / "after.json"), "--match", "auto"]
        stat = run(*sides, "--stat", "--color", "never")
        if stat.returncode != 0 or "nodes" not in stat.stdout:
            fail(f"kgdiff --stat: exit {stat.returncode}, {stat.stderr}")
        changed = run(*sides, "--exit-code", "--quiet")
        if changed.returncode != 1:
            fail(f"kgdiff --exit-code: exit {changed.returncode}")
        report = Path(scratch) / "report.html"
        html = run(*sides, "-o", str(report), "--reproducible", "--quiet")
        if html.returncode != 0 or "application/kgdiff+json" not in report.read_text("utf-8"):
            fail(f"kgdiff -o: exit {html.returncode}, {html.stderr}")

        # Only the command line: the module name stays free for the Python API (RFC 0002, D-7).
        module = subprocess.run([str(python), "-c", "import pykgdiff"], capture_output=True)
        if module.returncode == 0:
            fail("`import pykgdiff` works, but the wheels must not have a Python module yet.")

    print(f"pypi-smoke: pykgdiff {version} runs kgdiff on {sys.platform}-{platform.machine()}.")


if __name__ == "__main__":
    main()
