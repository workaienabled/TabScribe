"""Capture real extension views with clearly labelled example transcript text.

These images document layout; they are not evidence of speech recognition.
"""
import json
import time
from ux_test import UI

EXAMPLE = [
    'Let’s start with the product review. The goal is to make the transcript easier to read without interrupting the conversation.',
    'We agreed to keep the controls compact. Preferences should be easy to find, but stay out of the way while you are listening.',
    'If you scroll up to review an earlier point, new words should not pull you back down. You can return to the latest text when you are ready.',
    'The next step is to test the complete flow: capture, read, find a phrase, and save the notes. The audio must remain audible throughout.',
    'Before we finish, let’s confirm the follow-up: review the draft on Thursday, then share the final notes with the team.',
]

ui = UI()
try:
    ui.fixture(1)
    ui.capture_store()
    ui.js("fixtureStore.clear(); document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.js(f"({json.dumps(EXAMPLE)}).forEach((text,i)=>fixtureStore.update(i,text,true,i*16000)); document.getElementById('tsToggle').checked=true; document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.js("document.getElementById('target').textContent='Product review · example transcript'; document.getElementById('status').textContent='Example text. No audio is being captured.'")
    for theme in ['light', 'dark']:
        ui.size(420, 820)
        ui.js(f"document.getElementById('themeSel').value='{theme}'; document.getElementById('themeSel').dispatchEvent(new Event('change')); document.getElementById('transcript').scrollTop=0")
        time.sleep(.15)
        ui.shot(f'preview-{theme}')
    ui.js("document.getElementById('findBtn').click(); document.getElementById('findInput').value='review'; document.getElementById('findInput').dispatchEvent(new Event('input'))")
    ui.shot('preview-find')
    ui.js("document.getElementById('findClose').click(); document.getElementById('prefsBtn').click()")
    ui.shot('preview-preferences')
    ui.size(300, 400)
    ui.shot('preview-short-preferences')
    ui.js("document.getElementById('prefsCloseBtn').click(); document.getElementById('clearBtn').click()")
    ui.size(320, 680)
    ui.shot('preview-clear-undo')
finally:
    ui.chrome.kill()
    ui.temp.cleanup()
