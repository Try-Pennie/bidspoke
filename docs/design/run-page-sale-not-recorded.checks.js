// The decision checks for docs/design/run-page-sale-not-recorded.html (#3129). The decision is a
// colour, so its check reads the badge's tone classes, which are ToneBadge.tsx's own for the amber
// tone, the same on the design and on the built run page.
(function () {
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function qa(root, sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  var AMBER = ["bg-amber-50", "text-amber-700"];

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["run-page"], check: function (doc, ctx) {
      var partner = ctx.fixture.unresolved_partner;
      var row = qa(doc.body, "tbody tr").filter(function (r) { var cells = qa(r, "td"); return cells.length > 1 && txt(cells[1]) === partner; })[0];
      if (!row) return bad("no Buyers considered row names " + partner);
      var badge = qa(qa(row, "td")[2], "span")[0];
      if (!badge) return bad("the " + partner + " row's outcome cell holds no badge");
      if (txt(badge) !== "Sale not recorded") return bad("the " + partner + " row's outcome badge reads " + JSON.stringify(txt(badge)) + ", not Sale not recorded");
      var missing = AMBER.filter(function (c) { return !badge.classList.contains(c); });
      if (missing.length) return bad("the badge lacks the amber tone's " + missing.join(" and "));
      return ok("Sale not recorded, amber");
    } },
  ];
})();
