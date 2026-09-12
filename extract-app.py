#!/usr/bin/env python3
"""Extract the app's script block so the Node test suite can run it headless."""
import os, re
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
html = open(os.path.join(root, "beatforge.html")).read()
js = re.findall(r"<script>(.*?)</script>", html, re.S)[-1]
os.makedirs(os.path.join(root, "build"), exist_ok=True)
open(os.path.join(root, "build", "app.js"), "w").write(js)
print(f"extracted {len(js)} bytes of app JS -> build/app.js")
