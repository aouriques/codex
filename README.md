# Auto Scroller Chrome Extension

This repository contains a Chrome extension that lets you open any URL, automatically scroll through the page at a custom speed, and capture a recording of the session.

## Usage

1. Load the extension in Chrome by visiting `chrome://extensions`, enabling **Developer mode**, and choosing **Load unpacked**.
2. Select this project folder.
3. Open the popup, provide the target page URL and scroll speed (in pixels per second), and start the auto-scroll.
4. Keep the popup open until you see a status message that the recording is complete and a `.webm` download begins.

The extension opens the provided URL in the current window (reusing a blank new-tab page when possible), records the active tab, and scrolls until the bottom of the page is reached. When scrolling finishes, a WebM video file is downloaded automatically.
