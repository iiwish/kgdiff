"""The wheels of the Python distribution `pykgdiff` (python/pyproject.toml): one per target dist
builds, each holding that target's `kgdiff` binary from dist's archive, as
`pykgdiff-<version>.data/scripts/kgdiff[.exe]`, which pip and uv install on the PATH. No Python
module, no build backend: the binary is the one @kgdiff/cli's platform packages and the GitHub
release carry (with the viewer bundles release.yml's native-viewer job built once), never a
second build of it.

    python3 scripts/pypi-wheels.py <dist dir> [<out dir>] [--target <triple> ...]

Finds `kgdiff-<target>.tar.xz` / `.zip` below <dist dir> (at any depth, as
actions/download-artifact leaves them), checks that dist's manifests name the version of
python/pyproject.toml and each archive against its `.sha256`, reads the platform tag from the
binary itself (the minimum macOS of its Mach-O header; the newest glibc symbol version it needs,
for manylinux; its architecture), and writes `<out>/pykgdiff-<version>-py3-none-<tag>.whl`,
byte-identical for identical inputs. Every target is required unless `--target` names some (to
try it locally on one). The out dir is `target/pypi` by default.

Python >= 3.11 (tomllib), standard library only. scripts/pypi-smoke.py installs the result.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import re
import struct
import sys
import tarfile
import tomllib
import zipfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = ROOT / "python" / "pyproject.toml"


@dataclass(frozen=True)
class Target:
    triple: str
    # "macos", "manylinux", "musllinux" or "windows"
    system: str
    # The architecture as wheel tags spell it.
    arch: str

    @property
    def executable(self) -> str:
        return "kgdiff.exe" if self.system == "windows" else "kgdiff"

    @property
    def archive(self) -> str:
        return f"kgdiff-{self.triple}.{'zip' if self.system == 'windows' else 'tar.xz'}"


# dist-workspace.toml's targets, in its order (tests/release.test.ts checks it).
TARGETS = [
    Target("aarch64-apple-darwin", "macos", "arm64"),
    Target("x86_64-apple-darwin", "macos", "x86_64"),
    Target("aarch64-unknown-linux-gnu", "manylinux", "aarch64"),
    Target("x86_64-unknown-linux-gnu", "manylinux", "x86_64"),
    Target("aarch64-unknown-linux-musl", "musllinux", "aarch64"),
    Target("x86_64-unknown-linux-musl", "musllinux", "x86_64"),
    Target("x86_64-pc-windows-msvc", "windows", "amd64"),
]

# The shared libraries a manylinux (PEP 600) or musllinux (PEP 656) wheel may need from the system.
ALLOWED_LIBRARIES = re.compile(
    rb"(libc\.so\.6|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|libgcc_s\.so\.1"
    rb"|ld-linux-(x86-64|aarch64)\.so\.[12]|libc\.musl-(x86_64|aarch64)\.so\.1)"
)


class Failure(Exception):
    pass


def pep440(version: str) -> str:
    """The workspace's semver as PyPI spells it: `1.0.0-rc.1` → `1.0.0rc1`."""
    match = re.fullmatch(r"(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?", version)
    if match is None:
        raise Failure(f"{version} has no PEP 440 form (X.Y.Z, or X.Y.Z-alpha|beta|rc.N).")
    release, pre, number = match.groups()
    if pre is None:
        return release
    return release + {"alpha": "a", "beta": "b", "rc": "rc"}[pre] + number


# ─── The platform tag, from the binary ────────────────────────────────────────────────────────


def macos_tag(binary: bytes, target: Target) -> str:
    magic, cputype, _, _, ncmds = struct.unpack_from("<IiiII", binary)
    if magic != 0xFEEDFACF:
        raise Failure(f"{target.triple}: not a 64-bit Mach-O executable (a universal binary?).")
    expected = {"arm64": 0x0100000C, "x86_64": 0x01000007}[target.arch]
    if cputype != expected:
        raise Failure(f"{target.triple}: the binary is for CPU type {cputype:#x}.")
    offset, minos = 32, None
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", binary, offset)
        if cmd == 0x32:  # LC_BUILD_VERSION: platform, minos, …
            minos = struct.unpack_from("<I", binary, offset + 12)[0]
        elif cmd == 0x24:  # LC_VERSION_MIN_MACOSX: version, …
            minos = struct.unpack_from("<I", binary, offset + 8)[0]
        offset += size
    if minos is None:
        raise Failure(f"{target.triple}: the binary names no minimum macOS version.")
    major, minor = minos >> 16, (minos >> 8) & 0xFF
    # From macOS 11 on, pip only matches X_0.
    return f"macosx_{major}_{0 if major >= 11 else minor}_{target.arch}"


def elf_needed(binary: bytes) -> list[bytes]:
    """The DT_NEEDED entries of a 64-bit little-endian ELF file."""
    phoff, = struct.unpack_from("<Q", binary, 0x20)
    phentsize, phnum = struct.unpack_from("<HH", binary, 0x36)
    loads, dynamic = [], None
    for i in range(phnum):
        p_type, _, p_offset, p_vaddr, _, p_filesz = struct.unpack_from(
            "<IIQQQQ", binary, phoff + i * phentsize
        )
        if p_type == 1:  # PT_LOAD
            loads.append((p_vaddr, p_offset, p_filesz))
        elif p_type == 2:  # PT_DYNAMIC
            dynamic = (p_offset, p_filesz)
    if dynamic is None:
        return []  # statically linked
    entries, strtab = [], None
    for at in range(dynamic[0], dynamic[0] + dynamic[1], 16):
        tag, value = struct.unpack_from("<qQ", binary, at)
        if tag == 0:
            break
        if tag == 1:  # DT_NEEDED
            entries.append(value)
        elif tag == 5:  # DT_STRTAB, a virtual address
            strtab = value
    if strtab is None:
        raise Failure("the ELF file has a dynamic section without a string table.")
    base = next(
        (offset + strtab - vaddr for vaddr, offset, size in loads if vaddr <= strtab < vaddr + size),
        None,
    )
    if base is None:
        raise Failure("the ELF file's string table is outside its segments.")
    return [binary[base + e : binary.index(b"\0", base + e)] for e in entries]


def linux_tag(binary: bytes, target: Target) -> str:
    if binary[:4] != b"\x7fELF" or binary[4] != 2 or binary[5] != 1:
        raise Failure(f"{target.triple}: not a 64-bit little-endian ELF executable.")
    machine, = struct.unpack_from("<H", binary, 18)
    if machine != {"x86_64": 62, "aarch64": 183}[target.arch]:
        raise Failure(f"{target.triple}: the binary is for ELF machine {machine}.")
    for library in elf_needed(binary):
        if not ALLOWED_LIBRARIES.fullmatch(library):
            raise Failure(f"{target.triple}: needs {library.decode()}, which a wheel cannot.")
    glibc = [
        (int(major), int(minor))
        for major, minor in re.findall(rb"GLIBC_(\d+)\.(\d+)(?:\.\d+)?\0", binary)
    ]
    if target.system == "musllinux":
        if glibc:
            raise Failure(f"{target.triple}: the musl binary needs glibc symbols.")
        # Rust's musl targets link musl 1.2 statically.
        return f"musllinux_1_2_{target.arch}"
    # Rust's std needs glibc 2.17 at least; the build host can raise it (__libc_start_main@2.34).
    major, minor = max([(2, 17), *glibc])
    tag = f"manylinux_{major}_{minor}_{target.arch}"
    return f"{tag}.manylinux2014_{target.arch}" if (major, minor) == (2, 17) else tag


def windows_tag(binary: bytes, target: Target) -> str:
    pe, = struct.unpack_from("<I", binary, 0x3C)
    if binary[:2] != b"MZ" or binary[pe : pe + 4] != b"PE\0\0":
        raise Failure(f"{target.triple}: not a PE executable.")
    machine, = struct.unpack_from("<H", binary, pe + 4)
    if machine != 0x8664:
        raise Failure(f"{target.triple}: the binary is for PE machine {machine:#x}.")
    return "win_amd64"


def platform_tag(binary: bytes, target: Target) -> str:
    if target.system == "macos":
        return macos_tag(binary, target)
    if target.system == "windows":
        return windows_tag(binary, target)
    return linux_tag(binary, target)


# ─── dist's archives ──────────────────────────────────────────────────────────────────────────


def files_below(directory: Path) -> dict[str, Path]:
    return {path.name: path for path in sorted(directory.rglob("*")) if path.is_file()}


def dist_version(files: dict[str, Path]) -> str:
    """The kgdiff version every dist manifest below the dist dir names (exactly one)."""
    versions = set()
    for name, path in files.items():
        if name.endswith("-dist-manifest.json"):
            for release in json.loads(path.read_text("utf-8")).get("releases", []):
                if release.get("app_name") == "kgdiff" and release.get("app_version"):
                    versions.add(release["app_version"])
    if len(versions) != 1:
        raise Failure(f"the dist manifests name {sorted(versions) or 'no kgdiff version'}.")
    return versions.pop()


def binary_of(files: dict[str, Path], target: Target) -> bytes:
    archive, checksum = files.get(target.archive), files.get(f"{target.archive}.sha256")
    if archive is None or checksum is None:
        raise Failure(f"{target.archive} or its .sha256 is missing.")
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != checksum.read_text("utf-8").split()[0]:
        raise Failure(f"{target.archive} fails its checksum.")
    if target.system == "windows":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return z.read(target.executable)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as t:
        member = t.extractfile(f"kgdiff-{target.triple}/{target.executable}")
        if member is None:
            raise Failure(f"{target.archive} has no {target.executable}.")
        return member.read()


# ─── The wheel ────────────────────────────────────────────────────────────────────────────────


def metadata(project: dict, version: str) -> str:
    """Core metadata 2.4 of python/pyproject.toml's [project] table."""
    lines = [
        "Metadata-Version: 2.4",
        f"Name: {project['name']}",
        f"Version: {version}",
        f"Summary: {project['description']}",
        f"Keywords: {','.join(project['keywords'])}",
        *(f"Author: {author['name']}" for author in project["authors"]),
        f"License-Expression: {project['license']}",
        "License-File: LICENSE",
        *(f"Classifier: {c}" for c in project["classifiers"]),
        *(f"Project-URL: {label}, {url}" for label, url in project["urls"].items()),
        "Description-Content-Type: text/markdown",
    ]
    readme = (PYPROJECT.parent / project["readme"]).read_text("utf-8")
    return "\n".join(lines) + "\n\n" + readme


def record_hash(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={digest.decode()}"


def write_wheel(out: Path, project: dict, version: str, target: Target, binary: bytes) -> Path:
    tag = platform_tag(binary, target)
    name = project["name"]
    dist_info, data = f"{name}-{version}.dist-info", f"{name}-{version}.data"
    tags = [f"py3-none-{platform}" for platform in tag.split(".")]
    wheel = "".join(
        [
            "Wheel-Version: 1.0\n",
            "Generator: kgdiff (scripts/pypi-wheels.py)\n",
            "Root-Is-Purelib: false\n",
            *(f"Tag: {t}\n" for t in tags),
        ]
    )
    entries = [
        (f"{data}/scripts/{target.executable}", binary, 0o755),
        (f"{dist_info}/METADATA", metadata(project, version).encode(), 0o644),
        (f"{dist_info}/WHEEL", wheel.encode(), 0o644),
        (f"{dist_info}/licenses/LICENSE", (ROOT / "LICENSE").read_bytes(), 0o644),
    ]
    record = "".join(f"{path},{record_hash(body)},{len(body)}\n" for path, body, _ in entries)
    entries.append((f"{dist_info}/RECORD", f"{record}{dist_info}/RECORD,,\n".encode(), 0o644))
    path = out / f"{name}-{version}-py3-none-{tag}.whl"
    with zipfile.ZipFile(path, "w") as z:
        for member, body, mode in entries:
            # A fixed date and mode: identical inputs, identical wheels. pip and uv keep the
            # executable bit of the zip entry.
            info = zipfile.ZipInfo(member, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (0o100000 | mode) << 16
            info.create_system = 3  # Unix, so that the mode is read
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, body, compresslevel=9)
    return path


def build(dist: Path, out: Path, only: list[str]) -> list[Path]:
    project = tomllib.loads(PYPROJECT.read_text("utf-8"))["project"]
    version = project["version"]
    files = files_below(dist)
    built = dist_version(files)
    # A wheel says which kgdiff it holds by its version: never another release's binary.
    if pep440(built) != version:
        raise Failure(
            f"the archives hold kgdiff {built}, but python/pyproject.toml is at {version}."
        )
    unknown = set(only) - {t.triple for t in TARGETS}
    if unknown:
        raise Failure(f"unknown targets: {', '.join(sorted(unknown))}.")
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob(f"{project['name']}-*.whl"):
        old.unlink()
    targets = [t for t in TARGETS if not only or t.triple in only]
    return [write_wheel(out, project, version, t, binary_of(files, t)) for t in targets]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("dist", type=Path)
    parser.add_argument("out", type=Path, nargs="?", default=ROOT / "target" / "pypi")
    parser.add_argument("--target", action="append", default=[], metavar="TRIPLE")
    args = parser.parse_args()
    try:
        for wheel in build(args.dist.resolve(), args.out.resolve(), args.target):
            print(wheel)
    except Failure as failure:
        print(f"pypi-wheels: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
