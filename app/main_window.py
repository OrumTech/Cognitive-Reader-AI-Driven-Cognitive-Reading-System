"""
Main application window — orchestrates:
  document loading, web view, bridge, rule engine, learning engine,
  timers, import/export, fallback raw viewer.
"""
from __future__ import annotations

import os
from dataclasses import asdict
from typing import Any, Dict, Optional

from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QFileDialog, QMainWindow, QMessageBox

from .bridge import Bridge
from .document_loader import LoadedDocument, load_document
from .learning_engine import (AdaptiveFlow, ProgressIntelligence,
                              QuestionFactory, answer_about, build_mindmap,
                              learning_mode)
from .rule_engine import RuleEngine
from .state_store import StateStore

RES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources")


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Cognitive Reader — Learning OS")
        self.resize(1280, 860)

        self.store = StateStore()
        self.doc: Optional[LoadedDocument] = None
        self.doc_state: Dict[str, Any] = {}
        self.ui_ready = False
        self._pending_path: Optional[str] = None
        self._raw_mode = False

        # learning engine pieces
        self.qfactory = QuestionFactory()
        self.progress_ai = ProgressIntelligence(
            self.store.settings["learning"].get("expectedWpm", 200))
        self.flow = AdaptiveFlow()

        # session timer (Phase 9.2)
        self.timer_sec = 0
        self.timer_running = False
        self._timer = QTimer(self)
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._timer_tick)
        self._timer.start()

        # rule engine (Phase 6)
        self.rules = RuleEngine(self)
        self.rules.load_rules(self.store.settings.get("rules", []))
        self.rules.action_triggered.connect(self._on_rule_action)

        # web view + channel
        self.view = QWebEngineView(self)
        self.setCentralWidget(self.view)
        s = self.view.settings()
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, True)  # pdf viewer fallback
        s.setAttribute(QWebEngineSettings.WebAttribute.PdfViewerEnabled, True)

        self.bridge = Bridge(self)
        self.channel = QWebChannel(self)
        self.channel.registerObject("bridge", self.bridge)
        self.view.page().setWebChannel(self.channel)
        self._wire_bridge()

        self._load_reader_page()

    # ------------------------------------------------------------------
    def _load_reader_page(self) -> None:
        self._raw_mode = False
        self.ui_ready = False
        self.view.load(QUrl.fromLocalFile(os.path.join(RES_DIR, "reader.html")))

    def _wire_bridge(self) -> None:
        b = self.bridge
        b.event_from_js.connect(self._on_js_event)
        b.pick_file_requested.connect(self.pick_file)
        b.open_path_requested.connect(self.open_path)
        b.save_state_requested.connect(self._on_save_state)
        b.settings_updated.connect(self._on_settings_updated)
        b.learning_mode_requested.connect(self._on_learning_mode)
        b.ask_ai_requested.connect(self._on_ask_ai)
        b.regen_mindmap_requested.connect(self._on_regen_mindmap)
        b.export_requested.connect(self.export_state)
        b.import_requested.connect(self.import_state)
        b.timer_control_requested.connect(self._on_timer_control)
        b.progress_report_requested.connect(self._send_progress_report)
        b.flow_suggestion_requested.connect(self._send_flow_suggestion)

    # ------------------------------------------------------------------
    # JS event router
    # ------------------------------------------------------------------
    def _on_js_event(self, msg: Dict[str, Any]) -> None:
        mtype = msg.get("type")
        payload = msg.get("payload", {})

        if mtype == "ready":
            self.ui_ready = True
            if self._pending_path:
                p, self._pending_path = self._pending_path, None
                self.open_path(p)
            else:
                self.bridge.send("init", {"settings": self.store.settings,
                                          "document": None})
            return

        if mtype == "document_rendered":
            self.rules.on_event("document_opened", {})
            return

        # forward behavioural events to rule engine
        if mtype in ("selection", "scroll_speed", "progress", "checkpoint_reached",
                     "highlight_created", "note_created"):
            self.rules.on_event(mtype, payload)
            if mtype in ("highlight_created", "note_created"):
                self.progress_ai.engaged()
            if mtype == "selection":
                self._last_selection = payload.get("text", "")
            return

        if mtype == "activity":
            self.rules.notify_activity()
            return
        if mtype == "engagement":
            self.progress_ai.engaged()
            return
        if mtype == "question_answered":
            self.progress_ai.engaged()
            return
        if mtype == "section_visible":
            sid = payload.get("sectionId")
            if sid:
                self.qfactory.mark_read(sid)
                self.flow.visit(sid)
            return
        if mtype == "read_tick":
            # periodically nudge adaptive flow (every ~5 min of reading)
            total = payload.get("totalReadSec", 0)
            if self.store.settings["learning"].get("adaptiveFlow") and total and total % 300 == 0:
                self._send_flow_suggestion()
            return

    # ------------------------------------------------------------------
    # Rule actions  ->  JS
    # ------------------------------------------------------------------
    def _on_rule_action(self, rule: Dict[str, Any], action: Dict[str, Any]) -> None:
        atype = action.get("type")
        payload: Dict[str, Any] = {"action": action, "ruleId": rule.get("id")}

        if atype == "question":
            qcfg = self.store.settings.get("questions", {})
            if not qcfg.get("enabled", True):
                return
            qtype = action.get("questionType", "reflection")
            if not qcfg.get("types", {}).get(qtype, True):
                qtype = "reflection"
            ctx = rule.get("_context", {}).get("text", "")
            payload["question"] = self.qfactory.make(qtype, ctx)
        elif atype == "popup":
            popup = self.store.settings.get("popups", {}).get(action.get("popupId", ""))
            if not popup:
                return
            payload["popup"] = popup
        elif atype == "intro_overlay":
            if not self.store.settings["ui"].get("introOverlay", True):
                return

        self.bridge.send("rule_action", payload)

    # ------------------------------------------------------------------
    # File handling (Phase 1)
    # ------------------------------------------------------------------
    def pick_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Load document", "",
            "Documents (*.pdf *.docx *.txt *.md);;All files (*)")
        if path:
            self.open_path(path)

    def open_path(self, path: str) -> None:
        if not os.path.exists(path):
            QMessageBox.warning(self, "Not found", f"File does not exist:\n{path}")
            return
        if self._raw_mode:
            # we're on a raw page; go back to reader first, then load
            self._pending_path = path
            self._load_reader_page()
            return
        if not self.ui_ready:
            self._pending_path = path
            return

        doc = load_document(path)
        self.store.add_recent(path)

        if doc.fallback_raw:
            self._open_raw_fallback(doc)
            return

        self.doc = doc
        self.doc_state = self.store.load_doc_state(doc.doc_id)
        self.qfactory.set_document(doc)
        self.progress_ai.set_document(doc)
        self.flow.set_document(doc, self.store.settings["learning"].get("interleaving", True))
        if not self.doc_state.get("mindmap"):
            self.doc_state["mindmap"] = build_mindmap(doc)
        self.rules.reset_session()

        self.bridge.send("load_document", {
            "settings": self.store.settings,
            "document": {
                "title": doc.title,
                "kind": doc.kind,
                "sections": [asdict(s) for s in doc.sections],
            },
            "state": self.doc_state,
        })
        self.setWindowTitle(f"Cognitive Reader — {doc.title}")

    def _open_raw_fallback(self, doc: LoadedDocument) -> None:
        """Extraction failed → show file natively (no crash)."""
        self._raw_mode = True
        self.ui_ready = False
        QMessageBox.information(
            self, "Raw viewer mode",
            "Text extraction failed for this file "
            f"({doc.error}).\nOpening in raw viewer mode — annotations are "
            "unavailable, but you can still read it.\nUse File dialog again to "
            "load another document.")
        if doc.kind == "pdf":
            self.view.load(QUrl.fromLocalFile(doc.path))
        else:
            try:
                with open(doc.path, "rb") as f:
                    raw = f.read(200_000).decode("utf-8", errors="replace")
            except OSError as e:
                raw = f"Could not read file: {e}"
            html = ("<html><body style='background:#f6f1e7;color:#3b2f25;"
                    "font:15px monospace;white-space:pre-wrap;padding:40px'>"
                    + raw.replace("&", "&amp;").replace("<", "&lt;")
                    + "</body></html>")
            self.view.setHtml(html)

    # ------------------------------------------------------------------
    # State / settings
    # ------------------------------------------------------------------
    def _on_save_state(self, state: Dict[str, Any]) -> None:
        if self.doc:
            self.doc_state = state
            self.store.save_doc_state(self.doc.doc_id, state)

    def _on_settings_updated(self, settings: Dict[str, Any]) -> None:
        self.store.settings = settings
        self.store.save_settings()
        self.rules.load_rules(settings.get("rules", []))
        self.progress_ai.expected_wpm = settings["learning"].get("expectedWpm", 200)
        self.flow.interleave = settings["learning"].get("interleaving", True)
        self.bridge.send("settings_updated", {"settings": settings})

    # ------------------------------------------------------------------
    # Learning engine endpoints (Phase 4)
    # ------------------------------------------------------------------
    def _on_learning_mode(self, mode: str, text: str) -> None:
        if not text and self.doc:
            text = self.doc.plain_text[:3000]
        result = learning_mode(mode, text or "")
        self.bridge.send("learning_result", result)

    def _on_ask_ai(self, text: str, question: str) -> None:
        self.bridge.send("learning_result", answer_about(text, question))

    def _on_regen_mindmap(self) -> None:
        if not self.doc:
            return
        self.doc_state["mindmap"] = build_mindmap(self.doc)
        self.store.save_doc_state(self.doc.doc_id, self.doc_state)
        self.bridge.send("load_document", {
            "settings": self.store.settings,
            "document": {"title": self.doc.title, "kind": self.doc.kind,
                         "sections": [asdict(s) for s in self.doc.sections]},
            "state": self.doc_state,
        })

    def _send_progress_report(self) -> None:
        prog = self.doc_state.get("progress", {}) if self.doc else {}
        report = self.progress_ai.report(prog.get("percent", 0),
                                         prog.get("totalReadSec", 0))
        self.bridge.send("progress_report", report)

    def _send_flow_suggestion(self) -> None:
        sug = self.flow.next_suggestion()
        if sug:
            self.bridge.send("flow_suggestion", sug)

    # ------------------------------------------------------------------
    # Timer system (Phase 9.2) — timers trigger rules
    # ------------------------------------------------------------------
    def _on_timer_control(self, cmd: str) -> None:
        if cmd == "toggle":
            self.timer_running = not self.timer_running
            self.rules.on_event("timer_started" if self.timer_running else "timer_finished",
                                {"sec": self.timer_sec})
        elif cmd == "start":
            self.timer_running = True
            self.rules.on_event("timer_started", {"sec": self.timer_sec})
        elif cmd == "reset":
            self.timer_sec = 0
            self.timer_running = False
            self.rules.reset_session()   # resetting timer resets rule workflows
        self._push_timer()

    def _timer_tick(self) -> None:
        if self.timer_running:
            self.timer_sec += 1
            self._push_timer()

    def _push_timer(self) -> None:
        self.bridge.send("timer_update", {"sec": self.timer_sec,
                                          "running": self.timer_running})

    # ------------------------------------------------------------------
    # Import / export (Phase 9.1)
    # ------------------------------------------------------------------
    def export_state(self) -> None:
        path, _ = QFileDialog.getSaveFileName(self, "Export full state",
                                              "cognitive-reader-export.json",
                                              "JSON (*.json)")
        if path:
            self.store.export_all(path)
            QMessageBox.information(self, "Exported",
                                    "Settings, rules, mind maps, highlights, notes,\n"
                                    "checkpoints and reading progress exported.")

    def import_state(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Import full state", "",
                                              "JSON (*.json)")
        if not path:
            return
        if self.store.import_all(path):
            self.rules.load_rules(self.store.settings.get("rules", []))
            QMessageBox.information(self, "Imported",
                                    "State imported. Re-open your document to see it applied.")
            self.bridge.send("settings_updated", {"settings": self.store.settings})
        else:
            QMessageBox.warning(self, "Import failed", "Invalid export file.")
