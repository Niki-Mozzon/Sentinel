'use strict';

const DEFAULTS = {
  enabled: true,
  showConsoleErrors: true,
  showConsoleWarns: false,
  showNetwork: true,
  networkMinStatus: 0,
  clearOnNav: false
};

const ids = ['enabled', 'showConsoleErrors', 'showConsoleWarns', 'showNetwork', 'networkMinStatus', 'clearOnNav'];

function el(id) { return document.getElementById(id); }

function applySettings(settings) {
  ids.forEach(id => {
    const input = el(id);
    if (!input) return;
    if (input.type === 'checkbox') {
      input.checked = settings[id];
    } else {
      input.value = settings[id];
    }
  });
  updateThresholdVisibility(settings.showNetwork);
}

function updateThresholdVisibility(showNetwork) {
  const row = el('row-threshold');
  if (row) row.style.opacity = showNetwork ? '1' : '0.4';
}

function save(key, value) {
  const patch = {};
  patch[key] = value;
  chrome.storage.sync.set(patch);
}

chrome.storage.sync.get(DEFAULTS, applySettings);

ids.forEach(id => {
  const input = el(id);
  if (!input) return;
  input.addEventListener('change', () => {
    const value = input.type === 'checkbox' ? input.checked : Number(input.value);
    save(id, value);
    if (id === 'showNetwork') updateThresholdVisibility(value);
  });
});
