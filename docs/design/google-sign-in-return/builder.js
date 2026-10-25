// The settled return from Sign in with Google (#2338, build PR 13), drawn from the two rounds Dan
// settled on 2026-10-23: round 1 put it back in the add form he left (D1), round 2 kept the
// declined sentence the product's error red, FieldError (D2). Everything drawn is the product's own
// markup, the add form as captured on 2026-10-23 with its working line or its failed line under the
// Sign in with Google and Cancel row, exactly as the built page draws them.

function connectionsPage() {
  var main = document.getElementById("main-content");
  var page = main && main.querySelector(".cx-page");
  if (!page) throw new Error("the captured page has no .cx-page inside #main-content");
  return page.cloneNode(true);
}

// The working line: the app's Outcome, with its spinner, under the buttons (D1).
function workingLine(f) {
  var line = document.createElement("div");
  line.className = "ad-line";
  line.setAttribute("data-part", "save-line");
  line.setAttribute("data-state", "saving");
  var p = document.createElement("p");
  p.setAttribute("role", "status");
  p.className = "outcome outcome-working";
  p.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 animate-spin" aria-hidden="true" data-part="spinner"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
  // Four text nodes, as React writes {label}, {seconds} s, so the line is shaped as the build's is.
  p.append(document.createTextNode(f.finishing), document.createTextNode(", "), document.createTextNode(f.elapsed), document.createTextNode(" s"));
  line.append(p);
  return line;
}

// The failed line: FieldError, the product's error red (D2), under the buttons (D1).
function failedLine(f) {
  var p = document.createElement("p");
  p.setAttribute("role", "alert");
  p.className = "field-error text-sm ad-line";
  p.setAttribute("data-part", "save-line");
  p.setAttribute("data-state", "failed");
  p.textContent = f.declined;
  return p;
}

function buildScreen(variant) {
  var f = window.DESIGN_FIXTURE;
  var page = connectionsPage();
  var form = page.querySelector('[data-part="add-form"]');
  var foot = form && form.querySelector(".ad-foot");
  if (!foot) throw new Error("the captured page has no add form with an .ad-foot");
  if (variant.state === "finishing") {
    // While the finish runs the sign in button is held, as Save is while a login is checked (R13).
    var button = foot.querySelector('[data-part="google-sign-in"]');
    if (!button) throw new Error("the add form has no Sign in with Google button");
    button.setAttribute("disabled", "");
    foot.after(workingLine(f));
  } else if (variant.state === "declined") {
    foot.after(failedLine(f));
  } else {
    throw new Error("no such state: " + variant.state);
  }
  return page;
}
