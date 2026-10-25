// The App Action step's settings form (#2338), as Dan settled it in three rounds on 2026-10-24:
// round 1, two dropdowns, Service then Action listing only that service's actions; round 2, a
// required field says so in its label, finished or not, and nothing else marks an unfinished step;
// round 3 ("A button on the field"), a small Insert button on each argument field's label line opens
// the app's dropdown list under the field, headed by the step the values come from, each row the
// value's name with its sample from the last test as its second line.
//
// The fields are drawn as the app's own controls draw them: the Select's trigger for Service and
// Action, the step form's Connection field (docs/design/connections-step-form.html) with "Acts as"
// under it, the design system's input and textarea, the secondary small button, and the Combobox's
// list classes. Every argument of the catalogue's Gmail Send an email is drawn, in the catalogue's
// order, each required one saying so (the rounds drew three of them as a sample).

var CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-3.5 w-3.5" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
var CHEVRON_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down select-trigger-icon h-3.5 w-3.5" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';

function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function label(t, cls) { return el("label", cls || "mb-1 block text-xs font-medium text-gray-600", t); }

// The app's Select (components/ui/Select.tsx), closed, showing its value.
function select(text) {
  var b = el("button", "select-trigger"); b.type = "button"; b.setAttribute("role", "combobox");
  var t = el("span", "select-trigger-text"); var v = el("span", "", text); v.style.pointerEvents = "none"; t.append(v);
  var ic = el("span", "select-trigger-icon"); ic.setAttribute("aria-hidden", "true"); ic.innerHTML = CHEVRON;
  b.append(t, ic); return b;
}
function field(name, control) { var d = el("div", "field"); d.append(label(name), control); return d; }

// The step form's Connection field: the chosen connection with Acts as under it, or the placeholder.
function connection(f, chosen) {
  var outer = el("div"); outer.setAttribute("data-part", "connection-field");
  var d = el("div", "field"); d.append(label("Connection (required)"));
  var box = el("div", "combobox"); var anchor = el("div", "combobox-anchor");
  var b = el("button", "select-trigger"); b.type = "button"; b.setAttribute("role", "combobox");
  b.append(el("span", chosen ? "select-trigger-text" : "select-trigger-text combobox-placeholder", chosen ? f.connection : "Choose a connection"));
  b.insertAdjacentHTML("beforeend", CHEVRON_ICON);
  anchor.append(b); box.append(anchor);
  if (chosen) box.append(el("p", "combobox-hint text-hint", "Acts as " + f.actsAs));
  d.append(box); outer.append(d); return outer;
}

function sampleOf(v) { return typeof v === "string" ? v : JSON.stringify(v); }
function nameOf(key) { var w = key.replace(/[_\-.]+/g, " ").trim().toLowerCase(); return w.charAt(0).toUpperCase() + w.slice(1); }

// The data picker under a field: the app's dropdown list, headed by the step the values come from.
function picker(f) {
  var c = el("div", "combobox-content data-picker"); c.setAttribute("role", "listbox");
  var g = el("div"); g.setAttribute("role", "group");
  g.append(el("p", "combobox-note", "From " + f.fromStep));
  var ul = el("ul", "combobox-list");
  Object.keys(f.triggerPayload).forEach(function (k, i) {
    var li = el("li", "combobox-item" + (i === 0 ? " combobox-item-active" : "")); li.setAttribute("role", "option");
    li.append(el("span", "combobox-item-check"));
    var t = el("span", "combobox-item-text");
    t.append(el("span", "combobox-item-label", nameOf(k)), el("span", "combobox-item-hint", sampleOf(f.triggerPayload[k])));
    li.append(t); ul.append(li);
  });
  g.append(ul); c.append(g); return c;
}

function argument(f, x, value, open) {
  var name = x.label + (x.required ? " (required)" : "");
  var wrap = el("div", "relative");
  var control;
  if (x.multiline) { control = el("textarea", "textarea"); control.textContent = value; }
  else { control = el("input", "input"); control.type = "text"; control.setAttribute("value", value); }
  wrap.append(control);
  if (!x.insert) { var plain = el("div", "field"); plain.append(label(name), wrap); return plain; }
  var d = el("div", "field relative");
  var head = el("div", "mb-1 flex items-center justify-between");
  var ins = el("button", "btn btn-secondary btn-sm", "Insert"); ins.type = "button";
  ins.setAttribute("aria-haspopup", "listbox"); ins.setAttribute("aria-expanded", open ? "true" : "false");
  head.append(label(name, "block text-xs font-medium text-gray-600"), ins);
  d.append(head, wrap);
  if (open) d.append(picker(f));
  return d;
}

function buildScreen(variant) {
  var f = window.DESIGN_FIXTURE;
  var holder = el("div"); holder.innerHTML = f.block;
  var parts = Array.prototype.slice.call(holder.children);
  var stepId = parts[1];
  var values = variant.state === "finished" ? f.finished : f.unfinished;
  var added = [field("Service (required)", select(f.service)), field("Action (required)", select(f.action)), connection(f, variant.state !== "unfinished")];
  f.fields.forEach(function (x, i) { added.push(argument(f, x, values[x.key] || "", variant.state === "picker" && i === 0)); });
  var frag = document.createDocumentFragment();
  parts.forEach(function (p) { frag.append(p); if (p === stepId) added.forEach(function (n) { frag.append(n); }); });
  return frag;
}
