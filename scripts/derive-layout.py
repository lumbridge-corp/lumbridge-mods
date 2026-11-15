#!/usr/bin/env python3
"""Rebuilds layouts/lumbridge.json from lumbridge-app's shipped `main` layout.

Shipped layouts are replaced on every app start, and a personal copy never
gets upstream's changes. So ours is DERIVED: take the current shipped main,
apply our edits (below), write layouts/lumbridge.json (and, when the private/
folder is there, private/layouts/lumbridge.json with the private edits too). Re-run after a lumbridge-app
update changes main (scripts/check.sh warns when main changed since).

Edits live in EDITS; each mod's spec says which block it wants.
"""
import hashlib, json, os, subprocess, sys

HOME = os.environ.get("LUMBRIDGE_APP_HOME", os.path.expanduser("~/.config/lumbridge-app"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def find(node, ident):
    if node.get("id") == ident:
        return node
    for child in node.get("children", []):
        hit = find(child, ident)
        if hit:
            return hit
    return None

def edits(layout):
    # Sidebar a little wider.
    find(layout, "sidebar")["size"] = {"px": 300}
    # Favorites under Spaces and Agents: always shown, because mod commands only reach shown copies.
    find(layout, "sidebar-lists")["children"].append(
        {"id": "favorites", "type": "block", "size": {"weight": 1}, "min": 70, "content": {"mod": "lumbridge-favorites"}})

def private_edits(layout):
    # private/ (our own machines only, not in the public tree): the fleet mods.
    layout["terminal_menu"] = "lumbridge-menu"
    lists = find(layout, "sidebar-lists")["children"]
    lists.append({"id": "fleet", "type": "block", "size": {"weight": 1}, "min": 90, "content": {"mod": "lumbridge-fleet"}})
    lists.insert(0, {"id": "needs-you", "type": "block", "size": {"px": 120}, "min": 60, "content": {"mod": "lumbridge-needs-you"}})

def write(layout, folder, raw, version):
    out = os.path.join(folder, "lumbridge.json")
    with open(out, "w") as f:
        json.dump(layout, f, indent=2)
        f.write("\n")
    # Which shipped main it came from, for check.sh's drift warning. Dot-file: never installed.
    digest = hashlib.sha256(raw).hexdigest()[:16]
    with open(os.path.join(folder, ".lumbridge.derived.json"), "w") as f:
        json.dump({"from": "main", "main_sha256": digest, "app_version": version}, f, indent=2)
        f.write("\n")
    print(f"wrote {os.path.relpath(out, ROOT)} from main {digest} (lumbridge-app {version})")

def main():
    raw = open(os.path.join(HOME, "layouts", "main.json"), "rb").read()
    layout = json.loads(raw)
    edits(layout)
    version = subprocess.run(["lumbridge-app", "--version"], capture_output=True, text=True).stdout.split()[-1]
    # lumbridge-app validates cloned_from strictly: exactly {name, version}.
    layout["cloned_from"] = {"name": "main", "version": version}
    write(layout, os.path.join(ROOT, "layouts"), raw, version)
    private = os.path.join(ROOT, "private", "layouts")
    if os.path.isdir(private):
        private_edits(layout)
        write(layout, private, raw, version)

if __name__ == "__main__":
    sys.exit(main())
