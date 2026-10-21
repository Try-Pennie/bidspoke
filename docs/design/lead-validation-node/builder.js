// The lead validation step's settings panel, as Dan settled it in the #934 design rounds on 2026-10-21
// (#2590, #2588): round 1, a numbered list of checks on top and the chosen check edited below; round 2,
// each row shows the check's name and a short form of its condition; round 3, conditions are named in the
// rule builder dropdown's own words; round 4, the two new operators are "contains a letter" and "is not
// empty". This is round 4's builder drawing only the option Dan chose (listDetail, summary rows, the two
// settled names, check 3 open), into the captured config panel slot (#round-panel) at 1120 wide, with the
// product's own classes copied from the live Branch panel.
//
// The fixture's operators are the shared list's ids (CONDITION_OPERATORS); LABELS below is
// CONDITION_OPERATOR_SPECS' label for each, as the build reads it.
//
// Regenerate the settled file from the repository root with
//   python3 ~/.claude/skills/design-rounds/make-settled.py docs/design/lead-validation-node/settled.json docs/design/lead-validation-node.html
function h(tag, cls, kids, attrs) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  (kids || []).forEach(function (k) { if (k == null) return; e.append(typeof k === "string" ? document.createTextNode(k) : k); });
  Object.keys(attrs || {}).forEach(function (a) { e.setAttribute(a, attrs[a]); });
  return e;
}
function icon(d, size) {
  var s = size || 14;
  var wrap = document.createElement("span");
  wrap.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>";
  return wrap.firstChild;
}
var I = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>'
};
var LABELS = [
  ["eq", "="], ["neq", "≠"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"],
  ["contains", "contains"], ["not_contains", "not contains"], ["in_array", "in list"], ["not_in_array", "not in list"],
  ["is_true", "is true"], ["is_false", "is false"], ["is_null", "is null"], ["is_not_null", "is not null"],
  ["exists", "exists"], ["not_exists", "not exists"], ["has_letter", "contains a letter"], ["not_blank", "is not empty"]
];
var VALUELESS = ["is_true", "is_false", "is_null", "is_not_null", "exists", "not_exists", "has_letter", "not_blank"];
function opName(op) { for (var i = 0; i < LABELS.length; i++) if (LABELS[i][0] === op) return LABELS[i][1]; return op; }

function select(options, value, cls) {
  var s = h("select", cls || "input");
  options.forEach(function (o) {
    var opt = h("option", null, [o.label || o]);
    opt.value = o.value || o;
    if ((o.value || o) === value) opt.selected = true;
    s.append(opt);
  });
  return s;
}
function input(value, cls, placeholder) {
  var i = h("input", cls || "input");
  i.value = value || "";
  if (placeholder) i.placeholder = placeholder;
  return i;
}
function field(label, control, hint) {
  return h("div", null, [h("span", "mb-1 block text-xs font-medium text-gray-600", [label]), control, hint ? h("p", "mt-1 text-xs text-gray-500", [hint]) : null]);
}
// The rule builder group, exactly as the Branch panel draws one.
function ruleGroup(check) {
  var rows = h("div", "space-y-1.5", check.rows.map(function (r) {
    var kids = [
      h("div", "relative min-w-0 flex-1", [input(r.field, "w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-p-blue-dark focus:outline-none", "field.path")]),
      select(LABELS.map(function (o) { return {value: o[0], label: o[1]}; }), r.operator, "shrink-0 rounded border border-gray-200 px-1.5 py-1 text-xs focus:border-p-blue-dark focus:outline-none")
    ];
    if (VALUELESS.indexOf(r.operator) < 0) kids.push(input(r.value, "min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-xs focus:border-p-blue-dark focus:outline-none", "value"));
    kids.push(h("button", "shrink-0 text-gray-300 hover:text-red-400", [icon(I.x, 12)], {"aria-label": "Remove condition"}));
    return h("div", "flex items-center gap-1.5", kids);
  }));
  return h("div", "rounded-lg border border-gray-200 p-3 text-xs", [
    h("div", "mb-2 flex items-center gap-2", [
      h("span", "text-gray-500", ["Match:"]),
      h("button", "rounded px-1.5 py-0.5 font-medium " + (check.match === "AND" ? "bg-gray-100 text-gray-800" : "text-gray-500"), ["AND"]),
      h("button", "rounded px-1.5 py-0.5 font-medium " + (check.match === "OR" ? "bg-gray-100 text-gray-800" : "text-gray-500"), ["OR"])
    ]),
    rows,
    h("button", "mt-2 flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy", [icon(I.plus, 12), "Add condition"])
  ]);
}
function outcomeFields(check, fx) {
  return h("div", "grid grid-cols-2 gap-2", [
    field("Rejects with", select(fx.reasons, check.reason, "input text-xs")),
    field("If the lead has no value", select(fx.missing, check.missing, "input text-xs"))
  ]);
}
// A short form of the condition: the field's last segment, the operator in the dropdown's words, and the
// value with the Constants prefix dropped; a check with more rows says how many more.
function summary(check) {
  var r = check.rows[0];
  var tail = r.value ? " " + r.value.replace(/^steps\.constants\.output\./, "") : "";
  return r.field.split(".").pop() + " " + opName(r.operator) + tail + (check.rows.length > 1 ? " and " + (check.rows.length - 1) + " more" : "");
}
function numberBadge(n, selected) {
  return h("span", "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium " + (selected ? "bg-navy text-white" : "bg-gray-100 text-gray-600"), [String(n)]);
}
function moveRemove() {
  return h("div", "flex shrink-0 items-center gap-0.5", [
    h("button", "rounded p-1 text-gray-400 hover:bg-gray-100", [icon(I.up, 12)], {"aria-label": "Move up"}),
    h("button", "rounded p-1 text-gray-400 hover:bg-gray-100", [icon(I.down, 12)], {"aria-label": "Move down"}),
    h("button", "rounded p-1 text-gray-300 hover:text-red-400", [icon(I.x, 12)], {"aria-label": "Remove check"})
  ]);
}
function addCheck() {
  return h("button", "flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy", [icon(I.plus, 12), "Add check"]);
}
// A short numbered list on top, each row the check's name and its condition; the chosen check's editor
// under it.
function listDetail(fx, chosen) {
  var list = h("div", "overflow-hidden rounded-lg border border-gray-200", fx.checks.map(function (c, i) {
    var sel = i === chosen;
    var row = h("button", "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs " + (i ? "border-t border-gray-100 " : "") + (sel ? "bg-gray-50 font-medium text-navy" : "text-gray-800 hover:bg-gray-50"), [
      numberBadge(i + 1, sel), h("span", "min-w-0 flex-1 truncate", [c.label]),
      h("span", "min-w-0 max-w-[55%] shrink truncate text-gray-500 font-normal", [summary(c)])
    ]);
    // The selection mark is the product's navy (#1D212F), set directly: no Tailwind class for it ships.
    row.style.borderLeft = "2px solid " + (sel ? "#1D212F" : "transparent");
    return row;
  }));
  var c = fx.checks[chosen];
  var editor = h("div", "rounded-lg border border-gray-200 p-3 space-y-3", [
    h("div", "flex items-center gap-2", [h("span", "text-xs text-gray-500 shrink-0", ["Check " + (chosen + 1) + " of " + fx.checks.length]), input(c.label, "input flex-1"), moveRemove()]),
    ruleGroup(c),
    outcomeFields(c, fx)
  ]);
  return h("div", "space-y-3", [list, addCheck(), editor]);
}

function buildScreen(variant) {
  var fx = window.DESIGN_FIXTURE;
  var panel = h("div", "flex h-full flex-col", [
    h("div", "flex items-center justify-between border-b border-gray-100 px-4 py-3", [
      h("div", null, [h("p", "text-xs font-medium uppercase tracking-wide text-gray-500", ["lead validation"]), h("p", "mt-0.5 text-sm font-semibold text-graphite", [fx.node.title]), h("p", "font-mono text-xs text-gray-500", [fx.node.id])]),
      h("div", "flex items-center gap-1", [
        h("button", "rounded p-1.5 text-gray-500 hover:bg-gray-100", [icon(I.copy)], {"aria-label": "Duplicate node"}),
        h("button", "rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-500", [icon(I.trash)], {"aria-label": "Delete node"}),
        h("button", "rounded p-1.5 text-gray-500 hover:bg-gray-100", [icon(I.x)], {"aria-label": "Close"})
      ])
    ]),
    h("div", "flex-1 overflow-y-auto text-sm", [h("div", "p-4 space-y-5", [
      field("Display name", input(fx.node.title)),
      field("Step ID", input(fx.node.id)),
      field("Lead id field", input(fx.node.leadIdField), "Sent back as lead_id when a lead is rejected."),
      h("section", "space-y-3", [h("p", "text-xs font-medium uppercase tracking-wide text-gray-500", ["Checks, in order"]), listDetail(fx, variant.chosen != null ? variant.chosen : fx.chosen)]),
      h("div", null, [h("button", "flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500", [icon(I.chevR, 12), "Advanced"], {"aria-expanded": "false"})])
    ])]),
    h("div", "border-t border-gray-100 px-4 py-3", [h("button", "flex w-full items-center justify-between text-xs font-semibold text-gray-700", [h("span", null, ["Test this node"])])])
  ]);
  return panel;
}
