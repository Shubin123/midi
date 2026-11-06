// The UI themes and scale. Each theme sets the page's colour variables on the root element. The chosen theme
// and scale are saved (synthTheme, synthUIScale), and this script is loaded at the top of the page, before
// anything is drawn, so they are back at once on a reload instead of after the page has loaded. js/synth.js
// wires the UI Theme and UI Scale controls to window.uiThemes.
(() => {
 const THEMES = {
  "midnight-drive": {},
  "solarized-dark": {"--bg-color":"#002b36","--primary-surface-color":"#073642","--secondary-surface-color":"#586e75","--accent-color":"#2aa198","--accent-color-darker":"#22847B","--text-color":"#93a1a1","--text-muted-color":"#839496","--border-color":"#657b83","--key-white-bg":"#eee8d5","--key-black-bg":"#001f27","--key-label-white-color":"#586e75","--key-label-black-color":"#93a1a1","--key-label-active-color":"#002b36"},
  "crimson-peak": {"--bg-color":"#2C0A1E","--primary-surface-color":"#4B0D30","--secondary-surface-color":"#6A1F44","--accent-color":"#FF4081","--accent-color-darker":"#F50057","--text-color":"#F8BBD0","--text-muted-color":"#E1A0B5","--border-color":"#88365F","--key-white-bg":"#FCE4EC","--key-black-bg":"#3E0620","--key-label-white-color":"#6A1F44","--key-label-black-color":"#F8BBD0","--key-label-active-color":"#2C0A1E"},
  "cyber-glow": {"--bg-color":"#0D0221","--primary-surface-color":"#24134A","--secondary-surface-color":"#3C2A7D","--accent-color":"#F900BF","--accent-color-darker":"#C70099","--text-color":"#A075FF","--text-muted-color":"#7C51D7","--border-color":"#5A3FB4","--key-white-bg":"#E6DFFF","--key-black-bg":"#1A0F33","--key-label-white-color":"#3C2A7D","--key-label-black-color":"#A075FF","--key-label-active-color":"#0D0221"},
  "forest-calm": {"--bg-color":"#2A3D2F","--primary-surface-color":"#3F5745","--secondary-surface-color":"#5B7565","--accent-color":"#8AB088","--accent-color-darker":"#6E8C6D","--text-color":"#D8E0D9","--text-muted-color":"#B8C0B9","--border-color":"#7A8E7E","--key-white-bg":"#F0F2EF","--key-black-bg":"#1E2A22","--key-label-white-color":"#5B7565","--key-label-black-color":"#D8E0D9","--key-label-active-color":"#2A3D2F"},
  "ocean-depth": {"--bg-color":"#0F1E3D","--primary-surface-color":"#1A325A","--secondary-surface-color":"#2C4A7D","--accent-color":"#36A2EB","--accent-color-darker":"#277FBF","--text-color":"#AEC9E8","--text-muted-color":"#8DA9C7","--border-color":"#4E6A94","--key-white-bg":"#E0E8F5","--key-black-bg":"#0A142A","--key-label-white-color":"#2C4A7D","--key-label-black-color":"#AEC9E8","--key-label-active-color":"#0F1E3D"},
  "autumn-warmth": {"--bg-color":"#4A2A1E","--primary-surface-color":"#6E4532","--secondary-surface-color":"#8C5A40","--accent-color":"#E87A3F","--accent-color-darker":"#BF602F","--text-color":"#F0D9C9","--text-muted-color":"#D9C0AE","--border-color":"#A87A5F","--key-white-bg":"#FAF0E6","--key-black-bg":"#361E15","--key-label-white-color":"#8C5A40","--key-label-black-color":"#F0D9C9","--key-label-active-color":"#4A2A1E"},
  "lavender-haze": {"--bg-color":"#4A4057","--primary-surface-color":"#675A7B","--secondary-surface-color":"#807399","--accent-color":"#B298DC","--accent-color-darker":"#967BBC","--text-color":"#E6E0F0","--text-muted-color":"#C9C0D9","--border-color":"#998FAA","--key-white-bg":"#F5F0FA","--key-black-bg":"#352F3F","--key-label-white-color":"#807399","--key-label-black-color":"#E6E0F0","--key-label-active-color":"#4A4057"},
  "desert-sunset": {"--bg-color":"#3D1B0B","--primary-surface-color":"#5A2A10","--secondary-surface-color":"#7C3E17","--accent-color":"#FF7B2E","--accent-color-darker":"#D9601B","--text-color":"#FADCB9","--text-muted-color":"#EBC9A0","--border-color":"#995424","--key-white-bg":"#FFF5E8","--key-black-bg":"#2A1207","--key-label-white-color":"#7C3E17","--key-label-black-color":"#FADCB9","--key-label-active-color":"#3D1B0B"},
  "steampunk-gears": {"--bg-color":"#4A3B31","--primary-surface-color":"#6B5A4F","--secondary-surface-color":"#8C7C6E","--accent-color":"#D4A373","--accent-color-darker":"#B08968","--text-color":"#E0D6CC","--text-muted-color":"#C1B6AB","--border-color":"#A8998B","--key-white-bg":"#FDF6F0","--key-black-bg":"#382C25","--key-label-white-color":"#8C7C6E","--key-label-black-color":"#E0D6CC","--key-label-active-color":"#4A3B31"},
  "vintage-library": {"--bg-color":"#3D352A","--primary-surface-color":"#5A5043","--secondary-surface-color":"#7C7263","--accent-color":"#A89A85","--accent-color-darker":"#8F826F","--text-color":"#DED8CF","--text-muted-color":"#BEB6AB","--border-color":"#968B7A","--key-white-bg":"#F7F4EF","--key-black-bg":"#2A251E","--key-label-white-color":"#7C7263","--key-label-black-color":"#DED8CF","--key-label-active-color":"#3D352A"},
  "monochrome-noir": {"--bg-color":"#1C1C1C","--primary-surface-color":"#2B2B2B","--secondary-surface-color":"#3A3A3A","--accent-color":"#7F7F7F","--accent-color-darker":"#606060","--text-color":"#D4D4D4","--text-muted-color":"#A8A8A8","--border-color":"#505050","--key-white-bg":"#E8E8E8","--key-black-bg":"#121212","--key-label-white-color":"#3A3A3A","--key-label-black-color":"#D4D4D4","--key-label-active-color":"#1C1C1C"},
  "pastel-dream": {"--bg-color":"#F0E6FF","--primary-surface-color":"#E0D1F5","--secondary-surface-color":"#D1BCED","--accent-color":"#A78BFA","--accent-color-darker":"#8A6FD7","--text-color":"#5C4B7C","--text-muted-color":"#7E6A9F","--border-color":"#BDAAE0","--key-white-bg":"#FFFFFF","--key-black-bg":"#DCC9F7","--key-label-white-color":"#5C4B7C","--key-label-black-color":"#4A3A66","--key-label-active-color":"#F0E6FF"},
 };
 const DEFAULT_THEME = 'midnight-drive', SCALE = [75, 150];
 const KEYS = [...new Set(Object.values(THEMES).flatMap(Object.keys))]; // what any theme sets, cleared by each
 const root = document.documentElement.style;
 const saved = key => { try { return localStorage.getItem(key); } catch { return null; } };
 const keep = (key, value) => { try { localStorage.setItem(key, value); } catch { /* the session still works without storage */ } };
 const ui = {
  THEMES, DEFAULT_THEME, theme: DEFAULT_THEME, scale: 100,
  // Applies a theme by name (an unknown one, say from an older version, falls back to the default) and saves it.
  applyTheme(name, persist = true) {
   ui.theme = name in THEMES ? name : DEFAULT_THEME;
   KEYS.forEach(k => root.removeProperty(k));
   Object.entries(THEMES[ui.theme]).forEach(([k, v]) => root.setProperty(k, v));
   if (persist) keep('synthTheme', ui.theme);
   return ui.theme;
  },
  // Applies a UI scale in percent (75-150; anything else is 100) and saves it.
  applyScale(percent, persist = true) {
   const n = Number(percent);
   ui.scale = n >= SCALE[0] && n <= SCALE[1] ? n : 100;
   root.setProperty('--font-scale-factor', ui.scale / 100);
   if (persist) keep('synthUIScale', ui.scale);
   return ui.scale;
  },
 };
 ui.applyTheme(saved('synthTheme'), false);
 ui.applyScale(saved('synthUIScale') ?? 100, false);
 window.uiThemes = ui;
})();
