"""
Learning Intelligence Engine — fully local, no cloud.

Provides:
  * Feynman / summarize / examples / questions / problem-solving modes
  * Question generation (recall, reflection, comprehension, contextual)
  * Mind map auto-generation from document structure
  * Adaptive flow + reading-progress heuristics

Heuristic NLP (frequency-based extractive summarization, keyword extraction,
cloze question generation). Works for both English (LTR) and Persian (RTL).
"""
from __future__ import annotations

import math
import random
import re
import time
from collections import Counter
from typing import Any, Dict, List, Optional

from .document_loader import LoadedDocument, Section

RTL_RE = re.compile(r"[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]")

_STOP_EN = set("""a an the and or but if then than so of to in on for with at by from as is are was
were be been being it its this that these those i you he she they we him her them my your our their
not no nor do does did done can could will would shall should may might must have has had having
about into over under between during after before while out up down again further once here there
all any both each few more most other some such only own same too very just also
who what when where which whom whose why how because however therefore thus although
though since unless until upon within without against among toward towards first second
third fourth one two three four five called like new way make makes made using use used
get gets got many much well still even ever never always often sometimes""".split())

_STOP_FA = set("""و در به از که این آن را با است بود شد می های برای تا یا هم نیز اما اگر چون هر
او ما شما آنها من تو خود یک دو بر بی پس چه کجا چرا چگونه باید نباید شده بودند هستند نیست بین روی
زیر کنار مانند مثل ولی سپس البته یعنی حتی فقط دیگر همه هیچ چیز کرد کند کنند شود
""".split())


def is_rtl(text: str) -> bool:
    rtl = len(RTL_RE.findall(text))
    latin = len(re.findall(r"[A-Za-z]", text))
    return rtl > latin


def _words(text: str) -> List[str]:
    return re.findall(r"[\w\u0600-\u06FF\u0590-\u05FF']+", text.lower())


def _sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?؟۔])\s+|\n+", text)
    return [p.strip() for p in parts if len(p.strip()) > 15]


def keywords(text: str, n: int = 8) -> List[str]:
    ws = _words(text)
    freq = Counter(w for w in ws if len(w) > 2 and w not in _STOP_EN and w not in _STOP_FA)
    return [w for w, _ in freq.most_common(n)]


def _score_sentences(text: str) -> List[tuple]:
    sents = _sentences(text)
    if not sents:
        return []
    ws = _words(text)
    freq = Counter(w for w in ws if w not in _STOP_EN and w not in _STOP_FA and len(w) > 2)
    if not freq:
        return [(s, 1.0) for s in sents]
    maxf = max(freq.values())
    scored = []
    for i, s in enumerate(sents):
        sw = _words(s)
        if not sw:
            continue
        score = sum(freq.get(w, 0) / maxf for w in sw) / math.sqrt(len(sw))
        score *= 1.15 if i == 0 else 1.0  # lead bias
        scored.append((s, score))
    return scored


def summarize(text: str, max_sents: int = 4) -> str:
    scored = _score_sentences(text)
    if not scored:
        return text[:400]
    sents = _sentences(text)
    top = sorted(scored, key=lambda x: -x[1])[:max_sents]
    chosen = set(s for s, _ in top)
    ordered = [s for s in sents if s in chosen]
    return " ".join(ordered)


# ----------------------------------------------------------------------------
# Learning modes (Phase 4.1)
# ----------------------------------------------------------------------------

def learning_mode(mode: str, text: str) -> Dict[str, Any]:
    """Return {'title':..., 'html':...} for a learning mode applied to text."""
    rtl = is_rtl(text)
    kws = keywords(text, 6)
    summ = summarize(text, 3)
    short = summarize(text, 1)

    def li(items):
        return "".join(f"<li>{x}</li>" for x in items)

    if mode == "feynman":
        steps = [
            f"<b>Step 1 — Say it simply:</b> Imagine explaining this to a 12-year-old. "
            f"The core idea, stripped of jargon, is roughly: <i>“{short}”</i>",
            "<b>Step 2 — Find your gaps:</b> Try to re-explain these key terms in your own words "
            f"without looking: <b>{', '.join(kws[:4]) or '—'}</b>. "
            "Anywhere you hesitate is a gap.",
            "<b>Step 3 — Go back & simplify:</b> Re-read only the part covering the term you "
            "struggled with, then write a 2-sentence explanation a child would understand.",
            "<b>Step 4 — Use an analogy:</b> Complete this sentence out loud: "
            f"<i>“{(kws[0].capitalize() if kws else 'This concept')} is like ______ because ______.”</i>",
        ]
        return {"title": "🧒 Feynman Mode — Explain it like you're 12",
                "html": f"<ol class='lm-steps'>{li(steps)}</ol>", "rtl": rtl}

    if mode == "summary":
        return {"title": "📝 Summary",
                "html": f"<p class='lm-summary'>{summ}</p>"
                        f"<p class='lm-kw'>Key terms: <b>{', '.join(kws) or '—'}</b></p>",
                "rtl": rtl}

    if mode == "examples":
        prompts = [
            f"Think of a <b>real-life situation</b> where “{kws[0] if kws else 'this idea'}” shows up. Describe it in one sentence.",
            "Construct a <b>counter-example</b>: a case where this idea would NOT apply. What breaks?",
            f"Create a <b>numeric or concrete mini-example</b> using: {', '.join(kws[:3]) or 'the main concept'}.",
            "Explain how this idea would look in a <b>completely different field</b> (cooking, sports, music…).",
        ]
        return {"title": "💡 Example Generation", "html": f"<ul class='lm-steps'>{li(prompts)}</ul>", "rtl": rtl}

    if mode == "questions":
        qs = generate_questions_from_text(text, n=5)
        return {"title": "❓ Generated Questions",
                "html": f"<ol class='lm-steps'>{li(q['q'] for q in qs)}</ol>", "rtl": rtl}

    if mode == "problem":
        steps = [
            f"<b>Define:</b> What problem is this text trying to solve? (Hint: it centers on <b>{kws[0] if kws else '…'}</b>.)",
            "<b>Decompose:</b> Break it into 2–3 sub-problems and write them down.",
            "<b>Solve one:</b> Pick the smallest sub-problem and outline a solution using only what you've read.",
            "<b>Verify:</b> Re-read the passage — does the author's approach match yours? Where do you differ?",
        ]
        return {"title": "🧩 Problem-Solving Mode", "html": f"<ol class='lm-steps'>{li(steps)}</ol>", "rtl": rtl}

    return {"title": "Learning mode", "html": f"<p>{summ}</p>", "rtl": rtl}


# ----------------------------------------------------------------------------
# Question generation (Phase 5)
# ----------------------------------------------------------------------------

_REFLECTION_BANK = [
    "Pause: what is the single most important idea you've read in the last few minutes?",
    "If you had to tweet what you just read, what would it say?",
    "What surprised you in this section — and why?",
    "How does this connect to something you already knew?",
    "What question would you ask the author right now?",
    "Rate your understanding 1–5. If below 4, which part is fuzzy?",
]


def cloze_question(sentence: str) -> Optional[Dict[str, Any]]:
    ws = [w for w in _words(sentence) if len(w) > 3 and w not in _STOP_EN and w not in _STOP_FA]
    if not ws:
        return None
    target = max(ws, key=len)
    blanked = re.sub(re.escape(target), "_____", sentence, count=1, flags=re.IGNORECASE)
    if blanked == sentence:
        return None
    return {"q": f"Fill the blank: “{blanked}”", "answer": target, "type": "recall"}


def generate_questions_from_text(text: str, n: int = 3) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    sents = _sentences(text)
    random.shuffle(sents)
    for s in sents:
        if len(out) >= n:
            break
        if len(s) < 40 or len(s) > 260:
            continue
        c = cloze_question(s)
        if c:
            out.append(c)
    kws = keywords(text, 4)
    if kws and len(out) < n:
        out.append({"q": f"In your own words, what does “{kws[0]}” mean in this context?",
                    "answer": None, "type": "comprehension"})
    if len(out) < n:
        out.append({"q": random.choice(_REFLECTION_BANK), "answer": None, "type": "reflection"})
    return out[:n]


class QuestionFactory:
    """Builds questions per type, biased toward sections the user has read."""

    def __init__(self) -> None:
        self.doc: Optional[LoadedDocument] = None
        self.read_sections: List[str] = []

    def set_document(self, doc: LoadedDocument) -> None:
        self.doc = doc
        self.read_sections = []

    def mark_read(self, sid: str) -> None:
        if sid not in self.read_sections:
            self.read_sections.append(sid)

    def _section_text(self, prefer_read: bool = True) -> str:
        if not self.doc or not self.doc.sections:
            return ""
        paras = [s for s in self.doc.sections if s.level == 0 and len(s.text) > 80]
        if prefer_read and self.read_sections:
            read = [s for s in paras if s.sid in self.read_sections]
            if read:
                return random.choice(read[-12:]).text
        return random.choice(paras).text if paras else ""

    def make(self, qtype: str, context_text: str = "") -> Dict[str, Any]:
        if qtype == "reflection":
            return {"q": random.choice(_REFLECTION_BANK), "answer": None, "type": "reflection"}
        text = context_text or self._section_text()
        if not text:
            return {"q": random.choice(_REFLECTION_BANK), "answer": None, "type": "reflection"}
        if qtype == "recall":
            c = cloze_question(random.choice(_sentences(text) or [text]))
            if c:
                return c
        if qtype == "comprehension":
            kws = keywords(text, 3)
            if kws:
                return {"q": f"Explain the role of “{kws[0]}” in what you just read.",
                        "answer": None, "type": "comprehension"}
        if qtype == "contextual" and context_text:
            qs = generate_questions_from_text(context_text, 1)
            if qs:
                qs[0]["type"] = "contextual"
                return qs[0]
        qs = generate_questions_from_text(text, 1)
        return qs[0] if qs else {"q": random.choice(_REFLECTION_BANK), "answer": None, "type": "reflection"}


# ----------------------------------------------------------------------------
# "Ask AI" — local heuristic answering (no cloud)
# ----------------------------------------------------------------------------

def answer_about(text: str, question: str = "") -> Dict[str, Any]:
    rtl = is_rtl(text)
    summ = summarize(text, 3)
    kws = keywords(text, 6)
    html = (
        f"<p><b>Essence:</b> {summ}</p>"
        f"<p><b>Key concepts:</b> {', '.join(kws) or '—'}</p>"
        "<p class='lm-kw'>Local analysis engine (offline). Connect an LLM in "
        "<i>Logic Settings → AI</i> for deeper answers.</p>"
    )
    return {"title": "🤖 AI Analysis (local)", "html": html, "rtl": rtl}


# ----------------------------------------------------------------------------
# Mind map auto-generation (Phase 3.2)
# ----------------------------------------------------------------------------

def build_mindmap(doc: LoadedDocument) -> Dict[str, Any]:
    heads = [s for s in doc.sections if s.level > 0]
    # if the document has exactly one H1, use it as the root itself
    h1s = [s for s in heads if s.level == 1]
    root_sec = h1s[0] if len(h1s) == 1 else None
    root_label = (root_sec.text if root_sec else doc.title)[:48]
    nodes = [{"id": "root", "label": root_label,
              "sectionId": root_sec.sid if root_sec else None,
              "parent": None, "level": 0}]
    stack: List[tuple] = [("root", 0)]
    count = 0
    for s in doc.sections:
        if s.level == 0 or (root_sec is not None and s.sid == root_sec.sid):
            continue
        count += 1
        nid = f"n{count}"
        while stack and stack[-1][1] >= s.level:
            stack.pop()
        parent = stack[-1][0] if stack else "root"
        nodes.append({"id": nid, "label": s.text[:60], "sectionId": s.sid,
                      "parent": parent, "level": s.level})
        stack.append((nid, s.level))
        if count >= 60:
            break
    # no headings? derive topic nodes from keyword clusters of paragraph chunks
    if count == 0:
        paras = [s for s in doc.sections if s.level == 0]
        chunk = max(1, len(paras) // 6)
        for i in range(0, len(paras), chunk):
            grp = paras[i:i + chunk]
            kws = keywords(" ".join(p.text for p in grp), 2)
            label = " / ".join(kws) if kws else f"Part {i // chunk + 1}"
            nodes.append({"id": f"n{i}", "label": label[:60],
                          "sectionId": grp[0].sid, "parent": "root",
                          "level": 1})
    edges = [{"from": n["parent"], "to": n["id"]} for n in nodes if n["parent"]]
    return {"nodes": nodes, "edges": edges, "auto": True}


# ----------------------------------------------------------------------------
# Adaptive flow + progress intelligence (Phase 4.2 / 4.3)
# ----------------------------------------------------------------------------

class ProgressIntelligence:
    def __init__(self, expected_wpm: int = 200) -> None:
        self.expected_wpm = expected_wpm
        self.doc_words = 0
        self.session_start = time.time()
        self.engagement_events = 0   # highlights, notes, answered questions

    def set_document(self, doc: LoadedDocument) -> None:
        self.doc_words = len(_words(doc.plain_text)) or 1
        self.session_start = time.time()
        self.engagement_events = 0

    def engaged(self) -> None:
        self.engagement_events += 1

    def report(self, actual_percent: float, total_read_sec: float) -> Dict[str, Any]:
        elapsed_min = max(total_read_sec / 60.0, 0.05)
        expected_words = self.expected_wpm * elapsed_min
        expected_percent = min(100.0, 100.0 * expected_words / self.doc_words)
        gap = actual_percent - expected_percent
        # comprehension heuristic: engagement density vs. reading time
        density = self.engagement_events / max(elapsed_min, 1.0)
        comprehension = max(0.0, min(1.0, 0.35 + 0.18 * density - max(0, gap) * 0.004))
        if gap > 18:
            advice, action = ("You're moving much faster than expected — consider reviewing the earlier part.", "review")
        elif gap < -18:
            advice, action = ("You're behind the expected pace — that's fine if you're going deep. Otherwise, continue forward.", "continue")
        else:
            advice, action = (f"You're on track. You should be around the {int(expected_percent)}% mark — and you are.", "ok")
        return {
            "expectedPercent": round(expected_percent, 1),
            "actualPercent": round(actual_percent, 1),
            "comprehension": round(comprehension, 2),
            "advice": advice,
            "action": action,
        }


class AdaptiveFlow:
    """Suggests the next section over time, supports interleaving."""

    def __init__(self) -> None:
        self.doc: Optional[LoadedDocument] = None
        self.visited: List[str] = []
        self.interleave = True

    def set_document(self, doc: LoadedDocument, interleave: bool = True) -> None:
        self.doc = doc
        self.visited = []
        self.interleave = interleave

    def visit(self, sid: str) -> None:
        if sid and sid not in self.visited:
            self.visited.append(sid)

    def next_suggestion(self) -> Optional[Dict[str, str]]:
        if not self.doc:
            return None
        heads = [s for s in self.doc.sections if s.level > 0]
        if not heads:
            return None
        unread = [s for s in heads if s.sid not in self.visited]
        if not unread:
            # interleaved review: revisit a random old section
            old = random.choice(heads)
            return {"sectionId": old.sid, "label": old.text,
                    "reason": "Interleaved review — strengthen memory of an earlier topic."}
        if self.interleave and self.visited and random.random() < 0.25:
            old_ids = [v for v in self.visited]
            old = next((s for s in heads if s.sid == random.choice(old_ids)), None)
            if old:
                return {"sectionId": old.sid, "label": old.text,
                        "reason": "Interleaving: quick revisit before moving on."}
        nxt = unread[0]
        return {"sectionId": nxt.sid, "label": nxt.text,
                "reason": "Next unread topic in the learning flow."}
