"""Count what the regression run actually reported, from its own artifacts.

Prints suites run, exit codes, RESULT lines per suite, and the Node unit test
totals. Fails loudly if a registered suite is missing or any suite reported
fewer passes than checks. Usage: python3 probe/count_run.py
"""
import json
import re
import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
# Geometry-only suites print no RESULT line; allow them by name, not by falling through.
NO_RESULT_LINE = {'button-row'}

expected = [c[0] for c in runpy.run_path(str(ROOT / 'probe' / 'run_regressions.py'))['CASES']]
run = json.loads((OUT / 'regression-results.json').read_text())
names = [r['name'] for r in run]
missing = [n for n in expected if n not in names]
if missing:
    sys.exit(f'suites registered but not run: {missing}')
if names[0] != 'unit-tests':
    sys.exit('unit tests did not run first')

failures = [r for r in run if r['exit_code'] != 0]
checks = 0
suites = 0
for r in run:
    if r['name'] == 'unit-tests':
        continue
    suites += 1
    text = Path(r['log']).read_text(errors='replace')
    found = re.findall(r'RESULT:\s*(\d+)/(\d+)', text)
    if not found:
        if r['name'] in NO_RESULT_LINE:
            continue
        sys.exit(f"{r['name']}: no RESULT line")
    passed, total = map(int, found[-1])
    if passed != total or total == 0:
        failures.append(r)
    checks += total

unit = Path(run[0]['log']).read_text()


def tap_count(field):
    match = re.search(rf'^# {field} (\d+)', unit, re.M)
    if not match:
        sys.exit(f'unit test log has no "# {field}" summary line')
    return int(match.group(1))


tests, fail, cancelled, skipped = (tap_count(f) for f in ('tests', 'fail', 'cancelled', 'skipped'))

print(json.dumps({
    'browser_suites': suites,
    'browser_checks': checks,
    'unit_tests': tests, 'unit_fail': fail, 'unit_cancelled': cancelled, 'unit_skipped': skipped,
    'failed_suites': [r['name'] for r in failures],
    'total_seconds': round(sum(r['seconds'] for r in run), 1),
}, indent=2))
sys.exit(1 if failures or fail or cancelled else 0)
