'use strict';

const controls = {
  theme: document.getElementById('theme'),
  startPage: document.getElementById('start-page'),
  confirmOnClose: document.getElementById('confirm-on-close'),
};
const status = document.getElementById('settings-status');
let saved = null;

function message(text) {
  status.textContent = text;
  status.hidden = !text;
}

function show(values) {
  saved = values;
  controls.theme.value = values.theme;
  controls.startPage.value = values.startPage;
  controls.confirmOnClose.checked = values.confirmOnClose;
}

function disableSettings(disabled) {
  for (const control of Object.values(controls)) control.disabled = disabled;
}

async function load() {
  disableSettings(true);
  try {
    const result = await window.desktop.getSettings();
    if (!result?.ok || !result.settings) throw new Error(result?.error || 'Settings could not be loaded.');
    show(result.settings);
    disableSettings(false);
    message('');
    return true;
  } catch (error) {
    message(error.message || 'Settings could not be loaded.');
    return false;
  }
}

async function save(key, value) {
  if (!saved) return;
  disableSettings(true);
  try {
    const result = await window.desktop.setSetting(key, value);
    if (!result?.ok || !result.settings) throw new Error(result?.error || 'Setting could not be saved.');
    show(result.settings);
    message('Saved.');
  } catch (error) {
    show(saved);
    message(error.message || 'Setting could not be saved.');
  } finally {
    disableSettings(false);
  }
}

controls.theme.addEventListener('change', () => save('theme', controls.theme.value));
controls.startPage.addEventListener('change', () => save('startPage', controls.startPage.value));
controls.confirmOnClose.addEventListener('change', () => save('confirmOnClose', controls.confirmOnClose.checked));

async function runAction(buttonId, method, success) {
  const button = document.getElementById(buttonId);
  button.addEventListener('click', async () => {
    button.disabled = true;
    message('Working…');
    try {
      const result = await window.desktop[method]();
      if (result?.cancelled) {
        message('Cancelled.');
      } else {
        if (!result?.ok) throw new Error(result?.error || 'Action failed.');
        if (method === 'resetLauncher' && !await load()) return;
        message(success);
      }
    } catch (error) {
      message(error.message || 'Action failed.');
    } finally {
      button.disabled = false;
    }
  });
}

runAction('reload-client', 'reloadClient', 'Client reload requested.');
runAction('open-logs', 'openLogs', 'Logs folder opened.');
runAction('sign-out', 'signOutShowdown', 'Showdown data cleared.');
runAction('reset-launcher', 'resetLauncher', 'Launcher data reset.');
load();
