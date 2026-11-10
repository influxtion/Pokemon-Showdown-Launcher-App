"""Check builder boundaries without downloading or compiling the runtime."""

import importlib.util
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "laplace" / "build-python.py"
SPEC = importlib.util.spec_from_file_location("laplace_build_python", SCRIPT)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class BuilderTests(unittest.TestCase):
    def test_pending_location_excludes_active_runtime_and_parent_paths(self):
        pending = builder.VENDOR / "pending-builder-boundary-test"
        self.assertEqual(builder.pending_path(pending), pending)
        for path in (builder.VENDOR / "dist", builder.VENDOR / "nested" / "pending", builder.ROOT / "pending",
                     builder.VENDOR / "pending-x" / ".." / "pending-y"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                builder.pending_path(path)

    def test_extract_excludes_build_tools(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "archive.tar"
            payload = b"test"
            with tarfile.open(archive, "w") as output:
                for path in ("python/python.exe", "python/Lib/site-packages/pip/__init__.py"):
                    entry = tarfile.TarInfo(path)
                    entry.size = len(payload)
                    output.addfile(entry, io.BytesIO(payload))
            target = root / "extracted"
            builder.extract_archive(archive, target, skip=(PurePosixPath("python/Lib/site-packages"),))
            self.assertEqual((target / "python/python.exe").read_bytes(), payload)
            self.assertFalse((target / "python/Lib/site-packages").exists())

    def test_extract_rejects_traversal_and_links(self):
        for path, kind in (("../external", tarfile.REGTYPE), ("C:/external", tarfile.REGTYPE),
                           ("in-tree-link", tarfile.SYMTYPE)):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive = root / "archive.tar"
                with tarfile.open(archive, "w") as output:
                    entry = tarfile.TarInfo(path)
                    entry.type = kind
                    output.addfile(entry)
                with self.assertRaises(ValueError):
                    builder.extract_archive(archive, root / "extracted")

    def test_visual_cpp_stage_checks_members_and_extracts_only_locked_x64_files(self):
        def fake_dll(machine):
            data = bytearray(96)
            data[:2] = b"MZ"
            data[60:64] = (64).to_bytes(4, "little")
            data[64:68] = b"PE\0\0"
            data[68:70] = machine.to_bytes(2, "little")
            data[86:88] = b"\x00\x20"
            data[88:90] = b"\x0b\x02"
            return data

        def digest(data):
            return hashlib.sha256(data).hexdigest()

        for failure, message in ((None, None), ("hash", "checksum mismatch"),
                                 ("machine", "not an x64 DLL"), ("missing", "missing a locked member")):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                target = root / "python"
                target.mkdir()
                archive = root / "runtime.vsix"
                metadata = json.dumps({"id": "CRT.package", "version": "14.51.0"}).encode()
                entry = {"directory": "Contents/VC/Redist/MSVC/14.51.0/x64/Microsoft.VC145.CRT",
                         "package": "CRT.package", "version": "14.51.0", "manifestSha256": digest(metadata),
                         "dlls": {}}
                with zipfile.ZipFile(archive, "w") as bundle:
                    bundle.writestr("manifest.json", metadata)
                    bundle.writestr("Contents/VC/Redist/MSVC/14.51.0/debug_nonredist/msvcp140d.dll", b"debug")
                    bundle.writestr("../unapproved.dll", b"unapproved")
                    for index, name in enumerate(builder.VC_RUNTIME_DLLS):
                        contents = fake_dll(0x14C if failure == "machine" and index == 0 else 0x8664)
                        entry["dlls"][name] = "0" * 64 if failure == "hash" and index == 0 else digest(contents)
                        if failure != "missing" or index != 0:
                            bundle.writestr(f"{entry['directory']}/{name}", contents)
                if failure:
                    with self.assertRaisesRegex(ValueError, message):
                        builder.extract_visual_cpp_runtime(archive, target, entry)
                    self.assertEqual(list(target.iterdir()), [])
                else:
                    builder.extract_visual_cpp_runtime(archive, target, entry)
                    self.assertEqual({file.name for file in target.iterdir()},
                                     {*builder.VC_RUNTIME_DLLS, "visual-cpp-package.json"})
                    self.assertEqual((target / "visual-cpp-package.json").read_bytes(), metadata)
                    self.assertFalse((root / "unapproved.dll").exists())


if __name__ == "__main__":
    unittest.main()
