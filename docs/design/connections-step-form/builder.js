// A workflow step's Connection field on the canvas, as settled in the #2338 design rounds (rounds 8,
// 8b and 24, 2026-10-20, and the Check failing follow up the same day), drawn into the captured canvas chrome's step panel body (#step-panel-body)
// at 1120 wide. Display name, Step ID, Operation and Object are drawn as the product draws them
// today; only the Connection field is the decision. make-settled.py hands buildScreen one variant
// per frame: {chosen: "<connection name>" or null, list: "ready" (left out), "loading", "failed",
// "refused" or "empty"}; a chosen name the fixture does not hold is a connection the list no longer has.
//
// The field is the app's dropdown with the chosen connection's name, and under it "Acts as <who>"
// only. Nothing about status shows on a healthy day; a connection with a problem adds one red line,
// its status in the page's own vocabulary and where it is fixed: "Needs reconnecting on the
// Connections page", the page's name a dark underlined link (round 24). What a check reads is
// marked with data-part attributes.
//
// Regenerate the settled file from the repository root with
//   python3 ~/.claude/skills/design-rounds/make-settled.py docs/design/connections-step-form/settled.json docs/design/connections-step-form.html
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function part(e, name) { e.setAttribute("data-part", name); return e; }
var CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
// The app's working line spinner (lucide Loader2), sized by the shared .outcome svg rule (round 32).
var SPINNER = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true" data-part="spinner"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
function label(t) { return el("span", "mb-1 block text-xs font-medium text-gray-600", t); }
function field(t, control, hint) { var d = el("div"); d.setAttribute("data-field", t); d.append(label(t), control); if (hint) d.append(hint); return d; }
function input(v) { var i = el("input", "input"); i.value = v; return i; }
function picker(text) {
  var b = el("button", "select-trigger"); b.type = "button"; b.setAttribute("aria-haspopup", "listbox");
  var s = el("span", "select-trigger-text", text); var ic = el("span", "select-trigger-icon"); ic.innerHTML = CHEVRON;
  b.append(s, ic); return b;
}
function buildScreen(variant) {
  var fx = window.DESIGN_FIXTURE;
  var chosen = fx.connections.filter(function (c) { return c.name === variant.chosen; })[0];
  var body = el("div", "p-4 space-y-5");
  body.append(field("Display name", input(fx.step.displayName), el("p", "mt-1 text-xs text-gray-500", "How this step appears on the canvas. Leave blank to use the step ID.")));
  body.append(field("Step ID", input(fx.step.stepId), el("p", "mt-1 text-xs text-gray-500", "Unique identifier used to reference this step's output in later steps. E.g. steps.credit_check.score")));
  var list = variant.list || "ready";
  var words = fx.fieldWords;
  var under = el("div");
  var boxText = chosen ? chosen.name : "";
  // The field's own states, as Dan passed them on 2026-10-21 (#2338): the box never shows an id, so
  // it is blank while the list loads or failed, and reads the placeholder once the list is read
  // without the chosen connection. A list that could not be read says why in FieldError's red with
  // Try again; none of the service says where one is added.
  if (list === "loading") {
    boxText = "";
    var work = el("p", "outcome outcome-working");
    work.setAttribute("role", "status");
    work.innerHTML = SPINNER;
    work.append(document.createTextNode(words.loading + ", " + words.loadingSeconds + " s"));
    var wrap = el("div", "sf-hint sf-line"); wrap.append(work); under.append(wrap);
  } else if (list === "failed" || list === "refused") {
    boxText = "";
    var box = el("div", "sf-hint sf-line sf-failed");
    var why = part(el("p", "field-error text-xs", list === "failed" ? words.noAnswer : words.refused), "connection-failed");
    why.setAttribute("role", "alert");
    var again = el("button", "btn btn-secondary btn-sm", "Try again"); again.type = "button";
    box.append(why, again); under.append(box);
  } else if (list === "empty") {
    boxText = "";
    var none = el("p", "sf-hint sf-line text-hint");
    var add = el("a", null, words.page); add.href = "#";
    none.append(document.createTextNode(words.emptyBefore), add, document.createTextNode(words.emptyAfter));
    under.append(none);
  } else if (!chosen) {
    if (variant.chosen) {
      var gone = part(el("p", "sf-hint sf-line field-error", words.gone), "connection-failed");
      gone.setAttribute("role", "alert");
      under.append(gone);
    }
  } else {
    under.append(part(el("div", "sf-hint", "Acts as " + chosen.actsAs), "acts-as"));
  }
  if (list === "ready" && chosen && chosen.status !== "ok") {
    // Round 24 drew this line for Needs reconnecting; Dan settled Check failing the same way on
    // 2026-10-20 (#2338, the R8 follow up): "Check failing on the Connections page". The line is
    // drawn through the app's failure class (field-error, FieldError's red), the build's one red
    // for a sentence saying something is wrong, which no eye tells from the status red #B42318.
    var bad = part(el("div", "sf-hint sf-problem field-error"), "connection-problem");
    var where = el("a", null, "Connections page"); where.href = "#";
    bad.append(document.createTextNode(fx.statusVocabulary[chosen.status] + " on the "), where);
    under.append(bad);
  }
  var trigger = picker(boxText);
  if (!boxText && list === "ready" || list === "empty") {
    trigger.querySelector(".select-trigger-text").textContent = words.placeholder;
    trigger.querySelector(".select-trigger-text").classList.add("sf-placeholder");
  }
  var conn = field("Connection", trigger, under.childNodes.length ? under : null);
  conn.setAttribute("data-part", "connection-field");
  var sec = el("section", "space-y-4");
  sec.append(conn, field("Operation", picker(fx.step.operation)), field("Object", picker(fx.step.object)));
  body.append(sec);
  return body;
}
