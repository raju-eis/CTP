// js/speechToText.js
// Shared speech-to-text mic button for textareas.
// Uses Web Speech API (Chrome/Edge). Hides if unsupported.

/**
 * Attach a mic button to a textarea element for voice-to-text input.
 * The textarea must already be in the DOM.
 * @param {HTMLTextAreaElement} textarea
 * @param {object} [opts]
 * @param {string} [opts.lang="en-IN"] - BCP-47 language code
 * @returns {{ btn: HTMLButtonElement, destroy: () => void } | null}
 */
export function attachMicButton(textarea, opts = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !textarea) return null;

  const lang = opts.lang || "en-IN";

  // Wrap textarea in a positioned container for the mic button
  let wrap = textarea.parentElement;
  if (!wrap || !wrap.classList.contains("summary-field-wrap")) {
    wrap = document.createElement("div");
    wrap.className = "summary-field-wrap";
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(textarea);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mic-btn";
  btn.title = "Click to speak";
  btn.setAttribute("aria-label", "Voice input");
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
  wrap.appendChild(btn);

  let listening = false;
  let recognition = null;
  let restartTimer = null;

  // For live transcription: track what was in the textarea before mic started
  let baseText = "";      // text before speech started
  let finalText = "";     // accumulated final results in this session

  function updateTextarea(interim) {
    const spacer = baseText && !baseText.endsWith(" ") && !baseText.endsWith("\n") ? " " : "";
    textarea.value = baseText + spacer + finalText + interim;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    // Auto-scroll textarea to bottom
    textarea.scrollTop = textarea.scrollHeight;
  }

  function createRecognition() {
    const rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;  // LIVE transcription — shows text as user speaks
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let interimTranscript = "";

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          // This chunk is finalized — add it permanently
          finalText += transcript;
        } else {
          // Still being spoken — show as preview (will be replaced)
          interimTranscript += transcript;
        }
      }

      // Update textarea with base + all finals + current interim
      updateTextarea(interimTranscript);
    };

    rec.onerror = (e) => {
      console.warn("[Mic] error:", e.error);
      if (e.error === "no-speech") return;
      if (e.error === "aborted") return;

      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        btn.title = "Microphone access denied";
        alert("Microphone access denied. Please allow microphone access in your browser settings and try again.");
      } else if (e.error === "audio-capture") {
        btn.title = "No microphone found";
        alert("No microphone found. Please connect a microphone and try again.");
      } else if (e.error === "network") {
        btn.title = "Network error";
        alert("Speech recognition requires an internet connection. Please check your connection and try again.");
      } else {
        btn.title = "Speech error: " + e.error;
        alert("Speech recognition error: " + e.error);
      }
      stopListening();
    };

    rec.onend = () => {
      if (listening) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (!listening) return;
          try {
            recognition = createRecognition();
            recognition.start();
          } catch (err) {
            console.error("[Mic] restart failed:", err);
            clearTimeout(restartTimer);
            restartTimer = setTimeout(() => {
              if (!listening) return;
              try {
                recognition = createRecognition();
                recognition.start();
              } catch (err2) {
                console.error("[Mic] second restart failed:", err2);
                stopListening();
              }
            }, 1000);
          }
        }, 250);
      }
    };

    return rec;
  }

  function stopListening() {
    listening = false;
    clearTimeout(restartTimer);
    btn.classList.remove("listening");
    btn.title = "Click to speak";
    if (recognition) {
      try { recognition.abort(); } catch {}
      recognition = null;
    }
    // Reset tracking — next session starts fresh
    baseText = "";
    finalText = "";
  }

  function startListening() {
    if (listening) {
      stopListening();
      return;
    }

    // Capture current textarea content as the base
    baseText = textarea.value;
    finalText = "";

    try {
      recognition = createRecognition();
      recognition.start();
      listening = true;
      btn.classList.add("listening");
      btn.title = "Listening… click to stop";
    } catch (err) {
      console.error("[Mic] start failed:", err);
      alert("Could not start speech recognition. Make sure you're using Chrome/Edge with a microphone connected.");
      stopListening();
    }
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startListening();
  });

  function destroy() {
    stopListening();
    btn.remove();
  }

  return { btn, destroy };
}

/**
 * Check if speech-to-text is available in this browser.
 */
export function isSpeechAvailable() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  return !!SR;
}
