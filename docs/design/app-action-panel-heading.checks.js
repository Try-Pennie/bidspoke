// The decision checks for docs/design/app-action-panel-heading.html (#2765). Each reads only text and the
// document's structure, never a styling class, so it runs the same on the design and on the built canvas
// (apps/web/src/app/dev/app-action). The line's capitals are its CSS, so its text is compared as written.
(function () {
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function qa(root, sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  // The panel's heading line: the element just above the step's display name in the step panel.
  function headingLine(doc, label) {
    var name = qa(doc.body, "aside p").filter(function (e) { return txt(e) === label; })[0];
    return name ? { name: name, line: name.previousElementSibling } : null;
  }

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["panel-heading"], check: function (doc, ctx) {
      var f = ctx.fixture, want = [f.service, f.action].filter(Boolean).join(", ");
      var found = headingLine(doc, f.label);
      if (!found) return bad("no line in the panel reads the step name " + f.label);
      if (!found.line) return bad("nothing sits above the step name " + f.label);
      var got = txt(found.line);
      if (got.toLowerCase() !== want.toLowerCase()) return bad("the heading line reads " + JSON.stringify(got) + ", not " + JSON.stringify(want));
      return ok(got);
    } },
  ];
})();
