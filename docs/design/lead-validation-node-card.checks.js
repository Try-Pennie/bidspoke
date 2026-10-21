// The decision checks for docs/design/lead-validation-node-card.html (#2590). Each reads only text and
// computed colours, never a styling class, so it runs the same on the design and on the built canvas.
(function () {
  var FRAMES = ["card"];
  var SLATE_50 = "rgb(248, 250, 252)", SLATE_100 = "rgb(241, 245, 249)", SLATE_700 = "rgb(51, 65, 85)";
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function qa(root, sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function ownText(e) { return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); }); }
  // The "Lead validation" label of the card whose text also names how many checks it runs.
  function label(doc) {
    return qa(doc.body, "*").filter(function (e) {
      if (!ownText(e) || txt(e) !== "Lead validation") return false;
      var card = e.parentElement && e.parentElement.parentElement;
      return card && /\d+ checks/.test(txt(card));
    })[0] || null;
  }
  function header(doc) { var l = label(doc); return l ? l.parentElement : null; }
  function card(doc) { var h = header(doc); return h ? h.parentElement : null; }
  // Every line of text in the card below its header, in order.
  function lines(doc) {
    var h = header(doc);
    return qa(card(doc), "*").filter(function (e) { return ownText(e) && !h.contains(e); }).map(txt);
  }
  window.DESIGN_CHECKS = [
    { id: "C1", frames: FRAMES, check: function (doc, ctx) {
      if (!card(doc)) return bad("no card headed Lead validation");
      var want = [ctx.fixture.node.title, ctx.fixture.node.id, ctx.fixture.checks.length + " checks"];
      var got = lines(doc).slice(0, 3);
      return JSON.stringify(got) === JSON.stringify(want) ? ok(want.join(" / ")) : bad("the card reads " + JSON.stringify(lines(doc)));
    } },
    { id: "C2", frames: FRAMES, check: function (doc) {
      var h = header(doc), l = label(doc);
      if (!h) return bad("no card headed Lead validation");
      var s = css(h);
      if (s.backgroundColor !== SLATE_50) return bad("the header is " + s.backgroundColor);
      if (s.borderBottomColor !== SLATE_100) return bad("the header's rule is " + s.borderBottomColor);
      return css(l).color === SLATE_700 ? ok("slate 50, 100 and 700") : bad("the label is " + css(l).color);
    } },
    { id: "C3", frames: FRAMES, check: function (doc) {
      if (!card(doc)) return bad("no card headed Lead validation");
      var rest = lines(doc).slice(3);
      return JSON.stringify(rest) === JSON.stringify(["↓ pass"]) ? ok() : bad("after the three lines the card reads " + JSON.stringify(rest));
    } }
  ];
})();
