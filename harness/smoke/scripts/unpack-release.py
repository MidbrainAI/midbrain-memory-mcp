"""Unpack bounded npm release archives without links, devices or traversal."""
import pathlib
import shutil
import sys
import tarfile

archive, destination = sys.argv[1:]
root = pathlib.Path(destination)
with tarfile.open(archive, "r:gz") as bundle:
    members = []
    seen = set()
    size = 0
    for member in bundle:
        name = member.name.rstrip("/")
        parts = name.split("/")
        if (not parts or parts[0] != "package" or
                any(part in ("", ".", "..") for part in parts) or
                "\\" in name or ":" in name or
                not (member.isdir() or member.isfile()) or member.size < 0 or name in seen):
            raise ValueError("Unsafe or duplicate npm archive member")
        size += member.size
        if len(members) >= 10000 or size > 512 * 1024 * 1024:
            raise ValueError("Release archive exceeds extraction limits")
        seen.add(name)
        members.append(member)
    if "package/package.json" not in seen:
        raise ValueError("Archive has no npm package manifest")
    for member in members:
        target = root.joinpath(*member.name.rstrip("/").split("/"))
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
        else:
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with bundle.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o700 if member.mode & 0o111 else 0o600)
