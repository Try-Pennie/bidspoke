// The decision checks for docs/design/connections-step-form.html (#2338). Each reads only text,
// data-part and data-* attributes, layout boxes and computed colours, never a styling class, so it
// runs the same on the design and on the built canvas.
(function () {
  var BLUE = "rgb(27, 114, 186)", RED = "rgb(180, 35, 24)";
  var FRAMES = ["step-healthy", "step-problem"];
  function panel(doc) { return doc.getElementById("step-panel-body") || doc.body; }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function ownText(e) { return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); }); }
  function field(doc) { return q(panel(doc), '[data-part="connection-field"]'); }
  function chosen(ctx) {
    var name = ctx.frame === "step-problem" ? "Achieve Salesforce" : "Pennie Salesforce";
    return ctx.fixture.connections.filter(function (c) { return c.name === name; })[0];
  }
  window.DESIGN_CHECKS = [
    { id: "D8", frames: FRAMES, check: function (doc, ctx) {
      var f = field(doc), c = chosen(ctx);
      if (!f) return bad("no Connection field");
      var dd = q(f, "button, [role='combobox']");
      if (!dd || txt(dd) !== c.name) return bad("the dropdown does not read " + c.name);
      var lines = qa(f, "*").filter(function (e) { return ownText(e) && !e.closest("button") && txt(e) !== "Connection"; }).map(txt);
      var want = ["Acts as " + c.actsAs];
      if (c.status !== "ok") want.push(ctx.fixture.statusVocabulary[c.status]);
      if (JSON.stringify(lines) !== JSON.stringify(want)) return bad("under the dropdown: " + JSON.stringify(lines));
      var prob = q(f, '[data-part="connection-problem"]');
      if (c.status !== "ok" && (!prob || css(prob).color !== RED)) return bad("the problem line is not red");
      if (c.status === "ok" && prob) return bad("a problem line shows on a working connection");
      return ok(want.join(" / "));
    } },
    { id: "D24", frames: FRAMES, check: function (doc) {
      var off = qa(field(doc), "*").filter(function (e) {
        if (e.closest("button")) return false;
        var s = css(e); return s.backgroundColor === BLUE || (ownText(e) && s.color === BLUE);
      });
      return off.length ? bad("blue outside a button: " + txt(off[0])) : ok("no blue outside buttons");
    } },
    { id: "D25", frames: FRAMES, check: function (doc) {
      var off = qa(panel(doc), "*").filter(function (e) {
        var s = css(e);
        if (!(s.backgroundColor === RED || (ownText(e) && s.color === RED))) return false;
        return !e.closest('[data-part="connection-problem"]');
      });
      return off.length ? bad("red on something not wrong: " + txt(off[0])) : ok("red only on the problem line");
    } },
    { id: "D27", frames: FRAMES, check: function (doc) {
      var f = field(doc), lone = [];
      qa(f, "*").filter(ownText).forEach(function (b) {
        var ys = [];
        Array.prototype.forEach.call(b.childNodes, function (t) {
          if (t.nodeType !== 3) return;
          var re = /\S+/g, m;
          while ((m = re.exec(t.nodeValue))) {
            var r = doc.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length);
            var rect = r.getClientRects()[0]; if (rect && rect.width) ys.push(Math.round(rect.top));
          }
        });
        var lines = ys.filter(function (y, i) { return ys.indexOf(y) === i; });
        if (lines.length > 1 && ys.filter(function (y) { return y === lines[lines.length - 1]; }).length === 1) lone.push(txt(b));
      });
      return lone.length ? bad("ends on a lone word: " + lone[0]) : ok("no lone last word");
    } }
  ];
})();
