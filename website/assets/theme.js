(() => {
  try {
    const saved = localStorage.getItem('zlin-theme');
    const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch { document.documentElement.dataset.theme = 'light'; }
})();
