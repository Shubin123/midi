import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tarfile


root = Path(__file__).resolve().parent.parent
if sys.version_info < (3, 12):
    raise SystemExit("Python 3.12 or later is required for safe archive extraction")
archive = root / "vendor/unicorn/source.tar.gz"
expected = "ff976b48a43115f20e440fe75402fb3049043f93044428d05e9432652de94505"
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit("Unicorn source archive failed its SHA-256 integrity check")
if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 native/build-unicorn.py NEW_BUILD_DIRECTORY")
destination = Path(sys.argv[1]).resolve()
destination.mkdir(parents=True, exist_ok=False)
with tarfile.open(archive, "r:gz") as source:
    source.extractall(destination, filter="data")
environment = dict(os.environ)
environment.setdefault("EMSDK_PYTHON", sys.executable)
subprocess.run(
    [sys.executable, "-c", 'import build; build.generateConstants(); build.compileUnicorn(["x86"])'],
    cwd=destination, env=environment, check=True,
)
engine = destination / "dist/unicorn_x86.js"
print(f"Built {engine}")
print(f"SHA-256: {hashlib.sha256(engine.read_bytes()).hexdigest()}")
