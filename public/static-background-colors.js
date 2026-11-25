// Restore each supported desktop color before paint. These browser preferences are
// independent of the selected theme, animated backgrounds and collection data.
(() => {
  'use strict';
  const root = document.documentElement;
  const configurations = [
    { theme: 'dos', background: 'dosBackground', defaultColor: '#080a0a',
      key: 'savepoint-dos-classic-color-v1', property: '--dos-classic-color' },
    { theme: 'classic', background: 'classicBackground', defaultColor: '#008080',
      key: 'savepoint-classic-desktop-color-v1', property: '--classic-desktop-color' },
    { theme: 'classic3', background: 'classic3Background', defaultColor: '#3a6ea5',
      key: 'savepoint-classic3-desktop-color-v1', property: '--classic3-desktop-color' },
    { theme: 'platinum', defaultColor: '#858da8',
      key: 'savepoint-platinum-desktop-color-v1', property: '--platinum-desktop-color' },
    { theme: 'bee', defaultColor: '#07486d',
      key: 'savepoint-bee-desktop-color-v1', property: '--bee-desktop-color' }
  ];
  const colors = new Map();

  function normalizeColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
      ? value.toLowerCase() : null;
  }
  function applyColor(configuration, color) {
    colors.set(configuration.theme, color);
    root.style.setProperty(configuration.property, color);
    if (configuration.theme !== 'bee') return;

    // Tint Bee's woven desktop without changing its gradient geometry. The
    // default uses the original stylesheet verbatim, including its exact palette.
    root.dataset.beeDesktopCustomColor = String(color !== configuration.defaultColor);
    const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    const shade = (factor, white = 0) => '#' + channels
      .map(channel => Math.round(channel * factor + 255 * white).toString(16).padStart(2, '0'))
      .join('');
    root.style.setProperty('--bee-desktop-shadow', shade(0.86));
    root.style.setProperty('--bee-desktop-highlight', shade(0.78, 0.22));
    root.style.setProperty('--bee-desktop-sheen', shade(0.70, 0.30) + '22');
  }
  for (const configuration of configurations) {
    let saved = null;
    try { saved = localStorage.getItem(configuration.key); } catch {}
    const color = normalizeColor(saved) ?? configuration.defaultColor;
    applyColor(configuration, color);
  }

  function initializeColors() {
    const controls = document.getElementById('staticBackgroundColorControls');
    const picker = document.getElementById('staticBackgroundColor');
    const reset = document.getElementById('staticBackgroundColorReset');
    if (!controls || !picker || !reset) return;
    let displayedConfiguration = null;

    // Use the displayed background, including renderer-failure fallback. A
    // saved animated choice does not authorize editing its hidden desktop color.
    function currentConfiguration() {
      return configurations.find(configuration => root.dataset.theme === configuration.theme
        && (!configuration.background || root.dataset[configuration.background] === 'classic')) ?? null;
    }
    function render() {
      displayedConfiguration = currentConfiguration();
      controls.hidden = displayedConfiguration === null;
      picker.disabled = displayedConfiguration === null;
      if (!displayedConfiguration) { reset.disabled = true; return; }
      const color = colors.get(displayedConfiguration.theme);
      picker.value = color;
      reset.disabled = color === displayedConfiguration.defaultColor;
    }
    function editableConfiguration() {
      const current = currentConfiguration();
      // Reject events from a hidden or stale picker after a theme/background
      // change, even if a script dispatches them without a normal UI refresh.
      if (!current || current !== displayedConfiguration || controls.hidden) {
        render();
        return null;
      }
      return current;
    }
    function changeColor() {
      const configuration = editableConfiguration();
      const color = normalizeColor(picker.value);
      if (!configuration || !color) return;
      applyColor(configuration, color);
      try { localStorage.setItem(configuration.key, color); } catch {}
      render();
    }
    function resetColor() {
      const configuration = editableConfiguration();
      if (!configuration) return;
      applyColor(configuration, configuration.defaultColor);
      try { localStorage.removeItem(configuration.key); } catch {}
      // Reset becomes disabled at the default. Move its keyboard focus first
      // so the appearance menu does not interpret that as leaving the menu.
      if (document.activeElement === reset) {
        try { picker.focus({ preventScroll: true }); } catch {}
      }
      render();
    }

    picker.addEventListener('input', changeColor);
    picker.addEventListener('change', changeColor);
    reset.addEventListener('click', resetColor);
    document.addEventListener('savepoint:themechange', render);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeColors, { once: true });
  else initializeColors();
})();
