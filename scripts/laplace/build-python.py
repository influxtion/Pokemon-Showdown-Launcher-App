"""Build the locked Windows x64 Python and Laplace components in a pending runtime."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import tomllib
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "vendor" / "laplace"
LOCK = VENDOR / "runtime-lock.json"
CACHE = ROOT / "out" / "laplace"
COMPONENTS = ("python", "laplace", "python-build.json")
ARCHIVE_HOSTS = {"github.com", "files.pythonhosted.org", "download.pytorch.org", "download.visualstudio.microsoft.com"}
VC_RUNTIME_DLLS = ("msvcp140.dll", "msvcp140_atomic_wait.dll", "vcruntime140.dll", "vcruntime140_1.dll")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def command(args, *, env, cwd=None, capture=False, stdout=None):
    return subprocess.run(args, cwd=cwd, env=env, check=True, text=True,
                          capture_output=capture, stdout=stdout).stdout


def contained_path(path):
    resolved = path.resolve()
    if resolved != path.absolute() or not resolved.is_relative_to(ROOT):
        raise ValueError("Build directory must stay inside this checkout without aliases.")
    return resolved


def pending_path(path):
    output = contained_path(path)
    if output.parent != VENDOR or not re.fullmatch(r"pending(?:-[A-Za-z0-9_-]{1,80})?", output.name):
        raise ValueError("Use a pending directory directly under vendor/laplace.")
    for name in COMPONENTS:
        if (output / name).exists() or (output / name).is_symlink():
            raise ValueError(f"Pending runtime already contains {name}.")
    return output


def pinned_artifact(entry, directory):
    from urllib.parse import urlsplit

    name = entry["filename"]
    url = urlsplit(entry["url"])
    sha256 = entry["sha256"]
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,180}", name)
            or not re.fullmatch(r"[a-f0-9]{64}", sha256)
            or url.scheme != "https" or url.netloc not in ARCHIVE_HOSTS):
        raise ValueError("Invalid locked artifact.")
    target = contained_path(directory / name)
    if not target.exists():
        print(f"Downloading {name}", flush=True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with tempfile.NamedTemporaryFile(dir=directory, prefix="download-", delete=False) as stream:
            temporary = Path(stream.name)
        try:
            with opener.open(entry["url"], timeout=60) as response, temporary.open("wb") as stream:
                shutil.copyfileobj(response, stream)
            if digest(temporary) != sha256:
                raise ValueError(f"Download checksum mismatch for {name}.")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    if digest(target) != sha256:
        raise ValueError(f"Cached checksum mismatch for {name}.")
    return target


def extract_archive(archive, target, skip=()):
    def select(member):
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or "\\" in member.name or ":" in member.name:
            raise ValueError("Unsafe archive path.")
        if not (member.isfile() or member.isdir()):
            raise ValueError("Archive contains a special file.")
        return not any(path.is_relative_to(prefix) for prefix in skip)

    with tarfile.open(archive) as bundle:
        bundle.extractall(target, members=(member for member in bundle if select(member)), filter="data")


def extract_visual_cpp_runtime(archive, target, entry):
    directory = entry["directory"]
    if (not re.fullmatch(r"Contents/VC/Redist/MSVC/\d+\.\d+\.\d+/x64/Microsoft\.VC\d+\.CRT", directory)
            or set(entry["dlls"]) != set(VC_RUNTIME_DLLS)):
        raise ValueError("Invalid locked Visual C++ runtime paths.")
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Visual C++ archive contains duplicate paths.")
        try:
            metadata = bundle.read("manifest.json")
            files = {name: bundle.read(f"{directory}/{name}") for name in VC_RUNTIME_DLLS}
        except KeyError as error:
            raise ValueError("Visual C++ archive is missing a locked member.") from error
    if hashlib.sha256(metadata).hexdigest() != entry["manifestSha256"]:
        raise ValueError("Visual C++ package metadata checksum mismatch.")
    package = json.loads(metadata)
    if package.get("id") != entry["package"] or package.get("version") != entry["version"]:
        raise ValueError("Unexpected Visual C++ package identity.")
    for name, contents in files.items():
        if hashlib.sha256(contents).hexdigest() != entry["dlls"][name]:
            raise ValueError(f"Visual C++ runtime checksum mismatch for {name}.")
        pe = int.from_bytes(contents[60:64], "little")
        characteristics = int.from_bytes(contents[pe + 22:pe + 24], "little")
        if (contents[:2] != b"MZ" or not 64 <= pe <= len(contents) - 26
                or contents[pe:pe + 6] != b"PE\0\0\x64\x86" or contents[pe + 24:pe + 26] != b"\x0b\x02"
                or not characteristics & 0x2000):
            raise ValueError(f"Visual C++ runtime member {name} is not an x64 DLL.")
    for name, contents in files.items():
        (target / name).write_bytes(contents)
    (target / "visual-cpp-package.json").write_bytes(metadata)


def host_environment():
    keys = ("SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATH", "PATHEXT",
            "INCLUDE", "LIB", "LIBPATH", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN")
    environment = {key: os.environ[key] for key in keys if key in os.environ}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0",
                       PIP_CONFIG_FILE=os.devnull)
    return environment


def rust_toolchain(version, env):
    rustc = Path(command(["rustup", "which", "rustc"], env=env, capture=True).strip())
    cargo = Path(command(["rustup", "which", "cargo"], env=env, capture=True).strip())
    info = command([rustc, "--version", "--verbose"], env=env, capture=True).splitlines()
    host = next((line.removeprefix("host: ") for line in info if line.startswith("host: ")), "")
    cargo_version = command([cargo, "--version"], env=env, capture=True).strip()
    if (f"release: {version}" not in info or not cargo_version.startswith(f"cargo {version} ")
            or host not in {"x86_64-pc-windows-gnu", "x86_64-pc-windows-msvc"}):
        raise ValueError(f"Select Rust and Cargo {version} for a Windows x64 target.")
    compiler = "gcc" if host.endswith("gnu") else "cl"
    compiler_path = shutil.which(compiler, path=env.get("PATH"))
    if not compiler_path:
        raise ValueError(f"Put the Windows x64 {compiler} toolchain on PATH.")
    if compiler == "gcc":
        compiler_version = command([compiler_path, "--version"], env=env, capture=True).splitlines()[0]
        machine = command([compiler_path, "-dumpmachine"], env=env, capture=True).strip()
        if machine != "x86_64-w64-mingw32":
            raise ValueError("GCC must target Windows x64.")
    else:
        result = subprocess.run([compiler_path], env=env, capture_output=True, text=True)
        compiler_version = (result.stderr or result.stdout).splitlines()[0]
    env["PATH"] = os.pathsep.join((str(rustc.parent), env.get("PATH", "")))
    env["RUSTC"] = str(rustc)
    return cargo, {"target": host, "rustc": info[0], "cargo": cargo_version, "compiler": compiler_version}


def install_wheels(python, packages, wheelhouse, requirements, env, target=None):
    lines = []
    for package in packages:
        name, version, sha256 = package["name"], package["version"], package["sha256"]
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name)
                or not re.fullmatch(r"[0-9][A-Za-z0-9.+!-]*", version)
                or not re.fullmatch(r"[a-f0-9]{64}", sha256)):
            raise ValueError("Invalid locked wheel requirement.")
        lines.append(f"{name}=={version} --hash=sha256:{sha256}")
    requirements.write_text("\n".join(lines) + "\n", encoding="utf-8")
    args = [python, "-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "install",
            "--no-index", "--no-deps", "--no-compile", "--require-hashes", "--find-links", wheelhouse,
            "-r", requirements]
    if target is not None:
        args.extend(("--target", target))
    command(args, env=env)


def stage_laplace(source, entry, temp, env):
    revision = entry["revision"]
    git = ["git", "-C", source]
    if (not re.fullmatch(r"[a-f0-9]{40}", revision)
            or command([*git, "rev-parse", "HEAD"], env=env, capture=True).strip() != revision
            or command([*git, "status", "--porcelain"], env=env, capture=True).strip()):
        raise ValueError("Use a clean Laplace checkout at the locked revision.")
    archive = temp / "laplace-source.tar"
    with archive.open("wb") as stream:
        command([*git, "archive", "--format=tar", revision, "src", "data", "models/value_net.pt",
                 "LICENSE", "pyproject.toml"], env=env, stdout=stream)
    staged = temp / "laplace"
    extract_archive(archive, staged)
    if digest(staged / "models" / "value_net.pt") != entry["modelSha256"]:
        raise ValueError("Locked Laplace model checksum mismatch.")
    with (staged / "pyproject.toml").open("rb") as stream:
        return tomllib.load(stream)["project"]["version"]


def build_engine(lock, temp, python, wheelhouse, env):
    engine, maturin = lock["engine"], lock["maturin"]
    maturin_wheel = pinned_artifact(maturin, CACHE)
    shutil.copyfile(maturin_wheel, wheelhouse / maturin_wheel.name)
    install_wheels(python, [{"name": "maturin", **maturin}], wheelhouse, temp / "maturin.txt", env)

    archive = pinned_artifact(engine, CACHE)
    extract_archive(archive, temp / "engine-source")
    source = temp / "engine-source" / f"poke_engine-{engine['version']}"
    cargo_lock = digest(source / "Cargo.lock")
    if engine["features"] != ["poke-engine/terastallization"] or engine["defaultFeatures"] is not False:
        raise ValueError("Expected the locked stock Gen 9 engine features.")
    cargo, toolchain = rust_toolchain(engine["rustVersion"], env)
    env["CARGO_HOME"] = str(contained_path(CACHE / "cargo-home"))
    env["CARGO_TARGET_DIR"] = str(temp / "cargo-target")
    command([cargo, "fetch", "--locked", "--target", toolchain["target"]], cwd=source, env=env)
    engine_wheels = temp / "engine-wheels"
    command([python.parent / "maturin.exe", "build", "--release", "--interpreter", python,
             "--target", toolchain["target"], "--out", engine_wheels, "--locked", "--offline",
             "--features", engine["features"][0], "--no-default-features"], cwd=source, env=env)
    if digest(source / "Cargo.lock") != cargo_lock:
        raise ValueError("Engine build modified Cargo.lock.")
    wheels = list(engine_wheels.glob("*.whl"))
    if len(wheels) != 1 or not wheels[0].name.endswith("-cp312-cp312-win_amd64.whl"):
        raise ValueError("Expected one native Windows x64 CPython 3.12 engine wheel.")
    wheel = wheels[0]
    wheel.replace(wheelhouse / wheel.name)
    package = {"name": "poke-engine", "version": engine["version"], "filename": wheel.name,
               "sha256": digest(wheelhouse / wheel.name)}
    provenance = {"sourceSha256": engine["sha256"], "cargoLockSha256": cargo_lock,
                  "features": engine["features"], "defaultFeatures": False, "toolchain": toolchain,
                  "maturin": {"version": maturin["version"], "sha256": maturin["sha256"]}, "wheel": package}
    return package, provenance


def validate_python(python, stage, lock, packages, laplace_version, env):
    env = {key: value for key, value in env.items() if key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC")}
    windows = Path(env["SystemRoot"])
    env["PATH"] = os.pathsep.join((str(windows / "System32"), str(windows)))
    expected = {item["name"]: item["version"] for item in packages}
    expected["laplace"] = laplace_version
    check = textwrap.dedent("""
        import ctypes
        from ctypes import wintypes
        from importlib.metadata import distributions
        import json
        from pathlib import Path
        import platform
        import re
        import sys

        import numpy, torch, poke_env, websockets
        from poke_engine import State, monte_carlo_tree_search

        root = Path(sys.argv[1])
        paths = ('python', 'python/DLLs', 'python/Lib', 'python/Lib/site-packages', 'laplace/src')
        assert [Path(path).resolve() for path in sys.path] == [root / path for path in paths]
        assert platform.python_version() == sys.argv[3]

        def key(name):
            return re.sub(r'[-_.]+', '-', name).lower()

        expected = sorted((key(name), version) for name, version in json.loads(sys.argv[2]).items())
        installed = sorted((key(dist.metadata['Name']), dist.version) for dist in distributions())
        assert installed == expected
        kernel = ctypes.WinDLL('kernel32.dll', use_last_error=True)
        kernel.GetModuleHandleW.argtypes = (wintypes.LPCWSTR,)
        kernel.GetModuleHandleW.restype = wintypes.HMODULE
        kernel.GetModuleFileNameW.argtypes = (wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD)
        kernel.GetModuleFileNameW.restype = wintypes.DWORD
        for dll in json.loads(sys.argv[4]):
            handle = kernel.GetModuleHandleW(dll)
            loaded = ctypes.create_unicode_buffer(32768)
            assert handle and 0 < kernel.GetModuleFileNameW(handle, loaded, len(loaded)) < len(loaded), dll
            assert Path(loaded.value).resolve() == root / 'python' / dll, f'{dll} did not load app-local'
        assert monte_carlo_tree_search(State(), duration_ms=20, threads=1).total_visits > 0
    """)
    command([python, "-I", "-B", "-c", check, stage, json.dumps(expected), lock["python"]["version"],
             json.dumps(VC_RUNTIME_DLLS)], env=env)


def build(source, output):
    locked_bytes = LOCK.read_bytes()
    lock = json.loads(locked_bytes)
    if lock["version"] != 1 or sys.platform != "win32" or sys.version.split()[0] != lock["python"]["version"]:
        raise ValueError("Use the locked Windows standalone Python to build this runtime.")
    env = host_environment()
    cache = contained_path(CACHE)
    wheel_cache = contained_path(CACHE / "wheels")
    wheel_cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache, prefix="python-build-") as work:
        temp = contained_path(Path(work))
        laplace_version = stage_laplace(source, lock["laplace"], temp, env)
        wheelhouse = temp / "wheelhouse"
        wheelhouse.mkdir()
        for item in lock["wheels"]:
            wheel = pinned_artifact(item, wheel_cache)
            shutil.copyfile(wheel, wheelhouse / wheel.name)
        command([sys.executable, "-I", "-B", "-m", "venv", temp / "build-venv"], env=env)
        python = temp / "build-venv" / "Scripts" / "python.exe"
        engine, provenance = build_engine(lock, temp, python, wheelhouse, env)

        archive = pinned_artifact(lock["python"], cache)
        skip = tuple(PurePosixPath(path) for path in ("python/Scripts", "python/Lib/site-packages",
                                                      "python/Lib/ensurepip", "python/Lib/__pycache__"))
        extract_archive(archive, temp, skip=skip)
        staged_python = temp / "python"
        visual_cpp = lock["visualCppRuntime"]
        extract_visual_cpp_runtime(pinned_artifact(visual_cpp, cache), staged_python, visual_cpp)
        site = staged_python / "Lib" / "site-packages"
        packages = [*lock["wheels"], engine]
        install_wheels(python, packages, wheelhouse, temp / "runtime.txt", env, target=site)
        for directory in (site / "bin", site / "Scripts"):
            if directory.exists():
                shutil.rmtree(contained_path(directory))
        if any(site.glob("*.dist-info/direct_url.json")) or (site / "pip").exists():
            raise ValueError("Build-only package metadata leaked into the runtime.")
        info = site / f"laplace-{laplace_version}.dist-info"
        (info / "licenses").mkdir(parents=True)
        shutil.copyfile(temp / "laplace" / "LICENSE", info / "licenses" / "LICENSE")
        (info / "METADATA").write_text(f"Metadata-Version: 2.4\nName: laplace\nVersion: {laplace_version}\n"
                                       "License-Expression: MIT\nLicense-File: LICENSE\n", encoding="utf-8")
        (staged_python / "python312._pth").write_text(".\nDLLs\nLib\nLib/site-packages\n../laplace/src\n",
                                                     encoding="utf-8")
        validate_python(staged_python / "python.exe", temp, lock, packages, laplace_version, env)
        manifest = {"version": 1, "lockSha256": hashlib.sha256(locked_bytes).hexdigest(), "python": lock["python"],
                    "laplace": {**lock["laplace"], "version": laplace_version},
                    "runtimeWheels": lock["wheels"], "engine": provenance, "visualCppRuntime": visual_cpp}
        (temp / "python-build.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        output = pending_path(output)
        output.mkdir(exist_ok=True)
        for name in COMPONENTS:
            (temp / name).rename(output / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    args = parser.parse_args()
    build(args.source.resolve(strict=True), pending_path(args.output))


if __name__ == "__main__":
    main()
