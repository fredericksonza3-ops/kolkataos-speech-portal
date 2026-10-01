const $ = (id) => document.getElementById(id);
const api = "";
let session = null;
let recognition = null;
let listening = false;

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
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function attach() {
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

async function sendText(text) {
  if (!session) throw new Error("Connect a Roblox session first.");
  text = String(text || "").trim();
  if (!text) return;
  await jsonRequest(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/transcripts`, { method: "POST", headers: { "x-speech-session-token": session.browserToken }, body: JSON.stringify({ text }) });
  addLine(text);
}

function startRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("mic-status").textContent = "This browser has no speech recognition. Use the typed fallback below.";
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  recognition.onstart = () => { listening = true; $("mic-button").classList.add("active"); $("mic-label").textContent = "Listening… click to stop"; $("mic-status").textContent = "Listening for a line…"; };
  recognition.onresult = async (event) => {
    let finalText = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) if (event.results[i].isFinal) finalText += `${event.results[i][0].transcript} `;
    if (!finalText.trim()) return;
    try { await sendText(finalText); $("mic-status").textContent = "Line sent to Roblox. Keep speaking or click to stop."; } catch (error) { $("mic-status").textContent = error.message; }
  };
  recognition.onerror = (event) => { $("mic-status").textContent = `Microphone error: ${event.error}`; };
  recognition.onend = () => { if (listening) { try { recognition.start(); } catch {} } else { $("mic-button").classList.remove("active"); $("mic-label").textContent = "Start microphone"; } };
  recognition.start();
}

function stopRecognition() { listening = false; if (recognition) recognition.stop(); recognition = null; $("mic-button").classList.remove("active"); $("mic-label").textContent = "Start microphone"; $("mic-status").textContent = "Microphone is idle."; }
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
const queryCode = new URLSearchParams(location.search).get("code");
if (queryCode) { $("microphone-window").classList.remove("hidden"); $("pair-code").value = queryCode; }
