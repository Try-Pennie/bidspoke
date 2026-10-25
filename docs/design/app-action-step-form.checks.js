// The decision checks for docs/design/app-action-step-form.html (#2338). Each reads only text, roles,
// attributes and computed styles, never a styling class, so it runs the same on the design and on the
// built canvas (apps/web/src/app/dev/app-action).
(function () {
  var ALL = ["form-finished", "form-unfinished", "form-picker"];
  var HIGHLIGHT = ["rgb(241, 239, 234)"];
  var RED = /rgb\((2[0-9]{2}), ([0-9]{1,2}), ([0-9]{1,2})\)/;
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function qa(root, sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function ownText(e) { return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); }); }
  // The panel's labels, in order: every element whose own text is a field's name.
  function panel(doc) {
    var stepId = qa(doc.body, "*").filter(function (e) { return ownText(e) && txt(e) === "Step ID"; })[0];
    var e = stepId;
    while (e && !qa(e, "*").some(function (x) { return ownText(x) && /^Service/.test(txt(x)); })) e = e.parentElement;
    return e;
  }
  function labels(doc) { return qa(panel(doc), "label, span").filter(function (e) { return ownText(e) && e.children.length === 0; }); }
  function labelOf(doc, text) { return labels(doc).filter(function (e) { return txt(e) === text; })[0] || null; }
  // A field: the nearest ancestor of its label that also holds its control.
  function fieldOf(lab) { var e = lab; while (e && !e.querySelector("input, textarea, button[role=combobox]")) e = e.parentElement; return e; }
  function argLabel(x) { return x.label + (x.required ? " (required)" : ""); }
  function argLabels(doc, f) { return f.fields.map(function (x) { return labelOf(doc, argLabel(x)); }); }

  window.DESIGN_CHECKS = [
    { id: "F1", frames: ALL, check: function (doc, ctx) {
      var f = ctx.fixture, p = panel(doc);
      if (!p) return bad("no panel holding Step ID and Service");
      var names = labels(doc).map(txt);
      var at = ["Step ID", "Service (required)", "Action (required)", "Connection (required)"].map(function (n) { return names.indexOf(n); });
      if (at.some(function (i) { return i < 0; })) return bad("the panel reads " + JSON.stringify(names.slice(0, 8)));
      if (!(at[0] < at[1] && at[1] < at[2] && at[2] < at[3])) return bad("the order is " + JSON.stringify(at));
      var svc = fieldOf(labelOf(doc, "Service (required)")), act = fieldOf(labelOf(doc, "Action (required)"));
      var sb = svc && svc.querySelector("button[role=combobox]"), ab = act && act.querySelector("button[role=combobox]");
      if (!sb || txt(sb) !== f.service) return bad("Service shows " + txt(sb));
      if (!ab || txt(ab) !== f.action) return bad("Action shows " + txt(ab));
      return ok(f.service + " / " + f.action);
    } },
    { id: "F2", frames: ALL, check: function (doc, ctx) {
      var f = ctx.fixture, found = argLabels(doc, f);
      var missing = f.fields.filter(function (x, i) { return !found[i]; }).map(argLabel);
      if (missing.length) return bad("no label reads " + JSON.stringify(missing));
      for (var i = 1; i < found.length; i++) {
        if (found[i - 1].compareDocumentPosition(found[i]) & 2) return bad(argLabel(f.fields[i]) + " comes before " + argLabel(f.fields[i - 1]));
      }
      var red = qa(panel(doc), "*").filter(function (e) { return ownText(e) && RED.test(css(e).color) && +RED.exec(css(e).color)[1] > 180 && +RED.exec(css(e).color)[2] < 80; });
      if (red.length) return bad("red text in the panel: " + txt(red[0]));
      return ok(found.map(txt).join(", "));
    } },
    { id: "F3", frames: ["form-finished", "form-unfinished"], check: function (doc, ctx) {
      var f = ctx.fixture, fld = fieldOf(labelOf(doc, "Connection (required)"));
      if (!fld) return bad("no Connection field");
      var b = fld.querySelector("button[role=combobox]"), acts = "Acts as " + f.actsAs;
      var hasActs = qa(fld, "*").some(function (e) { return ownText(e) && txt(e) === acts; });
      if (ctx.frame === "form-unfinished") {
        if (txt(b) !== "Choose a connection") return bad("it shows " + txt(b));
        return hasActs ? bad("an Acts as line shows with no connection") : ok("Choose a connection");
      }
      if (txt(b) !== f.connection) return bad("it shows " + txt(b));
      return hasActs ? ok(f.connection + ", " + acts) : bad("no line reads " + acts);
    } },
    { id: "F4", frames: ALL, check: function (doc, ctx) {
      var f = ctx.fixture, found = argLabels(doc, f), wrong = [];
      f.fields.forEach(function (x, i) {
        var lab = found[i]; if (!lab) { wrong.push(argLabel(x) + " missing"); return; }
        var line = lab.parentElement;
        var ins = qa(line, "button").filter(function (b) { return txt(b) === "Insert"; })[0];
        if (x.insert && !ins) wrong.push(x.label + " has no Insert");
        if (!x.insert && ins) wrong.push(x.label + " has an Insert");
        if (ins && ins.getBoundingClientRect().left < lab.getBoundingClientRect().right) wrong.push(x.label + "'s Insert is not right of its label");
      });
      return wrong.length ? bad(wrong.join("; ")) : ok(f.fields.filter(function (x) { return x.insert; }).length + " Insert buttons");
    } },
    { id: "F5", frames: ["form-picker"], check: function (doc, ctx) {
      var f = ctx.fixture, lab = labelOf(doc, argLabel(f.fields[0])), fld = lab && lab.parentElement.parentElement;
      var box = fld && fld.querySelector("input, textarea");
      var list = fld && fld.querySelector("[role=listbox]");
      if (!list) return bad("no list under " + f.fields[0].label);
      var head = qa(list, "*").filter(function (e) { return ownText(e) && txt(e) === "From " + f.fromStep; })[0];
      if (!head) return bad("the list is not headed From " + f.fromStep);
      var keys = Object.keys(f.triggerPayload), rows = qa(list, "[role=option]");
      if (rows.length !== keys.length) return bad("it holds " + rows.length + " rows, not " + keys.length);
      for (var i = 0; i < rows.length; i++) {
        var lines = qa(rows[i], "*").filter(function (e) { return ownText(e); }).map(txt);
        var sample = typeof f.triggerPayload[keys[i]] === "string" ? f.triggerPayload[keys[i]] : JSON.stringify(f.triggerPayload[keys[i]]);
        if (lines[1] !== sample) return bad("row " + (i + 1) + " reads " + JSON.stringify(lines));
      }
      if (HIGHLIGHT.indexOf(css(rows[0]).backgroundColor) < 0) return bad("the first row is " + css(rows[0]).backgroundColor);
      var a = box.getBoundingClientRect(), b = list.getBoundingClientRect();
      if (Math.abs(a.left - b.left) > 0.5 || Math.abs(a.right - b.right) > 0.5 || b.top < a.bottom) return bad("the list is not under the field at its width");
      return ok(rows.length + " rows from " + f.fromStep);
    } }
  ];
})();
