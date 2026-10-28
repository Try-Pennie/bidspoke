// The decision checks for docs/design/google-mailbox-reconnect.html (#2727), one per decision the map
// verifies by a check. Each reads only what the design and the built page share: text, roles and
// data-part attributes, never a styling class. The score runs them on the design first (the positive
// control) and then on the built page.
(function () {
  var FIX = "Ask the Google Workspace admin to check Bidspoke's access to this mailbox, then Reconnect.";
  function main(doc) { return doc.getElementById("main-content") || doc.body; }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function p(root, name) { return q(root, '[data-part="' + name + '"]'); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function buttons(root) { return qa(root, 'button, [role="button"]'); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  // The company mailbox's panel, and why not when it is not drawn.
  function panelOf(doc) { return p(main(doc), "detail"); }
  function replaceIn(panel) { return buttons(panel).filter(function (b) { return txt(b) === "Replace"; }); }

  window.DESIGN_CHECKS = [
    // Round 1: Reconnect is a one click check under the word every connection uses, and another mailbox is a new connection.
    { id: "D1", frames: ["google-mailbox-working"], check: function (doc) {
      var panel = panelOf(doc);
      if (!panel) return bad("no detail panel");
      var acts = p(panel, "actions");
      if (!acts) return bad("the panel has no actions row");
      var labels = buttons(acts).map(txt);
      if (!same(labels, ["Reconnect"])) return bad("the actions row reads " + JSON.stringify(labels));
      if (replaceIn(panel).length) return bad("a button in the panel reads Replace");
      return ok("one Reconnect in the actions row, and no Replace");
    } },
    // Round 1: the refused panel has no Replace either.
    { id: "D3", frames: ["google-mailbox-refused"], check: function (doc) {
      var panel = panelOf(doc);
      if (!panel) return bad("no detail panel");
      if (!p(panel, "problem-notice")) return bad("the panel draws no problem notice, so this is not the refused mailbox");
      if (replaceIn(panel).length) return bad("a button in the panel reads Replace");
      return ok("no Replace in the refused panel");
    } },
    // Round 2: the notice's fix line sends the person to the Workspace admin, then Reconnect.
    { id: "D4", frames: ["google-mailbox-refused"], check: function (doc) {
      var panel = panelOf(doc);
      var note = panel && p(panel, "problem-notice");
      if (!note) return bad("no problem notice");
      var lines = qa(note, "p").map(txt);
      if (!lines.length) return bad("the notice has no lines");
      var fix = lines[lines.length - 1];
      if (fix !== FIX) return bad("the fix line reads " + JSON.stringify(fix));
      return ok("the fix line reads the settled sentence");
    } }
  ];
})();
