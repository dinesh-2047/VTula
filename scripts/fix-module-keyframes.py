"""
One-off codemod: repair dead animation references in CSS Modules.

CSS Modules rewrites the animation-name identifier in an `animation:` declaration
into the module's own scope. Every `*.module.css` in this project referenced
keyframes that are only defined in `globals.css`, so those references resolved to
scoped names that do not exist — meaning no loading spinner spun, no page
entrance animated, and no background orb floated anywhere in the app.

The fix is `animation: global(name) ...`, which the bundled
postcss-modules-local-by-default unwraps without scoping. Keyframes a module
defines for itself are left bare, because those *should* be scoped.

Kept in the repo as a record of what was changed and why; it is idempotent, so
re-running it after adding a new module is safe.
"""

import glob
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def keyframe_names(text):
    return set(re.findall(r"@keyframes\s+([A-Za-z_][\w-]*)", text))


def main():
    globals_path = os.path.join(ROOT, "src", "app", "globals.css")
    global_kf = keyframe_names(io.open(globals_path, encoding="utf-8").read())
    print("global keyframes: " + " ".join(sorted(global_kf)))
    print("")

    changed = 0
    for path in sorted(glob.glob(os.path.join(ROOT, "src", "**", "*.module.css"), recursive=True)):
        source = io.open(path, encoding="utf-8").read()
        local_kf = keyframe_names(source)
        updated = source
        wrapped = []
        skipped = []

        for name in sorted(global_kf):
            if name in local_kf:
                skipped.append(name)
                continue
            pattern = re.compile(r"(animation(?:-name)?:\s*)" + re.escape(name) + r"\b")
            updated, count = pattern.subn(r"\1global(" + name + ")", updated)
            if count:
                wrapped.append("%s x%d" % (name, count))

        # Anything left bare that is defined neither locally nor globally is dead
        # whatever we do, so surface it rather than silently "fixing" it.
        for match in re.finditer(r"animation(?:-name)?:\s*(?!global\()([A-Za-z_][\w-]*)", updated):
            name = match.group(1)
            if name not in local_kf and name not in global_kf:
                print("  !! %s: '%s' is defined nowhere" % (relative(path), name))

        if updated != source:
            io.open(path, "w", encoding="utf-8", newline="").write(updated)
            changed += 1
            note = ""
            if skipped:
                note = "  [local, left bare: %s]" % ", ".join(skipped)
            print("%-56s %s%s" % (relative(path), "; ".join(wrapped), note))

    print("")
    print("files changed: %d" % changed)
    return 0


def relative(path):
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


if __name__ == "__main__":
    sys.exit(main())
