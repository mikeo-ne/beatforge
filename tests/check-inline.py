#!/usr/bin/env python3
"""Check that local-engine.js is still the in-browser analyser that ships inside beatforge.html.

README documents local-engine.js as the *source* for the analyser that is inlined into the
single-file app. If the two drift, the page keeps working but the file nobody reads is a lie,
so the suite fails loudly instead.

Fix a failure by copying the changed analyser back into local-engine.js (or re-inlining
local-engine.js into the HTML's <script> block) until they match again.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

html = open(os.path.join(ROOT, "beatforge.html"), encoding="utf-8").read()
engine = open(os.path.join(ROOT, "local-engine.js"), encoding="utf-8").read()

blocks = re.findall(r"<script>(.*?)</script>", html, re.S)
if not blocks:
    sys.exit("check-inline.py: beatforge.html has no <script> block")

app = blocks[-1]
if engine.strip() in app:
    print(f"  local-engine.js ({len(engine)} bytes) is inlined verbatim in beatforge.html")
    sys.exit(0)

# Not in sync -- say where they diverge so the fix is obvious.
src = [ln for ln in engine.strip().splitlines() if ln.strip()]
missing = [ln for ln in src if ln not in app]
print("  FAIL local-engine.js does not match the analyser inlined in beatforge.html")
if missing:
    print(f"    {len(missing)} of {len(src)} source lines are absent from the app, first ones:")
    for ln in missing[:5]:
        print(f"      {ln.strip()[:100]}")
else:
    print("    every source line appears in the app, but not as one contiguous block")
print("    Re-sync the two: local-engine.js is the source, the HTML carries the shipped copy.")
sys.exit(1)
