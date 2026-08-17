// In-app text zoom: scales the reading text in both panes (not the UI chrome).
// Persists across reloads; driven by buttons and Ctrl +/-/0.
const KEY = "bt.readingScale";
const MIN = 0.7, MAX = 2.2, STEP = 0.1;

let scale = clamp(parseFloat(localStorage.getItem(KEY)) || 1);

function clamp(v) { return Math.min(MAX, Math.max(MIN, Math.round(v * 100) / 100)); }

function apply() {
  document.documentElement.style.setProperty("--reading-scale", String(scale));
  localStorage.setItem(KEY, String(scale));
  const label = document.getElementById("zoomLevel");
  if (label) label.textContent = Math.round(scale * 100) + "%";
}

function setScale(v) { scale = clamp(v); apply(); }
export function zoomIn() { setScale(scale + STEP); }
export function zoomOut() { setScale(scale - STEP); }
export function zoomReset() { setScale(1); }

export function initZoom() {
  apply();
  document.getElementById("zoomIn")?.addEventListener("click", zoomIn);
  document.getElementById("zoomOut")?.addEventListener("click", zoomOut);
  const label = document.getElementById("zoomLevel");
  label?.addEventListener("click", zoomReset);
  label?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zoomReset(); }
  });

  // Ctrl/Cmd +/-/0 override browser zoom with app-level text zoom.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomIn(); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomOut(); }
    else if (e.key === "0") { e.preventDefault(); zoomReset(); }
  });
}
