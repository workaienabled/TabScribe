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
    'Select the relevant passage, copy it into your AI chat, and ask your question. At the end of the meeting, download the full transcript.',
    'Before we finish, let’s confirm the follow-up: review the draft on Thursday, then share the final notes with the team.',
]

ui = UI()
try:
    ui.size(360, 680)
    ui.shot('focused-empty')
    ui.fixture(1)
    ui.capture_store()
    ui.js("fixtureStore.clear(); document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.js(f"({json.dumps(EXAMPLE)}).forEach((text,i)=>fixtureStore.update(i,text,true,i*16000)); document.getElementById('tsToggle').checked=true; document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.js("document.getElementById('target').textContent='Product review · example transcript'; document.getElementById('status').textContent='Example text. No audio is being captured.'")
    for theme in ['light', 'dark']:
        ui.size(420, 820)
        ui.js(f"document.getElementById('themeSel').value='{theme}'; document.getElementById('themeSel').dispatchEvent(new Event('change')); document.getElementById('transcript').scrollTop=0")
        time.sleep(.15)
        ui.shot(f'focused-{theme}')
    ui.js("(() => {const n=document.querySelectorAll('.seg .txt')[3].firstChild;const r=document.createRange();r.setStart(n,0);r.setEnd(n,75);getSelection().removeAllRanges();getSelection().addRange(r);document.querySelectorAll('.seg')[3].scrollIntoView({block:'center'});})()")
    time.sleep(.15)
    ui.shot('focused-selection')
    ui.js("getSelection().removeAllRanges();document.getElementById('prefsBtn').click()")
    ui.shot('focused-preferences')
    # The microphone option, which lives with the other occasional settings.
    ui.js("document.getElementById('includeMic').scrollIntoView({block:'nearest'})")
    ui.shot('focused-mic-option')
    ui.size(300, 400)
    ui.shot('focused-short-preferences')
    ui.js("document.getElementById('clearBtn').scrollIntoView({block:'nearest'})")
    ui.shot('focused-clear-setting')
    ui.js("document.getElementById('clearBtn').click()")
    ui.size(320, 680)
    ui.shot('focused-clear-undo')
finally:
    ui.cleanup()
