const ROOT = document.documentElement;

function syncViewportHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  ROOT.style.setProperty('--app-height', `${Math.round(height)}px`);
}

export function initViewportHeight() {
  syncViewportHeight();

  window.visualViewport?.addEventListener('resize', syncViewportHeight);
  window.visualViewport?.addEventListener('scroll', syncViewportHeight);
  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('orientationchange', syncViewportHeight);
}
