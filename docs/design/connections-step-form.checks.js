// The decision checks for docs/design/connections-step-form.html (#2338). Each reads only text,
// data-part and data-* attributes, layout boxes and computed colours, never a styling class, so it
// runs the same on the design and on the built canvas.
(function () {
  var BLUE = "rgb(27, 114, 186)", RED = "rgb(180, 35, 24)", NAVY = "rgb(29, 33, 47)";
  // Round 24: the problem line names where it is fixed, the page's name a link to it.
  var WHERE = " on the ", PAGE = "Connections page";
  var FRAMES = ["step-healthy", "step-problem", "step-failing"];
  var CHOSEN = { "step-healthy": "Pennie Salesforce", "step-problem": "Achieve Salesforce", "step-failing": "Lendco Salesforce" };
  function panel(doc) { return doc.getElementById("step-panel-body") || doc.body; }
  // The app's red for a sentence saying something is wrong, read from the colour FieldError's class draws
  // on this side, beside the status red; a line in grey or any other colour is refused, never passed.
  function failureRed(doc) {
    var p = panel(doc), probe = doc.createElement("span"); probe.className = "field-error"; probe.textContent = "x";
    p.append(probe); var c = css(probe).color; probe.remove();
    return c;
  }
  function reds(doc) { var f = failureRed(doc); return f && f !== css(panel(doc)).color ? [f, RED] : [RED]; }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function ownText(e) { return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); }); }
  function field(doc) { return q(panel(doc), '[data-part="connection-field"]'); }
  function underlined(e) { return css(e).textDecorationLine.indexOf("underline") >= 0; }
  function weight(e) { return parseInt(css(e).fontWeight, 10); }
  function chosen(ctx) {
    var name = CHOSEN[ctx.frame];
    return ctx.fixture.connections.filter(function (c) { return c.name === name; })[0];
  }
  window.DESIGN_CHECKS = [
    { id: "D8", frames: FRAMES, check: function (doc, ctx) {
      var f = field(doc), c = chosen(ctx);
      if (!f) return bad("no Connection field");
      var dd = q(f, "button, [role='combobox']");
      if (!dd || txt(dd) !== c.name) return bad("the dropdown does not read " + c.name);
      // Each line as read: a link inside a line is part of that line, not a line of its own.
      var lines = qa(f, "*").filter(function (e) { return ownText(e) && !e.closest("button") && !e.closest("a") && txt(e) !== "Connection"; }).map(txt);
      var want = ["Acts as " + c.actsAs];
      if (c.status !== "ok") want.push(ctx.fixture.statusVocabulary[c.status] + WHERE + PAGE);
      if (JSON.stringify(lines) !== JSON.stringify(want)) return bad("under the dropdown: " + JSON.stringify(lines));
      var prob = q(f, '[data-part="connection-problem"]');
      if (c.status === "ok") return prob || q(f, "a") ? bad("a problem line or link shows on a working connection") : ok(want.join(" / "));
      if (!prob || reds(doc).indexOf(css(prob).color) < 0 || weight(prob) !== 500) return bad("the problem line is not red at weight 500");
      var links = qa(prob, "a");
      if (links.length !== 1 || txt(links[0]) !== PAGE || !links[0].getAttribute("href")) return bad("the problem line has no link reading " + PAGE);
      var a = links[0];
      if (css(a).color !== NAVY || !underlined(a) || weight(a) !== 400) return bad("the " + PAGE + " link is not dark, underlined and normal weight");
      return ok(want.join(" / ") + ", " + PAGE + " a dark underlined link");
    } },
    { id: "D24", frames: FRAMES, check: function (doc) {
      var off = qa(field(doc), "*").filter(function (e) {
        if (e.closest("button")) return false;
        var s = css(e); return s.backgroundColor === BLUE || (ownText(e) && s.color === BLUE);
      });
      if (off.length) return bad("blue outside a button: " + txt(off[0]));
      var links = qa(field(doc), "a").filter(function (a) { return css(a).color !== NAVY || !underlined(a); });
      return links.length ? bad("a link is not dark and underlined: " + txt(links[0])) : ok("no blue outside buttons, links dark and underlined");
    } },
    { id: "D25", frames: FRAMES, check: function (doc) {
      var red = reds(doc);
      var off = qa(panel(doc), "*").filter(function (e) {
        var s = css(e);
        if (!(red.indexOf(s.backgroundColor) >= 0 || (ownText(e) && red.indexOf(s.color) >= 0))) return false;
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
