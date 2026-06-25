# 🧠 Cognitive Reader — AI-Driven Cognitive Reading System

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![PySide6](https://img.shields.io/badge/PySide6-GUI-green)

A fully offline (Local-first) reading application (PDF, DOCX, TXT) built on cognitive science principles. This system transforms passive reading into a deep learning process through active learning engines, dynamic question generation, and a highly customizable logic rule engine.

> **More than a PDF Reader:** It is your personal operating system for studying. Read, think, question, remember, and structure your knowledge.

---

## 📸 Screenshots

<!-- 
  TIP: Replace the placeholder image URLs below with the actual paths to your screenshots.
  Using a mix of full-width and side-by-side images makes the README look professional.
-->

### Main Reading Interface & Smart Annotations
<div align="center">
  <img src="https://github.com/OrumTech/Cognitive-Reader-AI-Driven-Cognitive-Reading-System/blob/main/screenshots/shot_bubbles.png" alt="Main Reading View" width="100%">
</div>

### Active Learning & Knowledge Structuring
<div align="center">
  <img src="https://github.com/OrumTech/Cognitive-Reader-AI-Driven-Cognitive-Reading-System/blob/main/screenshots/shot_mindmap.png" alt="Mind Map" width="49%">
  <img src="https://github.com/OrumTech/Cognitive-Reader-AI-Driven-Cognitive-Reading-System/blob/main/screenshots/shot_rules.png" alt="Rule Engine" width="49%">
</div>

---

## 🌟 Key Features

### 1. Data-Driven Rule Engine
All application behaviors are programmable via `JSON` rules (no code changes required). You can define triggers for pop-ups or study questions:
* **Triggers:** Based on reading time, inactivity, scroll speed, reading progress percentage, or reaching saved Checkpoints.
* **Actions:** Display question bubbles, custom pop-ups, or suggest changes to your study approach.

### 2. Active Learning Tools
* **Feynman Technique & Summarization:** Built-in tools for the Feynman technique, summarizing, and problem-solving (fully offline).
* **Automated Question Generation:** Automatically generates Cloze (fill-in-the-blank) questions, reading comprehension checks, and reflective prompts from the active text.
* **Adaptive Progress Intelligence:** Tracks your Words Per Minute (WPM) against an ideal speed and estimates your comprehension level based on interaction.

### 3. Knowledge Structuring
* **Automated Mind Maps:** Automatically extracts headings and generates an interactive, zoomable, and pannable Mind Map (SVG).
* **Text Blocks:** Creates "knowledge playlists" by categorizing important text snippets for rapid review.
* **State Management:** Export and import your entire study state—including highlights, notes, rules, and mind maps—as a single JSON file.

### 4. Rich Annotations & Luxurious UI
* **Smart RTL/LTR Support:** Automatically detects Persian/Arabic and English paragraphs and aligns them perfectly side-by-side or block-by-block.
* **Dynamic Highlights:** Choose colors and apply visual effects like blinking, pulsing, or temporary highlights.
* **Sticky Notes:** Draggable notes with a realistic paper appearance.
* **Canvas Brush:** Draw freely and sketch directly over the text with full Undo/Redo support.
* **Fallback Mode:** If text extraction fails, the document seamlessly opens in a native raw viewer so your study session is never interrupted.

---

## 🛠 Prerequisites & Installation

This project utilizes Python as the logical core and `PySide6` alongside `QWebEngine` for the user interface.

**Requirements:**
* `PySide6>=6.6`
* `pypdf>=4.0`
* `python-docx>=1.1`

**Steps to run locally:**

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/cognitive-reader.git
cd cognitive-reader

# 2. Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate   # On Windows: .venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run the application
python main.py
```
*Tip: You can open the test file `sample_docs/learning_how_to_learn.txt` to see the simultaneous RTL and LTR text alignment in action.*

---

## ⚙️ Customizing Study Rules

From the ☰ menu in the top-left corner, navigate to **Logic Settings**. You can add new rules using the JSON format. 

**Example of a Study Rule:**
*Recall important concepts every 30 minutes:*
```json
{
  "id": "rule-recall-30m", 
  "enabled": true,
  "name": "Memory recall every 30 minutes",
  "trigger": { "type": "time_elapsed", "everySec": 1800 },
  "action":  { 
      "type": "question", 
      "questionType": "recall",
      "ui": "bubble", 
      "autoCloseSec": 14, 
      "required": false 
  }
}
```

---

## 🏗 Architecture

The project is developed local-first and does not require any external servers or internet connection.

* `main.py`: Application entry point.
* `main_window.py`: Qt window management, event routing, and timers.
* `bridge.py`: The communication bridge between Python and the UI (JS ⇄ Python) using `QWebChannel`.
* `rule_engine.py`: JSON rule processor for executing pop-ups and queries.
* `learning_engine.py`: Offline Natural Language Processing (NLP) engine for summarization and question generation.
* `document_loader.py`: Text extractor for PDF/DOCX and initial structure generator.
* `resources/`: Directory containing HTML/CSS/JS files that build the application's beautiful UI.

---

## ⌨️ Keyboard Shortcuts

* `Ctrl + Z` / `Ctrl + Y`: Undo / Redo for highlights, notes, and brush strokes.
* `Esc`: Exit brush mode or close pop-ups and overlays.
* **Double Click** on a highlight: Delete the highlight.
