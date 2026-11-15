#!/usr/bin/env python3
"""Merges our config/ files into the lumbridge-app home's own files.

  config/keys.json      -> keys.json      (per section, per key)
  config/programs.json  -> programs.json  (per entry in "programs"; list items in
                                           "shells" / "interpreters")

Both home files are the person's (lumbridge-app doesn't replace them), so we never
overwrite them: our entries are ADDED where the name is free, left alone where
they already match, and reported (not changed) where the person has something
else there. Nothing is deleted or reordered. A backup (<file>.pre-lumbridge) is
written once, before the first change to an existing file. A home file that
isn't valid JSON is reported and left untouched. Running it twice is a no-op.

A private/config/ folder beside config/, when there is one, is merged after it.

Stdlib only, Python 3.9 (macOS /usr/bin/python3 runs it via
install.sh --host). LUMBRIDGE_APP_HOME picks the home (default ~/.config/lumbridge-app).
A config file that isn't there (an older copy on another host) is skipped.
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.environ.get("LUMBRIDGE_APP_HOME", os.path.expanduser("~/.config/lumbridge-app"))


def merge_keys(ours, theirs):
    """keys.json: {section: {key: action}}."""
    added, conflicts = [], []
    for section, binds in ours.items():
        have = theirs.setdefault(section, {})
        for key, action in binds.items():
            if key not in have:
                have[key] = action
                added.append("%s %s -> %s" % (section, key, action))
            elif have[key] != action:
                conflicts.append("%s %s: is '%s', ours '%s' (left as is)" % (section, key, have[key], action))
    return added, conflicts


def merge_programs(ours, theirs):
    """programs.json: {"programs": {key: entry}, "shells": [..], "interpreters": [..]}.
    An entry is ours or theirs as a whole: we don't merge fields into theirs."""
    added, conflicts = [], []
    for section, value in ours.items():
        if isinstance(value, dict):
            have = theirs.setdefault(section, {})
            for key, entry in value.items():
                if key not in have:
                    have[key] = entry
                    added.append("%s %s" % (section, key))
                elif have[key] != entry:
                    conflicts.append("%s %s: is %s, ours %s (left as is)"
                                     % (section, key, json.dumps(have[key]), json.dumps(entry)))
        elif isinstance(value, list):
            have = theirs.setdefault(section, [])
            for item in value:
                if item not in have:
                    have.append(item)
                    added.append("%s %s" % (section, item))
    return added, conflicts


def merge(name, merger, folder="config"):
    src = os.path.join(ROOT, folder, name)
    label = name[:-len(".json")]
    if not os.path.exists(src):
        if folder == "config":
            print("%s: no config/%s here, skipped" % (label, name))
        return 0
    with open(src) as f:
        ours = json.load(f)
    path = os.path.join(HOME, name)
    theirs = {}
    if os.path.exists(path):
        try:
            with open(path) as f:
                theirs = json.load(f)
        except ValueError as e:
            print("%s: %s is not valid JSON (%s), left as is" % (label, path, e))
            return 1
        if not isinstance(theirs, dict):
            print("%s: %s is not a JSON object, left as is" % (label, path))
            return 1
    added, conflicts = merger(ours, theirs)
    for c in conflicts:
        print("%s: conflict %s" % (label, c))
    if not added:
        print("%s: nothing to add" % label)
        return 0
    backup = path + ".pre-lumbridge"
    if os.path.exists(path) and not os.path.exists(backup):
        shutil.copy2(path, backup)
        print("%s: backup %s" % (label, backup))
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(theirs, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    for a in added:
        print("%s: added %s" % (label, a))
    return 0


def main():
    rc = 0
    for folder in ("config", os.path.join("private", "config")):
        rc |= merge("keys.json", merge_keys, folder)
        rc |= merge("programs.json", merge_programs, folder)
    return rc


if __name__ == "__main__":
    sys.exit(main())
