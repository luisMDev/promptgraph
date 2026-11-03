// The splash page's only script (DESIGN §20.1 item 4). The shell calls window.__pgSplashError(message)
// when the CLI fails; Retry reloads the page, and the shell runs the CLI again when it finishes loading.
// A separate file rather than an inline script, so the splash CSP needs no hashes.
window.__pgSplashError = function (message) {
  function show() {
    document.getElementById("message").textContent = String(message);
    document.body.classList.add("failed");
    document.getElementById("retry").focus();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show);
  else show();
};

document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("retry").addEventListener("click", function () {
    location.reload();
  });
});
