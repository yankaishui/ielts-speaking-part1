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
const PREP_BAND_KEY = "ielts-part1-prep-target-band";
const PREP_DRAFT_KEY = "ielts-part1-prep-drafts-v1";
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
function prepDraftKey() { return `${PREP_DRAFT_KEY}-${state.region}-${state.identity}`; }

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
  audioPrimed: false,
  voiceReady: null,
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
  finishing: false,
  prepSelection: new Set(),
  prepTargetBand: localStorage.getItem(PREP_BAND_KEY) || "7.0",
  prepItems: [],
  prepAnswers: new Map(),
  prepSkipped: new Set()
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

function preparationEligibleTopics() {
  return bank.topics.filter((topic) => topic.identity === "all" || topic.identity === state.identity);
}

function buildPreparation(topicIds) {
  return preparationEligibleTopics()
    .filter((topic) => topicIds.includes(topic.id))
    .map((topic) => ({ topic, questions: [...topic.questions] }));
}

function formatTime(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function currentSegment() { return state.segments[state.segmentIndex]; }
function currentQuestion() { return currentSegment()?.questions[state.questionIndex]; }
function currentPrepItem() {
  const question = currentQuestion();
  return question ? state.prepItems.find((item) => item.question.id === question.id) : null;
}

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

function prepTopicPickerItem(topic) {
  const label = document.createElement("label");
  label.className = "marked-topic-item";
  const preparedCount = topic.questions.filter((question) => state.prepAnswers.get(question.id)?.trim()).length;
  if (preparedCount) label.classList.add("is-prepared");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = topic.id;
  checkbox.checked = state.prepSelection.has(topic.id);
  checkbox.setAttribute("aria-label", `选择 ${topic.title}`);
  const copy = document.createElement("span");
  copy.className = "marked-topic-copy";
  const title = document.createElement("strong");
  title.textContent = topic.title;
  const count = document.createElement("small");
  count.textContent = preparedCount ? `已准备 ${preparedCount} / ${topic.questions.length} 道` : `${topic.questions.length} 道题`;
  copy.append(title, count);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.prepSelection.add(topic.id);
    else state.prepSelection.delete(topic.id);
    updatePrepSelectionSummary();
  });
  label.append(checkbox, copy);
  return label;
}

function updatePrepSelectionSummary() {
  const topics = preparationEligibleTopics().filter((topic) => state.prepSelection.has(topic.id));
  const questionCount = topics.reduce((sum, topic) => sum + topic.questions.length, 0);
  const hasPreparedContent = preparationEligibleTopics().some((topic) => topic.questions.some((question) => state.prepAnswers.get(question.id)?.trim()));
  $("prepSelectionSummary").textContent = `已选择 ${topics.length} 个主题，共 ${questionCount} 道题`;
  $("startPrepButton").disabled = !topics.length;
  $("prepDownloadSavedButton").disabled = !hasPreparedContent;
}

function renderPrepPicker() {
  const query = $("prepTopicSearch").value.trim().toLowerCase();
  const topics = preparationEligibleTopics().filter((topic) => !query || topic.title.toLowerCase().includes(query));
  const content = [];
  for (const type of ["opening", "seasonal"]) {
    const group = topics.filter((topic) => topic.type === type);
    if (!group.length) continue;
    const heading = document.createElement("p");
    heading.className = "topic-section-title";
    heading.textContent = type === "opening" ? "常规开场" : "当季抽查";
    content.push(heading, ...group.map(prepTopicPickerItem));
  }
  if (!content.length) {
    const empty = document.createElement("p");
    empty.className = "specialty-empty";
    empty.textContent = "没有找到匹配的主题";
    content.push(empty);
  }
  $("prepTopicList").replaceChildren(...content);
  updatePrepSelectionSummary();
}

function openAnswerPrepPicker() {
  loadPreparationDrafts();
  state.prepSelection.clear();
  $("prepTopicSearch").value = "";
  $("prepBandSelect").value = state.prepTargetBand;
  renderPrepPicker();
  $("answerPrepDialog").showModal();
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
  const prepAnswering = state.mode === "prepare" && phase === "answering";
  $("prepSaveButton").disabled = !prepAnswering;
  $("prepPreviousButton").disabled = state.mode !== "prepare" || state.prepItems.indexOf(currentPrepItem()) <= 0 || phase === "loading";
  $("prepSkipButton").disabled = state.mode !== "prepare" || phase === "loading";
}

function renderCurrentQuestion() {
  const segment = currentSegment();
  const question = currentQuestion();
  if (!segment || !question) return;
  $("topicProgress").textContent = `TOPIC ${state.segmentIndex + 1} · ${segment.topic.title}`;
  const prepItem = state.mode === "prepare" ? currentPrepItem() : null;
  $("questionProgress").textContent = prepItem
    ? `${prepItem.code} · QUESTION ${state.questionIndex + 1} / ${segment.questions.length}`
    : `QUESTION ${state.questionIndex + 1} / ${segment.questions.length}`;
  $("questionText").textContent = question.text;
  $("answerTime").textContent = "00:00";
  $("answerTime").classList.toggle("is-hidden", state.mode === "prepare");
  $("prepAnswerEditor").classList.toggle("is-hidden", state.mode !== "prepare");
  if (state.mode === "prepare") {
    $("prepAnswerInput").value = state.prepAnswers.get(question.id) || "";
  }
  $("markButton").classList.toggle("is-hidden", state.mode === "prepare");
  updateMarkButton();
}

function resetWelcome() {
  state.phase = "idle";
  state.mode = null;
  $("welcomeActions").classList.remove("is-hidden");
  $("practiceActions").classList.add("is-hidden");
  $("prepActions").classList.add("is-hidden");
  $("prepAnswerEditor").classList.add("is-hidden");
  $("markButton").classList.remove("is-hidden");
  $("topicProgress").textContent = "CURRENT QUESTION";
  $("questionProgress").textContent = "尚未开始";
  $("questionText").textContent = "准备好后，考官将在这里提问。";
  $("phaseText").textContent = "等待开始";
  $("answerTime").textContent = "00:00";
  $("answerTime").classList.remove("is-hidden");
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

function addPlaybackLeadIn(buffer, seconds = .22) {
  const leadFrames = Math.ceil(buffer.sampleRate * seconds);
  const padded = state.audioContext.createBuffer(
    buffer.numberOfChannels,
    buffer.length + leadFrames,
    buffer.sampleRate
  );
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    padded.copyToChannel(buffer.getChannelData(channel), channel, leadFrames);
  }
  return padded;
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
  const recorderStarted = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    state.mediaRecorder.addEventListener("start", finish, { once: true });
    setTimeout(finish, 2000);
  });
  state.mediaRecorder.start(1000);
  $("recordingIndicator").classList.remove("is-hidden");
  await recorderStarted;
  await new Promise((resolve) => setTimeout(resolve, 1200));
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

function activateAnswerTimer(reset = true, label = "请开始回答") {
  clearInterval(state.answerTimer);
  if (reset) state.answerSeconds = 0;
  $("answerTime").textContent = formatTime(state.answerSeconds);
  setPhase("answering", label);
  state.answerTimer = setInterval(() => {
    state.answerSeconds += 1;
    $("answerTime").textContent = formatTime(state.answerSeconds);
  }, 1000);
}

function startAnswerTimer(reset = true) {
  if (state.mode === "prepare") {
    clearInterval(state.answerTimer);
    setPhase("answering", "请输入中文回答");
    $("prepAnswerInput").focus({ preventScroll: true });
    return;
  }
  activateAnswerTimer(reset);
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
  if (!state.audioPrimed && index === 0) {
    source.buffer = addPlaybackLeadIn(buffers[index]);
    state.audioPrimed = true;
  } else {
    source.buffer = buffers[index];
  }
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
    await state.voiceReady;
    state.mode = state.pendingMode;
    state.segments = state.pendingSegments;
    state.segmentIndex = 0;
    state.questionIndex = 0;
    state.asked = [];
    state.audioPrimed = false;
    state.finishing = false;
    $("welcomeActions").classList.add("is-hidden");
    $("practiceActions").classList.remove("is-hidden");
    document.querySelectorAll("[data-identity]").forEach((button) => { button.disabled = true; });
    document.querySelectorAll("[data-region]").forEach((button) => { button.disabled = true; });
    renderCurrentQuestion();
    setPhase("loading", "正在准备考官语音");
    const firstAudioPromise = fetchExaminerAudio(currentQuestion().text);
    if (state.recordingEnabled) {
      try {
        await Promise.all([startRecording(), firstAudioPromise]);
      } catch {
        state.mediaStream?.getTracks().forEach((track) => track.stop());
        state.recordingEnabled = false;
        localStorage.setItem(RECORDING_KEY, "false");
        updateRecordingSettingUI();
        $("serviceDot").className = "fallback";
        $("serviceStatus").textContent = "麦克风不可用，本次练习将不录音";
        await firstAudioPromise;
      }
    } else {
      await firstAudioPromise;
    }
    state.startedAt = Date.now();
    await playCurrentQuestion({ countAsAsked: true });
  } catch (error) {
    alert(error.message || "暂时无法开始练习。 ");
  }
}

function persistPreparationDrafts() {
  localStorage.setItem(prepDraftKey(), JSON.stringify(Object.fromEntries(state.prepAnswers)));
}

function loadPreparationDrafts() {
  try {
    state.prepAnswers = new Map(Object.entries(JSON.parse(localStorage.getItem(prepDraftKey()) || "{}")));
  } catch {
    state.prepAnswers = new Map();
  }
}

function saveCurrentPrepDraft() {
  const question = currentQuestion();
  if (!question || state.mode !== "prepare") return;
  const answer = $("prepAnswerInput").value.trim();
  if (answer) {
    state.prepAnswers.set(question.id, answer);
    state.prepSkipped.delete(question.id);
  } else {
    state.prepAnswers.delete(question.id);
  }
  persistPreparationDrafts();
}

async function startPreparationSession() {
  try {
    const topicIds = [...state.prepSelection];
    const segments = buildPreparation(topicIds);
    if (!segments.length) throw new Error("请至少选择一个需要准备的主题。 ");
    state.prepTargetBand = $("prepBandSelect").value;
    localStorage.setItem(PREP_BAND_KEY, state.prepTargetBand);
    $("answerPrepDialog").close();
    await ensureAudioContext();
    await state.voiceReady;
    state.mode = "prepare";
    state.segments = segments;
    state.segmentIndex = 0;
    state.questionIndex = 0;
    state.asked = [];
    state.audioPrimed = false;
    state.finishing = false;
    loadPreparationDrafts();
    state.prepSkipped = new Set();
    let itemNumber = 0;
    state.prepItems = segments.flatMap((segment) => segment.questions.map((question) => {
      itemNumber += 1;
      return {
        code: `Q${String(itemNumber).padStart(3, "0")}`,
        topicId: segment.topic.id,
        topic: segment.topic.title,
        question
      };
    }));
    $("welcomeActions").classList.add("is-hidden");
    $("practiceActions").classList.add("is-hidden");
    $("prepActions").classList.remove("is-hidden");
    document.querySelectorAll("[data-identity], [data-region]").forEach((button) => { button.disabled = true; });
    renderCurrentQuestion();
    setPhase("loading", "正在准备考官语音");
    await fetchExaminerAudio(currentQuestion().text);
    state.startedAt = Date.now();
    await playCurrentQuestion({ countAsAsked: true });
  } catch (error) {
    resetWelcome();
    alert(error.message || "暂时无法开始答案准备。 ");
  }
}

async function advancePreparationQuestion() {
  const segment = currentSegment();
  let transitionKind = "";
  if (state.questionIndex < segment.questions.length - 1) {
    state.questionIndex += 1;
  } else if (state.segmentIndex < state.segments.length - 1) {
    state.segmentIndex += 1;
    state.questionIndex = 0;
    transitionKind = "topic";
  } else {
    await finishPreparationSession();
    return;
  }
  $("prepAnswerInput").value = "";
  renderCurrentQuestion();
  await playCurrentQuestion({ countAsAsked: true, transitionKind });
}

async function previousPreparationQuestion() {
  if (state.mode !== "prepare" || state.phase === "loading") return;
  saveCurrentPrepDraft();
  clearInterval(state.answerTimer);
  stopPlayback();
  const currentIndex = state.prepItems.indexOf(currentPrepItem());
  if (currentIndex <= 0) return;
  const target = state.prepItems[currentIndex - 1];
  const segmentIndex = state.segments.findIndex((segment) => segment.topic.id === target.topicId);
  const questionIndex = state.segments[segmentIndex].questions.findIndex((question) => question.id === target.question.id);
  state.segmentIndex = segmentIndex;
  state.questionIndex = questionIndex;
  renderCurrentQuestion();
  await playCurrentQuestion({ countAsAsked: false });
}

async function savePreparationAnswer() {
  if (state.mode !== "prepare" || state.phase !== "answering") return;
  saveCurrentPrepDraft();
  clearInterval(state.answerTimer);
  await advancePreparationQuestion();
}

async function skipPreparationQuestion() {
  if (state.mode !== "prepare" || state.phase === "loading") return;
  clearInterval(state.answerTimer);
  stopPlayback();
  const item = currentPrepItem();
  saveCurrentPrepDraft();
  if (item && !state.prepAnswers.get(item.question.id)?.trim()) state.prepSkipped.add(item.question.id);
  await advancePreparationQuestion();
}

function completedPreparationItems() {
  return state.prepItems.filter((item) => state.prepAnswers.get(item.question.id)?.trim());
}

async function finishPreparationSession() {
  if (state.finishing || state.mode !== "prepare") return;
  state.finishing = true;
  saveCurrentPrepDraft();
  clearInterval(state.answerTimer);
  stopPlayback();
  setPhase("finished", "答案准备已结束");
  const completed = completedPreparationItems().length;
  const skipped = state.prepItems.filter((item) => state.prepSkipped.has(item.question.id) && !state.prepAnswers.get(item.question.id)?.trim()).length;
  const remaining = Math.max(0, state.prepItems.length - completed - skipped);
  $("prepCompletedCount").textContent = completed;
  $("prepSkippedCount").textContent = skipped;
  $("prepRemainingCount").textContent = remaining;
  $("prepCopyButton").disabled = completed === 0;
  $("prepDownloadButton").disabled = completed === 0;
  $("prepResultDialog").showModal();
}

function preparationQuestionsMarkdown(sourceSegments = state.segments) {
  const region = state.region === "china" ? "中国大陆" : "加拿大";
  const identity = state.identity === "study" ? "学生" : "工作";
  const topics = sourceSegments
    .filter((segment) => segment.questions.some((question) => state.prepAnswers.get(question.id)?.trim()))
    .map((segment) => {
      const questions = segment.questions.map((question, questionIndex) => {
        const answer = state.prepAnswers.get(question.id)?.trim();
        return `## ${questionIndex + 1}. ${question.text}

**中文回答：** ${answer || "[未回答]"}`;
      }).join("\n\n");
      return `# 主题：${segment.topic.title}

${questions}`;
    });
  return `# IELTS Speaking Part 1 中文答案材料

- 考试地区：${region}
- 考生身份：${identity}
- 目标水平：Band ${state.prepTargetBand}

${topics.join("\n\n---\n\n")}`;
}

function preparationPrompt() {
  return `请根据后面的中文材料，生成一份简洁的 IELTS Speaking Part 1 个人答案。

规则：

1. 严格按照“主题 → 该主题下的问题”的原有顺序输出。
2. 每个主题先写主题名称，然后依次写英文问题和对应结果。
3. 如果中文信息充分，只生成一个 Band ${state.prepTargetBand} 左右的英文回答。答案应自然、口语化、容易记忆，通常为 2–4 句。
4. 保留用户的真实观点、经历和身份，不要虚构个人信息。
5. 如果中文信息不足或显示“未回答”，不要生成英文答案。直接在该问题下面用中文写：
   信息不足，需要补充：……
   请具体说明用户需要补充哪些真实信息，但不要另外建立汇总区域。
6. 不要提供备用答案、记忆技巧、词汇表、短语解析、停顿标记、评分分析或总体统计。
7. 不要把信息不足的问题集中到前面；它必须留在原主题和原问题的位置。
8. 不要添加材料中没有出现的主题，也不要添加前言、结语或其他说明。

输出格式：

# 主题名称

## 1. 英文问题

一个英文回答。

## 2. 英文问题

信息不足，需要补充：请补充……

现在请直接按这个格式处理全部材料。`;
}

function preparationMaterial(sourceSegments = state.segments) {
  return `${preparationPrompt()}

---

# 考生材料

${preparationQuestionsMarkdown(sourceSegments)}`;
}

async function copyPreparationMaterial() {
  const material = preparationMaterial();
  try {
    await navigator.clipboard.writeText(material);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = material;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    if (!copied) {
      alert("复制失败，请改用“下载答案材料”。");
      return;
    }
  }
  $("prepCopyButton").textContent = "已复制，可以粘贴给 AI";
  setTimeout(() => { $("prepCopyButton").textContent = "复制给 AI"; }, 2400);
}

function downloadPreparationMaterial(sourceSegments = state.segments) {
  const segments = Array.isArray(sourceSegments) ? sourceSegments : state.segments;
  const blob = new Blob([preparationMaterial(segments)], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `IELTS-Part1-Chinese-Answers-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

function downloadSavedPreparationMaterial() {
  loadPreparationDrafts();
  const segments = preparationEligibleTopics()
    .filter((topic) => topic.questions.some((question) => state.prepAnswers.get(question.id)?.trim()))
    .map((topic) => ({ topic, questions: [...topic.questions] }));
  if (!segments.length) return;
  downloadPreparationMaterial(segments);
}

function finishPreparationAndReturn() {
  if ($("prepResultDialog").open) $("prepResultDialog").close();
  state.prepSkipped = new Set();
  state.prepItems = [];
  state.finishing = false;
  resetWelcome();
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
$("answerPrepButton").addEventListener("click", openAnswerPrepPicker);
$("prepTopicSearch").addEventListener("input", renderPrepPicker);
$("prepBandSelect").addEventListener("change", () => {
  state.prepTargetBand = $("prepBandSelect").value;
  localStorage.setItem(PREP_BAND_KEY, state.prepTargetBand);
});
$("prepSelectAllButton").addEventListener("click", () => {
  preparationEligibleTopics().forEach((topic) => state.prepSelection.add(topic.id));
  renderPrepPicker();
});
$("prepClearButton").addEventListener("click", () => {
  state.prepSelection.clear();
  renderPrepPicker();
});
$("startPrepButton").addEventListener("click", startPreparationSession);
$("prepDownloadSavedButton").addEventListener("click", downloadSavedPreparationMaterial);
$("prepAnswerInput").addEventListener("input", () => saveCurrentPrepDraft());
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
$("prepPreviousButton").addEventListener("click", previousPreparationQuestion);
$("prepSaveButton").addEventListener("click", savePreparationAnswer);
$("prepSkipButton").addEventListener("click", skipPreparationQuestion);
$("prepEndButton").addEventListener("click", finishPreparationSession);
$("exportButton").addEventListener("click", exportRecording);
$("discardButton").addEventListener("click", finishAndReturn);
$("closeResultButton").addEventListener("click", finishAndReturn);
$("resultDialog").addEventListener("cancel", (event) => event.preventDefault());
$("prepCopyButton").addEventListener("click", copyPreparationMaterial);
$("prepDownloadButton").addEventListener("click", downloadPreparationMaterial);
$("prepReturnButton").addEventListener("click", finishPreparationAndReturn);
$("closePrepResultButton").addEventListener("click", finishPreparationAndReturn);
$("prepResultDialog").addEventListener("cancel", (event) => event.preventDefault());
$("historyButton").addEventListener("click", () => { renderHistory(); $("historyDialog").showModal(); });
document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  if (event.code === "Space" && state.mode !== "prepare" && state.phase === "answering" && !isEditing && !event.isComposing && !event.repeat && !document.querySelector("dialog[open]")) {
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
state.voiceReady = checkLocalService();
