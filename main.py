#!/usr/bin/env python3
"""
Cognitive Reader — AI-Driven Cognitive Reading & Learning System
Local-first. PySide6 + QWebEngine.

Entry point.
"""
import os
import sys

os.environ.setdefault(
    "QTWEBENGINE_CHROMIUM_FLAGS",
    "--enable-smooth-scrolling --autoplay-policy=no-user-gesture-required",
)

from PySide6.QtWidgets import QApplication
from app.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Cognitive Reader")
    app.setOrganizationName("CognitiveReader")

    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
