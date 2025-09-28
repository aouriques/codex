const form = document.getElementById('scrollForm');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const downloadLinkEl = document.getElementById('downloadLink');
const resultFilenameEl = document.getElementById('resultFilename');

const recorderState = {
  mediaRecorder: null,
  chunks: [],
  stream: null,
  stopPromise: null,
  resolveStop: null
};

let lastRecording = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#f87171' : '#a5b4fc';
}

function clearRecordingResult() {
  if (lastRecording?.url) {
    URL.revokeObjectURL(lastRecording.url);
  }

  lastRecording = null;

  if (resultEl) {
    resultEl.classList.add('hidden');
  }

  if (downloadLinkEl) {
    downloadLinkEl.removeAttribute('href');
    downloadLinkEl.removeAttribute('download');
  }

  if (resultFilenameEl) {
    resultFilenameEl.textContent = '';
  }
}

function showRecordingResult(file) {
  if (!file || !downloadLinkEl || !resultEl) {
    return;
  }

  if (lastRecording?.url) {
    URL.revokeObjectURL(lastRecording.url);
  }

  lastRecording = file;
  downloadLinkEl.href = file.url;
  downloadLinkEl.download = file.filename;

  if (resultFilenameEl) {
    resultFilenameEl.textContent = file.filename;
  }

  resultEl.classList.remove('hidden');
}

async function loadUrlInCurrentTab(url) {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!currentTab) {
    throw new Error('No active tab found to load the requested URL.');
  }

  return chrome.tabs.update(currentTab.id, { url, active: true });
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let finished = false;

    const cleanup = () => {
      if (finished) {
        return;
      }

      finished = true;
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      chrome.tabs.onRemoved.removeListener(handleRemoved);
      clearTimeout(timeoutId);
    };

    const handleUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    const handleRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        cleanup();
        reject(new Error('The tab was closed before the page finished loading.'));
      }
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the page to finish loading.'));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(handleUpdated);
    chrome.tabs.onRemoved.addListener(handleRemoved);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        cleanup();
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!tab) {
        cleanup();
        reject(new Error('Unable to locate the requested tab.'));
        return;
      }

      if (tab.status === 'complete') {
        cleanup();
        resolve();
      }
    });
  });
}

function resetRecorderState() {
  if (recorderState.stream) {
    recorderState.stream.getTracks().forEach((track) => track.stop());
  }

  recorderState.mediaRecorder = null;
  recorderState.chunks = [];
  recorderState.stream = null;
  recorderState.stopPromise = null;
  recorderState.resolveStop = null;
}

function finalizeRecording() {
  if (!recorderState.chunks.length) {
    return null;
  }

  const blob = new Blob(recorderState.chunks, { type: 'video/webm' });
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
  const filename = `auto-scroll-${timestamp}.webm`;
  const url = URL.createObjectURL(blob);

  return { url, filename };
}

function startRecording() {
  if (recorderState.mediaRecorder) {
    return recorderState.stopPromise || Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: false, video: true }, (stream) => {
      if (chrome.runtime.lastError || !stream) {
        reject(
          new Error(chrome.runtime.lastError?.message || 'Unable to capture the current tab.')
        );
        return;
      }

      recorderState.stream = stream;
      recorderState.chunks = [];

      try {
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType: 'video/webm;codecs=vp9'
        });

        const stopPromise = new Promise((resolveStop) => {
          recorderState.resolveStop = resolveStop;
        });

        recorderState.stopPromise = stopPromise;

        const handleStop = () => {
          mediaRecorder.removeEventListener('stop', handleStop);
          mediaRecorder.removeEventListener('error', handleError);

          const resolveStop = recorderState.resolveStop;
          const file = finalizeRecording();
          resetRecorderState();
          resolveStop?.(file);
        };

        const handleError = (event) => {
          console.error('MediaRecorder error:', event.error);
          handleStop();
        };

        mediaRecorder.addEventListener('dataavailable', (event) => {
          if (event.data && event.data.size > 0) {
            recorderState.chunks.push(event.data);
          }
        });

        mediaRecorder.addEventListener('stop', handleStop);
        mediaRecorder.addEventListener('error', handleError);

        recorderState.mediaRecorder = mediaRecorder;
        mediaRecorder.start(1000);
        resolve();
      } catch (error) {
        console.error('Failed to start recorder:', error);
        stream.getTracks().forEach((track) => track.stop());
        resetRecorderState();
        reject(error);
      }
    });
  });
}

function stopRecording() {
  const stopPromise = recorderState.stopPromise || Promise.resolve(null);
  const { mediaRecorder } = recorderState;

  if (!mediaRecorder) {
    return stopPromise;
  }

  if (mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch (error) {
      console.error('Failed to stop recorder cleanly:', error);
    }
  }

  return stopPromise;
}

async function startAutoScroll(tabId, speed) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (pixelsPerSecond) => {
      const state = (window.__autoScrollState = window.__autoScrollState || {});

      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
      }

      if (state.resolve) {
        state.resolve();
      }

      state.lastTimestamp = null;

      return new Promise((resolve) => {
        state.resolve = resolve;

        const scrollStep = (timestamp) => {
          if (!state.lastTimestamp) {
            state.lastTimestamp = timestamp;
          }

          const elapsed = timestamp - state.lastTimestamp;
          const distance = (pixelsPerSecond * elapsed) / 1000;

          const scrollingElement =
            document.scrollingElement || document.documentElement || document.body;

          const maxScroll = Math.max(
            0,
            (scrollingElement?.scrollHeight || 0) - window.innerHeight
          );
          const currentScroll = scrollingElement?.scrollTop ?? window.scrollY;
          const nextScroll = Math.min(currentScroll + distance, maxScroll);

          if (scrollingElement) {
            scrollingElement.scrollTop = nextScroll;
          } else {
            window.scrollTo({ top: nextScroll, behavior: 'auto' });
          }

          state.lastTimestamp = timestamp;

          if (nextScroll >= maxScroll) {
            state.rafId = null;
            state.lastTimestamp = null;
            state.resolve = null;
            resolve();
            return;
          }

          state.rafId = requestAnimationFrame(scrollStep);
        };

        state.rafId = requestAnimationFrame(scrollStep);
      });
    },
    args: [speed]
  });

  return result?.result;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const url = formData.get('url');
  const speed = Number(formData.get('speed'));

  if (!url || Number.isNaN(speed) || speed <= 0) {
    setStatus('Please provide a valid URL and scroll speed.', true);
    return;
  }

  clearRecordingResult();
  setStatus('Loading page and preparing scroll…');

  try {
    const tab = await loadUrlInCurrentTab(url);

    await waitForTabComplete(tab.id).catch((error) => {
      console.warn('Falling back to a short delay while waiting for the tab:', error);
      return new Promise((resolve) => setTimeout(resolve, 1000));
    });

    await startRecording();
    setStatus('Auto-scroll and recording in progress. Keep this popup open.');
    await startAutoScroll(tab.id, speed);
    const file = await stopRecording();

    if (file) {
      showRecordingResult(file);
      setStatus('Auto-scroll complete. Use the link below to open the recording.');
    } else {
      setStatus('Auto-scroll complete, but no recording was captured.', true);
    }
  } catch (error) {
    console.error(error);
    setStatus('Failed to start auto-scroll. Check console for details.', true);
    await stopRecording();
  }
});
