"""
Phase 6 — Dynamic Rule Engine.

Fully data-driven: rules are JSON dicts stored in settings.
No hardcoded behaviors — this module only *interprets* rule schemas.

Rule schema:
{
  "id": "...", "name": "...", "enabled": true,
  "trigger": {
      "type": "time_elapsed|inactivity|selection|scroll_speed|progress|
               checkpoint_reached|document_opened|timer_started|timer_finished|
               highlight_created|note_created",
      ... params (everySec, afterSec, minChars, minPxPerSec, atPercent,
                  once, cooldownSec)
  },
  "action": {
      "type": "question|popup|intro_overlay|navigate|learning_mode|animation",
      ... params (questionType, ui, autoCloseSec, required, popupId,
                  sectionId, mode, name, durationSec)
  }
}
"""
from __future__ import annotations

import time
from typing import Any, Callable, Dict, List

from PySide6.QtCore import QObject, QTimer, Signal


class RuleEngine(QObject):
    action_triggered = Signal(dict, dict)   # (rule, action)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.rules: List[Dict[str, Any]] = []
        self._last_fire: Dict[str, float] = {}
        self._fired_once: set = set()
        self._session_start = time.time()
        self._last_activity = time.time()
        self._tick = QTimer(self)
        self._tick.setInterval(1000)
        self._tick.timeout.connect(self._on_tick)
        self._tick.start()
        self._paused = False

    # -- lifecycle --------------------------------------------------------
    def load_rules(self, rules: List[Dict[str, Any]]) -> None:
        self.rules = [r for r in rules if isinstance(r, dict)]
        self._fired_once.clear()
        self._last_fire.clear()
        self._session_start = time.time()

    def reset_session(self) -> None:
        self._session_start = time.time()
        self._fired_once.clear()
        self._last_fire.clear()

    def set_paused(self, paused: bool) -> None:
        self._paused = paused

    # -- helpers ------------------------------------------------------------
    def _cooldown_ok(self, rule: Dict[str, Any]) -> bool:
        cd = rule.get("trigger", {}).get("cooldownSec", 0)
        last = self._last_fire.get(rule["id"], 0)
        return (time.time() - last) >= cd

    def _fire(self, rule: Dict[str, Any]) -> None:
        if self._paused:
            return
        rid = rule.get("id", "")
        trig = rule.get("trigger", {})
        if trig.get("once") and rid in self._fired_once:
            return
        if not self._cooldown_ok(rule):
            return
        self._last_fire[rid] = time.time()
        self._fired_once.add(rid)
        self.action_triggered.emit(rule, rule.get("action", {}))

    def _matching(self, ttype: str):
        for r in self.rules:
            if r.get("enabled", True) and r.get("trigger", {}).get("type") == ttype:
                yield r

    # -- event ingestion (called by app) ---------------------------------------
    def notify_activity(self) -> None:
        self._last_activity = time.time()

    def on_event(self, event_type: str, payload: Dict[str, Any] | None = None) -> None:
        """Generic event entry: selection, scroll_speed, progress, checkpoint_reached,
        document_opened, timer_started, timer_finished, highlight_created, note_created."""
        payload = payload or {}
        self.notify_activity()
        for rule in self._matching(event_type):
            trig = rule["trigger"]
            if event_type == "selection":
                if len(payload.get("text", "")) < trig.get("minChars", 0):
                    continue
            elif event_type == "scroll_speed":
                if payload.get("pxPerSec", 0) < trig.get("minPxPerSec", 99999):
                    continue
            elif event_type == "progress":
                at = trig.get("atPercent", 101)
                if payload.get("percent", 0) < at:
                    continue
            self._fire(self._with_context(rule, payload))

    def _with_context(self, rule: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
        r = dict(rule)
        r["_context"] = payload
        return r

    # -- periodic triggers -------------------------------------------------------
    def _on_tick(self) -> None:
        if self._paused:
            return
        now = time.time()
        for rule in self._matching("time_elapsed"):
            every = rule["trigger"].get("everySec", 0)
            if every <= 0:
                continue
            last = self._last_fire.get(rule["id"], self._session_start)
            if now - last >= every:
                self._fire(rule)
        for rule in self._matching("inactivity"):
            after = rule["trigger"].get("afterSec", 0)
            if after > 0 and (now - self._last_activity) >= after:
                if self._cooldown_ok_or_default(rule, after):
                    self._fire(rule)

    def _cooldown_ok_or_default(self, rule: Dict[str, Any], default_cd: float) -> bool:
        last = self._last_fire.get(rule["id"], 0)
        cd = rule.get("trigger", {}).get("cooldownSec", default_cd)
        return (time.time() - last) >= cd
