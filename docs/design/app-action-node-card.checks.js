// The decision checks for docs/design/app-action-node-card.html (#2339). Each reads only text,
// attributes and computed styles, never a styling class, so it runs the same on the design and on
// the built canvas (apps/web/src/app/dev/app-action).
(function () {
  var FRAMES = ["app-action-card"];
  // Tailwind 4 computes its palette as oklch; the rgb spelling is kept for a page that writes hex.
  var BEIGE = ["rgb(249, 246, 240)"];
  var GRAY_100 = ["rgb(243, 244, 246)", "oklch(0.967 0.003 264.542)"];
  var GRAY_600 = ["rgb(75, 85, 99)", "oklch(0.446 0.03 256.802)"];
  function is(colour, names) { return names.indexOf(colour) !== -1; }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function qa(root, sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function ownText(e) { return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); }); }
  // The service's name: the element whose own text is the fixture's service, followed by the action's chip.
  function name(doc, f) {
    return qa(doc.body, "*").filter(function (e) {
      return ownText(e) && txt(e) === f.service && e.nextElementSibling && txt(e.nextElementSibling) === f.action;
    })[0] || null;
  }
  function header(doc, f) { var n = name(doc, f); return n ? n.parentElement : null; }
  function card(doc, f) { var h = header(doc, f); return h ? h.parentElement : null; }
  // Every line of text in the card below its header, in order.
  function lines(doc, f) {
    var h = header(doc, f);
    return qa(card(doc, f), "*").filter(function (e) { return ownText(e) && !h.contains(e); });
  }
  window.DESIGN_CHECKS = [
    { id: "A1", frames: FRAMES, check: function (doc, ctx) {
      var n = name(doc, ctx.fixture);
      if (!n) return bad("no header reads " + ctx.fixture.service + " beside a chip reading " + ctx.fixture.action);
      var chip = n.nextElementSibling;
      var a = n.getBoundingClientRect(), b = chip.getBoundingClientRect();
      return b.left >= a.right ? ok(ctx.fixture.service + " | " + ctx.fixture.action) : bad("the chip starts at " + b.left + ", left of the name's end at " + a.right);
    } },
    { id: "A2", frames: FRAMES, check: function (doc, ctx) {
      var n = name(doc, ctx.fixture), h = header(doc, ctx.fixture);
      if (!h) return bad("no App Action header");
      if (!is(css(h).backgroundColor, BEIGE)) return bad("the header is " + css(h).backgroundColor);
      if (!qa(h, "svg path").some(function (p) { return (p.getAttribute("fill") || "").toLowerCase() === "#0066da"; })) return bad("the header holds no Google Drive mark");
      if (css(n).textTransform !== "none") return bad("the service's name is drawn " + css(n).textTransform);
      if (!is(css(n).color, GRAY_600)) return bad("the service's name is " + css(n).color);
      var chip = n.nextElementSibling, s = css(chip);
      if (!is(s.backgroundColor, GRAY_100) || !is(s.color, GRAY_600)) return bad("the chip is " + s.backgroundColor + " with " + s.color + " text");
      return ok("beige header, Drive mark, gray 600 name, gray 100 chip");
    } },
    { id: "A3", frames: FRAMES, check: function (doc, ctx) {
      if (!card(doc, ctx.fixture)) return bad("no App Action card");
      var below = lines(doc, ctx.fixture);
      var got = below.map(txt), want = [ctx.fixture.label, ctx.fixture.namespace];
      if (JSON.stringify(got) !== JSON.stringify(want)) return bad("below its header the card reads " + JSON.stringify(got));
      var family = css(below[1]).fontFamily.toLowerCase();
      return /mono/.test(family) ? ok(want.join(" / ")) : bad("the step id is drawn in " + family);
    } }
  ];
})();
