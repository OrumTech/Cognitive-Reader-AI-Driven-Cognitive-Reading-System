"""
Local-first state persistence.

Everything lives in ./data/ as JSON:
  settings.json      - global settings, rules, question schedules, popup schemas
  docs/<doc_id>.json - per-document state: highlights, notes, blocks,
                       checkpoints, mind map, drawings, reading progress.

Full export/import of the whole state is supported.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Dict

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DOCS_DIR = os.path.join(DATA_DIR, "docs")
SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")


DEFAULT_RULES = [
    {
        "id": "rule-welcome-bubbles",
        "enabled": True,
        "name": "First-launch question bubbles",
        "trigger": {"type": "document_opened"},
        "action": {"type": "intro_overlay", "durationSec": 120, "skippable": True},
    },
    {
        "id": "rule-recall-30m",
        "enabled": True,
        "name": "Memory recall every 30 minutes",
        "trigger": {"type": "time_elapsed", "everySec": 1800},
        "action": {"type": "question", "questionType": "recall",
                   "ui": "bubble", "autoCloseSec": 14, "required": False},
    },
    {
        "id": "rule-idle-nudge",
        "enabled": True,
        "name": "Inactivity reflection nudge",
        "trigger": {"type": "inactivity", "afterSec": 180},
        "action": {"type": "question", "questionType": "reflection",
                   "ui": "bubble", "autoCloseSec": 12, "required": False},
    },
    {
        "id": "rule-selection-question",
        "enabled": True,
        "name": "Selection-based contextual question",
        "trigger": {"type": "selection", "minChars": 220, "cooldownSec": 90},
        "action": {"type": "question", "questionType": "contextual",
                   "ui": "bubble", "autoCloseSec": 12, "required": False},
    },
    {
        "id": "rule-progress-checkin",
        "enabled": True,
        "name": "Progress check-in at 50%",
        "trigger": {"type": "progress", "atPercent": 50, "once": True},
        "action": {"type": "popup", "popupId": "popup-progress-check"},
    },
    {
        "id": "rule-checkpoint-review",
        "enabled": True,
        "name": "On new checkpoint: offer review",
        "trigger": {"type": "checkpoint_reached", "cooldownSec": 120},
        "action": {"type": "question", "questionType": "comprehension",
                   "ui": "bubble", "autoCloseSec": 14, "required": False},
    },
    {
        "id": "rule-scroll-fast",
        "enabled": True,
        "name": "Fast scrolling -> slow down popup",
        "trigger": {"type": "scroll_speed", "minPxPerSec": 2600, "cooldownSec": 240},
        "action": {"type": "popup", "popupId": "popup-slow-down"},
    },
]

DEFAULT_POPUPS = {
    "popup-progress-check": {
        "title": "📍 Halfway check-in",
        "body": "You've reached the middle of this document. Can you summarize the main argument so far in one sentence?",
        "timerSec": 0,
        "requireInteraction": True,
        "input": True,
        "buttons": [
            {"label": "Save my summary", "action": "save_reflection", "style": "primary"},
            {"label": "Review earlier part", "action": "navigate_back", "style": "ghost"},
            {"label": "Continue", "action": "close", "style": "ghost"},
        ],
    },
    "popup-slow-down": {
        "title": "🐢 Slow down",
        "body": "You're scrolling quickly. Skimming is fine — but if you want retention, slow down and engage with the text.",
        "timerSec": 8,
        "requireInteraction": False,
        "input": False,
        "buttons": [{"label": "Got it", "action": "close", "style": "primary"}],
    },
}

DEFAULT_SETTINGS: Dict[str, Any] = {
    "version": 2,
    "ui": {
        "fontSize": 19,
        "margin": 200,
        "theme": "cream",
        "introOverlay": True,
        "introDurationSec": 120,
    },
    "questions": {
        "enabled": True,
        "intervalSec": 1800,
        "types": {"recall": True, "reflection": True, "comprehension": True, "contextual": True},
        "autoClose": True,
        "autoCloseSec": 14,
        "requiredInteraction": False,
        "maxOnScreen": 2,
    },
    "learning": {
        "adaptiveFlow": True,
        "interleaving": True,
        "expectedWpm": 200,
    },
    "rules": DEFAULT_RULES,
    "popups": DEFAULT_POPUPS,
    "recentFiles": [],
}


def _empty_doc_state(doc_id: str) -> Dict[str, Any]:
    return {
        "docId": doc_id,
        "highlights": [],     # {id, color, mode, text, sectionId, startOff, endOff}
        "notes": [],          # {id, x, y, text, color, sectionId}
        "blocks": {},         # category -> [ {id, text, sectionId, ts} ]
        "checkpoints": [],    # {id, name, sectionId, scrollY, ts}
        "drawings": [],       # brush strokes: [{points:[[x,y],...], color, size}]
        "mindmap": None,      # {nodes:[{id,label,sectionId,x,y,parent}], edges:[..]}
        "progress": {"scrollY": 0, "percent": 0, "totalReadSec": 0,
                     "sessions": 0, "lastSection": None},
        "reflections": [],    # saved answers / reflections
        "events": [],         # lightweight telemetry for heuristics
    }


class StateStore:
    def __init__(self) -> None:
        os.makedirs(DOCS_DIR, exist_ok=True)
        self.settings = self._load_json(SETTINGS_PATH, None)
        if not self.settings:
            self.settings = json.loads(json.dumps(DEFAULT_SETTINGS))
            self.save_settings()
        # merge any new default keys
        for k, v in DEFAULT_SETTINGS.items():
            self.settings.setdefault(k, v)
        self._migrate()

    def _migrate(self) -> None:
        """Upgrade old stored rules to current defaults where the old default
        was problematic (e.g. blocking card on checkpoint navigation)."""
        changed = False
        for r in self.settings.get("rules", []):
            if r.get("id") == "rule-checkpoint-review" and \
                    r.get("action", {}).get("ui") == "card":
                new = next(d for d in DEFAULT_RULES if d["id"] == "rule-checkpoint-review")
                r["trigger"] = dict(new["trigger"])
                r["action"] = dict(new["action"])
                r["name"] = new["name"]
                changed = True
        if changed:
            self.save_settings()

    # -- generic io ----------------------------------------------------------
    @staticmethod
    def _load_json(path: str, default: Any) -> Any:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return default

    @staticmethod
    def _save_json(path: str, data: Any) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    # -- settings -------------------------------------------------------------
    def save_settings(self) -> None:
        self._save_json(SETTINGS_PATH, self.settings)

    def add_recent(self, path: str) -> None:
        rec = self.settings.setdefault("recentFiles", [])
        if path in rec:
            rec.remove(path)
        rec.insert(0, path)
        del rec[8:]
        self.save_settings()

    # -- per-document ----------------------------------------------------------
    def _doc_path(self, doc_id: str) -> str:
        return os.path.join(DOCS_DIR, f"{doc_id}.json")

    def load_doc_state(self, doc_id: str) -> Dict[str, Any]:
        state = self._load_json(self._doc_path(doc_id), None)
        if not state:
            state = _empty_doc_state(doc_id)
        base = _empty_doc_state(doc_id)
        for k, v in base.items():
            state.setdefault(k, v)
        return state

    def save_doc_state(self, doc_id: str, state: Dict[str, Any]) -> None:
        state["savedAt"] = time.time()
        self._save_json(self._doc_path(doc_id), state)

    # -- full export / import ---------------------------------------------------
    def export_all(self, out_path: str) -> None:
        bundle = {"exportedAt": time.time(), "settings": self.settings, "docs": {}}
        for fn in os.listdir(DOCS_DIR):
            if fn.endswith(".json"):
                bundle["docs"][fn[:-5]] = self._load_json(os.path.join(DOCS_DIR, fn), {})
        self._save_json(out_path, bundle)

    def import_all(self, in_path: str) -> bool:
        bundle = self._load_json(in_path, None)
        if not bundle or "settings" not in bundle:
            return False
        self.settings = bundle["settings"]
        for k, v in DEFAULT_SETTINGS.items():
            self.settings.setdefault(k, v)
        self.save_settings()
        for doc_id, state in bundle.get("docs", {}).items():
            self._save_json(self._doc_path(doc_id), state)
        return True
