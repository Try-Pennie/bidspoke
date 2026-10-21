// The lead validation step's card on the canvas, as Dan settled it in the #934 design rounds on 2026-10-21
// (#2590): round 5, its one extra line says how many checks it runs ("7 checks"); round 6, its header is
// slate, the Tailwind 50 shade behind (#f8fafc), 100 for the rule (#f1f5f9) and 700 for the label (#334155),
// the same steps every other card uses. This is round 6's builder drawing only the option Dan chose, in place
// of the Filter card in the captured canvas (#round-card), at the Filter card's width (208px at the canvas's
// 125% zoom), from the same fixture as the settled panel.
//
// Regenerate the settled file from the repository root with
//   python3 ~/.claude/skills/design-rounds/make-settled.py docs/design/lead-validation-node-card/settled.json docs/design/lead-validation-node-card.html
function h(tag, cls, kids, attrs) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  (kids || []).forEach(function (k) { if (k == null) return; e.append(typeof k === "string" ? document.createTextNode(k) : k); });
  Object.keys(attrs || {}).forEach(function (a) { e.setAttribute(a, attrs[a]); });
  return e;
}
function icon(d) {
  var w = document.createElement("span");
  w.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>";
  return w.firstChild;
}
// The capture was taken 1911 wide; the design draws narrower, so the canvas is moved to keep this card centred.
function recentre(card) {
  var doc = card.ownerDocument;
  var vp = doc.querySelector(".react-flow__viewport");
  var pane = doc.querySelector(".react-flow");
  if (!vp || !pane) return;
  var m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(vp.style.transform);
  if (!m) return;
  var p = pane.getBoundingClientRect(), r = card.getBoundingClientRect();
  var tx = +m[1] + (p.x + p.width / 2 - (r.x + r.width / 2));
  var ty = +m[2] + (p.y + p.height / 2 - (r.y + r.height / 2));
  vp.style.transform = "translate(" + Math.round(tx) + "px, " + Math.round(ty) + "px) scale(" + m[3] + ")";
}
var SLATE = {bg: "#f8fafc", rule: "#f1f5f9", ink: "#334155"};
function buildScreen(variant) {
  var fx = window.DESIGN_FIXTURE;
  var card = h("div", "relative rounded-lg border bg-white shadow-sm border-gray-200", [
    h("div", "flex items-center gap-2 rounded-t-lg border-b px-3 py-2", [
      icon('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
      h("span", "text-xs font-semibold uppercase tracking-wide", ["Lead validation"])
    ]),
    h("div", "px-3 py-2", [
      h("p", "truncate text-sm font-semibold text-graphite", [fx.node.title]),
      h("p", "truncate font-mono text-xs text-slate-400", [fx.node.id]),
      h("p", "mt-0.5 truncate text-xs text-slate-400", [fx.checks.length + " checks"])
    ]),
    h("div", "relative border-t border-gray-100 text-xs", [h("span", "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-0.5 text-center truncate text-green-600", ["↓ pass"])], {style: "height: 28px;"})
  ], {style: "width: 208px;"});
  // The header in slate: set directly, since a hue no card uses yet is not in the captured stylesheet.
  var head = card.firstChild;
  head.style.background = SLATE.bg;
  head.style.borderBottomColor = SLATE.rule;
  head.style.color = SLATE.ink;
  return card;
}
function screenShown(variant, element) {
  var slot = element && element.ownerDocument && element.ownerDocument.getElementById ? element.ownerDocument.getElementById("round-card") : null;
  if (slot) recentre(slot);
}
