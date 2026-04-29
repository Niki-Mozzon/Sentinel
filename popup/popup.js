'use strict';

const enabledEl = document.getElementById('enabled');

chrome.storage.sync.get({ enabled: true }, function (r) {
  enabledEl.checked = r.enabled;
});

enabledEl.addEventListener('change', function () {
  chrome.storage.sync.set({ enabled: enabledEl.checked });
});

document.getElementById('open-settings').addEventListener('click', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: '__SENTINEL_OPEN_SETTINGS__' }, function () {
      if (chrome.runtime.lastError) return;
    });
    window.close();
  });
});
