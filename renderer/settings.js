'use strict';

const theme = document.getElementById('theme');

window.desktop.getTheme().then((value) => {
  if (value) theme.value = value;
});

theme.addEventListener('change', async () => {
  const saved = await window.desktop.setTheme(theme.value);
  if (!saved) theme.value = await window.desktop.getTheme();
});
