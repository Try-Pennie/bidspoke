// The confirmation before testing an ops step that really sends (#2339), as Dan settled it in round 1
// ("A tick first"): a tick box above the Build from run and Run cold buttons, which must be ticked
// before Run cold works. The step is Gmail's Send an email on the Ops mailbox connection. The test
// section is exactly as the product draws it (captured), and the tick box is the app's own TickRow
// (components/ui/form.tsx): a navy square holding a tick when ticked, its words after it.

var CHECK = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check h-2.5 w-2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';

function el(tag, className, text) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

// What the tick box says: what the action sends and the connection it sends from.
function words(f) {
  return "Send for real. This " + f.realSend + " from " + f.connection + ". It cannot be taken back.";
}

function buildScreen(variant) {
  var f = window.DESIGN_FIXTURE;
  var ticked = variant.ticked === true;
  var wrap = el("div", "");
  wrap.innerHTML = f.section;
  var buttons = wrap.querySelector(".flex.items-center.gap-2");
  var runCold = buttons.lastElementChild;

  var row = el("button", ticked ? "tick-row tick-row-on" : "tick-row");
  row.type = "button";
  row.setAttribute("role", "checkbox");
  row.setAttribute("aria-checked", ticked ? "true" : "false");
  var box = el("span", "tick-box");
  box.setAttribute("aria-hidden", "true");
  if (ticked) box.innerHTML = CHECK;
  row.append(box, el("span", "", words(f)));
  // Its lines are balanced so none ends with one word alone (Dan's copy rule, .impeccable.md); the
  // words are the round's.
  var line = el("div", "");
  line.style.textWrap = "pretty";
  line.append(row);
  buttons.parentElement.insertBefore(line, buttons);
  runCold.disabled = !ticked;

  // The captured section's own container is the slot; its children are the section.
  var frag = document.createDocumentFragment();
  while (wrap.firstChild) frag.appendChild(wrap.firstChild);
  return frag;
}
