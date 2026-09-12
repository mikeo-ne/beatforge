#!/usr/bin/env python3
"""Extract the app's script block so the Node test suite can run it headless.

Writes <repo>/build/app.js from the single self-contained <script> block in
beatforge.html. The repo root is found by walking up from this file, so the
script works no matter which directory it is invoked from.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def find_root(start):
    d = start
    while True:
        if os.path.isfile(os.path.join(d, "beatforge.html")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


root = find_root(HERE)
if root is None:
    sys.exit("extract-app.py: could not find beatforge.html above " + HERE)

html = open(os.path.join(root, "beatforge.html")).read()
blocks = re.findall(r"<script>(.*?)</script>", html, re.S)
if not blocks:
    sys.exit("extract-app.py: no <script> block found in beatforge.html")
js = blocks[-1]

build = os.path.join(root, "build")
os.makedirs(build, exist_ok=True)
out = os.path.join(build, "app.js")
open(out, "w").write(js)
print(f"extracted {len(js)} bytes of app JS -> {os.path.relpath(out, root)}")
