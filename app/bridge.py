"""
QWebChannel bridge between Python core and the JS reading UI.
"""
from __future__ import annotations

import json
from PySide6.QtCore import QObject, Signal, Slot


class Bridge(QObject):
    """Exposed to JS as `bridge`."""
    js_message = Signal(str)            # python -> js
    event_from_js = Signal(dict)        # js -> python (parsed)

    # plain command signals consumed by MainWindow
    pick_file_requested = Signal()
    open_path_requested = Signal(str)
    save_state_requested = Signal(dict)
    settings_updated = Signal(dict)
    learning_mode_requested = Signal(str, str)
    ask_ai_requested = Signal(str, str)
    regen_mindmap_requested = Signal()
    export_requested = Signal()
    import_requested = Signal()
    timer_control_requested = Signal(str)
    progress_report_requested = Signal()
    flow_suggestion_requested = Signal()

    # ---- python -> js -------------------------------------------------
    def send(self, msg_type: str, payload: dict | None = None) -> None:
        self.js_message.emit(json.dumps({"type": msg_type, "payload": payload or {}},
                                        ensure_ascii=False))

    # ---- js -> python (slots) -----------------------------------------
    @Slot(str)
    def on_js_event(self, json_str: str) -> None:
        try:
            msg = json.loads(json_str)
        except json.JSONDecodeError:
            return
        self.event_from_js.emit(msg)

    @Slot(str)
    def save_state(self, json_str: str) -> None:
        try:
            self.save_state_requested.emit(json.loads(json_str))
        except json.JSONDecodeError:
            pass

    @Slot(str)
    def update_settings(self, json_str: str) -> None:
        try:
            self.settings_updated.emit(json.loads(json_str))
        except json.JSONDecodeError:
            pass

    @Slot()
    def pick_file(self) -> None:
        self.pick_file_requested.emit()

    @Slot(str)
    def open_path(self, path: str) -> None:
        self.open_path_requested.emit(path)

    @Slot(str, str)
    def learning_mode(self, mode: str, text: str) -> None:
        self.learning_mode_requested.emit(mode, text)

    @Slot(str, str)
    def ask_ai(self, text: str, question: str) -> None:
        self.ask_ai_requested.emit(text, question)

    @Slot()
    def regen_mindmap(self) -> None:
        self.regen_mindmap_requested.emit()

    @Slot()
    def export_state(self) -> None:
        self.export_requested.emit()

    @Slot()
    def import_state(self) -> None:
        self.import_requested.emit()

    @Slot(str)
    def timer_control(self, cmd: str) -> None:
        self.timer_control_requested.emit(cmd)

    @Slot()
    def show_progress_report(self) -> None:
        self.progress_report_requested.emit()

    @Slot()
    def next_flow_suggestion(self) -> None:
        self.flow_suggestion_requested.emit()
