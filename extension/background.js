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
// Bump whenever a message type is added or its reply shape changes. Chrome can
// keep an old service worker running across an unpacked reload, so a panel
// document from the new files may be talking to a worker from the old ones.
// The panel compares this against its own copy and says so, rather than
// letting the mismatch surface later as an unrelated failure — which is how a
// stale worker once stopped a meeting mid-switch with no error anywhere.
const PROTOCOL_VERSION = 4;
// Set by the window the moment it starts switching back, cleared when the panel
// acknowledges the restored snapshot. The TTL guards a switch that died halfway:
// it must comfortably exceed a slow recognizer flush, or it reintroduces the
// very race it exists to close.
const SWITCH_KEY = 'switchPending';
const SWITCH_TTL_MS = 30000;
const HANDOFF_WAIT_MS = 15000;
const AUTOSAVE_KEY = 'liveTranscript';
let openingWindow = false;
const acceptedHandoffs = new Set();
const cancelledHandoffs = new Set();

// Storage get/set pairs are not transactions. Serialize ownership changes so
// two extension documents cannot both claim the same exclusive capture.
let handoffQueue = Promise.resolve();
function withHandoffLock(operation) {
  const task = handoffQueue.then(operation);
  handoffQueue = task.catch(() => {});
  return task;
}

function makeHandoff(message) {
  return {
    id: crypto.randomUUID(),
    snapshot: message.snapshot || { epoch: 0, segments: [] },
    resume: !!message.resume,
    micText: message.micText || null,
    savedText: typeof message.savedText === 'string' ? message.savedText : '',
    state: 'pending',
    expiresAt: Date.now() + HANDOFF_WAIT_MS,
    owner: null,
  };
}

function handoffOwner(sender, receiverId) {
  if (typeof sender?.documentId === 'string' && sender.documentId) return `document:${sender.documentId}`;
  if (validChromeId(sender?.tab?.id)) return `tab:${sender.tab.id}`;
  // Real Chrome sidebars may expose neither documentId nor tab. A nonce is
  // scoped to this trusted extension page, not accepted as sender authentication.
  const panel = chrome.runtime.getURL('sidepanel.html');
  const trustedPanel = sender?.id === chrome.runtime.id
    && typeof sender.url === 'string' && sender.url.split(/[?#]/, 1)[0] === panel;
  if (trustedPanel && typeof receiverId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receiverId)) {
    return `panel:${receiverId}`;
  }
  throw new Error('Cannot identify the receiving document.');
}

async function clearSwitchPending() {
  // Acceptance and its recovery copy are already durable. A bookkeeping failure
  // must not tell the source to resume competing with an accepted receiver.
  try { await chrome.storage.session.remove(SWITCH_KEY); }
  catch (e) { console.warn('Could not clear switch flag:', e); }
}

function emptyHandoff() {
  return { ok: true, handoffId: null, snapshot: null, resume: false, micText: null, savedText: '' };
}

async function claimHandoff(sender, receiverId) {
  return withHandoffLock(async () => {
    let payload = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY];
    if (!payload) return emptyHandoff();
    // Older builds and existing fixtures staged unversioned envelopes.
    if (!payload.id) payload = makeHandoff(payload);
    if (payload.state !== 'pending' || cancelledHandoffs.has(payload.id)
        || Date.now() >= payload.expiresAt) return emptyHandoff();
    const owner = handoffOwner(sender, receiverId);
    if (payload.owner && payload.owner !== owner) return emptyHandoff();
    payload = { ...payload, owner };
    await chrome.storage.session.set({ [HANDOFF_KEY]: payload });
    return { ok: true, handoffId: payload.id, snapshot: payload.snapshot,
      resume: payload.resume, micText: payload.micText, savedText: payload.savedText };
  });
}

async function acknowledgeHandoff(id, sender, receiverId) {
  return withHandoffLock(async () => {
    const payload = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY];
    if (!id || payload?.id !== id || payload.owner !== handoffOwner(sender, receiverId)) {
      throw new Error('This handoff does not belong to the receiving document.');
    }
    if (payload.state === 'accepted') return { ok: true };
    if (payload.state !== 'pending' || cancelledHandoffs.has(id) || Date.now() >= payload.expiresAt) {
      throw new Error('The handoff expired or was cancelled. Keep the original view open and try again.');
    }
    await chrome.storage.session.set({
      [HANDOFF_KEY]: { ...payload, state: 'accepted' },
      [AUTOSAVE_KEY]: { snapshot: payload.snapshot, micText: payload.micText,
        savedText: payload.savedText, at: Date.now() },
    });
    acceptedHandoffs.add(id);
    await clearSwitchPending();
    return { ok: true };
  });
}

async function stageHandoff(message, extra = {}) {
  return withHandoffLock(async () => {
    const previous = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY];
    if (previous && (!previous.id || (previous.state === 'pending'
        && Date.now() < previous.expiresAt && !cancelledHandoffs.has(previous.id)))) {
      throw new Error('Another transcript transfer is still pending. Keep the original view open.');
    }
    const payload = makeHandoff(message);
    await chrome.storage.session.set({ ...extra, [HANDOFF_KEY]: payload });
    return payload;
  });
}

async function cancelHandoff(id) {
  return withHandoffLock(async () => {
    if (acceptedHandoffs.has(id)) return true;
    // Also deny a late ACK when storage is temporarily unavailable. The persisted
    // deadline independently rejects it after a service-worker restart.
    cancelledHandoffs.add(id);
    const payload = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY];
    if (payload?.id !== id) throw new Error('The transcript transfer outcome could not be confirmed.');
    if (payload.state === 'accepted') {
      acceptedHandoffs.add(id);
      cancelledHandoffs.delete(id);
      return true;
    }
    await chrome.storage.session.set({ [HANDOFF_KEY]: { ...payload, state: 'cancelled' } });
    await clearSwitchPending();
    return false;
  });
}

async function waitForHandoff(payload) {
  try {
    for (;;) {
      const accepted = await withHandoffLock(async () => {
        if (acceptedHandoffs.has(payload.id)) return true;
        const current = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY];
        if (current?.id !== payload.id || current.state === 'cancelled') {
          throw new Error('The transcript transfer was cancelled.');
        }
        return current.state === 'accepted';
      });
      if (accepted) return;
      if (Date.now() >= payload.expiresAt) throw new Error('The transcript transfer timed out. Keep the original view open and try again.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (e) {
    // ACK and timeout compete under the same lock; durable acceptance wins.
    if (await cancelHandoff(payload.id)) return;
    throw e;
  }
}

async function discardPopup(windowId) {
  if (!validChromeId(windowId)) return;
  try { await chrome.windows.remove(windowId); }
  catch (e) { console.warn('Could not close failed pop-out:', e); }
  try {
    const stored = await chrome.storage.session.get(WINDOW_KEY);
    if (stored[WINDOW_KEY] === windowId) await chrome.storage.session.remove(WINDOW_KEY);
  } catch (e) { console.warn('Could not clear failed pop-out metadata:', e); }
}

function validChromeId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2147483647;
}

// A failed open has no panel in which to display its error. Use the existing
// toolbar action, and contain failures of the reporting API itself.
async function setToolbarError(message = '') {
  const title = message
    ? `TabScribe: ${message}`
    : chrome.runtime.getManifest().action.default_title;
  for (const update of [
    () => chrome.action.setBadgeText({ text: message ? '!' : '' }),
    () => chrome.action.setTitle({ title }),
  ]) {
    try { await update(); } catch (e) { console.warn('Toolbar status failed:', e); }
  }
}

async function reportWorkerError(context, error) {
  const message = `${context}: ${error?.message || String(error)}`;
  console.error(message);
  await setToolbarError(message);
}

async function disableAutoOpen() {
  // Must stay false: with true, Chrome opens the panel itself and the click no
  // longer counts as an extension invocation (see header).
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {
    await reportWorkerError('Panel setup failed', e);
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
  if (!validChromeId(tab?.id)) {
    return reportWorkerError('Could not open the panel', new Error('No valid tab to attach to.'));
  }

  // Call open() first, synchronously, so the user-gesture context is intact.
  let pendingOpen;
  try {
    pendingOpen = chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    return reportWorkerError('Could not open the panel', e);
  }
  const rememberTarget = async () => chrome.storage.session.set({
    [TARGET_KEY]: tab.id, targetTabTitle: tab.title || '',
  });
  return Promise.all([pendingOpen, rememberTarget()])
    .then(() => setToolbarError())
    .catch((e) => reportWorkerError('Could not prepare the panel', e));
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // Every reply is stamped with the protocol version this worker was built
  // with. Object replies only; the handlers below never send anything else.
  const sendResponse = (reply) => {
    try {
      respond(reply && typeof reply === 'object'
        ? { ...reply, workerVersion: PROTOCOL_VERSION } : reply);
    } catch (e) {
      // A document can disappear during an awaited Chrome call. Its closed
      // channel must not reject the worker's detached async handler.
      console.warn('Could not deliver worker response:', e);
    }
  };

  if (msg?.type === 'GET_STREAM_ID') {
    (async () => {
      try {
        let tabId = msg.tabId;
        let title = '';

        if (tabId != null && !validChromeId(tabId)) throw new Error('Invalid tab ID.');
        if (tabId == null) {
          const stored = await chrome.storage.session.get([TARGET_KEY, 'targetTabTitle']);
          tabId = stored[TARGET_KEY];
          title = stored.targetTabTitle || '';
        }
        if (!validChromeId(tabId)) {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!validChromeId(active?.id)) throw new Error('No active tab to capture.');
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
        if (validChromeId(stored[TARGET_KEY])) {
          sendResponse({ ok: true, tabId: stored[TARGET_KEY], title: stored.targetTabTitle || '' });
          return;
        }
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!validChromeId(active?.id)) throw new Error('No active tab to capture.');
        sendResponse({ ok: true, tabId: active.id, title: active.title || '' });
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
        if (validChromeId(sender?.tab?.windowId)) {
          sendResponse({ ok: true, windowId: sender.tab.windowId });
          return;
        }
        const win = await chrome.windows.getLastFocused();
        if (!validChromeId(win?.id)) throw new Error('No browser window to attach to.');
        sendResponse({ ok: true, windowId: win.id });
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
    if (openingWindow) {
      sendResponse({ ok: false, safeToResume: false, error: 'A window transfer is already in progress.' });
      return true;
    }
    openingWindow = true;
    (async () => {
      let win;
      let payload;
      let safeToResume = true;
      try {
        const existing = await chrome.storage.session.get(WINDOW_KEY);
        const existingId = existing[WINDOW_KEY];
        if (validChromeId(existingId)) {
          try {
            await chrome.windows.update(existingId, { focused: true, drawAttention: true });
            sendResponse({ ok: true, windowId: existingId, reused: true });
            return;
          } catch (e) {
            // A focus failure is not proof the window stopped capturing.
            if (!/no window with id|window not found/i.test(String(e?.message || e))) throw e;
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

        // Do not start a receiver until the transfer and window metadata are
        // durable. A storage failure leaves only a harmless blank popup.
        win = await chrome.windows.create({
          url: 'about:blank',
          type: 'popup',
          width,
          height,
          focused: true,
        });
        if (!validChromeId(win?.id) || !validChromeId(win.tabs?.[0]?.id)) {
          throw new Error('Chrome did not create a usable pop-out window.');
        }
        safeToResume = false;
        payload = await stageHandoff(msg, { [WINDOW_KEY]: win.id });
        await chrome.tabs.update(win.tabs[0].id, { url: chrome.runtime.getURL('sidepanel.html?view=window') });
        await waitForHandoff(payload);

        // Close the side panel so only the window remains. Verified on Chrome 151:
        // close() requires a CloseOptions argument — `{}` is rejected with "At least
        // one of `tabId` and `windowId` must be provided", and `{tabId}` with "No
        // active tab-specific side panel", because this panel is window-scoped.
        // `{windowId}` is the shape that works. setOptions({enabled:false}) does NOT
        // close an open panel, so it is not a fallback.
        let panelClosed = false;
        if (msg.closePanel !== false && validChromeId(msg.sourceWindowId)) {
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
        let accepted = false;
        if (payload) {
          try {
            accepted = await cancelHandoff(payload.id);
            safeToResume = !accepted;
          }
          catch (cancelError) { console.warn('Could not persist handoff cancellation:', cancelError); }
        }
        if (accepted) {
          // Never ask the source to reclaim capture after a durable receiver ACK,
          // even if a later bookkeeping operation failed.
          sendResponse({ ok: true, windowId: win.id, reused: false, panelClosed: false });
          return;
        }
        await discardPopup(win?.id);
        sendResponse({ ok: false, safeToResume, error: String(e && e.message ? e.message : e) });
      } finally {
        openingWindow = false;
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
      let payload;
      let tabId;
      let safeToResume = true;
      try {
        // Re-enable the panel for the tab, in case the pop-out disabled it.
        const stored = await chrome.storage.session.get(TARGET_KEY);
        tabId = stored[TARGET_KEY];
        if (!validChromeId(tabId)) throw new Error('No valid tab to attach to.');
        await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
        safeToResume = false;
        payload = await stageHandoff(msg);
        // A surviving panel document (one sidePanel.close() failed to remove)
        // never re-runs init(), so it is told directly that the snapshot is
        // ready. Fresh documents ignore this: nothing was handed off to them
        // yet, and init() claims it. No listener is not an error.
        try {
          chrome.runtime.sendMessage({ type: 'SWITCHED_BACK' }).catch(() => {});
        } catch (e) { console.warn('Could not notify the sidebar:', e); }
        await waitForHandoff(payload);
        // The receiver owns capture now; metadata cleanup must not make the
        // source resume. Its window-removal listener can retry this cleanup.
        try { await chrome.storage.session.remove(WINDOW_KEY); }
        catch (e) { console.warn('Could not clear pop-out metadata:', e); }
        sendResponse({ ok: true, tabId });
      } catch (e) {
        if (payload) {
          try {
            if (await cancelHandoff(payload.id)) {
              sendResponse({ ok: true, tabId });
              return;
            }
            safeToResume = true;
          } catch (cancelError) { console.warn('Could not persist handoff cancellation:', cancelError); }
        }
        sendResponse({ ok: false, safeToResume, error: String(e && e.message ? e.message : e) });
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

  // Claim reserves the payload; only the restoring document can acknowledge it.
  // A read is never permission to delete the last transcript copy.
  if (msg?.type === 'CLAIM_HANDOFF') {
    (async () => {
      try {
        sendResponse(await claimHandoff(sender, msg.receiverId));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'ACK_HANDOFF') {
    (async () => {
      try {
        sendResponse(await acknowledgeHandoff(msg.handoffId, sender, msg.receiverId));
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
  try {
    const stored = await chrome.storage.session.get(WINDOW_KEY);
    if (stored[WINDOW_KEY] === windowId) {
      await chrome.storage.session.remove(WINDOW_KEY);
      const target = await chrome.storage.session.get(TARGET_KEY);
      const tabId = target[TARGET_KEY];
      if (validChromeId(tabId)) {
        await chrome.sidePanel.setOptions({
          tabId,
          path: 'sidepanel.html',
          enabled: true,
        });
      }
    }
  } catch (e) {
    await reportWorkerError('Could not restore the sidebar after closing the window', e);
  }
});
