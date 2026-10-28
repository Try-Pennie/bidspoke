// The decision checks for docs/design/insert-too-big-answer.html (#2882). Each reads only text, roles
// and attributes, never a styling class, so it runs the same on the design and on the built canvas.
(function () {
  var SENTENCE = "Its last test answered more than 160 KB, too much to keep, so it has no values.";
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function qa(root, sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function ownText(e) { return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); }); }

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["picker-too-big"], check: function (doc) {
      var list = qa(doc.body, "[role=listbox]").filter(function (l) { return l.getAttribute("aria-label") === "Values from earlier steps"; })[0];
      if (!list) return bad("no Insert list open");
      var group = qa(list, "[role=group]").filter(function (g) { return g.getAttribute("aria-label") === "From Find lead"; })[0];
      if (!group) return bad("the list has no group From Find lead");
      var lines = qa(group, "*").filter(function (e) { return ownText(e); }).map(txt);
      if (lines.indexOf(SENTENCE) < 0) return bad("the group reads " + JSON.stringify(lines));
      return ok(SENTENCE);
    } }
  ];
})();
