const $ = (id) => document.getElementById(id);
const BANK_KEYS = {
  china: "ielts-part1-bank-china-v2",
  canada: "ielts-part1-bank-canada-v2"
};
const REGION_KEY = "ielts-part1-region";
const HISTORY_KEY = "ielts-part1-history-v2";
const IDENTITY_KEY = "ielts-part1-identity";
const RECENT_TOPICS_KEY = "ielts-part1-recent-topics";
const RECORDING_KEY = "ielts-part1-recording-enabled";
const TRANSITIONS = {
  topic: [
    "Thank you. Now, let's move on to a new topic.",
    "All right. Let's talk about something different now.",
    "Okay. Let's move on to the next topic.",
    "Thank you. I'd now like to ask you about another topic.",
    "That's fine. Now, let's change the subject.",
    "All right. Now, we're going to talk about a different topic."
  ]
};

function slug(text) {
  return String(text || "topic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic";
}

function normaliseBank(source) {
  const data = source && Array.isArray(source.topics) ? source : window.DEFAULT_PART1_BANK;
  return {
    version: 2,
    name: data.name || data.season || "Part 1 题库",
    updatedAt: data.updatedAt || new Date().toISOString(),
    topics: data.topics.map((topic, topicIndex) => {
      const title = String(topic.title || topic.topic || `Topic ${topicIndex + 1}`).trim();
      const topicId = topic.id || slug(title);
      const guessedOpening = /work|stud|hometown|home town/i.test(title);
      return {
        id: topicId,
        title,
        type: topic.type === "opening" || topic.type === "seasonal" ? topic.type : (guessedOpening ? "opening" : "seasonal"),
        identity: ["work", "study", "all"].includes(topic.identity) ? topic.identity : "all",
        questions: (topic.questions || []).map((question, questionIndex) => {
          const item = typeof question === "string" ? { text: question } : question;
          return {
            id: item.id || `${topicId}-${questionIndex + 1}`,
            text: String(item.text || item.question || "").trim(),
            order: Number(item.order) || questionIndex + 1,
            active: item.active !== false
          };
        }).filter((question) => question.text && question.active !== false).sort((a, b) => a.order - b.order)
      };
    }).filter((topic) => topic.questions.length)
  };
}

function loadBank(region) {
  try {
    const raw = localStorage.getItem(BANK_KEYS[region]);
    return normaliseBank(raw ? JSON.parse(raw) : window.REGIONAL_PART1_BANKS?.[region] || window.DEFAULT_PART1_BANK);
  } catch {
    return normaliseBank(window.REGIONAL_PART1_BANKS?.[region] || window.DEFAULT_PART1_BANK);
  }
}

function markedKey(region) { return `ielts-part1-marked-${region}`; }
function recentTopicsKey(region) { return `${RECENT_TOPICS_KEY}-${region}`; }

const initialRegion = ["china", "canada"].includes(localStorage.getItem(REGION_KEY)) ? localStorage.getItem(REGION_KEY) : "canada";
let bank = loadBank(initialRegion);
let marked = new Set(JSON.parse(localStorage.getItem(markedKey(initialRegion)) || "[]"));
const state = {
  region: initialRegion,
  identity: localStorage.getItem(IDENTITY_KEY) || "study",
  mode: null,
  segments: [],
  segmentIndex: 0,
  questionIndex: 0,
  phase: "idle",
  answerSeconds: 0,
  answerTimer: null,
  startedAt: 0,
  asked: [],
  currentSource: null,
  speechToken: 0,
  audioContext: null,
  recordDestination: null,
  mediaStream: null,
  mediaRecorder: null,
  recordingChunks: [],
  recordingBlob: null,
  recordingMime: "",
  recordingEnabled: localStorage.getItem(RECORDING_KEY) === "true",
  audioCache: new Map(),
  lastTransitionText: "",
  specialtyTab: "all",
  specialtySelection: new Set(),
  localVoiceAvailable: false,
  pendingMode: null,
  finishing: false
};

function shuffled(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function weightedPick(items, weightFor) {
  if (!items.length) return null;
  const weights = items.map((item) => Math.max(.01, weightFor(item)));
  let cursor = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < items.length; index++) {
    cursor -= weights[index];
    if (cursor <= 0) return items[index];
  }
  return items.at(-1);
}

function weightedSample(items, count, weightFor) {
  const pool = [...items];
  const result = [];
  while (pool.length && result.length < count) {
    const chosen = weightedPick(pool, weightFor);
    result.push(chosen);
    pool.splice(pool.indexOf(chosen), 1);
  }
  return result;
}

function eligibleTopics(type) {
  return bank.topics.filter((topic) => topic.type === type && (topic.identity === "all" || topic.identity === state.identity));
}

function topicWeight(topic) {
  const markedCount = topic.questions.filter((question) => marked.has(question.id)).length;
  const recent = JSON.parse(localStorage.getItem(recentTopicsKey(state.region)) || "[]");
  return 1 + markedCount * 1.5 + (recent.includes(topic.id) ? -.55 : 0);
}

function questionWeight(question) {
  return marked.has(question.id) ? 4 : 1;
}

function examQuestions(topic) {
  const fixed = topic.questions.slice(0, 2);
  const random = weightedSample(topic.questions.slice(2), 2, questionWeight);
  return [...fixed, ...random];
}

function buildSimulation() {
  const openingPool = eligibleTopics("opening");
  const seasonalPool = eligibleTopics("seasonal");
  const opening = weightedPick(openingPool, topicWeight);
  const seasonal = weightedSample(seasonalPool, 2, topicWeight);
  const topics = [opening, ...seasonal].filter(Boolean);
  if (!topics.length) throw new Error("当前身份下没有可用主题，请先在题库后台添加。 ");
  return topics.map((topic) => ({ topic, questions: examQuestions(topic) }));
}

function buildContinuous() {
  const topics = weightedSample(
    bank.topics.filter((topic) => topic.identity === "all" || topic.identity === state.identity),
    bank.topics.length,
    topicWeight
  );
  const firstPass = [];
  const secondPass = [];
  topics.forEach((topic) => {
    const ordered = [...topic.questions.slice(0, 2), ...weightedSample(topic.questions.slice(2), topic.questions.length, questionWeight)];
    firstPass.push({ topic, questions: ordered.slice(0, 4) });
    if (ordered.length > 4) secondPass.push({ topic, questions: ordered.slice(4) });
  });
  return [...firstPass, ...shuffled(secondPass)].filter((segment) => segment.questions.length);
}

function markedTopicEntries() {
  return bank.topics.map((topic) => ({
    topic,
    questions: shuffled(topic.questions.filter((question) => marked.has(question.id)))
  })).filter((segment) => segment.questions.length);
}

function buildMarkedPractice(topicIds = []) {
  const topics = markedTopicEntries();
  if (topicIds.length) return topics.filter((segment) => topicIds.includes(segment.topic.id));
  return shuffled(topics);
}

function allEligibleTopics() {
  return bank.topics;
}

function buildTopicPractice(topicIds) {
  return allEligibleTopics()
    .filter((topic) => topicIds.includes(topic.id))
    .map((topic) => ({ topic, questions: examQuestions(topic) }));
}

function formatTime(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function currentSegment() { return state.segments[state.segmentIndex]; }
function currentQuestion() { return currentSegment()?.questions[state.questionIndex]; }

function updateIdentityUI() {
  document.querySelectorAll("[data-identity]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.identity === state.identity));
  });
}

function updateRegionUI() {
  document.querySelectorAll("[data-region]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.region === state.region));
  });
}

function switchRegion(region) {
  if (region === state.region || state.phase !== "idle") return;
  state.region = region;
  localStorage.setItem(REGION_KEY, region);
  bank = loadBank(region);
  marked = new Set(JSON.parse(localStorage.getItem(markedKey(region)) || "[]"));
  state.specialtySelection.clear();
  updateRegionUI();
  updateMarkedCount();
  resetWelcome();
}

function updateRecordingSettingUI() {
  $("recordingSetting").checked = state.recordingEnabled;
}

function updateMarkedCount() {
  const markedTopics = markedTopicEntries().length;
  $("markedCount").textContent = markedTopics ? `自选主题 · ${markedTopics} 个标记主题` : "自选主题或复习标记题";
}

function topicPickerItem(topic, countText) {
    const label = document.createElement("label");
    label.className = "marked-topic-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = topic.id;
    checkbox.checked = state.specialtySelection.has(topic.id);
    checkbox.setAttribute("aria-label", `选择 ${topic.title}`);
    const copy = document.createElement("span");
    copy.className = "marked-topic-copy";
    const title = document.createElement("strong");
    title.textContent = topic.title;
    const count = document.createElement("small");
    count.textContent = countText;
    copy.append(title, count);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.specialtySelection.add(topic.id);
      else state.specialtySelection.delete(topic.id);
      updateSpecialtyActions();
    });
    label.append(checkbox, copy);
    return label;
}

function renderSpecialtyPicker() {
  const isMarked = state.specialtyTab === "marked";
  const markedEntries = markedTopicEntries();
  $("markedTopicCount").textContent = markedEntries.length;
  document.querySelectorAll("[data-specialty-tab]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.specialtyTab === state.specialtyTab));
  });
  $("topicSearchWrap").classList.toggle("is-hidden", isMarked);
  $("specialtyAllActions").classList.toggle("is-hidden", isMarked);
  $("specialtyMarkedActions").classList.toggle("is-hidden", !isMarked);

  const query = isMarked ? "" : $("topicSearch").value.trim().toLowerCase();
  const entries = (isMarked
    ? markedEntries.map((segment) => ({ topic: segment.topic, countText: `${segment.questions.length} 道已标记题` }))
    : allEligibleTopics().map((topic) => ({ topic, countText: `${topic.questions.length} 道题` })))
    .filter((entry) => !query || entry.topic.title.toLowerCase().includes(query));

  const content = [];
  for (const type of ["opening", "seasonal"]) {
    const group = entries.filter((entry) => entry.topic.type === type);
    if (!group.length) continue;
    const heading = document.createElement("p");
    heading.className = "topic-section-title";
    heading.textContent = type === "opening" ? "常规开场" : "当季抽查";
    content.push(heading, ...group.map((entry) => topicPickerItem(entry.topic, entry.countText)));
  }
  if (!content.length) {
    const empty = document.createElement("p");
    empty.className = "specialty-empty";
    empty.textContent = isMarked ? "还没有标记过题目" : "没有找到匹配的主题";
    content.push(empty);
  }
  $("specialtyTopicList").replaceChildren(...content);
  updateSpecialtyActions();
}

function updateSpecialtyActions() {
  const hasSelection = state.specialtySelection.size > 0;
  $("removeMarkedTopicsButton").disabled = !hasSelection;
  $("startSelectedMarkedButton").disabled = !hasSelection;
  $("startSelectedTopicsButton").disabled = !hasSelection;
  $("randomMarkedButton").disabled = !markedTopicEntries().length;
  $("randomTopicButton").disabled = !allEligibleTopics().length;
}

function openSpecialtyPicker() {
  state.specialtyTab = "all";
  state.specialtySelection.clear();
  $("topicSearch").value = "";
  renderSpecialtyPicker();
  $("specialtyDialog").showModal();
}

function removeSelectedMarkedTopics() {
  if (!state.specialtySelection.size) return;
  bank.topics.filter((topic) => state.specialtySelection.has(topic.id)).forEach((topic) => {
    topic.questions.forEach((question) => marked.delete(question.id));
  });
  localStorage.setItem(markedKey(state.region), JSON.stringify([...marked]));
  state.specialtySelection.clear();
  updateMarkedCount();
  renderSpecialtyPicker();
}

function updateMarkButton() {
  const question = currentQuestion();
  const isMarked = Boolean(question && marked.has(question.id));
  $("markButton").disabled = !question;
  $("markButton").setAttribute("aria-pressed", String(isMarked));
  $("markButton").querySelector("span").textContent = isMarked ? "已标记" : "标记此题";
}

function setPhase(phase, label) {
  state.phase = phase;
  $("phaseText").textContent = label;
  $("voiceState").classList.toggle("is-speaking", phase === "speaking" || phase === "loading");
  $("nextButton").disabled = phase !== "answering";
  $("repeatButton").disabled = phase === "loading";
}

function renderCurrentQuestion() {
  const segment = currentSegment();
  const question = currentQuestion();
  if (!segment || !question) return;
  $("topicProgress").textContent = `TOPIC ${state.segmentIndex + 1} · ${segment.topic.title}`;
  $("questionProgress").textContent = `QUESTION ${state.questionIndex + 1} / ${segment.questions.length}`;
  $("questionText").textContent = question.text;
  $("answerTime").textContent = "00:00";
  updateMarkButton();
}

function resetWelcome() {
  state.phase = "idle";
  state.mode = null;
  $("welcomeActions").classList.remove("is-hidden");
  $("practiceActions").classList.add("is-hidden");
  $("topicProgress").textContent = "CURRENT QUESTION";
  $("questionProgress").textContent = "尚未开始";
  $("questionText").textContent = "准备好后，考官将在这里提问。";
  $("phaseText").textContent = "等待开始";
  $("answerTime").textContent = "00:00";
  $("voiceState").classList.remove("is-speaking");
  $("recordingIndicator").classList.add("is-hidden");
  $("markButton").disabled = true;
  document.querySelectorAll("[data-identity]").forEach((button) => { button.disabled = false; });
  document.querySelectorAll("[data-region]").forEach((button) => { button.disabled = false; });
}

async function staticAudioUrl(text) {
  const payload = new TextEncoder().encode(`bf_emma|0.96|${text}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `audio-cache/${hash}.wav`;
}

async function checkLocalService() {
  try {
    const staticResponse = await fetch(await staticAudioUrl("What subjects are you studying?"), { method: "HEAD", cache: "force-cache" });
    if (staticResponse.ok) {
      state.localVoiceAvailable = true;
      $("serviceDot").className = "ready";
      $("serviceStatus").textContent = "Emma 考官语音已就绪";
      return;
    }
    const response = await fetch("/api/health", { cache: "no-store" });
    const health = await response.json();
    state.localVoiceAvailable = Boolean(health.ttsAvailable);
    $("serviceDot").className = state.localVoiceAvailable ? "ready" : "fallback";
    $("serviceStatus").textContent = state.localVoiceAvailable ? "Emma 本地考官语音已就绪" : "将使用浏览器英文语音";
  } catch {
    state.localVoiceAvailable = false;
    $("serviceDot").className = "fallback";
    $("serviceStatus").textContent = "请通过本地启动器打开，以使用 Emma 语音";
  }
}

async function ensureAudioContext() {
  if (!state.audioContext) state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (state.audioContext.state === "suspended") await state.audioContext.resume();
}

function preferredMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported(type)) || "";
}

async function startRecording() {
  await ensureAudioContext();
  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  state.recordDestination = state.audioContext.createMediaStreamDestination();
  const microphone = state.audioContext.createMediaStreamSource(state.mediaStream);
  microphone.connect(state.recordDestination);
  state.recordingChunks = [];
  state.recordingBlob = null;
  state.recordingMime = preferredMimeType();
  state.mediaRecorder = new MediaRecorder(state.recordDestination.stream, state.recordingMime ? { mimeType: state.recordingMime } : undefined);
  state.mediaRecorder.addEventListener("dataavailable", (event) => { if (event.data.size) state.recordingChunks.push(event.data); });
  state.mediaRecorder.start(1000);
  $("recordingIndicator").classList.remove("is-hidden");
}

async function stopRecording() {
  $("recordingIndicator").classList.add("is-hidden");
  if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") return null;
  const recorder = state.mediaRecorder;
  const blob = await new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(new Blob(state.recordingChunks, { type: recorder.mimeType || state.recordingMime || "audio/webm" })), { once: true });
    recorder.stop();
  });
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.recordingBlob = blob;
  return blob;
}

async function fetchExaminerAudio(text) {
  if (!state.localVoiceAvailable) return null;
  if (!state.audioCache.has(text)) {
    const request = (async () => {
      let response = await fetch(await staticAudioUrl(text), { cache: "force-cache" });
      if (!response.ok) {
        response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });
      }
      if (!response.ok) throw new Error("Emma 语音加载失败");
      await ensureAudioContext();
      return state.audioContext.decodeAudioData(await response.arrayBuffer());
    })().catch(() => null);
    state.audioCache.set(text, request);
  }
  return state.audioCache.get(text);
}

function stopPlayback() {
  state.speechToken++;
  if (state.currentSource) {
    try { state.currentSource.stop(); } catch {}
    state.currentSource = null;
  }
  window.speechSynthesis?.cancel();
}

function startAnswerTimer(reset = true) {
  clearInterval(state.answerTimer);
  if (reset) state.answerSeconds = 0;
  $("answerTime").textContent = formatTime(state.answerSeconds);
  setPhase("answering", "请开始回答");
  state.answerTimer = setInterval(() => {
    state.answerSeconds += 1;
    $("answerTime").textContent = formatTime(state.answerSeconds);
  }, 1000);
}

function browserSpeak(text, token, resetAnswer) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-GB";
  utterance.rate = .92;
  utterance.pitch = 1;
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => /Sonia|Libby|Emma|British|UK/i.test(voice.name) && voice.lang.toLowerCase().startsWith("en")) || voices.find((voice) => voice.lang.toLowerCase().startsWith("en-gb")) || null;
  utterance.onend = utterance.onerror = () => { if (token === state.speechToken) startAnswerTimer(resetAnswer); };
  speechSynthesis.speak(utterance);
}

function chooseTransition(kind) {
  const choices = TRANSITIONS[kind] || [];
  const available = choices.filter((text) => text !== state.lastTransitionText);
  const text = (available.length ? available : choices)[Math.floor(Math.random() * (available.length || choices.length))] || "";
  state.lastTransitionText = text;
  return text;
}

function playAudioSequence(buffers, token, resetAnswer, index = 0) {
  if (token !== state.speechToken) return;
  if (index >= buffers.length) {
    state.currentSource = null;
    startAnswerTimer(resetAnswer);
    return;
  }
  const source = state.audioContext.createBufferSource();
  source.buffer = buffers[index];
  source.connect(state.audioContext.destination);
  if (state.recordDestination) source.connect(state.recordDestination);
  source.addEventListener("ended", () => {
    if (token !== state.speechToken) return;
    state.currentSource = null;
    if (index < buffers.length - 1) {
      setTimeout(() => playAudioSequence(buffers, token, resetAnswer, index + 1), 220);
    } else {
      startAnswerTimer(resetAnswer);
    }
  }, { once: true });
  state.currentSource = source;
  source.start();
}

async function playCurrentQuestion({ resetAnswer = true, countAsAsked = false, transitionKind = "" } = {}) {
  const question = currentQuestion();
  if (!question) return;
  clearInterval(state.answerTimer);
  stopPlayback();
  const token = state.speechToken;
  const transition = transitionKind ? chooseTransition(transitionKind) : "";
  setPhase("loading", state.localVoiceAvailable ? "正在准备考官语音" : "考官正在提问");
  if (countAsAsked) state.asked.push({ topicId: currentSegment().topic.id, topic: currentSegment().topic.title, questionId: question.id, question: question.text });
  const [transitionBuffer, questionBuffer] = await Promise.all([
    transition ? fetchExaminerAudio(transition) : Promise.resolve(null),
    fetchExaminerAudio(question.text)
  ]);
  if (token !== state.speechToken) return;
  setPhase("speaking", "考官正在提问");
  if (!questionBuffer) {
    browserSpeak([transition, question.text].filter(Boolean).join(" "), token, resetAnswer);
    return;
  }
  playAudioSequence([transitionBuffer, questionBuffer].filter(Boolean), token, resetAnswer);
  prefetchUpcoming();
}

function upcomingQuestions(limit = 2) {
  const result = [];
  let segmentIndex = state.segmentIndex;
  let questionIndex = state.questionIndex + 1;
  while (result.length < limit && segmentIndex < state.segments.length) {
    const segment = state.segments[segmentIndex];
    if (questionIndex < segment.questions.length) result.push(segment.questions[questionIndex++]);
    else { segmentIndex += 1; questionIndex = 0; }
  }
  return result;
}

function prefetchUpcoming() {
  if (!state.localVoiceAvailable) return;
  upcomingQuestions().forEach((question) => { fetchExaminerAudio(question.text); });
}

function requestStart(mode, { topicIds = [] } = {}) {
  try {
    state.pendingMode = mode;
    const preview = mode === "simulation"
      ? buildSimulation()
      : mode === "continuous"
        ? buildContinuous()
        : mode === "topics"
          ? buildTopicPractice(topicIds)
          : buildMarkedPractice(topicIds);
    if (!preview.length) throw new Error("当前没有可以练习的题目。 ");
    state.pendingSegments = preview;
    void confirmStart();
  } catch (error) {
    alert(error.message || "暂时无法开始练习。 ");
  }
}

async function confirmStart() {
  try {
    await ensureAudioContext();
    if (state.recordingEnabled) {
      try {
        await startRecording();
      } catch {
        state.recordingEnabled = false;
        localStorage.setItem(RECORDING_KEY, "false");
        updateRecordingSettingUI();
        $("serviceDot").className = "fallback";
        $("serviceStatus").textContent = "麦克风不可用，本次练习将不录音";
      }
    }
    state.mode = state.pendingMode;
    state.segments = state.pendingSegments;
    state.segmentIndex = 0;
    state.questionIndex = 0;
    state.asked = [];
    state.startedAt = Date.now();
    state.finishing = false;
    $("welcomeActions").classList.add("is-hidden");
    $("practiceActions").classList.remove("is-hidden");
    document.querySelectorAll("[data-identity]").forEach((button) => { button.disabled = true; });
    document.querySelectorAll("[data-region]").forEach((button) => { button.disabled = true; });
    renderCurrentQuestion();
    await playCurrentQuestion({ countAsAsked: true });
  } catch (error) {
    alert(error.message || "暂时无法开始练习。 ");
  }
}

async function nextQuestion() {
  if (state.phase !== "answering") return;
  clearInterval(state.answerTimer);
  const segment = currentSegment();
  let transitionKind = "";
  if (state.questionIndex < segment.questions.length - 1) {
    state.questionIndex += 1;
  } else if (state.segmentIndex < state.segments.length - 1) {
    state.segmentIndex += 1;
    state.questionIndex = 0;
    transitionKind = "topic";
  } else {
    await finishSession();
    return;
  }
  renderCurrentQuestion();
  await playCurrentQuestion({ countAsAsked: true, transitionKind });
}

async function finishSession() {
  if (state.finishing || state.phase === "idle") return;
  state.finishing = true;
  clearInterval(state.answerTimer);
  stopPlayback();
  setPhase("finished", "练习已结束");
  await stopRecording();
  const totalSeconds = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
  const uniqueTopics = [...new Set(state.asked.map((item) => item.topicId))];
  $("resultTopics").textContent = uniqueTopics.length;
  $("resultQuestions").textContent = state.asked.length;
  $("resultTime").textContent = formatTime(totalSeconds);
  $("exportButton").disabled = !state.recordingBlob;
  $("recordingSummary").textContent = state.recordingBlob
    ? "录音已在本机准备好，你可以选择导出或直接结束。"
    : "本次练习没有录音，可以直接结束并返回。";
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  history.unshift({
    date: new Date().toISOString(),
    mode: state.mode,
    region: state.region,
    identity: state.identity,
    topics: uniqueTopics.map((id) => state.asked.find((item) => item.topicId === id)?.topic).filter(Boolean),
    questions: state.asked.length,
    seconds: totalSeconds
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 40)));
  localStorage.setItem(recentTopicsKey(state.region), JSON.stringify(uniqueTopics.slice(-4)));
  $("resultDialog").showModal();
}

function finishAndReturn() {
  if ($("resultDialog").open) $("resultDialog").close();
  state.recordingBlob = null;
  state.recordingChunks = [];
  state.finishing = false;
  resetWelcome();
  updateMarkedCount();
}

function exportRecording() {
  if (!state.recordingBlob) return;
  const extension = state.recordingBlob.type.includes("ogg") ? "ogg" : "webm";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(state.recordingBlob);
  link.download = `IELTS-Part1-${stamp}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  finishAndReturn();
}

function toggleCurrentMark() {
  const question = currentQuestion();
  if (!question) return;
  if (marked.has(question.id)) marked.delete(question.id); else marked.add(question.id);
  localStorage.setItem(markedKey(state.region), JSON.stringify([...marked]));
  updateMarkButton();
  updateMarkedCount();
}

function renderHistory() {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  if (!history.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有练习记录。";
    $("historyList").replaceChildren(empty);
    return;
  }
  const labels = { simulation: "模拟考试", continuous: "连续练习", marked: "标记题练习", topics: "专项练习" };
  $("historyList").replaceChildren(...history.map((entry) => {
    const article = document.createElement("article");
    article.className = "history-item";
    const date = document.createElement("p");
    date.textContent = new Date(entry.date).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const title = document.createElement("h3");
    title.textContent = `${labels[entry.mode] || "Part 1 练习"} · ${entry.questions || 0} 题`;
    const summary = document.createElement("p");
    const regionLabel = entry.region === "china" ? "中国大陆" : entry.region === "canada" ? "加拿大" : "";
    summary.textContent = `${regionLabel ? `${regionLabel} · ` : ""}${(entry.topics || []).join("、") || "未记录主题"} · ${formatTime(entry.seconds || 0)}`;
    article.append(date, title, summary);
    return article;
  }));
}

document.querySelectorAll("[data-identity]").forEach((button) => {
  button.addEventListener("click", () => {
    state.identity = button.dataset.identity;
    localStorage.setItem(IDENTITY_KEY, state.identity);
    updateIdentityUI();
  });
});
document.querySelectorAll("[data-region]").forEach((button) => {
  button.addEventListener("click", () => switchRegion(button.dataset.region));
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).close()));
$("simulationButton").addEventListener("click", () => requestStart("simulation"));
$("continuousButton").addEventListener("click", () => requestStart("continuous"));
$("specialtyPracticeButton").addEventListener("click", openSpecialtyPicker);
document.querySelectorAll("[data-specialty-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    state.specialtyTab = button.dataset.specialtyTab;
    state.specialtySelection.clear();
    renderSpecialtyPicker();
  });
});
$("topicSearch").addEventListener("input", () => {
  state.specialtySelection.clear();
  renderSpecialtyPicker();
});
$("randomTopicButton").addEventListener("click", () => {
  const topic = weightedPick(allEligibleTopics(), topicWeight);
  if (!topic) return;
  $("specialtyDialog").close();
  requestStart("topics", { topicIds: [topic.id] });
});
$("startSelectedTopicsButton").addEventListener("click", () => {
  const topicIds = [...state.specialtySelection];
  $("specialtyDialog").close();
  requestStart("topics", { topicIds });
});
$("removeMarkedTopicsButton").addEventListener("click", removeSelectedMarkedTopics);
$("startSelectedMarkedButton").addEventListener("click", () => {
  const topicIds = [...state.specialtySelection];
  $("specialtyDialog").close();
  requestStart("marked", { topicIds });
});
$("randomMarkedButton").addEventListener("click", () => {
  $("specialtyDialog").close();
  requestStart("marked");
});
$("recordingSetting").addEventListener("change", () => {
  state.recordingEnabled = $("recordingSetting").checked;
  localStorage.setItem(RECORDING_KEY, String(state.recordingEnabled));
});
$("markButton").addEventListener("click", toggleCurrentMark);
$("repeatButton").addEventListener("click", () => playCurrentQuestion({ resetAnswer: false, countAsAsked: false }));
$("nextButton").addEventListener("click", nextQuestion);
$("endButton").addEventListener("click", finishSession);
$("exportButton").addEventListener("click", exportRecording);
$("discardButton").addEventListener("click", finishAndReturn);
$("closeResultButton").addEventListener("click", finishAndReturn);
$("resultDialog").addEventListener("cancel", (event) => event.preventDefault());
$("historyButton").addEventListener("click", () => { renderHistory(); $("historyDialog").showModal(); });
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && state.phase === "answering" && !event.repeat && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    nextQuestion();
  }
});
window.addEventListener("beforeunload", () => { state.mediaStream?.getTracks().forEach((track) => track.stop()); });

updateIdentityUI();
updateRegionUI();
updateRecordingSettingUI();
updateMarkedCount();
resetWelcome();
checkLocalService();
