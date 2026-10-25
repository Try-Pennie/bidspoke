// The decision checks for docs/design/app-action-test-send.html (#2339). Each reads only text, roles,
// attributes and computed styles, never a styling class, so it runs the same on the design and on the
// built canvas (apps/web/src/app/dev/app-action).
(function () {
  var FRAMES = ["send-unticked", "send-ticked"];
  // Tailwind 4 may compute a colour as oklch; the rgb spelling is kept for a page that writes hex.
  var NAVY = ["rgb(29, 33, 47)"];
  var WHITE = ["rgb(255, 255, 255)", "oklch(1 0 0)"];
  function is(colour, names) { return names.indexOf(colour) !== -1; }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function qa(root, sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function words(f) { return "Send for real. This " + f.realSend + " from " + f.connection + ". It cannot be taken back."; }
  // The step's test section: the nearest element holding both the Test this node toggle and Run cold.
  function runCold(doc) {
    return qa(doc.body, "button").filter(function (b) { return txt(b) === "Run cold"; })[0] || null;
  }
  function section(doc) {
    var run = runCold(doc), e = run;
    while (e && !qa(e, "button").some(function (b) { return txt(b) === "Test this node"; })) e = e.parentElement;
    return e;
  }
  function tick(doc) { return qa(section(doc), "[role=checkbox]")[0] || null; }
  function ticked(ctx) { return ctx.frame === "send-ticked" || (ctx.frame && ctx.frame.id === "send-ticked"); }
  // How many words sit on the last line the element's text is drawn on.
  function lastLineWords(e) {
    var node = null, walker = e.ownerDocument.createTreeWalker(e, 4);
    var range = e.ownerDocument.createRange(), tops = [], m, re = /\S+/g;
    while ((node = walker.nextNode())) {
      while ((m = re.exec(node.nodeValue))) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        tops.push(Math.round(range.getBoundingClientRect().top));
      }
      re.lastIndex = 0;
    }
    var last = Math.max.apply(null, tops);
    return tops.filter(function (t) { return Math.abs(t - last) <= 2; }).length;
  }
  window.DESIGN_CHECKS = [
    { id: "T1", frames: FRAMES, check: function (doc, ctx) {
      var run = runCold(doc), box = tick(doc);
      if (!run || !section(doc)) return bad("no test section holding Test this node and Run cold");
      if (!box) return bad("the test section holds no checkbox");
      if (txt(box) !== words(ctx.fixture)) return bad("the checkbox reads " + JSON.stringify(txt(box)));
      if (box.getBoundingClientRect().bottom > run.getBoundingClientRect().top) return bad("the checkbox is not above Run cold");
      var n = lastLineWords(box);
      return n >= 2 ? ok(txt(box)) : bad("its last line holds " + n + " word");
    } },
    { id: "T2", frames: FRAMES, check: function (doc, ctx) {
      var run = runCold(doc), box = tick(doc);
      if (!run || !box) return bad("no checkbox and Run cold");
      var want = ticked(ctx), checked = box.getAttribute("aria-checked") === "true" || box.checked === true;
      if (checked !== want) return bad("the checkbox is " + (checked ? "" : "not ") + "checked");
      if (run.disabled === want) return bad("Run cold is " + (run.disabled ? "disabled" : "enabled") + " with the box " + (want ? "ticked" : "unticked"));
      return ok((want ? "ticked, Run cold enabled" : "unticked, Run cold disabled"));
    } },
    { id: "T3", frames: FRAMES, check: function (doc, ctx) {
      var box = tick(doc);
      if (!box) return bad("no checkbox");
      var square = box.firstElementChild, label = box.lastElementChild;
      if (!square || square === label) return bad("the checkbox has no square before its words");
      var s = css(square);
      if (!is(s.borderTopColor, NAVY)) return bad("the square's border is " + s.borderTopColor);
      var want = ticked(ctx) ? NAVY : WHITE;
      if (!is(s.backgroundColor, want)) return bad("the square's fill is " + s.backgroundColor);
      if (!is(css(label).color, NAVY)) return bad("its words are " + css(label).color);
      return ok("navy square, " + (ticked(ctx) ? "navy" : "white") + " fill, navy words");
    } }
  ];
})();
