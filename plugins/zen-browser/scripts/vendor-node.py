"""Maintainer-only: vendor the pinned official Windows runtime; never run at MCP startup."""
import hashlib
import json
from pathlib import Path
import urllib.request
import zipfile

VERSION = "24.21.0"
ARCHIVE_HASH = "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"
NODE_HASH = "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32"
ROOT = Path(__file__).resolve().parent.parent
URL = f"https://nodejs.org/dist/v{VERSION}/node-v{VERSION}-win-x64.zip"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    archive = ROOT / ".artifacts" / "runtime-downloads" / f"node-v{VERSION}-win-x64.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        with urllib.request.urlopen(URL, timeout=40) as response:
            data = response.read(70_000_000)
        if sha(data) != ARCHIVE_HASH:
            raise RuntimeError("The official runtime archive did not match the pinned SHA-256")
        archive.write_bytes(data)
    if sha(archive.read_bytes()) != ARCHIVE_HASH:
        raise RuntimeError("The cached archive does not match the pinned SHA-256")
    with zipfile.ZipFile(archive) as bundle:
        executable = bundle.read(f"node-v{VERSION}-win-x64/node.exe")
        license_text = bundle.read(f"node-v{VERSION}-win-x64/LICENSE")
    if sha(executable) != NODE_HASH:
        raise RuntimeError("The runtime executable did not match the official SHA-256")
    if len(executable) >= 100 * 1024 * 1024:
        raise RuntimeError("The runtime exceeds this repository's single-file distribution limit")
    output = ROOT / "runtime"
    output.mkdir(exist_ok=True)
    (output / "node.exe").write_bytes(executable)
    (output / "LICENSE.node.txt").write_bytes(license_text)
    (output / "manifest.json").write_text(json.dumps({
        "name": "Node.js", "version": VERSION, "platform": "win32", "arch": "x64",
        "source": URL, "archiveSha256": ARCHIVE_HASH,
        "executable": "node.exe", "sha256": NODE_HASH, "bytes": len(executable),
        "license": "LICENSE.node.txt", "licenseSha256": sha(license_text)
    }, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"version": VERSION, "bytes": len(executable), "sha256": NODE_HASH}))


if __name__ == "__main__":
    main()
