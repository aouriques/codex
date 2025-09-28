# Auto Scroller Chrome Extension

This repository contains a Chrome extension that lets you open any URL, automatically scroll through the page at a custom speed, and capture a recording of the session.

## Usage

1. Load the extension in Chrome by visiting `chrome://extensions`, enabling **Developer mode**, and choosing **Load unpacked**.
2. Select this project folder.
3. Open the popup, provide the target page URL and scroll speed (in pixels per second), and start the auto-scroll.
4. Keep the popup open until you see the status message that the recording is ready. A link to the `.webm` file appears when scrolling finishes.

The extension loads the provided URL in the currently active tab, records the tab, and scrolls until the bottom of the page is reached. When scrolling finishes, use the link in the popup to open or download the WebM video.
