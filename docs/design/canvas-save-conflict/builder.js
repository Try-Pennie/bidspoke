// The canvas save conflict (#2599), as rounds 1 and 2 settled it on 2026-10-22: the round 2
// builder, drawing every frame of the settled design. The bar is the canvas's own red save error
// strip with both actions on its right in the toolbar's own button style (round 1); each action
// asks first in the app's shared warning Dialog, naming exactly what is lost, with Cancel and a red
// action (round 2, and Dan for both actions on 2026-10-22). Buttons and the dialog are the
// product's own classes (btn btn-secondary / btn btn-destructive, and the shared Dialog's
// dialog-overlay / dialog / dialog-title / dialog-description / dialog-actions).
var ALERT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-alert h-3.5 w-3.5 flex-shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg>';
var TOOLBAR_BUTTON = "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium border-gray-200 text-gray-600 hover:bg-beige bg-white whitespace-nowrap shrink-0";

function el(tag, className, text) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function sentence(f, named) {
  return named
    ? "Not saved. " + f.savedBy + " saved this workflow at " + f.savedAt + ", after you opened it. Your changes are still on the canvas."
    : "Not saved. This workflow was changed at " + f.savedAt + ", outside the canvas, after you opened it. Your changes are still on the canvas.";
}

function bar(text) {
  var b = el("div", "flex items-center gap-2 bg-red-50 px-4 py-2 text-xs text-red-600");
  b.setAttribute("data-part", "save-conflict");
  b.innerHTML = ALERT_ICON;
  b.append(el("span", "", text));
  var actions = el("div", "ml-auto flex items-center gap-2");
  actions.append(el("button", TOOLBAR_BUTTON, "Load their version"));
  actions.append(el("button", TOOLBAR_BUTTON, "Save mine over theirs"));
  b.append(actions);
  return b;
}

function dialog(title, description, action) {
  var frag = document.createDocumentFragment();
  frag.append(el("div", "dialog-overlay"));
  var d = el("div", "dialog dialog-sm");
  d.setAttribute("role", "alertdialog");
  d.setAttribute("aria-modal", "true");
  d.append(el("h2", "dialog-title", title));
  d.append(el("p", "dialog-description", description));
  var actions = el("div", "dialog-actions");
  actions.append(el("button", "btn btn-secondary", "Cancel"));
  actions.append(el("button", "btn btn-destructive", action));
  d.append(actions);
  frag.append(d);
  return frag;
}

function buildScreen(variant) {
  var f = window.DESIGN_FIXTURE;
  var wrap = el("div", "");
  wrap.append(bar(sentence(f, variant.named !== false)));
  if (variant.ask === "save-over") {
    wrap.append(dialog("Save over " + f.savedBy + "'s version?", "Their save at " + f.savedAt + " is replaced by your changes. It stays in Version history.", "Save over theirs"));
  }
  if (variant.ask === "load-theirs") {
    wrap.append(dialog("Load " + f.savedBy + "'s version?", "Your unsaved changes on the canvas are discarded and cannot be brought back.", "Load theirs"));
  }
  return wrap;
}
