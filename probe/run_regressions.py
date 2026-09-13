"""Run the branch's real-Chrome checks serially; retain exact exits and full logs.

Use a private Xvfb DISPLAY. Legacy audio fixtures share port 8899, so they must
not run concurrently. This runner never starts, stops, or edits a user browser.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)
CASES = [(f'ux-{stage}', ['ux_test.py', stage], {}) for stage in ['shell','reading','navigation','undo']]
CASES += [
    ('ux-focus', ['focus_test.py'], {}),
    ('ux-robustness', ['robustness_test.py'], {}),
    ('ux-review', ['robustness_test.py', 'review'], {}),
    ('ux-mic', ['mic_test.py'], {}),
    ('ux-mic-permission', ['mic_permission_test.py'], {}),
    ('ux-mic-grant', ['mic_grant_test.py'], {}),
    ('first-load', ['first_load_test.py'], {}),
    ('ux-toolbar', ['toolbar_test.py'], {}),
    ('ux-bare-shell', ['bare_shell_test.py'], {}),
    ('ux-delete-control', ['delete_control_test.py'], {}),
    ('button-row', ['measure_button_row.py'], {}),
    ('prefs', ['prefs_test.py'], {}),
    ('popout', ['popout_test.py'], {}),
    ('e2e-sample1', ['e2e_full.py'], {}),
    ('e2e-sample2', ['e2e_full.py'], {'TABSCRIBE_CLIP':'sample2.wav'}),
    ('e2e-resume', ['e2e_full.py'], {'TABSCRIBE_RESUME_CHECK':'1'}),
    ('e2e-mic-interference', ['e2e_full.py'], {'TABSCRIBE_MIC_CHECK':'1'}),
    ('selection', ['selection_test.py'], {}),
    ('clear', ['clear_test.py'], {}),
    ('model-notice', ['model_notice_test.py'], {}),
]

if __name__ == '__main__':
    if not os.environ.get('DISPLAY') or os.environ['DISPLAY'] in (':0', ':1'):
        raise SystemExit('Use a dedicated virtual display for browser regression tests.')
    results = []
    for name, args, extra in CASES:
        print(f'START {name}', flush=True)
        start = time.monotonic()
        log = OUT / f'{name}.log'
        with log.open('w') as output:
            try:
                proc = subprocess.run([sys.executable, '-u', *args], cwd=ROOT / 'probe',
                                      env={**os.environ, **extra}, stdout=output, stderr=subprocess.STDOUT, timeout=620)
                code = proc.returncode
            except subprocess.TimeoutExpired:
                code = 124
        result = dict(name=name, exit_code=code, seconds=round(time.monotonic()-start, 1), log=str(log))
        results.append(result)
        (OUT / 'regression-results.json').write_text(json.dumps(results, indent=2))
        print(f'END {name}: exit={code}, {result["seconds"]}s', flush=True)
        # A timeout may leave a test-owned Chrome holding shared resources.
        if code == 124:
            break
    print(json.dumps(results, indent=2), flush=True)
    sys.exit(0 if len(results)==len(CASES) and all(r['exit_code']==0 for r in results) else 1)
