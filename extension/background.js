/**
 * TabScribe service worker.
 *
 * Panel opening strategy: handle chrome.action.onClicked and call
 * chrome.sidePanel.open() from inside the listener.
 *
 * This is not a stylistic choice. The two available strategies were measured against
 * a real toolbar click on Chrome 151:
 *
 *   openPanelOnActionClick: true   panel opens, but chrome.tabCapture then fails with
 *                                  "Extension has not been invoked for the current
 *                                  page" — Chrome opening the panel itself does NOT
 *                                  count as an extension invocation, so no activeTab.
 *   onClicked -> sidePanel.open()  activeTab IS granted and tabCapture succeeds.
 *
 * Since tab audio is the entire point of this extension, the onClicked path is the
 * only viable one.
 *
 * Gesture handling: chrome.sidePanel.open() must be called while the user-gesture
 * context is still intact. Nothing is awaited before it — storage is written after
 * the call, and the promise is handled without blocking the listener.
 */

const TARGET_KEY = 'targetTabId';
const WINDOW_KEY = 'popoutWindowId';
const HANDOFF_KEY = 'handoffSnapshot';
const MIC_PAGE_SHOWN_KEY = 'micPageShown';
// Set by the window the moment it starts switching back, cleared when the panel
// claims the snapshot. The TTL only guards against a switch that died halfway:
// it must comfortably exceed a slow recognizer flush, or it reintroduces the
// very race it exists to close.
const SWITCH_KEY = 'switchPending';
const SWITCH_TTL_MS = 30000;

async function disableAutoOpen() {
  // Must stay false: with true, Chrome opens the panel itself and the click no
  // longer counts as an extension invocation (see header).
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {
    console.error('setPanelBehavior failed:', e);
  }
}

chrome.runtime.onInstalled.addListener(disableAutoOpen);
chrome.runtime.onStartup.addListener(disableAutoOpen);
disableAutoOpen();

/**
 * Offer the microphone page once, on first install.
 *
 * The microphone is the one capability this extension cannot ask for from its
 * own UI: a side panel cannot raise Chrome's prompt, and there is no manifest
 * permission for it in an extension (measured — see mic-permission.js). A normal
 * page in a tab can, so first install is the natural moment to offer it, before
 * the user is in a meeting and pressing Start.
 *
 * Three guards, because a tab that comes back is worse than no tab at all:
 *
 *  - a stored flag, because chrome.runtime.onInstalled fires with reason
 *    'install' on EVERY load of an unpacked extension, not only the first
 *    (measured on Chrome 151 in probe/spike_install_event.py), so the reason
 *    alone would reopen the tab on every developer reload;
 *  - the live permission state, so a profile that already granted the
 *    microphone is never interrupted;
 *  - reason === 'install', so an update or a browser restart never triggers it.
 *
 * Nothing here can affect transcription: it runs in the worker, touches no
 * capture state, and every failure is swallowed.
 */
async function offerMicrophonePageOnce(details) {
  try {
    if (details?.reason !== 'install') return;

    const stored = await chrome.storage.local.get(MIC_PAGE_SHOWN_KEY);
    if (stored[MIC_PAGE_SHOWN_KEY]) return;

    // Already allowed (or explicitly blocked): asking again would be noise.
    let state = 'prompt';
    try {
      state = (await navigator.permissions.query({ name: 'microphone' })).state;
    } catch (e) { /* treat an unreadable state as 'not yet asked' */ }
    if (state === 'granted' || state === 'denied') {
      await chrome.storage.local.set({ [MIC_PAGE_SHOWN_KEY]: true });
      return;
    }

    // Record before opening: if the tab fails to open, the user is not going to
    // be asked again and again on every reload.
    await chrome.storage.local.set({ [MIC_PAGE_SHOWN_KEY]: true });
    await chrome.tabs.create({
      url: chrome.runtime.getURL('mic-permission.html'),
      active: true,
    });
  } catch (e) {
    console.warn('microphone page on install failed:', e);
  }
}

chrome.runtime.onInstalled.addListener(offerMicrophonePageOnce);

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id === undefined) return;

  // Call open() first, synchronously, so the user-gesture context is intact.
  chrome.sidePanel
    .open({ tabId: tab.id })
    .catch((e) => console.error('sidePanel.open failed:', e));

  chrome.storage.session
    .set({ [TARGET_KEY]: tab.id, targetTabTitle: tab.title || '' })
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GET_STREAM_ID') {
    (async () => {
      try {
        let tabId = msg.tabId;
        let title = '';

        if (tabId === undefined) {
          const stored = await chrome.storage.session.get([TARGET_KEY, 'targetTabTitle']);
          tabId = stored[TARGET_KEY];
          title = stored.targetTabTitle || '';
        }
        if (tabId === undefined) {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!active) throw new Error('No active tab to capture.');
          tabId = active.id;
          title = active.title || '';
        }

        // tabCapture requires an active extension invocation on the target tab,
        // granted by the user's click on the toolbar action. Host permissions do
        // NOT substitute: verified on Chrome 151 that an extension holding
        // <all_urls> still fails with "Extension has not been invoked for the
        // current page".
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        await chrome.storage.session.set({ [TARGET_KEY]: tabId, targetTabTitle: title });
        sendResponse({ ok: true, streamId, tabId, title });
      } catch (e) {
        const message = String(e && e.message ? e.message : e);
        sendResponse({
          ok: false,
          error: message,
          needsInvocation: /has not been invoked|activeTab/i.test(message),
        });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  if (msg?.type === 'GET_TARGET') {
    (async () => {
      try {
        const stored = await chrome.storage.session.get([TARGET_KEY, 'targetTabTitle']);
        if (stored[TARGET_KEY] !== undefined) {
          sendResponse({ ok: true, tabId: stored[TARGET_KEY], title: stored.targetTabTitle || '' });
          return;
        }
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        sendResponse({ ok: true, tabId: active?.id, title: active?.title || '' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  // The side panel has no direct way to learn which browser window hosts it, and
  // sidePanel.close() needs that windowId. The sender's tab carries it.
  if (msg?.type === 'GET_HOST_WINDOW') {
    (async () => {
      try {
        if (sender?.tab?.windowId !== undefined) {
          sendResponse({ ok: true, windowId: sender.tab.windowId });
          return;
        }
        const win = await chrome.windows.getLastFocused();
        sendResponse({ ok: true, windowId: win?.id });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  // Pop the panel out into its own always-visible window.
  //
  // Only one capture per tab is possible — verified: a second getMediaStreamId on a
  // tab that is already captured fails with "Cannot capture a tab with an active
  // stream." So this is a handoff: the caller releases its capture and hands over
  // its transcript, the window restores it and re-arms.
  if (msg?.type === 'OPEN_WINDOW') {
    (async () => {
      try {
        if (msg.snapshot) {
          await chrome.storage.session.set({
            [HANDOFF_KEY]: { snapshot: msg.snapshot, resume: !!msg.resume },
          });
        }

        const existing = await chrome.storage.session.get(WINDOW_KEY);
        const existingId = existing[WINDOW_KEY];
        if (existingId !== undefined) {
          try {
            await chrome.windows.update(existingId, { focused: true, drawAttention: true });
            sendResponse({ ok: true, windowId: existingId, reused: true });
            return;
          } catch (e) {
            // Window was closed since it was recorded; fall through and make a new one.
            await chrome.storage.session.remove(WINDOW_KEY);
          }
        }

        // Window size: the stored preference is the authority, because the
        // window records its own size on resize and the requesting panel may
        // hold a stale cached value. The message is only a fallback.
        let width = msg.width || 460;
        let height = msg.height || 780;
        try {
          const stored = (await chrome.storage.local.get('prefs'))?.prefs || {};
          if (typeof stored.windowWidth === 'number' && stored.windowWidth >= 200) {
            width = stored.windowWidth;
          }
          if (typeof stored.windowHeight === 'number' && stored.windowHeight >= 200) {
            height = stored.windowHeight;
          }
        } catch (e) { /* fall back to the message values */ }

        const win = await chrome.windows.create({
          url: chrome.runtime.getURL('sidepanel.html?view=window'),
          type: 'popup',
          width,
          height,
          focused: true,
        });
        await chrome.storage.session.set({ [WINDOW_KEY]: win.id });

        // Close the side panel so only the window remains. Verified on Chrome 151:
        // close() requires a CloseOptions argument — `{}` is rejected with "At least
        // one of `tabId` and `windowId` must be provided", and `{tabId}` with "No
        // active tab-specific side panel", because this panel is window-scoped.
        // `{windowId}` is the shape that works. setOptions({enabled:false}) does NOT
        // close an open panel, so it is not a fallback.
        let panelClosed = false;
        if (msg.closePanel !== false && msg.sourceWindowId !== undefined) {
          try {
            await chrome.sidePanel.close({ windowId: msg.sourceWindowId });
            panelClosed = true;
          } catch (e) {
            // Not fatal: the pop-out window is already open and usable. Older Chrome
            // builds have no close() at all.
            console.warn('sidePanel.close failed:', e);
          }
        }

        sendResponse({ ok: true, windowId: win.id, reused: false, panelClosed });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  // Going the other way: the window hands the transcript back and the side panel
  // picks it up. The panel itself is opened by the WINDOW, synchronously inside
  // the click — sidePanel.open() needs a user gesture, and routing the call
  // through here would spend it on the message round trip.
  if (msg?.type === 'BACK_TO_PANEL') {
    (async () => {
      try {
        if (msg.snapshot) {
          await chrome.storage.session.set({
            [HANDOFF_KEY]: { snapshot: msg.snapshot, resume: !!msg.resume },
          });
        }
        // Re-enable the panel for the tab, in case the pop-out disabled it.
        const stored = await chrome.storage.session.get(TARGET_KEY);
        const tabId = stored[TARGET_KEY];
        if (tabId !== undefined) {
          try {
            await chrome.sidePanel.setOptions({
              tabId,
              path: 'sidepanel.html',
              enabled: true,
            });
          } catch (e) { /* the tab may be gone; the panel will say so */ }
        }
        // The panel no longer reads WINDOW_KEY to decide whether to wait — the
        // SWITCH_PENDING flag says so explicitly — so clear it here rather than
        // relying on the window's own close to do it.
        await chrome.storage.session.remove(WINDOW_KEY);
        sendResponse({ ok: true, tabId });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  // The window is switching back and is about to tear down. It says so before
  // the teardown, because the panel opens immediately and would otherwise have
  // to guess how long to wait for a snapshot that arrives only afterwards.
  if (msg?.type === 'SWITCH_PENDING') {
    (async () => {
      try {
        await chrome.storage.session.set({
          [SWITCH_KEY]: { at: Date.now(), resume: !!msg.resume },
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  // Is a hand-off actually on its way? The side panel asks on load and waits for
  // the snapshot only when the answer is yes. A stale flag is ignored: a switch
  // that never completed must not stall the next ordinary open.
  if (msg?.type === 'GET_SWITCH_PENDING') {
    (async () => {
      try {
        const stored = await chrome.storage.session.get(SWITCH_KEY);
        const entry = stored[SWITCH_KEY];
        const fresh = !!entry && (Date.now() - entry.at) < SWITCH_TTL_MS;
        if (entry && !fresh) await chrome.storage.session.remove(SWITCH_KEY);
        sendResponse({ ok: true, pending: fresh });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  // The window claims the handoff snapshot exactly once, so a later reload of the
  // window does not resurrect a stale transcript.
  if (msg?.type === 'CLAIM_HANDOFF') {
    (async () => {
      try {
        const stored = await chrome.storage.session.get(HANDOFF_KEY);
        await chrome.storage.session.remove(HANDOFF_KEY);
        const payload = stored[HANDOFF_KEY] || null;
        // The switch is complete once its snapshot has been claimed; leaving the
        // flag set would make the next ordinary panel open wait for nothing.
        if (payload) await chrome.storage.session.remove(SWITCH_KEY);
        sendResponse({
          ok: true,
          snapshot: payload ? payload.snapshot : null,
          resume: payload ? !!payload.resume : false,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  return false;
});

// Forget the pop-out window once it is gone, so the next pop-out opens a new one
// instead of trying to focus a window that no longer exists.
//
// This deliberately does NOT reopen the side panel. chrome.sidePanel.open()
// requires a user gesture and a window closing is not one, so any attempt here
// fails with "`sidePanel.open()` may only be called in response to a user
// gesture". Returning to the sidebar is the Sidebar button's job, in the window,
// where a real click supplies the gesture. The panel is re-enabled for the tab
// so the toolbar icon works again either way.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const stored = await chrome.storage.session.get(WINDOW_KEY);
  if (stored[WINDOW_KEY] === windowId) {
    await chrome.storage.session.remove(WINDOW_KEY);
    const target = await chrome.storage.session.get(TARGET_KEY);
    const tabId = target[TARGET_KEY];
    if (tabId !== undefined) {
      try {
        await chrome.sidePanel.setOptions({
          tabId,
          path: 'sidepanel.html',
          enabled: true,
        });
      } catch (e) {
        // The tab may be gone too; nothing to restore in that case.
      }
    }
  }
});
