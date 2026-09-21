"""Controller-level review regressions with real Chrome and injected boundaries."""
import sys
import time
from ux_test import UI
from error_paths_test import BOOT, prepare, reload, snapshot


def download_now_during_preview(ui):
    """The first-run notice can fetch the model without starting a recording.

    Replaces the old "Use cloud instead" regression. That button was the notice's
    only action and it silently switched the user off on-device recognition; this
    one does what the notice is actually about. The invariant carried over is the
    important half: an install this document is no longer waiting on must not
    resurrect its panel.
    """
    reload(ui)
    ui.js("document.getElementById('localOnly').checked=true;fault.availability='downloadable';fault.holdInstall=true;"
          "document.getElementById('localOnly').dispatchEvent(new Event('change'))")
    ui.chrome.wait_for_js(ui.sid, "!document.getElementById('modelPanel').hidden", timeout=6)
    offered = ui.js("""({
      downloadShown: !document.getElementById('downloadModelBtn').hidden,
      cloudGone: !document.getElementById('useCloudBtn'),
      body: document.getElementById('modelBody').textContent,
    })""")
    ui.check('the first-run notice offers to download the model',
             offered['downloadShown'], offered)
    ui.check('and no longer offers to switch the user to the cloud',
             offered['cloudGone'], offered)

    before_captures = ui.js("captureTracks.length")
    ui.js("document.getElementById('downloadModelBtn').click()")
    ui.chrome.wait_for_js(ui.sid, "typeof finishInstall==='function'", timeout=6)
    during = ui.js("""({
      pressed: document.getElementById('recordBtn').getAttribute('aria-pressed'),
      recognizers: recognizers.length,
      state: document.getElementById('modelState').textContent,
      captures: captureTracks.length,
    })""")
    ui.check('Download now installs without entering the recording state',
             during['pressed'] != 'true' and during['recognizers'] == 0, during)
    # The panel arms tab capture when it OPENS, so the meaningful claim is that
    # downloading adds no capture of its own — not that none exists.
    ui.check('and acquires no additional tab capture of its own',
             during['captures'] == before_captures,
             {'before': before_captures, **during})
    ui.check('while the notice reports the download', 'download' in during['state'].lower(), during)

    # Record supersedes the standalone wait; the late install must stay inert.
    ui.js("document.getElementById('recordBtn').click()")
    time.sleep(.3)
    ui.js("fault.availability='available'; finishInstall(true)")
    time.sleep(.4)
    ui.check('a late standalone install cannot resurrect its own panel',
             ui.js("document.getElementById('recordBtn').getAttribute('aria-pressed')==='true'"),
             snapshot(ui))


def model_poll_error(ui):
    reload(ui)
    ui.js("document.getElementById('localOnly').checked=true;fault.availability='downloadable';fault.holdInstall=true;document.getElementById('recordBtn').click()")
    ui.chrome.wait_for_js(ui.sid,"typeof finishInstall==='function'",timeout=5)
    ui.js("fault.availabilityError=true")
    ui.chrome.wait_for_js(ui.sid,"document.getElementById('status').classList.contains('error')",timeout=10)
    state=ui.js("""({status:document.getElementById('status').textContent,
        hidden:document.getElementById('modelPanel').hidden, pressed:document.getElementById('recordBtn').getAttribute('aria-pressed')})""")
    ui.check('failed model polling stops the abandoned download panel',
             state['hidden'] and state['pressed']=='false' and 'policy' in state['status'].lower(),state)
    ui.js("fault.availabilityError=false;fault.availability='available';finishInstall(true)")
    time.sleep(.25)
    ui.check('late model completion cannot revive failed progress or start recognition',
             ui.js("document.getElementById('modelPanel').hidden && recognizers.length===0"),snapshot(ui))


def delayed_end(ui):
    reload(ui)
    ui.js("document.getElementById('recordBtn').click()")
    ui.chrome.wait_for_js(ui.sid,"document.getElementById('status').textContent.startsWith('Listening')",timeout=5)
    ui.js("recognizers[0].stop=function(){this.stopped=true}; captureTracks[0].dispatchEvent(new Event('ended'))")
    ui.chrome.wait_for_js(ui.sid,"!document.getElementById('recordBtn').disabled",timeout=6)
    before=snapshot(ui)['status']
    ui.js("recognizers[0].onend?.()")
    time.sleep(.1)
    after=snapshot(ui)
    ui.check('late recognizer end does not erase the tab-audio failure reason',
             'Tab audio ended' in before and after['status']==before,{'before':before,**after})


def microphone_errors(ui):
    ui.js("chrome.storage.local.set({prefs:{includeMic:true,micChoiceKnown:true,localOnly:true}})")
    code="""
    const query=navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query=(d)=>d.name==='microphone'?Promise.resolve({state:'granted'}):query(d);
    navigator.mediaDevices.enumerateDevices=async()=>[{kind:'audioinput',deviceId:'injected-mic'}];
    const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async(c)=>{
      if(c.audio && !c.audio.mandatory){
        if (fault.micError) throw new DOMException('Injected microphone acquisition failure', fault.micError);
        const ctx=new AudioContext(), src=ctx.createConstantSource(), dest=ctx.createMediaStreamDestination();
        src.connect(dest);src.start(); return dest.stream;
      }
      return gum(c);
    };
    """
    added=ui.chrome.send('Page.addScriptToEvaluateOnNewDocument',session_id=ui.sid,source=code)
    ui.chrome.send('Page.reload',session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid,"document.getElementById('status').textContent.includes('Ready')",timeout=10)
    ui.js("document.getElementById('recordBtn').click()")
    try:
        ui.chrome.wait_for_js(ui.sid,"recognizers.length===2 && document.getElementById('micStatusBtn').dataset.state==='recording'",timeout=6)
    except RuntimeError:
        print('Microphone fixture diagnostics:', ui.chrome.send('Runtime.evaluate', session_id=ui.sid,
              expression="JSON.stringify({url:location.href,recognizers:typeof recognizers==='undefined'?null:recognizers.length,body:document.body.innerText,mic:document.getElementById('micStatusBtn').outerHTML,includeMic:document.getElementById('includeMic').checked,hint:document.getElementById('micHint').textContent,unhandled:window.unhandled})", returnByValue=True))
        raise
    ui.js("recognizers[1].fail('language-not-supported')")
    time.sleep(.3)
    data=ui.js("""({issue:document.getElementById('issues').innerText,
      hidden:document.getElementById('issues').hidden,mic:document.getElementById('micStatusBtn').dataset.state,
      status:document.getElementById('status').textContent,prefsHidden:document.getElementById('prefsPanel').hidden,
      unhandled:[...unhandled]})""")
    ui.check('specific mic failure stays visible with Preferences closed',
             data['prefsHidden'] and not data['hidden'] and 'language' in data['issue'].lower(),data)
    ui.check('mic failure does not interrupt meeting recognition or throw another error',
             data['status'].startswith('Listening') and data['mic']=='error' and not data['unhandled'],data)
    for name, expected in [('NotFoundError', 'No microphone'), ('NotReadableError', 'busy')]:
        ui.js("document.getElementById('includeMic').checked=false;document.getElementById('includeMic').dispatchEvent(new Event('change'))")
        time.sleep(.15)
        ui.js(f"fault.micError={name!r};document.getElementById('includeMic').checked=true;document.getElementById('includeMic').dispatchEvent(new Event('change'))")
        time.sleep(.25)
        actual=ui.js("""({issue:document.getElementById('issues').innerText,
          hidden:document.getElementById('issues').hidden,mic:document.getElementById('micStatusBtn').dataset.state,
          status:document.getElementById('status').textContent,prefsHidden:document.getElementById('prefsPanel').hidden,
          unhandled:[...unhandled]})""")
        ui.check(f'{name} acquisition failure is visible outside Preferences without stopping meeting recognition',
                 not actual['hidden'] and actual['prefsHidden'] and expected.lower() in actual['issue'].lower()
                 and actual['mic']=='error' and 'Listening' in actual['status'] and not actual['unhandled'],actual)
    ui.chrome.send('Page.removeScriptToEvaluateOnNewDocument',session_id=ui.sid,identifier=added['identifier'])
    ui.js("chrome.storage.local.set({prefs:{includeMic:false,localOnly:true}})")


def lost_positive_reply(ui):
    ui.fixture(3)
    prepare(ui)
    ui.js("document.getElementById('includeMic').checked=false;document.getElementById('recordBtn').click()")
    ui.chrome.wait_for_js(ui.sid,"document.getElementById('status').textContent.startsWith('Listening')",timeout=6)
    ui.js("""window.beforeTransferRecognizers=recognizers.length;
      const send=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=async(m,...a)=>{
        const reply=await send(m,...a);
        if(m?.type==='OPEN_WINDOW' && reply?.ok) throw new Error('Successful transfer reply lost');
        return reply;
      }; document.getElementById('popoutBtn').click();""")
    ui.chrome.wait_for_js(ui.sid,"document.getElementById('issues').innerText.includes('Successful transfer reply lost')",timeout=25)
    data=snapshot(ui)
    accepted=ui.js("(async()=> (await chrome.storage.session.get('handoffSnapshot')).handoffSnapshot?.state)()")
    ui.check('lost-reply fixture really reached durable destination acceptance',accepted=='accepted',accepted)
    ui.check('lost positive reply cannot restart competing source recognition',
             ui.js("recognizers.length===beforeTransferRecognizers") and data['pressed']=='false' and data['disabled'],data)
    ui.check('uncertain source retains downloadable text',
             ui.js("document.querySelectorAll('.seg').length===3 && !document.getElementById('downloadBtn').disabled"))


if __name__=='__main__':
    ui=UI()
    try:
        prepare(ui)
        download_now_during_preview(ui)
        model_poll_error(ui)
        delayed_end(ui)
        microphone_errors(ui)
        lost_positive_reply(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('review-errors'))
