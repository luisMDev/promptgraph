// The splash page's only script (DESIGN §20.1 item 4). The shell calls window.__pgSplashError(message)
// when the CLI fails; Retry reloads the page, and the shell runs the CLI again when it finishes loading.
// window.__pgSplashStatus(text) replaces the "Starting promptgraph…" line while something takes longer
// (installing the runtime, restarting the daemon, downloading an update).
// A separate file rather than an inline script, so the splash CSP needs no hashes.
function whenReady(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
  else fn();
}

window.__pgSplashStatus = function (text) {
  whenReady(function () {
    document.getElementById("status").textContent = String(text);
  });
};

window.__pgSplashError = function (message) {
  whenReady(function () {
    document.getElementById("message").textContent = String(message);
    document.body.classList.add("failed");
    document.getElementById("retry").focus();
  });
};

document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("retry").addEventListener("click", function () {
    location.reload();
  });
});
