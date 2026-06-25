/* ============================================================
   Cognitive Reader — front-end engine
   Talks to Python through QWebChannel (window.bridge).
   ============================================================ */
"use strict";

const CR = {
  bridge: null,
  state: null,          // per-doc state mirror
  settings: null,
  doc: null,            // {title, sections:[{level,text,sid}]}
  undoStack: [], redoStack: [],
  brush: { on:false, color:"#b08968", size:6, drawing:false, stroke:null },
  scroll: { lastY:0, lastT:0 },
  readTimer: { total:0, lastTick: Date.now() },
  hlColors: ["#ffe9a8","#ffd6cc","#d4edda","#cce5ff","#e8d5f5","#f5e0c3","#d9f2e6"],
  noteColors:["#fff3a8","#ffd9e8","#d2f0ff","#dcffd8","#f3e3ff","#ffe6c7"],
  tools: { highlightDefault:false },
  bubbleCount: 0,
};

/* ------------------------------------------------ utils */
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const uid = () => "id" + Math.random().toString(36).slice(2, 10);
const esc = s => (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF]/g;
function dirOf(text){
  const rtl = (text.match(RTL_RE)||[]).length;
  const ltr = (text.match(/[A-Za-z]/g)||[]).length;
  return rtl > ltr ? "rtl" : "ltr";
}
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove("show"), 2600);
}
function send(type, payload){ if (CR.bridge) CR.bridge.on_js_event(JSON.stringify({type, payload: payload||{}})); }
function saveState(){ if (CR.bridge && CR.state) CR.bridge.save_state(JSON.stringify(CR.state)); }

/* undo/redo: command pattern */
function pushCmd(cmd){ CR.undoStack.push(cmd); CR.redoStack = []; if (CR.undoStack.length>120) CR.undoStack.shift(); }
function undo(){ const c = CR.undoStack.pop(); if(!c) return toast("Nothing to undo"); c.undo(); CR.redoStack.push(c); saveState(); }
function redo(){ const c = CR.redoStack.pop(); if(!c) return toast("Nothing to redo"); c.redo(); CR.undoStack.push(c); saveState(); }

/* ============================================================
   BOOT
   ============================================================ */
new QWebChannel(qt.webChannelTransport, channel => {
  CR.bridge = channel.objects.bridge;
  CR.bridge.js_message.connect(handlePyMessage);
  send("ready");
});

function handlePyMessage(jsonStr){
  let m; try { m = JSON.parse(jsonStr); } catch(e){ return; }
  const h = {
    init: initApp,
    load_document: loadDocument,
    show_welcome: showWelcome,
    rule_action: runRuleAction,
    learning_result: showLearningPanel,
    settings_updated: d => { CR.settings = d.settings; applyUISettings(); },
    flow_suggestion: showFlowBanner,
    progress_report: showProgressReport,
    timer_update: updateTimerDisplay,
  }[m.type];
  if (h) h(m.payload || {});
}

function initApp(p){
  CR.settings = p.settings;
  applyUISettings();
  if (p.document) loadDocument(p); else showWelcome(p);
}

/* ============================================================
   WELCOME (no doc)
   ============================================================ */
function showWelcome(p){
  $("#cr-header").classList.add("hidden");
  const files = p.settings?.recentFiles || CR.settings?.recentFiles || [];
  $("#cr-content").innerHTML = `
    <div id="welcome">
      <div class="logo">Cognitive Reader</div>
      <div class="tag">Read · Think · Question · Remember</div>
      <button class="load-big" onclick="CR.bridge.pick_file()">📂 Load File &nbsp;·&nbsp; PDF / DOCX / TXT</button>
      ${files.length ? `<div style="margin-top:22px;color:var(--ink-faint);font-size:12px">RECENT</div>
        ${files.map((f,i)=>`<div class="recent-file" data-ri="${i}">📄 ${esc(f)}</div>`).join("")}` : ""}
    </div>`;
  $$(".recent-file").forEach(el => el.onclick = ()=>CR.bridge.open_path(files[+el.dataset.ri]));
}

/* ============================================================
   DOCUMENT RENDER
   ============================================================ */
function loadDocument(p){
  CR.doc = p.document; CR.state = p.state; CR.settings = p.settings;
  CR.undoStack = []; CR.redoStack = [];
  $("#cr-header").classList.remove("hidden");
  $("#doc-title").textContent = CR.doc.title;

  const html = CR.doc.sections.map(s => {
    // dir="auto": browser resolves direction per-block from first strong char —
    // correct for Persian/Arabic (RTL), English (LTR) and mixed documents.
    if (s.level > 0){
      const tag = "h" + Math.min(s.level, 3);
      return `<${tag} id="${s.sid}" dir="auto">${esc(s.text)}</${tag}>`;
    }
    const cls = s.kind === "li" ? ' class="bullet"' : "";
    return `<p id="${s.sid}"${cls} dir="auto">${esc(s.text)}</p>`;
  }).join("\n");
  $("#cr-content").innerHTML = html;
  $("#cr-content").dir = dirOf(CR.doc.sections.map(s=>s.text).join(" ").slice(0,4000));

  applyUISettings();
  restoreHighlights();
  restoreNotes();
  restoreCheckpointFlags();
  setupBrushCanvas();
  restoreDrawings();
  requestAnimationFrame(()=> {
    if (CR.state.progress?.scrollY > 80) {
      window.scrollTo({top: CR.state.progress.scrollY, behavior:"smooth"});
      toast("Resumed where you left off");
    }
  });
  send("document_rendered");
  if (CR.settings.ui.introOverlay && !CR.state.progress.sessions) runIntroOverlay(CR.settings.ui.introDurationSec || 120);
  CR.state.progress.sessions = (CR.state.progress.sessions||0) + 1;
  saveState();
}

function applyUISettings(){
  if (!CR.settings) return;
  document.documentElement.style.setProperty("--fs", CR.settings.ui.fontSize + "px");
  document.documentElement.style.setProperty("--marg", CR.settings.ui.margin + "px");
}

/* ============================================================
   INTRO OVERLAY — first launch bubbles (Phase 8.1)
   ============================================================ */
const INTRO_QS = [
  "What do you already know about this topic?",
  "What do you want to be able to explain after reading?",
  "Set an intention: skim, study, or master?",
  "What's one question you hope this document answers?",
  "How will you know you truly understood it?",
  "Predict: what will the hardest part be?",
];
function runIntroOverlay(durationSec){
  const ov = document.createElement("div");
  ov.id = "intro-overlay";
  ov.innerHTML = `<div id="intro-center">
      <div class="title">Take a breath. Prime your mind before reading…</div>
      <button id="intro-skip">Start reading →</button>
    </div>`;
  document.body.appendChild(ov);
  let alive = true;
  const spawn = () => {
    if (!alive) return;
    const q = INTRO_QS[Math.floor(Math.random()*INTRO_QS.length)];
    const b = document.createElement("div");
    b.className = "intro-bubble";
    b.style.left = (8 + Math.random()*64) + "vw";
    b.style.top  = (8 + Math.random()*55) + "vh";
    b.style.setProperty("--dx", (Math.random()*70-35)+"px");
    b.style.setProperty("--dy", (-(20+Math.random()*50))+"px");
    b.style.setProperty("--dur", (7+Math.random()*5)+"s");
    b.textContent = q;
    ov.appendChild(b);
    setTimeout(()=>{ b.style.transition="opacity 1.6s"; b.style.opacity="0"; setTimeout(()=>b.remove(), 1700); }, 9000);
    setTimeout(spawn, 2600 + Math.random()*2200);
  };
  spawn(); setTimeout(spawn, 1200); setTimeout(spawn, 2300);
  const end = () => { alive=false; ov.classList.add("fade"); setTimeout(()=>ov.remove(), 1500); };
  $("#intro-skip", ov).onclick = end;
  setTimeout(end, durationSec*1000);
}

/* ============================================================
   SELECTION SYSTEM (Phase 2.1)
   ============================================================ */
let selSaved = null;
document.addEventListener("mouseup", e => {
  if (CR.brush.on) return;
  if (e.target.closest("#sel-menu") || e.target.closest(".sticky-note") || e.target.closest(".overlay-dim")) return;
  setTimeout(()=> {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    const menu = $("#sel-menu");
    if (!text || text.length < 2 || sel.rangeCount===0) { menu.style.display="none"; return; }
    const range = sel.getRangeAt(0);
    if (!$("#cr-content").contains(range.commonAncestorContainer)) { menu.style.display="none"; return; }
    selSaved = { text, range: range.cloneRange() };
    const r = range.getBoundingClientRect();
    menu.style.display = "flex";
    const mw = 320;
    menu.style.left = Math.max(10, Math.min(window.innerWidth - mw - 10, r.left + r.width/2 - mw/2 + window.scrollX)) + "px";
    menu.style.top = (r.bottom + window.scrollY + 10) + "px";
    send("selection", { text });
  }, 10);
});
document.addEventListener("mousedown", e => {
  if (!e.target.closest("#sel-menu")) $("#sel-menu").style.display = "none";
});

function buildSelMenu(){
  const sw = CR.hlColors.map(c =>
    `<div class="swatch" style="background:${c}" onclick="applyHighlight('${c}','solid')"></div>`).join("");
  $("#sel-menu").innerHTML = `
    <div class="row">${sw}
      <div class="swatch" title="Random color" style="background:conic-gradient(#ffd6cc,#ffe9a8,#d4edda,#cce5ff,#e8d5f5,#ffd6cc)" onclick="applyHighlight(null,'solid')"></div>
    </div>
    <div class="row">
      <button class="mini-btn" onclick="applyHighlight(null,'pulse')">〰 Pulse</button>
      <button class="mini-btn" onclick="applyHighlight(null,'flicker')">⚡ Flicker</button>
      <button class="mini-btn" onclick="applyHighlight(null,'temp')">⏳ Temp</button>
    </div>
    <div class="row">
      <button class="mini-btn" onclick="noteFromSelection()">📝 Note</button>
      <button class="mini-btn" onclick="openBlockAssign()">📚 Text Block</button>
      <button class="mini-btn" onclick="askAI()">🤖 Ask AI</button>
    </div>
    <div class="row">
      <button class="mini-btn" onclick="selLearning('feynman')">🧒 Feynman</button>
      <button class="mini-btn" onclick="selLearning('summary')">📝 Summarize</button>
      <button class="mini-btn" onclick="selLearning('examples')">💡 Examples</button>
      <button class="mini-btn" onclick="selLearning('questions')">❓ Quiz me</button>
      <button class="mini-btn" onclick="selLearning('problem')">🧩 Solve</button>
    </div>`;
}

/* ============================================================
   HIGHLIGHTS (Phase 2.2) — robust via section char offsets
   ============================================================ */
function sectionAndOffsets(range){
  // find enclosing section element & absolute char offsets within it
  let el = range.commonAncestorContainer;
  while (el && !(el.id && el.id.startsWith("sec-"))) el = el.parentNode;
  if (!el) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el); pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { sectionId: el.id, start, end: start + range.toString().length };
}
function wrapOffsets(sectionEl, start, end, hl){
  // walk text nodes, wrap intersecting parts
  const walker = document.createTreeWalker(sectionEl, NodeFilter.SHOW_TEXT);
  let pos = 0; const targets = [];
  while (walker.nextNode()){
    const node = walker.currentNode, len = node.textContent.length;
    const s = Math.max(start - pos, 0), e = Math.min(end - pos, len);
    if (s < e) targets.push({node, s, e});
    pos += len;
    if (pos >= end) break;
  }
  targets.forEach(({node, s, e}) => {
    const r = document.createRange();
    r.setStart(node, s); r.setEnd(node, e);
    const span = document.createElement("span");
    span.className = "cr-hl new" + (hl.mode!=="solid" ? " hl-"+hl.mode : "");
    span.style.background = hl.color;
    span.dataset.hlId = hl.id;
    try { r.surroundContents(span); } catch(err){ /* partial overlap, skip */ }
    setTimeout(()=>span.classList.remove("new"), 900);
    if (hl.mode==="temp") setTimeout(()=>removeHighlightDom(hl.id), 8200);
  });
}
function applyHighlight(color, mode){
  if (!selSaved) return;
  const info = sectionAndOffsets(selSaved.range);
  if (!info) return toast("Select inside the document text");
  const hl = { id: uid(), color: color || CR.hlColors[Math.floor(Math.random()*CR.hlColors.length)],
               mode: mode||"solid", text: selSaved.text.slice(0,300), ...info };
  wrapOffsets(document.getElementById(info.sectionId), info.start, info.end, hl);
  if (mode !== "temp") {
    CR.state.highlights.push(hl);
    pushCmd({
      undo(){ removeHighlightDom(hl.id); CR.state.highlights = CR.state.highlights.filter(h=>h.id!==hl.id); },
      redo(){ CR.state.highlights.push(hl); wrapOffsets(document.getElementById(hl.sectionId), hl.start, hl.end, hl); },
    });
    saveState();
  }
  $("#sel-menu").style.display="none";
  window.getSelection().removeAllRanges();
  send("highlight_created", {text: hl.text});
  // Phase 10.2: highlight can trigger learning integration
  maybeHighlightFollowup(hl);
}
function removeHighlightDom(id){
  $$(`[data-hl-id="${id}"]`).forEach(sp => {
    const parent = sp.parentNode;
    while (sp.firstChild) parent.insertBefore(sp.firstChild, sp);
    sp.remove(); parent.normalize();
  });
}
function restoreHighlights(){
  (CR.state.highlights||[]).forEach(hl => {
    const el = document.getElementById(hl.sectionId);
    if (el) wrapOffsets(el, hl.start, hl.end, {...hl, mode: hl.mode==="temp"?"solid":hl.mode});
  });
}
let lastHlFollow = 0;
function maybeHighlightFollowup(hl){
  if (Date.now() - lastHlFollow < 60000 || hl.text.length < 60) return;
  lastHlFollow = Date.now();
  setTimeout(()=> spawnBubble({
    type:"contextual",
    q:"Nice highlight. Want to go deeper?",
    actions:[
      {label:"🧒 Feynman it", run:()=>CR.bridge.learning_mode("feynman", hl.text)},
      {label:"📚 Save to block", run:()=>{ selSaved={text:hl.text,range:null}; openBlockAssign(true); }},
      {label:"❓ Quiz me", run:()=>CR.bridge.learning_mode("questions", hl.text)},
    ],
    autoCloseSec: 10,
  }), 1400);
}
document.addEventListener("dblclick", e => {  // dbl-click a highlight to remove
  const sp = e.target.closest(".cr-hl");
  if (!sp) return;
  const id = sp.dataset.hlId;
  const hl = CR.state.highlights.find(h=>h.id===id);
  removeHighlightDom(id);
  CR.state.highlights = CR.state.highlights.filter(h=>h.id!==id);
  if (hl) pushCmd({
    undo(){ CR.state.highlights.push(hl); wrapOffsets(document.getElementById(hl.sectionId), hl.start, hl.end, hl); },
    redo(){ removeHighlightDom(hl.id); CR.state.highlights = CR.state.highlights.filter(h=>h.id!==hl.id); },
  });
  saveState(); toast("Highlight removed");
});

/* ============================================================
   STICKY NOTES (Phase 2.3)
   ============================================================ */
let notePlacing = false;
function toggleNoteMode(){
  notePlacing = !notePlacing;
  $("#btn-note").classList.toggle("active", notePlacing);
  document.body.style.cursor = notePlacing ? "copy" : "";
  if (notePlacing) toast("Click anywhere on the page to place a sticky note");
}
document.addEventListener("click", e => {
  if (!notePlacing || e.target.closest("#cr-header") || e.target.closest(".sticky-note")) return;
  notePlacing = false; $("#btn-note").classList.remove("active"); document.body.style.cursor="";
  createNote({ id: uid(), x: e.pageX - 95, y: e.pageY - 20, text: "",
               color: CR.noteColors[Math.floor(Math.random()*CR.noteColors.length)],
               rot: (Math.random()*6-3).toFixed(1) }, true);
});
function noteFromSelection(){
  if (!selSaved) return;
  const r = selSaved.range ? selSaved.range.getBoundingClientRect() : {right: window.innerWidth/2, top: window.innerHeight/2};
  $("#sel-menu").style.display="none";
  createNote({ id: uid(), x: r.right + window.scrollX + 18, y: r.top + window.scrollY - 8,
               text: "", color: CR.noteColors[Math.floor(Math.random()*CR.noteColors.length)],
               rot:(Math.random()*6-3).toFixed(1), ref: selSaved.text.slice(0,80) }, true);
}
function createNote(n, isNew){
  const d = document.createElement("div");
  d.className = "sticky-note"; d.id = n.id;
  d.style.cssText = `left:${n.x}px;top:${n.y}px;background:${n.color};transform:rotate(${n.rot}deg)`;
  d.innerHTML = `<span class="note-x" title="Delete">✕</span>
    ${n.ref?`<div style="font-size:10px;opacity:.55;margin-bottom:4px">↪ ${esc(n.ref)}…</div>`:""}
    <textarea dir="auto" placeholder="Write a note…">${esc(n.text)}</textarea>`;
  document.body.appendChild(d);
  const ta = $("textarea", d);
  ta.addEventListener("input", ()=>{ n.text = ta.value; scheduleNoteSave(); });
  $(".note-x", d).onclick = () => {
    d.style.transition="all .35s"; d.style.opacity="0"; d.style.transform+=" scale(.5)";
    setTimeout(()=>d.remove(), 360);
    CR.state.notes = CR.state.notes.filter(x=>x.id!==n.id);
    pushCmd({ undo(){ CR.state.notes.push(n); createNote(n,false); },
              redo(){ $("#"+n.id)?.remove(); CR.state.notes = CR.state.notes.filter(x=>x.id!==n.id); } });
    saveState();
  };
  // drag
  d.addEventListener("mousedown", ev => {
    if (ev.target===ta || ev.target.className==="note-x") return;
    ev.preventDefault();
    const ox = ev.pageX - n.x, oy = ev.pageY - n.y;
    d.classList.add("dragging");
    const mv = e2 => { n.x = e2.pageX-ox; n.y = e2.pageY-oy; d.style.left=n.x+"px"; d.style.top=n.y+"px"; };
    const up = () => { d.classList.remove("dragging"); document.removeEventListener("mousemove",mv);
                       document.removeEventListener("mouseup",up); scheduleNoteSave(); };
    document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
  });
  if (isNew){
    CR.state.notes.push(n);
    pushCmd({ undo(){ $("#"+n.id)?.remove(); CR.state.notes = CR.state.notes.filter(x=>x.id!==n.id); },
              redo(){ CR.state.notes.push(n); createNote(n,false); } });
    saveState(); ta.focus();
    send("note_created", {});
  }
}
let noteSaveT=null;
function scheduleNoteSave(){ clearTimeout(noteSaveT); noteSaveT=setTimeout(saveState, 700); }
function restoreNotes(){ (CR.state.notes||[]).forEach(n => createNote(n, false)); }

/* ============================================================
   BRUSH TOOL (Phase 2.4) — real canvas, smooth strokes, undo/redo
   ============================================================ */
/* Performance: the canvas is VIEWPORT-sized and position:fixed (not a giant
   document-height bitmap). Strokes are stored in page coordinates; on scroll
   we redraw only strokes intersecting the viewport, throttled to one rAF. */
function setupBrushCanvas(){
  let cv = $("#brush-canvas");
  if (!cv){ cv = document.createElement("canvas"); cv.id="brush-canvas"; document.body.appendChild(cv); }
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    cv.width = Math.round(window.innerWidth*dpr); cv.height = Math.round(window.innerHeight*dpr);
    cv.style.width = window.innerWidth+"px"; cv.style.height = window.innerHeight+"px";
    cv._dpr = dpr;
    redrawStrokes();
  };
  resize();
  window.addEventListener("resize", resize);
  // repaint on scroll, max once per frame
  let rafPending = false;
  window.addEventListener("scroll", () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(()=>{ rafPending = false; redrawStrokes(); });
  }, {passive:true});

  const pagePt = e => [e.clientX + window.scrollX, e.clientY + window.scrollY];
  cv.onmousedown = e => {
    if (!CR.brush.on) return;
    CR.brush.drawing = true;
    CR.brush.stroke = { points:[pagePt(e)], color: CR.brush.color, size: CR.brush.size };
  };
  cv.onmousemove = e => {
    if (!CR.brush.drawing) return;
    const pts = CR.brush.stroke.points;
    const p = pagePt(e);
    const last = pts[pts.length-1];
    if (Math.abs(p[0]-last[0]) + Math.abs(p[1]-last[1]) < 2) return;  // decimate
    pts.push(p);
    drawSegment(viewCtx(cv), pts.slice(-3), CR.brush.stroke);
  };
  const end = () => {
    if (!CR.brush.drawing) return;
    CR.brush.drawing = false;
    const st = CR.brush.stroke;
    if (st.points.length > 1){
      st.bbox = strokeBBox(st);
      CR.state.drawings.push(st);
      pushCmd({ undo(){ CR.state.drawings.pop(); redrawStrokes(); },
                redo(){ CR.state.drawings.push(st); redrawStrokes(); } });
      saveState();
    }
    CR.brush.stroke = null;
  };
  cv.onmouseup = end; cv.onmouseleave = end;
}
function strokeBBox(st){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  st.points.forEach(([x,y])=>{ if(x<x0)x0=x; if(y<y0)y0=y; if(x>x1)x1=x; if(y>y1)y1=y; });
  return [x0-st.size, y0-st.size, x1+st.size, y1+st.size];
}
function viewCtx(cv){
  // context transformed so that PAGE coordinates draw correctly in the viewport
  const ctx = cv.getContext("2d");
  ctx.setTransform(cv._dpr,0,0,cv._dpr, -window.scrollX*cv._dpr, -window.scrollY*cv._dpr);
  return ctx;
}
function drawSegment(ctx, pts, st){
  ctx.lineCap="round"; ctx.lineJoin="round";
  ctx.strokeStyle = st.color; ctx.lineWidth = st.size; ctx.globalAlpha = .8;
  ctx.beginPath();
  if (pts.length < 3){ ctx.moveTo(...pts[0]); ctx.lineTo(...pts[pts.length-1]); }
  else {
    const [a,b,c] = pts;
    ctx.moveTo((a[0]+b[0])/2, (a[1]+b[1])/2);
    ctx.quadraticCurveTo(b[0], b[1], (b[0]+c[0])/2, (b[1]+c[1])/2);
  }
  ctx.stroke(); ctx.globalAlpha = 1;
}
function redrawStrokes(){
  const cv = $("#brush-canvas"); if (!cv) return;
  const ctx = cv.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,cv.width,cv.height);
  const vx0 = window.scrollX, vy0 = window.scrollY,
        vx1 = vx0 + window.innerWidth, vy1 = vy0 + window.innerHeight;
  const vctx = viewCtx(cv);
  (CR.state?.drawings||[]).forEach(st => {
    const b = st.bbox || (st.bbox = strokeBBox(st));
    if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) return;  // off-screen
    if (st.points.length===2) drawSegment(vctx, st.points, st);
    else for (let i=2;i<st.points.length;i++) drawSegment(vctx, st.points.slice(i-2,i+1), st);
  });
  // live stroke continuity after scroll
  if (CR.brush.stroke) {
    const pts = CR.brush.stroke.points;
    for (let i=2;i<pts.length;i++) drawSegment(vctx, pts.slice(i-2,i+1), CR.brush.stroke);
  }
}
function restoreDrawings(){ redrawStrokes(); }
function toggleBrush(force){
  CR.brush.on = force!==undefined ? force : !CR.brush.on;
  document.body.classList.toggle("brush-mode", CR.brush.on);
  $("#btn-brush").classList.toggle("active", CR.brush.on);
  $("#brush-bar").classList.toggle("show", CR.brush.on);
  if (CR.brush.on) toast("Brush mode — draw on the document. Esc to exit.");
}
function clearDrawings(){
  const old = [...CR.state.drawings];
  CR.state.drawings = []; redrawStrokes();
  pushCmd({ undo(){ CR.state.drawings = old; redrawStrokes(); },
            redo(){ CR.state.drawings = []; redrawStrokes(); } });
  saveState();
}
document.addEventListener("keydown", e=>{
  if (e.key==="Escape"){ if (CR.brush.on) toggleBrush(false); closeOverlay(); $("#tab-menu").classList.remove("show"); }
  if ((e.ctrlKey||e.metaKey) && e.key==="z" && !e.shiftKey){ e.preventDefault(); undo(); }
  if ((e.ctrlKey||e.metaKey) && (e.key==="y" || (e.key==="Z"&&e.shiftKey))){ e.preventDefault(); redo(); }
});

/* ============================================================
   TEXT BLOCKS — knowledge playlists (Phase 3.1)
   ============================================================ */
/* NOTE: category names are user text — never embed them in inline onclick
   attributes (quoting breaks the HTML). All bindings are done in JS. */
let pendingBlock = null;   // {text, sectionId} captured at menu time
function openBlockAssign(fromHl){
  const text = selSaved?.text; if (!text) return;
  const info = selSaved.range ? sectionAndOffsets(selSaved.range) : null;
  pendingBlock = { text, sectionId: info?.sectionId || visibleSection()?.id || null };
  $("#sel-menu").style.display = "none";
  const cats = Object.keys(CR.state.blocks||{});
  const panel = openOverlay(`
    <button class="panel-close" data-act="close">✕</button>
    <h2>📚 Save to Text Block</h2>
    <div class="sub">Categories work like playlists of knowledge excerpts.</div>
    <div class="excerpt" dir="auto">${esc(text.slice(0,400))}${text.length>400?"…":""}</div>
    <h3>Add to an existing category</h3>
    <div id="cat-list">${cats.map(c=>`
      <div class="block-cat" data-cat="${esc(c)}">
        <div class="bc-icon">🎵</div><div><div class="bc-name"></div>
        <div class="bc-count">${CR.state.blocks[c].length} excerpts</div></div></div>`).join("")
      || '<div class="empty">No categories yet — create one below.</div>'}</div>
    <h3>Or create new</h3>
    <div style="display:flex;gap:8px">
      <input type="text" id="new-cat" placeholder="e.g. Key Definitions" style="flex:1;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font:14px var(--font-ui);outline:none">
      <button class="btn primary" id="cat-create">Create & Save</button>
    </div>`);
  // safe bindings: read the real category name back from dataset
  $$(".block-cat", panel).forEach((el,i) => { $(".bc-name", el).textContent = cats[i]; el.onclick = ()=>assignBlock(cats[i]); });
  $(".panel-close", panel).onclick = closeOverlay;
  $("#cat-create", panel).onclick = ()=>assignBlock($("#new-cat").value.trim());
  $("#new-cat", panel).addEventListener("keydown", e=>{ if (e.key==="Enter") assignBlock(e.target.value.trim()); });
  setTimeout(()=>$("#new-cat")?.focus(), 300);
}
function assignBlock(cat){
  if (!cat) return toast("Enter a category name");
  if (!pendingBlock) return closeOverlay();
  (CR.state.blocks[cat] = CR.state.blocks[cat] || []).push({
    id: uid(), text: pendingBlock.text, sectionId: pendingBlock.sectionId, ts: Date.now() });
  pendingBlock = null;
  saveState(); closeOverlay(); toast(`Saved to “${cat}”`);
  send("engagement", {});
}
function openTextBlocks(){
  const cats = Object.keys(CR.state?.blocks||{});
  const panel = openOverlay(`
    <button class="panel-close" data-act="close">✕</button>
    <h2>📚 Text Blocks</h2><div class="sub">Your knowledge playlists — click a category to open it.</div>
    ${cats.length ? cats.map(c=>`
      <div class="block-cat">
        <div class="bc-icon">🎵</div>
        <div style="flex:1"><div class="bc-name"></div><div class="bc-count">${CR.state.blocks[c].length} excerpts</div></div>
        <span class="ex-jump bc-goto" title="Jump to where the first excerpt lives">↪ go to section</span>
        <div style="color:var(--ink-faint)">›</div>
      </div>`).join("") : '<div class="empty">Select text in the document → “📚 Text Block” to start a playlist.</div>'}`);
  $(".panel-close", panel).onclick = closeOverlay;
  $$(".block-cat", panel).forEach((el,i)=>{
    const c = cats[i];
    $(".bc-name", el).textContent = c;
    el.onclick = ()=>openBlockCat(c);
    $(".bc-goto", el).onclick = e => {           // category title → navigate to related section
      e.stopPropagation();
      const first = (CR.state.blocks[c]||[]).find(x=>x.sectionId);
      if (first){ closeOverlay(); jumpTo(first.sectionId); }
      else toast("No linked section in this category");
    };
  });
}
function openBlockCat(cat){
  const items = CR.state.blocks[cat]||[];
  const panel = openOverlay(`
    <button class="panel-close" data-act="close">✕</button>
    <h2>🎵 <span id="cat-title"></span></h2><div class="sub">${items.length} saved excerpts — click ↪ to jump to the source section.</div>
    <button class="btn ghost" id="cat-back" style="margin-bottom:14px">← All categories</button>
    ${items.map(it=>`<div class="excerpt" dir="auto" data-eid="${it.id}">${esc(it.text)}
      <br>${it.sectionId?`<span class="ex-jump ex-go">↪ Jump to source</span>`:""}
      <span class="ex-jump ex-del" style="color:#b3503e">✕ remove</span>
    </div>`).join("") || '<div class="empty">Empty playlist</div>'}`);
  $("#cat-title", panel).textContent = cat;
  $(".panel-close", panel).onclick = closeOverlay;
  $("#cat-back", panel).onclick = openTextBlocks;
  $$(".excerpt", panel).forEach(el => {
    const it = items.find(x=>x.id===el.dataset.eid); if (!it) return;
    const go = $(".ex-go", el);
    if (go) go.onclick = ()=>{ closeOverlay(); jumpTo(it.sectionId); };
    $(".ex-del", el).onclick = ()=>{
      CR.state.blocks[cat] = CR.state.blocks[cat].filter(x=>x.id!==it.id);
      if (!CR.state.blocks[cat].length) delete CR.state.blocks[cat];
      saveState(); CR.state.blocks[cat] ? openBlockCat(cat) : openTextBlocks();
    };
  });
}

/* ============================================================
   CHECKPOINTS (Phase 3.3 / 7.5)
   ============================================================ */
function addCheckpointHere(){
  // nearest visible section
  const el = visibleSection();
  const name = (el?.textContent||"Position").replace(/📍/g,"").trim().slice(0,40);
  const cp = { id: uid(), name: `${name}…`, sectionId: el?.id || null, scrollY: window.scrollY, ts: Date.now() };
  CR.state.checkpoints.push(cp); saveState();
  flagCheckpoint(cp);
  toast("📍 Checkpoint saved");
  send("checkpoint_reached", {name: cp.name});
}
function flagCheckpoint(cp){
  if (!cp.sectionId) return;
  const el = document.getElementById(cp.sectionId);
  if (!el || $(".checkpoint-flag", el)) return;
  const f = document.createElement("span");
  f.className="checkpoint-flag"; f.textContent="📍"; f.title = "Checkpoint: " + cp.name;
  f.onclick = e => { e.stopPropagation(); openCheckpoints(); };
  el.style.position="relative"; el.prepend(f);
}
function restoreCheckpointFlags(){ (CR.state.checkpoints||[]).forEach(flagCheckpoint); }
function openCheckpoints(){
  const cps = CR.state?.checkpoints||[];
  openOverlay(`
    <button class="panel-close" onclick="closeOverlay()">✕</button>
    <h2>📍 Checkpoints & Bookmarks</h2><div class="sub">Saved reading positions — click to jump instantly.</div>
    <button class="btn primary" onclick="addCheckpointHere();openCheckpoints()" style="margin-bottom:14px">+ Checkpoint at current position</button>
    ${cps.map((cp,i)=>`<div class="cp-item" onclick="jumpToCheckpoint(${i})">
        <span>📍</span><div style="flex:1">${esc(cp.name)}<div style="font-size:11px;color:var(--ink-faint)">${new Date(cp.ts).toLocaleString()}</div></div>
        <span class="ex-jump" style="color:#b3503e" onclick="event.stopPropagation();CR.state.checkpoints.splice(${i},1);saveState();openCheckpoints()">✕</span>
      </div>`).join("") || '<div class="empty">No checkpoints yet.</div>'}`);
}
function jumpToCheckpoint(i){
  const cp = CR.state.checkpoints[i]; if (!cp) return;
  closeOverlay();
  // NOTE: deliberately NOT firing the `checkpoint_reached` rule here —
  // navigating via the bookmarks panel must never spawn overlays mid-jump.
  window.scrollTo({top: cp.scrollY, behavior:"smooth"});
  if (cp.sectionId) {
    const el = document.getElementById(cp.sectionId);
    el?.animate([{background:"rgba(201,162,39,.35)"},{background:"transparent"}], {duration:2000});
  }
}
function jumpTo(sid){
  const el = document.getElementById(sid);
  if (el){ el.scrollIntoView({behavior:"smooth", block:"start"});
    el.animate([{background:"rgba(201,162,39,.35)"},{background:"transparent"}], {duration:2000}); }
}
function visibleSection(){
  const els = $$("#cr-content [id^='sec-']");
  return els.find(el => { const r = el.getBoundingClientRect(); return r.top > 60 && r.top < window.innerHeight*0.6; }) || els[0];
}

/* ============================================================
   MIND MAP (Phase 3.2) — SVG radial tree, editable, click→jump
   ============================================================ */
function openMindMap(){
  openOverlay(`
    <button class="panel-close" onclick="closeOverlay()">✕</button>
    <h2>🧠 Mind Map</h2>
    <div class="sub">Click a node to jump to its section · drag to rearrange · double-click to rename · wheel to zoom.</div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn" onclick="CR.bridge.regen_mindmap()">↻ Re-generate</button>
      <button class="btn" onclick="mmAddNode()">+ Add node</button>
    </div>
    <svg id="mindmap-svg"></svg>`);
  if (!CR.state.mindmap) CR.bridge.regen_mindmap();
  else renderMindMap();
}
function layoutMindMap(mm){
  const byParent = {};
  mm.nodes.forEach(n => { if (n.parent) (byParent[n.parent] = byParent[n.parent]||[]).push(n); });
  const W = 1600, H = 1100, cx = W/2, cy = H/2;
  const root = mm.nodes.find(n=>!n.parent);
  if (root && root.x===undefined){ root.x = cx; root.y = cy; }
  const place = (id, a0, a1, depth) => {
    const kids = byParent[id]||[];
    kids.forEach((k,i)=>{
      const a = a0 + (a1-a0)*(i+0.5)/kids.length;
      if (k.x===undefined){ k.x = cx + Math.cos(a)*(190*depth); k.y = cy + Math.sin(a)*(140*depth); }
      place(k.id, a0+(a1-a0)*i/kids.length, a0+(a1-a0)*(i+1)/kids.length, depth+1);
    });
  };
  if (root) place(root.id, -Math.PI/2, Math.PI*1.5, 1);
}
/* Fast mind map: SVG DOM is built ONCE; drags only update the dragged node's
   transform + its incident edge paths. Click (small movement) jumps to section. */
function renderMindMap(){
  const svg = $("#mindmap-svg"); if (!svg || !CR.state.mindmap) return;
  const mm = CR.state.mindmap;
  layoutMindMap(mm);
  svg.setAttribute("viewBox", svg._vb || (svg._vb = "0 0 1600 1100"));
  const nodeById = Object.fromEntries(mm.nodes.map(n=>[n.id,n]));
  const widthOf = n => Math.max(90, Math.min(240, n.label.length*7.4+34));

  svg.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const edgeEls = {};                       // nodeId -> [pathEl...]
  const edgePath = (a,b) => `M${a.x},${a.y} C${(a.x+b.x)/2},${a.y} ${(a.x+b.x)/2},${b.y} ${b.x},${b.y}`;
  mm.edges.forEach(e=>{
    const a=nodeById[e.from], b=nodeById[e.to]; if(!a||!b) return;
    const p = document.createElementNS(NS,"path");
    p.setAttribute("class","mm-edge"); p.setAttribute("d", edgePath(a,b));
    p._a=a; p._b=b;
    (edgeEls[a.id]=edgeEls[a.id]||[]).push(p);
    (edgeEls[b.id]=edgeEls[b.id]||[]).push(p);
    svg.appendChild(p);
  });
  const gEls = {};
  mm.nodes.forEach(n=>{
    const w = widthOf(n);
    const g = document.createElementNS(NS,"g");
    g.setAttribute("class", "mm-node"+(n.parent?"":" root"));
    g.dataset.id = n.id;
    g.setAttribute("transform", `translate(${n.x-w/2},${n.y-18})`);
    g.innerHTML = `<rect width="${w}" height="36" rx="12"></rect>
      <text x="${w/2}" y="23" text-anchor="middle"></text>`;
    g.lastElementChild.textContent = n.label.slice(0,32);   // safe text (RTL ok)
    if (n.sectionId) g.style.cursor = "pointer";
    svg.appendChild(g);
    gEls[n.id] = g; g._w = w;
  });

  const moveNode = n => {
    gEls[n.id].setAttribute("transform", `translate(${n.x-gEls[n.id]._w/2},${n.y-18})`);
    (edgeEls[n.id]||[]).forEach(p=>p.setAttribute("d", edgePath(p._a, p._b)));
  };

  let drag=null, pan=null;
  svg.onmousedown = e => {
    e.preventDefault();
    const g = e.target.closest(".mm-node");
    if (g){ const n = nodeById[g.dataset.id];
            drag = {n, sx:e.clientX, sy:e.clientY, ox:n.x, oy:n.y, moved:false}; }
    else { const vb = svg._vb.split(" ").map(Number); pan = {vb, sx:e.clientX, sy:e.clientY}; }
  };
  svg.onmousemove = e => {
    const scale = (svg._vb.split(" ")[2]|0 || 1600) / svg.clientWidth;
    if (drag){
      const dx = (e.clientX-drag.sx)*scale, dy = (e.clientY-drag.sy)*scale;
      if (Math.abs(dx)+Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved){ drag.n.x = drag.ox+dx; drag.n.y = drag.oy+dy; moveNode(drag.n); }
    } else if (pan){
      const [x,y,w,h] = pan.vb;
      svg._vb = `${x-(e.clientX-pan.sx)*scale} ${y-(e.clientY-pan.sy)*scale} ${w} ${h}`;
      svg.setAttribute("viewBox", svg._vb);
    }
  };
  svg.onmouseup = e => {
    if (drag){
      if (!drag.moved && drag.n.sectionId){   // CLICK → navigate to topic
        const sid = drag.n.sectionId;
        drag = null; pan = null;
        closeOverlay(); jumpTo(sid);
        return;
      }
      if (drag.moved) saveState();
    }
    drag=null; pan=null;
  };
  svg.onmouseleave = () => { if (drag?.moved) saveState(); drag=null; pan=null; };
  svg.onwheel = e => {
    e.preventDefault();
    const vb = svg._vb.split(" ").map(Number);
    const k = e.deltaY>0 ? 1.12 : 0.9;
    svg._vb = `${vb[0]+vb[2]*(1-k)/2} ${vb[1]+vb[3]*(1-k)/2} ${vb[2]*k} ${vb[3]*k}`;
    svg.setAttribute("viewBox", svg._vb);
  };
  svg.ondblclick = e => {
    const g = e.target.closest(".mm-node"); if (!g) return;
    const n = nodeById[g.dataset.id];
    const v = prompt("Node label:", n.label);
    if (v!==null && v.trim()){ n.label = v.trim(); saveState(); renderMindMap(); }
  };
}
function mmAddNode(){
  const mm = CR.state.mindmap || (CR.state.mindmap = {nodes:[{id:"root",label:CR.doc.title.slice(0,40),parent:null,x:800,y:550}],edges:[]});
  const label = prompt("New node label:"); if (!label) return;
  const id = uid();
  mm.nodes.push({id, label, parent:"root", x:800+Math.random()*260-130, y:550+Math.random()*200-100});
  mm.edges.push({from:"root", to:id});
  saveState(); renderMindMap();
}

/* ============================================================
   QUESTION BUBBLES (Phase 5)
   ============================================================ */
function spawnBubble(opt){
  const layer = $("#bubble-layer");
  const max = CR.settings?.questions?.maxOnScreen ?? 2;
  if (CR.bubbleCount >= max && !opt.required) return;
  CR.bubbleCount++;
  const b = document.createElement("div");
  b.className = "q-bubble" + (opt.required ? " required" : "");
  const side = Math.random()<.5;
  b.style.cssText = `${side?"left":"right"}: ${28+Math.random()*40}px; top: ${90+Math.random()* (window.innerHeight*0.45)}px;`;
  const typeLabel = {recall:"🧠 Memory recall", reflection:"🤔 Reflection", comprehension:"📖 Comprehension",
                     contextual:"✨ About your selection", ai:"🤖 AI prompt"}[opt.type] || "💭 Question";
  b.innerHTML = `
    <div class="q-type">${typeLabel}</div>
    <div class="q-text" dir="auto">${esc(opt.q)}</div>
    ${opt.answer!==undefined && opt.answer!==null || opt.input ? `<input type="text" placeholder="${opt.answer!=null?"Type your answer…":"Your thoughts…"}" dir="auto">`:""}
    <div class="q-actions"></div>
    ${opt.autoCloseSec ? `<div class="q-timerbar"><i style="animation: shrink ${opt.autoCloseSec}s linear forwards"></i></div>`:""}`;
  if (!document.getElementById("shrink-kf")){
    const st = document.createElement("style"); st.id="shrink-kf";
    st.textContent = "@keyframes shrink { from { transform: scaleX(1);} to { transform: scaleX(0);} }";
    document.head.appendChild(st);
  }
  const actions = $(".q-actions", b);
  const close = () => { b.classList.add("fading"); setTimeout(()=>{ b.remove(); CR.bubbleCount--; }, 950); };
  (opt.actions||[]).forEach(a => {
    const btn = document.createElement("button"); btn.className="mini-btn"; btn.textContent=a.label;
    btn.onclick = ()=>{ a.run(); close(); }; actions.appendChild(btn);
  });
  if (opt.answer!=null){
    const check = document.createElement("button"); check.className="mini-btn"; check.textContent="Check";
    check.onclick = () => {
      const v = ($("input",b)?.value||"").trim().toLowerCase();
      const ok = v && (opt.answer.toLowerCase().includes(v) || v.includes(opt.answer.toLowerCase()));
      const fb = document.createElement("div"); fb.className="q-feedback";
      fb.style.color = ok ? "#3d7a4f" : "#b3503e";
      fb.textContent = ok ? "✓ Correct — well remembered!" : `✗ It was: “${opt.answer}”`;
      actions.before(fb);
      send("question_answered", {correct: ok});
      setTimeout(close, 2200);
    };
    actions.appendChild(check);
    $("input",b).addEventListener("keydown", e=>{ if(e.key==="Enter") check.click(); });
  } else if (opt.input || $("input", b)) {
    const saveB = document.createElement("button"); saveB.className="mini-btn"; saveB.textContent="Save reflection";
    saveB.onclick = ()=>{
      const v = ($("input",b)?.value||"").trim();
      if (v){ CR.state.reflections.push({q:opt.q, a:v, ts:Date.now()}); saveState(); toast("Reflection saved"); send("question_answered", {correct:null}); }
      close();
    };
    actions.appendChild(saveB);
  }
  if (!opt.required){
    const dis = document.createElement("button"); dis.className="mini-btn"; dis.textContent="✕";
    dis.onclick = close; actions.appendChild(dis);
  } else {
    b.querySelectorAll("input").forEach(i=>i.focus());
  }
  layer.appendChild(b);
  if (opt.autoCloseSec && !opt.required) setTimeout(()=>{ if (b.isConnected) close(); }, opt.autoCloseSec*1000);
}

/* ============================================================
   RULE ACTIONS dispatched from Python rule engine (Phase 6)
   ============================================================ */
function runRuleAction(p){
  const a = p.action || {};
  switch (a.type){
    case "question": {
      const q = p.question; if (!q) break;
      if ((a.ui||"bubble") === "card"){
        showQuestionCard(q, a);
      } else {
        spawnBubble({ ...q, required: !!a.required,
          autoCloseSec: a.required ? 0 : (a.autoCloseSec ?? CR.settings.questions.autoCloseSec) });
      }
      break;
    }
    case "popup": showCustomPopup(p.popup || {}, a); break;
    case "intro_overlay": runIntroOverlay(a.durationSec||120); break;
    case "navigate": if (a.sectionId) jumpTo(a.sectionId); break;
    case "learning_mode": {
      const el = visibleSection();
      CR.bridge.learning_mode(a.mode||"summary", el ? sectionContext(el) : "");
      break;
    }
    case "animation": document.body.animate([{filter:"brightness(1)"},{filter:"brightness(1.06)"},{filter:"brightness(1)"}],{duration:900}); break;
  }
}
function sectionContext(el){
  // paragraph text around the element
  let txt = el.textContent || "";
  let n = el.nextElementSibling, c=0;
  while (n && c<4){ txt += "\n" + n.textContent; n = n.nextElementSibling; c++; }
  return txt.slice(0, 2400);
}
function showQuestionCard(q, a){
  const panel = openOverlay(`
    <h2>🛑 Quick check</h2>
    <div class="sub">${a.required?"Answer to continue reading.":"Optional check-in."}</div>
    <div class="q-text" dir="auto" style="font-size:16px;line-height:1.7"></div>
    <input type="text" id="card-answer" dir="auto" placeholder="Your answer…" style="width:100%;margin-top:16px;padding:11px 13px;border:1px solid var(--line);border-radius:10px;font:14px var(--font-ui);outline:none">
    <div class="pp-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      ${a.required?"":'<button class="btn ghost" id="card-skip">Skip</button>'}
      <button class="btn primary" id="card-submit">Submit</button>
    </div>`, !a.required);
  $(".q-text", panel).textContent = q.q;          // safe text, any quotes/RTL
  const submit = () => {
    const v = ($("#card-answer")?.value||"").trim();
    if (!v) return toast("Write something first 🙂");
    CR.state.reflections.push({q: q.q, a: v, ts: Date.now()});
    saveState(); closeOverlay(); toast("Saved — back to reading");
    send("question_answered", {correct: null});
  };
  $("#card-submit", panel).onclick = submit;
  $("#card-skip", panel) && ($("#card-skip", panel).onclick = closeOverlay);
  $("#card-answer", panel).addEventListener("keydown", e=>{ if (e.key==="Enter") submit(); });
  setTimeout(()=>$("#card-answer")?.focus(), 350);
}

/* ============================================================
   CUSTOM POPUPS — schema driven (Phase 6.2)
   ============================================================ */
function showCustomPopup(schema, action){
  const id = uid();
  const buttons = schema.buttons || [{label:"OK", action:"close", style:"primary"}];
  const timer = schema.timerSec ? `<div class="pp-timer"><i style="animation: shrink ${schema.timerSec}s linear forwards"></i></div>` : "";
  const panel = openOverlay(`
    <div class="cr-popup" data-pid="${id}" style="box-shadow:none;padding:0;width:auto;transform:none;opacity:1">
      <h3>${esc(schema.title||"Notice")}</h3>
      <p dir="auto">${esc(schema.body||"")}</p>
      ${schema.input?'<input type="text" id="pp-input" placeholder="Type here…" dir="auto">':""}
      <div class="pp-actions">${buttons.map((b,i)=>
        `<button class="btn ${esc(b.style||"")}" data-bi="${i}">${esc(b.label)}</button>`).join("")}</div>
      ${timer}
    </div>`, !schema.requireInteraction);
  // bind in JS — action strings are user data, never inline them in HTML attrs
  $$("[data-bi]", panel).forEach(btn =>
    btn.onclick = ()=>popupAction(id, buttons[+btn.dataset.bi]?.action || "close"));
  if (schema.timerSec && !schema.requireInteraction)
    setTimeout(()=>{ if ($(`[data-pid="${id}"]`)) closeOverlay(); }, schema.timerSec*1000);
}
function popupAction(pid, act){
  const v = ($("#pp-input")?.value||"").trim();
  switch(act){
    case "save_reflection":
      if (v){ CR.state.reflections.push({q:"popup", a:v, ts:Date.now()}); saveState(); toast("Saved"); }
      break;
    case "navigate_back": {
      const cps = CR.state.checkpoints;
      if (cps.length) window.scrollTo({top: cps[cps.length-1].scrollY, behavior:"smooth"});
      else window.scrollTo({top: Math.max(0, window.scrollY - window.innerHeight*3), behavior:"smooth"});
      break;
    }
    case "start_timer": CR.bridge.timer_control("start"); break;
  }
  closeOverlay();
}

/* ============================================================
   OVERLAY / PANEL infra
   ============================================================ */
let overlayGen = 0;   // generation counter: prevents a delayed close-cleanup
                      // from wiping an overlay that was re-opened meanwhile
function openOverlay(innerHtml, dismissable=true){
  overlayGen++;
  let ov = $("#overlay");
  if (!ov){ ov = document.createElement("div"); ov.id="overlay"; ov.className="overlay-dim"; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="panel">${innerHtml}</div>`;
  ov.onclick = e => { if (e.target===ov && (dismissable || !ov.firstElementChild)) closeOverlay(); };
  requestAnimationFrame(()=>ov.classList.add("show"));
  return ov.firstElementChild;   // the .panel, for JS event binding
}
function closeOverlay(){
  const ov = $("#overlay"); if (!ov) return;
  const gen = ++overlayGen;
  ov.classList.remove("show");
  setTimeout(()=>{ if (overlayGen === gen) ov.innerHTML = ""; }, 420);
}

/* ============================================================
   LEARNING PANELS (Phase 4.1)
   ============================================================ */
function selLearning(mode){
  if (!selSaved) return;
  $("#sel-menu").style.display="none";
  CR.bridge.learning_mode(mode, selSaved.text);
  send("engagement", {});
}
function askAI(){
  if (!selSaved) return;
  $("#sel-menu").style.display="none";
  CR.bridge.ask_ai(selSaved.text, "");
}
function showLearningPanel(p){
  openOverlay(`
    <button class="panel-close" onclick="closeOverlay()">✕</button>
    <h2>${p.title}</h2>
    <div dir="${p.rtl?"rtl":"ltr"}" style="font-size:15px;line-height:1.8">${p.html}</div>`);
}

/* ============================================================
   ADAPTIVE FLOW banner (Phase 4.2) + progress report (4.3)
   ============================================================ */
function showFlowBanner(p){
  let fb = $("#flow-banner");
  if (!fb){ fb = document.createElement("div"); fb.id="flow-banner"; document.body.appendChild(fb); }
  fb.innerHTML = `<div class="fb-reason">🧭 ${esc(p.reason)}</div>
    <div class="fb-label" onclick="jumpTo('${p.sectionId}');$('#flow-banner').classList.remove('show')">→ ${esc(p.label)}</div>
    <div style="text-align:right;margin-top:6px"><button class="mini-btn" onclick="$('#flow-banner').classList.remove('show')">Dismiss</button></div>`;
  fb.classList.add("show");
  setTimeout(()=>fb.classList.remove("show"), 18000);
}
function showProgressReport(r){
  openOverlay(`
    <button class="panel-close" onclick="closeOverlay()">✕</button>
    <h2>📊 Reading Intelligence</h2>
    <div class="sub">Local heuristics — expected vs. actual progress.</div>
    <div class="field"><span>Expected progress</span><b>${r.expectedPercent}%</b></div>
    <div class="field"><span>Actual progress</span><b>${r.actualPercent}%</b></div>
    <div class="field"><span>Estimated comprehension</span><b>${Math.round(r.comprehension*100)}%</b></div>
    <p style="font-size:14px;line-height:1.7;color:var(--ink-soft);margin-top:16px">💡 ${esc(r.advice)}</p>
    ${r.action==="review"?'<button class="btn primary" onclick="popupAction(null,\'navigate_back\')">⏪ Review earlier part</button>':""}`);
}

/* ============================================================
   SCROLL / PROGRESS tracking
   ============================================================ */
let scrollSaveT=null;
window.addEventListener("scroll", () => {
  const now = performance.now();
  const dy = Math.abs(window.scrollY - CR.scroll.lastY);
  const dt = (now - CR.scroll.lastT)/1000;
  if (dt > 0.05 && dt < 2 && dy > 4) send("scroll_speed", { pxPerSec: dy/dt });
  CR.scroll.lastY = window.scrollY; CR.scroll.lastT = now;

  const doc = document.documentElement;
  const pct = Math.min(100, 100 * (window.scrollY + window.innerHeight) / Math.max(doc.scrollHeight,1));
  $("#progress-bar").style.width = pct + "%";
  if (CR.state){
    CR.state.progress.scrollY = window.scrollY;
    CR.state.progress.percent = Math.max(CR.state.progress.percent||0, Math.round(pct));
    const vs = visibleSection();
    if (vs){ CR.state.progress.lastSection = vs.id; send("section_visible", {sectionId: vs.id}); }
    send("progress", { percent: CR.state.progress.percent });
    clearTimeout(scrollSaveT); scrollSaveT = setTimeout(saveState, 1200);
  }
}, {passive:true});

/* reading-time accumulation (only when tab focused & recently active) */
setInterval(()=>{
  if (!CR.state || document.hidden) return;
  CR.state.progress.totalReadSec = (CR.state.progress.totalReadSec||0) + 5;
  send("read_tick", {totalReadSec: CR.state.progress.totalReadSec});
}, 5000);
["mousemove","keydown","wheel"].forEach(ev =>
  document.addEventListener(ev, throttle(()=>send("activity",{}), 5000), {passive:true}));
function throttle(fn, ms){ let t=0; return (...a)=>{ const n=Date.now(); if(n-t>ms){ t=n; fn(...a);} }; }

/* ============================================================
   HEADER + TABS + TIMER
   ============================================================ */
function buildHeader(){
  $("#cr-header").innerHTML = `
    <button class="hbtn main-tab" id="btn-tabs" title="Main menu">☰ Tabs</button>
    <div class="hsep"></div>
    <button class="hbtn" onclick="undo()" title="Undo (Ctrl+Z)">↩</button>
    <button class="hbtn" onclick="redo()" title="Redo (Ctrl+Y)">↪</button>
    <div class="hsep"></div>
    <button class="hbtn" onclick="fontDelta(-1)" title="Smaller text">A−</button>
    <button class="hbtn" onclick="fontDelta(1)" title="Larger text">A+</button>
    <button class="hbtn" onclick="marginDelta(-40)" title="Wider text">⇤⇥</button>
    <button class="hbtn" onclick="marginDelta(40)" title="Narrower text">⇥⇤</button>
    <div class="hsep"></div>
    <button class="hbtn" id="btn-brush" onclick="toggleBrush()" title="Brush tool">🖌</button>
    <button class="hbtn" id="btn-note" onclick="toggleNoteMode()" title="Sticky note">🗒</button>
    <button class="hbtn" onclick="toast('Select text to highlight it')" title="Highlight">🖍</button>
    <button class="hbtn" onclick="addCheckpointHere()" title="Add checkpoint">📍</button>
    <div class="hspacer"></div>
    <span id="doc-title"></span>
    <div class="hspacer"></div>
    <button class="hbtn" onclick="CR.bridge.show_progress_report()" title="Reading intelligence">📊</button>
    <span id="timer-display">00:00</span>
    <button class="hbtn" id="btn-timer" onclick="CR.bridge.timer_control('toggle')" title="Start/stop timer">▶</button>
    <button class="hbtn" onclick="CR.bridge.timer_control('reset')" title="Reset timer">⟲</button>
    <div class="hsep"></div>
    <button class="hbtn" onclick="CR.bridge.pick_file()" title="Load file">📂</button>`;
  $("#btn-tabs").onclick = e => { e.stopPropagation(); $("#tab-menu").classList.toggle("show"); };
  document.addEventListener("click", e=>{ if (!e.target.closest("#tab-menu") && !e.target.closest("#btn-tabs")) $("#tab-menu").classList.remove("show"); });

  $("#tab-menu").innerHTML = `
    <div class="tab-item" onclick="openLogicSettings()">⚙️ <span>Logic Settings</span></div>
    <div class="tab-item" onclick="openQuestionSettings()">❓ <span>Question Settings</span></div>
    <div class="tab-item" onclick="openTextBlocks()">📚 <span>Text Blocks</span></div>
    <div class="tab-item" onclick="openCheckpoints()">📍 <span>Bookmarks</span></div>
    <div class="tab-item" onclick="openMindMap()">🧠 <span>Mind Map</span></div>
    <div class="tab-item" onclick="openReflections()">💭 <span>Reflections</span></div>
    <div class="tab-item" onclick="CR.bridge.export_state()">📦 <span>Export everything</span></div>
    <div class="tab-item" onclick="CR.bridge.import_state()">📥 <span>Import state</span></div>`;

  $("#side-tabs").innerHTML = `
    <div class="side-tab" onclick="openMindMap()">🧠 Map</div>
    <div class="side-tab" onclick="openTextBlocks()">📚 Blocks</div>
    <div class="side-tab" onclick="openCheckpoints()">📍 Marks</div>
    <div class="side-tab" onclick="quizMeNow()">❓ Quiz</div>
    <div class="side-tab" onclick="CR.bridge.next_flow_suggestion()">🧭 Flow</div>`;

  $("#brush-bar").innerHTML = `
    <span style="font:600 12px var(--font-ui);color:var(--ink-faint)">BRUSH</span>
    ${["#b08968","#c0392b","#2e86ab","#3d7a4f","#c9a227","#5b4a86"].map(c=>
      `<div class="swatch" style="background:${c}" onclick="CR.brush.color='${c}'"></div>`).join("")}
    <input type="range" id="brush-size" min="2" max="22" value="6" oninput="CR.brush.size=+this.value">
    <button class="mini-btn" onclick="undo()">↩</button>
    <button class="mini-btn" onclick="redo()">↪</button>
    <button class="mini-btn" onclick="clearDrawings()">Clear</button>
    <button class="mini-btn" onclick="toggleBrush(false)">Done</button>`;
}
function fontDelta(d){
  CR.settings.ui.fontSize = Math.max(13, Math.min(30, CR.settings.ui.fontSize + d));
  applyUISettings(); CR.bridge.update_settings(JSON.stringify(CR.settings));
}
function marginDelta(d){
  CR.settings.ui.margin = Math.max(20, Math.min(420, CR.settings.ui.margin + d));
  applyUISettings(); CR.bridge.update_settings(JSON.stringify(CR.settings));
}
function updateTimerDisplay(p){
  const el = $("#timer-display");
  const mm = String(Math.floor(p.sec/60)).padStart(2,"0"), ss = String(p.sec%60).padStart(2,"0");
  el.textContent = `${mm}:${ss}`;
  el.classList.toggle("running", p.running);
  $("#btn-timer").textContent = p.running ? "⏸" : "▶";
}
function quizMeNow(){
  const el = visibleSection();
  CR.bridge.learning_mode("questions", el ? sectionContext(el) : "");
}
function openReflections(){
  const items = CR.state?.reflections||[];
  openOverlay(`
    <button class="panel-close" onclick="closeOverlay()">✕</button>
    <h2>💭 Reflections</h2><div class="sub">Your saved answers and thoughts.</div>
    ${items.slice().reverse().map(r=>`<div class="excerpt" dir="${dirOf(r.a)}"><b style="font-size:12px;color:var(--ink-faint)">${esc((r.q||"").slice(0,90))}</b><br>${esc(r.a)}</div>`).join("")
      || '<div class="empty">Answer floating questions to collect reflections.</div>'}`);
}

/* ============================================================
   SETTINGS PANELS (Phases 5.4, 6, 9)
   ============================================================ */
function openQuestionSettings(){
  const q = CR.settings.questions;
  openOverlay(`
    <button class="panel-close" onclick="closeOverlay()">✕</button>
    <h2>❓ Question Settings</h2><div class="sub">Scheduled & floating questions behavior.</div>
    <div class="field"><span>Questions enabled</span><label class="switch"><input type="checkbox" id="qs-en" ${q.enabled?"checked":""}><i></i></label></div>
    <div class="field"><span>Interval (minutes)</span><input type="number" id="qs-int" min="1" value="${Math.round(q.intervalSec/60)}"></div>
    <div class="field"><span>Auto-close bubbles</span><label class="switch"><input type="checkbox" id="qs-ac" ${q.autoClose?"checked":""}><i></i></label></div>
    <div class="field"><span>Auto-close after (seconds)</span><input type="number" id="qs-acs" min="3" value="${q.autoCloseSec}"></div>
    <div class="field"><span>Required interaction (must answer)</span><label class="switch"><input type="checkbox" id="qs-req" ${q.requiredInteraction?"checked":""}><i></i></label></div>
    <div class="field"><span>Max bubbles on screen</span><input type="number" id="qs-max" min="1" max="5" value="${q.maxOnScreen}"></div>
    <h3>Question types</h3>
    ${Object.keys(q.types).map(t=>`<div class="field"><span style="text-transform:capitalize">${t}</span>
      <label class="switch"><input type="checkbox" data-qtype="${t}" ${q.types[t]?"checked":""}><i></i></label></div>`).join("")}
    <div class="pp-actions" style="display:flex;justify-content:flex-end;margin-top:18px">
      <button class="btn primary" onclick="saveQuestionSettings()">Save</button></div>`);
}
function saveQuestionSettings(){
  const q = CR.settings.questions;
  q.enabled = $("#qs-en").checked;
  q.intervalSec = Math.max(60, (+$("#qs-int").value||30)*60);
  q.autoClose = $("#qs-ac").checked;
  q.autoCloseSec = +$("#qs-acs").value||14;
  q.requiredInteraction = $("#qs-req").checked;
  q.maxOnScreen = +$("#qs-max").value||2;
  $$("input[data-qtype]").forEach(i=> q.types[i.dataset.qtype] = i.checked);
  // sync the scheduled-question rule (data-driven)
  const r = CR.settings.rules.find(r=>r.trigger?.type==="time_elapsed" && r.action?.type==="question");
  if (r){ r.enabled = q.enabled; r.trigger.everySec = q.intervalSec;
          r.action.autoCloseSec = q.autoCloseSec; r.action.required = q.requiredInteraction; }
  CR.bridge.update_settings(JSON.stringify(CR.settings));
  closeOverlay(); toast("Question settings saved");
}
function openLogicSettings(){
  const rules = CR.settings.rules||[];
  openOverlay(`
    <button class="panel-close" onclick="closeOverlay()">✕</button>
    <h2>⚙️ Logic Settings — Rule Engine</h2>
    <div class="sub">Fully data-driven rules: trigger → action. Edit JSON directly for full control.</div>
    ${rules.map((r,i)=>`
      <div class="rule-card">
        <div class="rc-head">
          <label class="switch"><input type="checkbox" ${r.enabled?"checked":""} onchange="CR.settings.rules[${i}].enabled=this.checked;pushRules()"><i></i></label>
          <span class="rc-name">${esc(r.name||r.id)}</span>
          <button class="mini-btn" onclick="editRule(${i})">Edit</button>
          <button class="mini-btn" style="color:#b3503e" onclick="CR.settings.rules.splice(${i},1);pushRules();openLogicSettings()">✕</button>
        </div>
        <div class="rc-meta">when <b>${esc(r.trigger?.type)}</b> ${esc(JSON.stringify({...r.trigger,type:undefined}).replace(/"|\{|\}|,?"?type"?:undefined,?/g," ").trim())}
          → <b>${esc(r.action?.type)}</b></div>
      </div>`).join("")}
    <button class="btn primary" onclick="addRule()" style="margin-top:8px">+ New rule</button>
    <h3>Custom popups (schema-driven)</h3>
    ${Object.keys(CR.settings.popups||{}).map(pid=>`
      <div class="rule-card"><div class="rc-head"><span class="rc-name">${esc(pid)} — ${esc(CR.settings.popups[pid].title||"")}</span>
      <button class="mini-btn" onclick="editPopup(${JSON.stringify(pid)})">Edit</button>
      <button class="mini-btn" onclick="showCustomPopup(CR.settings.popups[${JSON.stringify(pid)}],{})">Preview</button></div></div>`).join("")}
    <button class="btn" onclick="addPopup()" style="margin-top:8px">+ New popup schema</button>
    <h3>Reading / learning</h3>
    <div class="field"><span>Adaptive flow suggestions</span><label class="switch"><input type="checkbox" ${CR.settings.learning.adaptiveFlow?"checked":""} onchange="CR.settings.learning.adaptiveFlow=this.checked;pushRules()"><i></i></label></div>
    <div class="field"><span>Interleaved learning</span><label class="switch"><input type="checkbox" ${CR.settings.learning.interleaving?"checked":""} onchange="CR.settings.learning.interleaving=this.checked;pushRules()"><i></i></label></div>
    <div class="field"><span>Expected reading speed (wpm)</span><input type="number" value="${CR.settings.learning.expectedWpm}" onchange="CR.settings.learning.expectedWpm=+this.value||200;pushRules()"></div>
    <div class="field"><span>Intro bubble overlay on open</span><label class="switch"><input type="checkbox" ${CR.settings.ui.introOverlay?"checked":""} onchange="CR.settings.ui.introOverlay=this.checked;pushRules()"><i></i></label></div>`);
}
function pushRules(){ CR.bridge.update_settings(JSON.stringify(CR.settings)); }
function editRule(i){
  const r = CR.settings.rules[i];
  openOverlay(`
    <button class="panel-close" onclick="openLogicSettings()">✕</button>
    <h2>Edit rule</h2><div class="sub">JSON schema — trigger types: time_elapsed, inactivity, selection, scroll_speed, progress, checkpoint_reached, document_opened, timer_started, timer_finished, highlight_created, note_created. Action types: question, popup, intro_overlay, navigate, learning_mode, animation.</div>
    <textarea class="json-edit" id="rule-json" style="min-height:240px">${esc(JSON.stringify(r, null, 2))}</textarea>
    <div class="pp-actions" style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
      <button class="btn ghost" onclick="openLogicSettings()">Cancel</button>
      <button class="btn primary" onclick="saveRule(${i})">Save rule</button></div>`);
}
function saveRule(i){
  try {
    CR.settings.rules[i] = JSON.parse($("#rule-json").value);
    pushRules(); openLogicSettings(); toast("Rule saved");
  } catch(e){ toast("Invalid JSON: " + e.message); }
}
function addRule(){
  CR.settings.rules.push({ id:"rule-"+uid(), name:"New rule", enabled:true,
    trigger:{type:"time_elapsed", everySec:600},
    action:{type:"question", questionType:"reflection", ui:"bubble", autoCloseSec:12, required:false} });
  pushRules(); editRule(CR.settings.rules.length-1);
}
function editPopup(pid){
  openOverlay(`
    <button class="panel-close" onclick="openLogicSettings()">✕</button>
    <h2>Edit popup schema</h2><div class="sub">Buttons support actions: close, save_reflection, navigate_back, start_timer.</div>
    <textarea class="json-edit" id="popup-json" style="min-height:240px">${esc(JSON.stringify(CR.settings.popups[pid], null, 2))}</textarea>
    <div class="pp-actions" style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
      <button class="btn ghost" onclick="openLogicSettings()">Cancel</button>
      <button class="btn primary" onclick="savePopup(${JSON.stringify(pid)})">Save</button></div>`);
}
function savePopup(pid){
  try { CR.settings.popups[pid] = JSON.parse($("#popup-json").value); pushRules(); openLogicSettings(); toast("Popup saved"); }
  catch(e){ toast("Invalid JSON: " + e.message); }
}
function addPopup(){
  const pid = "popup-" + uid();
  CR.settings.popups[pid] = { title:"New popup", body:"Your message…", timerSec:0,
    requireInteraction:false, input:false,
    buttons:[{label:"OK", action:"close", style:"primary"}] };
  pushRules(); editPopup(pid);
}

/* ============================================================
   INIT DOM scaffolding
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  document.body.insertAdjacentHTML("beforeend", `
    <div id="cr-header"></div><div id="progress-bar"></div>
    <div id="cr-content"></div>
    <div id="sel-menu"></div>
    <div id="bubble-layer"></div>
    <div id="side-tabs"></div>
    <div id="tab-menu"></div>
    <div id="brush-bar"></div>
    <div id="toast"></div>`);
  buildHeader();
  buildSelMenu();
});
