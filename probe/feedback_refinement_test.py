"""Delete confirmation stays readable and dismissible in narrow panels."""
import sys
import time
from preferences_refinement_test import key
from ux_test import UI


def feedback(ui):
    ui.fixture(8)
    ui.js("document.getElementById('prefsBtn').click()")
    for width in (280, 300, 360, 640):
        ui.size(width, 420)
        # Trigger the real toast and confirmation together in one event turn.
        ui.js("document.getElementById('clearScreenBtn').click(); document.getElementById('clearBtn').click()")
        time.sleep(.2)
        shape=ui.js("""(() => {
          const bar=document.getElementById('confirmBar'),toast=document.getElementById('toast');
          const b=bar.getBoundingClientRect(),t=toast.getBoundingClientRect();
          const buttons=[...bar.querySelectorAll('button')].map(e=>{
            const r=e.getBoundingClientRect();return {id:e.id,x:r.x,right:r.right,y:r.y,bottom:r.bottom,h:r.height};
          });
          return {shown:!bar.hidden,toastShown:!toast.hidden,toastBottom:t.bottom,barTop:b.top,
            overflow:document.documentElement.scrollWidth>innerWidth,buttons};
        })()""")
        ui.check(f'{width}px: all confirmation actions fit and have 28px targets',
                 shape['shown'] and len(shape['buttons'])==3 and not shape['overflow']
                 and all(b['x']>=0 and b['right']<=width and b['y']>=0 and b['bottom']<=420 and b['h']>=28 for b in shape['buttons']), shape)
        ui.check(f'{width}px: the actual toast stays above the whole question',
                 shape['toastShown'] and shape['toastBottom'] <= shape['barTop'] - 4, shape)
        # Focus may leave this nonmodal question while the user reads/copies.
        ui.js("document.getElementById('transcript').focus()")
        key(ui,'Escape','Escape',27)
        state=ui.js("({hidden:document.getElementById('confirmBar').hidden,prefsOpen:!document.getElementById('prefsPanel').hidden})")
        ui.check(f'{width}px: Escape cancels the question even after focus leaves it',state['hidden'],state)
        ui.check(f'{width}px: cancelling the question does not also close Preferences',state['prefsOpen'],state)
        # Cleanup also works against old code, allowing every width to run RED.
        ui.js("document.getElementById('confirmCancelBtn').click();document.getElementById('showHiddenBtn').click(); if(document.getElementById('prefsPanel').hidden)document.getElementById('prefsBtn').click()")
    ui.check('cancelling every question left the actual transcript intact',ui.js("document.querySelectorAll('.seg').length") == 8)


if __name__ == '__main__':
    ui=UI()
    try:
        feedback(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('feedback-refinement'))
