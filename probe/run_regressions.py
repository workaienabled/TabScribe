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
    ('ux-refinement-surface', ['ui_refinement_test.py', 'surface'], {}),
    ('ux-preferences-refinement', ['preferences_refinement_test.py'], {}),
    ('ux-feedback-refinement', ['feedback_refinement_test.py'], {}),
    ('ux-restore-order', ['restore_order_test.py'], {}),
    ('ux-action-feedback', ['action_feedback_test.py'], {}),
    ('ux-switch-label', ['switch_label_test.py'], {}),
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
    ('ux-delete-confirm', ['delete_confirm_test.py'], {}),
    ('error-paths', ['error_paths_test.py'], {}),
    ('capture-errors', ['capture_errors_test.py'], {}),
    ('output-errors', ['output_errors_test.py'], {}),
    ('persistence-errors', ['persistence_errors_test.py'], {}),
    ('transfer-errors', ['transfer_errors_test.py'], {}),
    ('review-errors', ['review_errors_test.py'], {}),
    ('ux-window-round-trip', ['window_round_trip_test.py'], {}),
    ('view-switch', ['view_switch_test.py'], {}),
    ('button-row', ['measure_button_row.py'], {}),
    ('prefs', ['prefs_test.py'], {}),
    ('popout', ['popout_test.py'], {}),
    ('e2e-sample1', ['e2e_full.py'], {}),
    ('e2e-sample2', ['e2e_full.py'], {'TABSCRIBE_CLIP':'sample2.wav'}),
    ('e2e-resume', ['e2e_full.py'], {'TABSCRIBE_RESUME_CHECK':'1'}),
    ('e2e-mic-interference', ['e2e_full.py'], {'TABSCRIBE_MIC_CHECK':'1'}),
    # Owns port 8899 like the e2e cases, so it must stay in this serial list.
    ('live-switch', ['live_switch_test.py'], {}),
    ('switch-survivor', ['switch_survivor_test.py'], {}),
    ('stale-worker', ['stale_worker_test.py'], {}),
    ('selection', ['selection_test.py'], {}),
    ('clear', ['clear_test.py'], {}),
    ('model-notice', ['model_notice_test.py'], {}),
]

# Node unit tests. They were documented but never run by this runner, so a broken
# contract between Transcriber and the panel could sit green for a whole session.
# They are fast and need no display, so they run FIRST: a failure here explains a
# browser failure that would otherwise take minutes to reproduce.
UNIT_TESTS = sorted(path.name for path in (ROOT / 'probe').glob('*.test.mjs'))
if not UNIT_TESTS:
    raise SystemExit('No Node unit tests found.')

if __name__ == '__main__':
    if not os.environ.get('DISPLAY') or os.environ['DISPLAY'] in (':0', ':1'):
        raise SystemExit('Use a dedicated virtual display for browser regression tests.')
    results = []

    # Unit tests first: fast, display-free, and they explain browser failures.
    print('START unit-tests', flush=True)
    unit_start = time.monotonic()
    unit_log = OUT / 'unit-tests.log'
    with unit_log.open('w') as output:
        proc = subprocess.run(['node', '--test', '--test-reporter=tap', *UNIT_TESTS], cwd=ROOT / 'probe',
                              stdout=output, stderr=subprocess.STDOUT, timeout=300)
    unit_result = dict(name='unit-tests', exit_code=proc.returncode,
                       seconds=round(time.monotonic() - unit_start, 1), log=str(unit_log))
    results.append(unit_result)
    (OUT / 'regression-results.json').write_text(json.dumps(results, indent=2))
    print(f'END unit-tests: exit={proc.returncode}, {unit_result["seconds"]}s', flush=True)

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
    # +1 for the unit-test entry prepended above.
    expected = len(CASES) + 1
    sys.exit(0 if len(results) == expected and all(r['exit_code'] == 0 for r in results) else 1)
