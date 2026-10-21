// The decision checks for docs/design/lead-validation-node.html (#2590, #2588). Each reads only text,
// accessible names, roles, form values and computed colours, never a styling class or the page's
// structure beyond "this element holds that text", so it runs the same on the design and on the built
// settings panel. A dropdown is read as a native select or as a combobox button with its listbox.
(function () {
  var NAVY = "rgb(29, 33, 47)", WHITE = "rgb(255, 255, 255)";
  var FRAMES = ["panel"];
  // CONDITION_OPERATOR_SPECS' labels, in CONDITION_OPERATORS order, as settled (D9, D11).
  var OPERATORS = ["=", "≠", ">", "≥", "<", "≤", "contains", "not contains", "in list", "not in list",
    "is true", "is false", "is null", "is not null", "exists", "not exists", "contains a letter", "is not empty"];
  // Each list row: the check's name, then its short condition (D2).
  var ROWS = [
    ["Bidding is on", "biddingActive is true"],
    ["State is allowed", "state in list states"],
    ["Name has letters", "firstName contains a letter and 1 more"],
    ["Loan within maximum", "loanAmount ≤ maximumLoanAmount"],
    ["Not military", "employmentStatus ≠ military"],
    ["Self employed", "employmentStatus = self_employed"],
    ["Phone given", "primaryPhone is not empty"]
  ];
  var SPELLED = /\b(equals|does not equal|greater than|less than|does not contain|does not exist)\b/;

  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function squash(s) { return String(s).replace(/\s+/g, ""); }
  function qa(root, sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function before(a, b) { return !!(a.compareDocumentPosition(b) & 4); }
  // The deepest elements whose whole text is t.
  function byText(root, t) {
    return qa(root, "*").filter(function (e) {
      return txt(e) === t && !Array.prototype.some.call(e.children, function (c) { return txt(c) === t; });
    });
  }
  function upTo(e, pred) { while (e && !pred(e)) e = e.parentElement; return e; }
  function name(e) { return (e.getAttribute("aria-label") || e.getAttribute("title") || txt(e)).trim(); }
  function controlIn(root) { return root ? root.querySelector("select, [role='combobox'], button[aria-haspopup]") : null; }
  function shown(c) {
    if (!c) return "";
    if (c.tagName === "SELECT") return c.selectedIndex >= 0 ? txt(c.options[c.selectedIndex]) : "";
    return txt(c);
  }
  function offered(c) {
    if (!c) return [];
    if (c.tagName === "SELECT") return Array.prototype.map.call(c.options, txt);
    var list = c.getAttribute("aria-controls") && c.ownerDocument.getElementById(c.getAttribute("aria-controls"));
    return qa(list, "[role='option']").map(txt);
  }

  // The panel body: the nearest element around the "Checks, in order" heading holding the lead id field
  // and Advanced too.
  function panel(doc) {
    var h = byText(doc.body, "Checks, in order")[0];
    return upTo(h, function (e) { var t = txt(e); return t.indexOf("Lead id field") >= 0 && t.indexOf("Advanced") >= 0; });
  }
  function heading(doc) { return byText(panel(doc), "Checks, in order")[0]; }
  // Row n (1 based): the deepest element reading its number and the check's name, then anything.
  function row(doc, n) {
    var lead = squash(n + ROWS[n - 1][0]);
    var hits = qa(panel(doc), "button, [role='option'], [role='tab'], [role='button'], li").filter(function (e) {
      return squash(txt(e)).indexOf(lead) === 0;
    });
    return hits.filter(function (e) { return !hits.some(function (o) { return o !== e && e.contains(o); }); })[0] || null;
  }
  function chosenLabel(doc) { return byText(panel(doc), "Check 3 of 7")[0] || null; }
  function editor(doc) {
    return upTo(chosenLabel(doc), function (e) { return txt(e).indexOf("Rejects with") >= 0; });
  }
  function firstLine(doc) { var c = chosenLabel(doc); return c ? c.parentElement : null; }
  // Each condition row of the editor: the element around one "Remove condition" button holding its field.
  function conditionRows(doc) {
    return qa(editor(doc), "button").filter(function (b) { return name(b) === "Remove condition"; })
      .map(function (b) { return upTo(b, function (e) { return qa(e, "input").length > 0; }); });
  }
  function fieldControl(doc, label) {
    var l = byText(panel(doc), label)[0];
    return l ? controlIn(l.parentElement) : null;
  }
  function badge(r, n) { return byText(r, String(n))[0] || null; }

  window.DESIGN_CHECKS = [
    { id: "D1", frames: FRAMES, check: function (doc) {
      var p = panel(doc);
      if (!p) return bad("no panel holding the heading Checks, in order");
      var rows = ROWS.map(function (_, i) { return row(doc, i + 1); });
      var missing = rows.map(function (r, i) { return r ? null : i + 1; }).filter(Boolean);
      if (missing.length) return bad("no list row for check " + missing.join(", "));
      if (!before(heading(doc), rows[0])) return bad("the list is not under the heading");
      for (var i = 1; i < rows.length; i++) if (!before(rows[i - 1], rows[i])) return bad("row " + (i + 1) + " is out of order");
      var eds = qa(p, "*").filter(function (e) { return /^Check \d+ of \d+$/.test(txt(e)) && !e.children.length; });
      if (eds.length !== 1) return bad(eds.length + " editors, wanted one");
      var ed = editor(doc);
      if (!ed || !before(rows[6], ed)) return bad("the editor is not after the list");
      var stray = byText(p, "Match:").filter(function (m) { return !ed.contains(m); });
      return stray.length ? bad("a rule builder outside the editor") : ok("seven rows in order, one editor below");
    } },
    { id: "D2", frames: FRAMES, check: function (doc) {
      for (var i = 0; i < ROWS.length; i++) {
        var r = row(doc, i + 1);
        var want = (i + 1) + ROWS[i][0] + ROWS[i][1];
        if (!r || squash(txt(r)) !== squash(want)) return bad("row " + (i + 1) + " reads " + JSON.stringify(txt(r)) + ", wanted " + JSON.stringify(want));
      }
      return ok("every row reads its name and short condition");
    } },
    { id: "D3", frames: FRAMES, check: function (doc) {
      for (var n = 1; n <= ROWS.length; n++) {
        var r = row(doc, n), b = r && badge(r, n);
        if (!b) return bad("row " + n + " has no number badge");
        var edge = css(r), navyEdge = edge.borderLeftColor === NAVY && edge.borderLeftWidth === "2px";
        var navyBadge = css(b).backgroundColor === NAVY;
        if (n === 3) {
          if (!navyBadge || css(b).color !== WHITE) return bad("row 3's badge is not navy with white text");
          if (!navyEdge) return bad("row 3 has no 2px navy left edge");
        } else if (navyBadge || navyEdge) {
          return bad("row " + n + " is marked navy");
        }
      }
      return ok("only row 3 is marked navy");
    } },
    { id: "D4", frames: FRAMES, check: function (doc) {
      var ed = editor(doc);
      return ed && txt(ed).indexOf("Check 3 of 7") === 0 ? ok() : bad("the editor does not start with Check 3 of 7");
    } },
    { id: "D5", frames: FRAMES, check: function (doc) {
      var boxes = qa(firstLine(doc), "input");
      return boxes.length === 1 && boxes[0].value === "Name has letters" ? ok() : bad("the editor's first line holds no text box reading Name has letters");
    } },
    { id: "D6", frames: FRAMES, check: function (doc) {
      var names = qa(firstLine(doc), "button").map(name);
      return JSON.stringify(names) === JSON.stringify(["Move up", "Move down", "Remove check"]) ? ok() : bad("buttons on the first line: " + JSON.stringify(names));
    } },
    { id: "D7", frames: FRAMES, check: function (doc, ctx) {
      var ed = editor(doc);
      if (!ed || !byText(ed, "Match:").length) return bad("no Match: in the editor");
      var logic = qa(ed, "button").map(name);
      if (logic.indexOf("AND") < 0 || logic.indexOf("OR") < 0) return bad("no AND and OR buttons");
      if (logic.indexOf("Add condition") < 0) return bad("no Add condition button");
      var want = ctx.fixture.checks[2].rows, rows = conditionRows(doc);
      if (rows.length !== want.length) return bad(rows.length + " condition rows, wanted " + want.length);
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i] || qa(rows[i], "input")[0].value !== want[i].field) return bad("condition " + (i + 1) + " does not hold " + want[i].field);
        if (!controlIn(rows[i])) return bad("condition " + (i + 1) + " has no operator dropdown");
      }
      return ok("the rule builder with " + rows.length + " conditions");
    } },
    { id: "D8", frames: FRAMES, check: function (doc) {
      var adds = qa(panel(doc), "button").filter(function (b) { return name(b) === "Add check"; });
      if (adds.length !== 1) return bad(adds.length + " Add check buttons");
      return before(row(doc, 7), adds[0]) && before(adds[0], chosenLabel(doc)) ? ok() : bad("Add check is not between the list and the editor");
    } },
    { id: "D9", frames: FRAMES, check: function (doc) {
      for (var n = 1; n <= ROWS.length; n++) {
        var t = txt(row(doc, n)).replace(ROWS[n - 1][0], "");
        if (SPELLED.test(t)) return bad("row " + n + " spells its operator out: " + t);
      }
      var summary = txt(row(doc, 3));
      var off = conditionRows(doc).map(function (r) { return shown(controlIn(r)); }).filter(function (s) { return !s || summary.indexOf(s) < 0; });
      return off.length ? bad("the dropdown's words " + JSON.stringify(off) + " are not in row 3's summary") : ok("summaries use the dropdown's words");
    } },
    { id: "D11", frames: FRAMES, check: function (doc) {
      var rows = conditionRows(doc);
      if (!rows.length) return bad("no condition rows");
      for (var i = 0; i < rows.length; i++) {
        var c = controlIn(rows[i]);
        if (JSON.stringify(offered(c)) !== JSON.stringify(OPERATORS)) return bad("condition " + (i + 1) + " offers " + JSON.stringify(offered(c)));
        if (shown(c) !== "contains a letter") return bad("condition " + (i + 1) + " shows " + shown(c));
        if (qa(rows[i], "input").length !== 1) return bad("condition " + (i + 1) + " has a value box");
      }
      return ok("eighteen operators, the last two contains a letter and is not empty");
    } },
    { id: "D12", frames: FRAMES, check: function (doc) {
      var l = byText(panel(doc), "Lead id field")[0];
      if (!l) return bad("no Lead id field");
      var box = qa(l.parentElement, "input")[0];
      if (!box || box.value !== "trigger.payload.leadUuid") return bad("the Lead id field does not read trigger.payload.leadUuid");
      if (!byText(l.parentElement, "Sent back as lead_id when a lead is rejected.").length) return bad("no line saying what the lead id is for");
      return before(l, heading(doc)) ? ok() : bad("the Lead id field is not ahead of the checks");
    } },
    { id: "D13", frames: FRAMES, check: function (doc, ctx) {
      var c = fieldControl(doc, "Rejects with");
      if (!c) return bad("no Rejects with dropdown");
      if (shown(c) !== "invalid name") return bad("Rejects with shows " + shown(c));
      return JSON.stringify(offered(c)) === JSON.stringify(ctx.fixture.reasons) ? ok() : bad("Rejects with offers " + JSON.stringify(offered(c)));
    } },
    { id: "D14", frames: FRAMES, check: function (doc) {
      var c = fieldControl(doc, "If the lead has no value");
      if (!c) return bad("no If the lead has no value dropdown");
      if (shown(c) !== "Reject with this reason") return bad("it shows " + shown(c));
      var want = ["Reject with this reason", "Let it through", "Fail the run"];
      return JSON.stringify(offered(c)) === JSON.stringify(want) ? ok() : bad("it offers " + JSON.stringify(offered(c)));
    } },
    { id: "D15", frames: FRAMES, check: function (doc) {
      var p = panel(doc);
      var adv = qa(p, "button").filter(function (b) { return name(b) === "Advanced"; });
      if (adv.length !== 1) return bad(adv.length + " Advanced buttons");
      if (adv[0].getAttribute("aria-expanded") === "true") return bad("Advanced is expanded");
      if (!before(heading(doc), adv[0])) return bad("Advanced is not after the checks");
      return /Advanced$/.test(txt(p)) ? ok() : bad("something follows Advanced in the panel");
    } }
  ];
})();
