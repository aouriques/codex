const form = document.getElementById('scrollForm');
const statusEl = document.getElementById('status');

const recorderState = {
  mediaRecorder: null,
  chunks: [],
  stream: null,
  stopPromise: null,
  resolveStop: null,
  stopHandler: null
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#f87171' : '#a5b4fc';
}

async function createOrUpdateTab(url) {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (currentTab && currentTab.url === 'chrome://newtab/') {
    return chrome.tabs.update(currentTab.id, { url });
  }

  return chrome.tabs.create({ url, active: true });
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
  recorderState.stopHandler = null;
}

function downloadRecording() {
  if (!recorderState.chunks.length) {
    return Promise.resolve();
  }

  const blob = new Blob(recorderState.chunks, { type: 'video/webm' });

  const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
  const filename = `auto-scroll-${timestamp}.webm`;
  const url = URL.createObjectURL(blob);

  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to start download:', chrome.runtime.lastError.message);
      }

      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      resolve();
    });
  });
}

function startRecording() {
  if (recorderState.mediaRecorder) {
    return recorderState.stopPromise || Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: false, video: true }, (stream) => {
      if (chrome.runtime.lastError || !stream) {
        reject(
          new Error(
            chrome.runtime.lastError?.message || 'Unable to capture the current tab.'
          )
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

        let handled = false;

        const handleStop = async () => {
          if (handled) {
            return;
          }

          handled = true;
          mediaRecorder.removeEventListener('stop', handleStop);
          mediaRecorder.removeEventListener('error', handleError);

          const resolveStop = recorderState.resolveStop;
          await downloadRecording();
          resetRecorderState();
          resolveStop?.();
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
        recorderState.stopHandler = handleStop;
        mediaRecorder.start(1000);
        resolve();
      } catch (error) {
        console.error('Failed to start recorder:', error);
        stream.getTracks().forEach((track) => track.stop());
        reject(error);
      }
    });
  });
}

function stopRecording() {
  if (!recorderState.mediaRecorder) {
    return Promise.resolve();
  }

  const { mediaRecorder, stopPromise } = recorderState;

  if (mediaRecorder.state === 'inactive') {
    recorderState.stopHandler?.();
    return stopPromise || Promise.resolve();
  }

  try {
    mediaRecorder.stop();
  } catch (error) {
    console.error('Failed to stop recorder cleanly:', error);
    recorderState.stopHandler?.();
  }

  return stopPromise || Promise.resolve();
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

          const maxScroll =
            document.documentElement.scrollHeight - window.innerHeight;
          const currentScroll = window.scrollY;
          const nextScroll = Math.min(currentScroll + distance, maxScroll);

          window.scrollTo({ top: nextScroll, behavior: 'auto' });
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

  setStatus('Opening tab and preparing scroll…');

  try {
    const tab = await createOrUpdateTab(url);

    await new Promise((resolve) => setTimeout(resolve, 750));

    await startRecording();
    setStatus('Auto-scroll and recording started. Keep this popup open until the download begins.');
    await startAutoScroll(tab.id, speed);
    await stopRecording();
    setStatus('Auto-scroll complete. A video download should have started.');
  } catch (error) {
    console.error(error);
    setStatus('Failed to start auto-scroll. Check console for details.', true);
    await stopRecording();
  }
});
