const $ = (id) => document.getElementById(id);
const api = "";
let session = null;
let recognition = null;
let listening = false;
let restartTimer = null;
let recognitionStarting = false;
let sendQueue = Promise.resolve();
let lastSentText = "";
let lastSentAt = 0;
let liveStreamId = null;
let lastPartialText = "";
let lastPartialSentAt = 0;

function setConnection(online, label = online ? "CONNECTED" : "OFFLINE") {
  $("connection-label").textContent = label;
  document.querySelector(".status-light").style.background = online ? "#66d48a" : "#9b5d58";
}

function setStatus(message, error = false) {
  const node = $("pair-status");
  node.textContent = message;
  node.style.color = error ? "#f0937c" : "";
}

function addLine(text) {
  const box = $("transcript-box");
  const empty = box.querySelector(".placeholder");
  if (empty) empty.remove();
  const line = document.createElement("p");
  line.className = "transcript-line";
  const stamp = document.createElement("span");
  stamp.className = "transcript-time";
  stamp.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  line.append(stamp, document.createTextNode(text));
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(api + url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

async function attach() {
  if ($("pair-button").disabled) return;
  const code = $("pair-code").value.trim().toUpperCase();
  if (code.length !== 6) return setStatus("Enter the six-character code from Roblox.", true);
  $("pair-button").disabled = true;
  setStatus("Connecting to the desk…");
  try {
    session = await jsonRequest("/api/v1/browser/attach", { method: "POST", body: JSON.stringify({ code }) });
    $("pair-card").classList.add("hidden");
    $("device-card").classList.remove("hidden");
    $("player-name").textContent = session.player.displayName || session.player.username;
    $("session-code").textContent = `CODE ${session.code}`;
    updateExpiry();
    setConnection(true);
    $("mic-status").textContent = "Session connected. Microphone is idle.";
    const queryCode = new URLSearchParams(location.search).get("code");
    if (queryCode) history.replaceState({}, "", "/");
  } catch (error) {
    setStatus(error.message, true);
  } finally { $("pair-button").disabled = false; }
}

function updateExpiry() {
  if (!session) return;
  const remaining = Math.max(0, session.expiresAt - Date.now());
  $("session-expires").textContent = `EXPIRES ${Math.ceil(remaining / 60000)}M`;
  if (remaining <= 0) disconnect("Session expired.");
}

function newStreamId() {
  return window.crypto?.randomUUID?.() || `speech-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function sendTranscript(text, { partial = false, streamId = null, targetSession = session } = {}) {
  // A queued result belongs to the session captured when recognition emitted it.
  // Never send it into a newly paired window/session after a disconnect.
  if (!targetSession || targetSession !== session) return;
  text = String(text || "").trim();
  if (!text) return;
  try {
    await jsonRequest(`/api/v1/sessions/${encodeURIComponent(targetSession.sessionId)}/transcripts`, {
      method: "POST",
      headers: { "x-speech-session-token": targetSession.browserToken },
      body: JSON.stringify({ text, partial, streamId }),
    });
  } catch (error) {
    if (targetSession === session && (error.status === 401 || error.code === "storage_not_configured")) {
      disconnect(error.message);
      setStatus(error.message, true);
    }
    throw error;
  }
  if (!partial && targetSession === session) addLine(text);
}

async function sendText(text) {
  return sendTranscript(text);
}

function micStatus(message, error = false) {
  const node = $("mic-status");
  node.textContent = message;
  node.style.color = error ? "#9c1c1c" : "";
}

function queueSpeech(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return;
  // Chrome can repeat the last final result when it restarts recognition.
  if (normalized === lastSentText && Date.now() - lastSentAt < 1500) return;
  lastSentText = normalized;
  lastSentAt = Date.now();
  const streamId = liveStreamId;
  const targetSession = session;
  sendQueue = sendQueue.then(async () => {
    await sendTranscript(normalized, { streamId, targetSession });
    if (listening) micStatus("Line sent to Roblox. Keep speaking or click to stop.");
  }).catch((error) => micStatus(error.message, true));
}

function queuePartial(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized || !session || !liveStreamId) return;
  const now = Date.now();
  if (normalized === lastPartialText || now - lastPartialSentAt < 320) return;
  lastPartialText = normalized;
  lastPartialSentAt = now;
  const streamId = liveStreamId;
  const targetSession = session;
  sendQueue = sendQueue.then(() => sendTranscript(normalized, { partial: true, streamId, targetSession })).catch((error) => micStatus(error.message, true));
}

function scheduleRecognitionRestart(delay = 180) {
  if (!listening || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!listening || !recognition || recognitionStarting) return;
    try {
      recognitionStarting = true;
      recognition.start();
    } catch (error) {
      recognitionStarting = false;
      if (error.name !== "InvalidStateError") micStatus("Could not restart the microphone. Try clicking Stop, then Start again.", true);
      scheduleRecognitionRestart(500);
    }
  }, delay);
}

function startRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micStatus("This browser has no speech recognition. Use Chrome or Edge, or use the typed fallback below.", true);
    return;
  }
  if (listening) return;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  lastSentText = "";
  lastPartialText = "";
  lastPartialSentAt = 0;
  liveStreamId = newStreamId();
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = navigator.language || "en-US";
  listening = true;
  recognition.onstart = () => {
    recognitionStarting = false;
    $("mic-button").classList.add("active");
    $("mic-label").textContent = "Listening... click to stop";
    micStatus("Listening for a line...");
  };
  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0]?.transcript || "";
      if (event.results[i].isFinal) finalText += `${transcript} `;
      else interimText += transcript;
    }
    if (finalText.trim()) {
      queueSpeech(finalText);
      liveStreamId = newStreamId();
      lastPartialText = "";
      lastPartialSentAt = 0;
    }
    if (interimText.trim()) {
      micStatus(`Hearing: ${interimText.trim()}`);
      queuePartial(interimText);
    }
  };
  recognition.onerror = (event) => {
    recognitionStarting = false;
    const errors = {
      "not-allowed": "Microphone permission was blocked. Allow microphone access for this site, then try again.",
      "service-not-allowed": "This browser blocked its speech service. Try Chrome or Edge.",
      "audio-capture": "No microphone was found. Check your microphone and browser permissions.",
      network: "Speech service connection dropped. Reconnecting...",
      "no-speech": "No speech detected yet. Still listening...",
    };
    const message = errors[event.error] || `Microphone error: ${event.error}`;
    micStatus(message, ["not-allowed", "audio-capture"].includes(event.error));
    if (["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"].includes(event.error)) listening = false;
  };
  recognition.onend = () => {
    recognitionStarting = false;
    if (listening) scheduleRecognitionRestart();
    else {
      $("mic-button").classList.remove("active");
      $("mic-label").textContent = "Start microphone";
    }
  };
  try {
    recognitionStarting = true;
    recognition.start();
  } catch (error) {
    recognitionStarting = false;
    listening = false;
    micStatus("Could not start the microphone. Check the browser permission and try again.", true);
  }
}

function stopRecognition() {
  listening = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const activeRecognition = recognition;
  recognition = null;
  recognitionStarting = false;
  liveStreamId = null;
  lastPartialText = "";
  if (activeRecognition) { try { activeRecognition.stop(); } catch {} }
  $("mic-button").classList.remove("active");
  $("mic-label").textContent = "Start microphone";
  micStatus("Microphone is idle.");
}

function disconnect(message = "Disconnected.") { stopRecognition(); session = null; $("device-card").classList.add("hidden"); $("pair-card").classList.remove("hidden"); setStatus(message); setConnection(false); }

$("microphone-icon").addEventListener("click", () => $("microphone-window").classList.remove("hidden"));
$("close-window").addEventListener("click", () => $("microphone-window").classList.add("hidden"));
$("pair-button").addEventListener("click", attach);
$("pair-code").addEventListener("keydown", (event) => { if (event.key === "Enter") attach(); });
$("disconnect-button").addEventListener("click", () => disconnect());
$("mic-button").addEventListener("click", () => listening ? stopRecognition() : startRecognition());
$("typed-send").addEventListener("click", async () => { try { const input = $("typed-text"); await sendText(input.value); input.value = ""; $("mic-status").textContent = "Typed line sent to Roblox."; } catch (error) { $("mic-status").textContent = error.message; } });
$("send-test").addEventListener("click", () => $("typed-text").focus());
setInterval(updateExpiry, 30_000);
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }, 1000);
setConnection(false);
jsonRequest("/api/v1/health").catch((error) => {
  if (!session) setStatus(error.code === "storage_not_configured" ? error.message : "The portal is not ready. Check Redis configuration in Vercel and redeploy.", true);
});
const queryCode = new URLSearchParams(location.search).get("code");
if (queryCode) { $("microphone-window").classList.remove("hidden"); $("pair-code").value = queryCode; }
