"""Compact UI refinements in isolated Chrome; fixture text is not ASR evidence.

Use a private DISPLAY. Surface checks deliberately exercise idle and active
styles without pretending to start recognition; live audio has its own suites.
"""
import argparse
import sys

from ux_test import UI


def surface(ui):
    ui.fixture(5)
    ui.capture_store()
    ui.js("fixtureStore.update(99, 'An incoming sentence should be readable too.', false, 9000); document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    for theme in ('light', 'dark'):
        ui.js(f"document.getElementById('themeSel').value='{theme}'; document.getElementById('themeSel').dispatchEvent(new Event('change'))")
        contrast = ui.js(r"""(() => {
          const row = document.querySelector('.seg.interim');
          if (!row) return {error: 'missing interim fixture'};
          const luminance = rgb => {
            const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
              v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
            });
            return .2126*c[0] + .7152*c[1] + .0722*c[2];
          };
          const fg = getComputedStyle(row).color;
          const bg = getComputedStyle(document.body).backgroundColor;
          const a = luminance(fg), b = luminance(bg);
          return {fg, bg, ratio: (Math.max(a,b)+.05)/(Math.min(a,b)+.05),
                  size: getComputedStyle(document.getElementById('transcript')).fontSize};
        })()""")
        ui.check(f'{theme}: incoming text meets 4.5:1 contrast without larger type',
                 contrast.get('ratio', 0) >= 4.5 and contrast.get('size') == '13px', contrast)

        for width in (280, 320, 360, 420, 640):
            ui.size(width, 620)
            for active in (False, True):
                # Style fixture only. This does not claim a real recording.
                ui.js(f"document.getElementById('dot').hidden={str(not active).lower()}; document.getElementById('dot').dataset.state='listening'; document.getElementById('recordBtn').setAttribute('aria-pressed','{str(active).lower()}')")
                shape = ui.js("""(() => {
                  const buttons = [...document.querySelectorAll('.controls > button')];
                  const boxes = buttons.map(b => {
                    const r=b.getBoundingClientRect();
                    return {id:b.id, x:r.x, right:r.right, w:r.width, h:r.height, cy:r.y+r.height/2};
                  });
                  const label=document.querySelector('.popout-label').getBoundingClientRect();
                  return {boxes, centreSpread:Math.max(...boxes.map(r=>r.cy))-Math.min(...boxes.map(r=>r.cy)),
                    labelWidth:label.width, overflow:document.documentElement.scrollWidth>innerWidth,
                    toolbarHeight:document.querySelector('.controls').getBoundingClientRect().height};
                })()""")
                ui.check(f'{theme} {width}px active={active}: eight aligned targets, labelled switch, no overflow',
                         len(shape['boxes']) == 8 and shape['centreSpread'] <= .25
                         and all(r['w'] >= 28 and r['h'] >= 28 and r['x'] >= 0 and r['right'] <= width for r in shape['boxes'])
                         and shape['labelWidth'] > 20 and not shape['overflow']
                         and shape['toolbarHeight'] <= 48, shape)
        ui.size(360, 620)
        ui.js("document.getElementById('micStatusBtn').disabled=true; document.getElementById('micStatusBtn').dataset.state='recording'")
        opacity = ui.js("getComputedStyle(document.getElementById('micStatusBtn')).opacity")
        ui.check(f'{theme}: the live mic status is not faded as an unavailable action', float(opacity) == 1, opacity)
    ui.js("document.getElementById('recordBtn').setAttribute('aria-pressed','false'); document.getElementById('prefsBtn').click()")
    expanded = ui.js("(() => {const b=document.getElementById('prefsBtn'),s=getComputedStyle(b);return {open:b.getAttribute('aria-expanded'),border:s.borderTopColor,color:s.color,background:s.backgroundColor};})()")
    ui.check('expanded Preferences retains its visible active border',
             expanded['open'] == 'true' and expanded['border'] == expanded['color'], expanded)
    target = ui.js("(() => {const r=document.getElementById('prefsBtn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()")
    ui.chrome.send('Input.dispatchMouseEvent', session_id=ui.sid,
                   type='mouseMoved', x=target['x'], y=target['y'])
    hovered = ui.js("(() => {const b=document.getElementById('prefsBtn'),s=getComputedStyle(b);return {hover:b.matches(':hover'),open:b.getAttribute('aria-expanded'),border:s.borderTopColor,background:s.backgroundColor};})()")
    ui.check('expanded Preferences retains its accent border and background under native hover',
             hovered['hover'] and hovered['open'] == 'true'
             and hovered['border'] == expanded['color']
             and hovered['background'] == expanded['background'], hovered)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['surface'])
    args = parser.parse_args()
    ui = UI()
    try:
        globals()[args.stage](ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish(f'refinement-{args.stage}'))
