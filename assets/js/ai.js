/* ── 360 AI — ai.js ───────────────────────────────────────────────────── */
const sb          = supabaseClient;
const aiInput     = document.getElementById("ai-input");
const aiSendBtn   = document.getElementById("ai-send-btn");
const aiOutput    = document.getElementById("ai-output");
const convList    = document.getElementById("conv-list");
const fileInput   = document.getElementById("ai-file-input");
const welcome     = document.getElementById("ai-welcome");
const modelBadge  = document.getElementById("model-badge");

const SB_URL = "https://wiswfpfsjiowtrdyqpxy.supabase.co";

let history       = [];
let currentConvId = null;
let currentUserId = null;
let pendingFile   = null;   // { file, name, base64, mimeType, previewUrl }
let isSending     = false;

/* ── Configure marked ── */
marked.setOptions({ breaks: true, gfm: true });

// Custom renderer — wraps code blocks with copy button + hljs highlighting
const renderer = new marked.Renderer();
renderer.code = function(code, lang) {
  const safeCode = code.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const label = lang || "code";
  const id = "cb-" + Math.random().toString(36).slice(2,8);
  return `<div class="code-block-wrap">
    <div class="code-block-header">
      <span class="code-block-lang">${label}</span>
      <button class="code-copy-btn" onclick="copyCode('${id}')">Copy</button>
    </div>
    <pre><code id="${id}" class="language-${label}">${safeCode}</code></pre>
  </div>`;
};
marked.use({ renderer });

window.copyCode = function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = el.closest(".code-block-wrap")?.querySelector(".code-copy-btn");
    if (btn) { btn.textContent = "Copied!"; setTimeout(() => btn.textContent = "Copy", 1800); }
  });
};

/* ── Render markdown and highlight ── */
function renderMarkdown(text) {
  const html = marked.parse(text);
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  wrap.querySelectorAll("pre code").forEach(el => {
    hljs.highlightElement(el);
  });
  return wrap.innerHTML;
}

/* ── Bubble helpers ── */
function hideWelcome() {
  if (welcome) welcome.style.display = "none";
}

function appendUserBubble(text, file) {
  hideWelcome();
  const div = document.createElement("div");
  div.className = "ai-bubble user";
  let inner = "";
  if (file?.previewUrl && file.mimeType?.startsWith("image/")) {
    inner += `<div class="attached-preview"><img src="${file.previewUrl}" alt="${escHtml(file.name)}" /></div>`;
  } else if (file) {
    inner += `<a class="attached-file-link" href="${file.previewUrl||"#"}" target="_blank">📎 ${escHtml(file.name)}</a>`;
  }
  if (text) inner += `<div class="bubble-inner">${escHtml(text)}</div>`;
  div.innerHTML = inner;
  aiOutput.appendChild(div);
  scrollBottom();
  return div;
}

function appendAssistantBubble(text, isThinking = false) {
  hideWelcome();
  const div = document.createElement("div");
  div.className = "ai-bubble assistant";
  const avatar = document.createElement("div");
  avatar.className = "ai-avatar";
  avatar.textContent = "✦";
  const inner = document.createElement("div");
  inner.className = "bubble-inner";
  if (isThinking) {
    inner.innerHTML = `<div class="thinking"><span></span><span></span><span></span></div>`;
  } else {
    inner.innerHTML = renderMarkdown(text);
  }
  div.appendChild(avatar);
  div.appendChild(inner);
  aiOutput.appendChild(div);
  scrollBottom();
  return { div, inner };
}

function scrollBottom() {
  aiOutput.scrollTop = aiOutput.scrollHeight;
}

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ── File handling ── */
document.getElementById("ai-attach-btn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) attachFile(file);
  e.target.value = "";
});

function attachFile(file) {
  const name = file.name;
  const isImage = file.type.startsWith("image/");
  let previewUrl = null;
  const reader = new FileReader();
  reader.onload = ev => {
    const base64 = ev.target.result.split(",")[1];
    previewUrl = isImage ? ev.target.result : null;
    pendingFile = { file, name, base64, mimeType: file.type, previewUrl };

    const thumb = document.getElementById("fp-thumb");
    if (isImage) {
      thumb.innerHTML = `<img src="${previewUrl}" alt="preview" style="max-height:44px;border-radius:6px;" />`;
    } else {
      thumb.innerHTML = `<span class="fp-icon">📎</span>`;
    }
    document.getElementById("fp-name").textContent = name;
    document.getElementById("file-preview").classList.add("show");
  };
  reader.readAsDataURL(file);
}

document.getElementById("fp-cancel").addEventListener("click", clearFile);
function clearFile() {
  pendingFile = null;
  document.getElementById("file-preview").classList.remove("show");
  document.getElementById("fp-thumb").innerHTML = "";
  document.getElementById("fp-name").textContent = "";
}

/* ── Clipboard image paste ── */
document.addEventListener("paste", e => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        const named = new File([file], `pasted-image-${Date.now()}.png`, { type: file.type });
        attachFile(named);
      }
      break;
    }
  }
});

/* ── Drag and drop ── */
const aiMain = document.getElementById("ai-main");
aiMain.addEventListener("dragover", e => { e.preventDefault(); aiMain.classList.add("drag-over"); });
aiMain.addEventListener("dragleave", e => { if (!aiMain.contains(e.relatedTarget)) aiMain.classList.remove("drag-over"); });
aiMain.addEventListener("drop", e => {
  e.preventDefault();
  aiMain.classList.remove("drag-over");
  const file = e.dataTransfer?.files[0];
  if (file) attachFile(file);
});

/* ── Upload to Supabase storage ── */
async function uploadToStorage(file, name) {
  const ext = name.split(".").pop() || "bin";
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await sb.storage.from("ai-uploads").upload(path, file, { cacheControl: "3600", upsert: false });
  if (error) return null;
  return sb.storage.from("ai-uploads").getPublicUrl(path).data?.publicUrl || null;
}

/* ── Send ── */
async function sendAI() {
  if (isSending) return;
  const prompt = aiInput.value.trim();
  if (!prompt && !pendingFile) return;

  isSending = true;
  aiSendBtn.disabled = true;
  aiInput.value = "";
  aiInput.style.height = "auto";

  const captured = pendingFile ? { ...pendingFile } : null;
  clearFile();

  // Upload for storage URL (for saving/display) — non-blocking
  let storageUrl = null;
  if (captured) {
    storageUrl = await uploadToStorage(captured.file, captured.name).catch(() => null);
  }

  // Show user bubble immediately with local preview
  appendUserBubble(prompt, captured ? { ...captured, previewUrl: storageUrl || captured.previewUrl } : null);

  const { div: thinkDiv, inner: thinkInner } = appendAssistantBubble("", true);

  try {
    const body = {
      message: prompt || "The user attached a file. Please analyze it.",
      memory: history,
    };
    if (captured) {
      body.file = { base64: captured.base64, mimeType: captured.mimeType, fileName: captured.name };
    }

    const res = await fetch(`${SB_URL}/functions/v1/ai-chatbot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    const reply = data.reply || "No response.";

    // Update model badge from response header if present
    const modelUsed = res.headers.get("x-model-used");
    if (modelUsed) updateModelBadge(modelUsed);

    thinkInner.innerHTML = renderMarkdown(reply);
    scrollBottom();

    // Push to history
    const userEntry = { role: "user", content: prompt || "(file attached)" };
    if (storageUrl) { userEntry.fileUrl = storageUrl; userEntry.fileName = captured.name; }
    history.push(userEntry);
    history.push({ role: "assistant", content: reply });

    scheduleAutoSave();

  } catch (err) {
    thinkInner.innerHTML = `<span style="color:#ef4444;">⚠️ ${escHtml(err.message)}</span>`;
  } finally {
    isSending = false;
    aiSendBtn.disabled = false;
    aiInput.focus();
  }
}

function updateModelBadge(model) {
  if (!modelBadge) return;
  const map = {
    "openrouter": "✦ Claude Opus · OpenRouter",
    "claude": "✦ Claude Sonnet · Direct",
    "groq": "⚡ Llama 3.3 · Groq",
    "gemini": "◆ Gemini · Google",
  };
  for (const [k, v] of Object.entries(map)) {
    if (model.toLowerCase().includes(k)) { modelBadge.textContent = v; return; }
  }
}

/* ── Auto-resize textarea ── */
aiInput.addEventListener("input", () => {
  aiInput.style.height = "auto";
  aiInput.style.height = Math.min(aiInput.scrollHeight, 200) + "px";
});

/* ── Input events ── */
aiInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAI(); }
});
aiSendBtn.addEventListener("click", sendAI);

/* ── Welcome chips ── */
document.querySelectorAll(".wl-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    aiInput.value = chip.dataset.prompt;
    aiInput.dispatchEvent(new Event("input"));
    aiInput.focus();
    sendAI();
  });
});

/* ── Sidebar toggle ── */
document.getElementById("sidebar-toggle").addEventListener("click", () => {
  document.getElementById("ai-sidebar").classList.toggle("collapsed");
});

/* ── Auto-save ── */
let autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveConversation(true), 1800);
}

async function saveConversation(silent = false) {
  if (!currentUserId) return;
  const userMsgs = history.filter(m => m.role === "user");
  if (!userMsgs.length) return;
  const title = (userMsgs[0].content || "Chat").slice(0, 50);
  const payload = { user_id: currentUserId, title, messages: history, updated_at: new Date().toISOString() };
  if (currentConvId) {
    await sb.from("ai_conversations").update(payload).eq("id", currentConvId);
  } else {
    const { data, error } = await sb.from("ai_conversations").insert(payload).select().single();
    if (error) { if (!silent) showToast("Save failed: " + error.message); return; }
    currentConvId = data.id;
  }
  if (!silent) showToast("💾 Saved");
  loadConversations();
}

/* ── Conversation list ── */
let loadConvTimer = null;
function scheduleLoad() { clearTimeout(loadConvTimer); loadConvTimer = setTimeout(loadConversations, 100); }

async function loadConversations() {
  convList.innerHTML = "";
  if (!currentUserId) {
    convList.innerHTML = `<div class="conv-empty">Sign in to save chats</div>`;
    return;
  }
  const { data } = await sb.from("ai_conversations")
    .select("id,title,updated_at")
    .eq("user_id", currentUserId)
    .order("updated_at", { ascending: false })
    .limit(60);
  if (!data?.length) { convList.innerHTML = `<div class="conv-empty">No saved chats yet</div>`; return; }
  data.forEach(conv => {
    const item = document.createElement("div");
    item.className = "conv-item" + (conv.id === currentConvId ? " active" : "");
    item.innerHTML = `<span class="conv-item-title">💬 ${escHtml(conv.title)}</span><button class="conv-del" title="Delete">✕</button>`;
    item.addEventListener("click", e => { if (!e.target.classList.contains("conv-del")) loadConversation(conv.id); });
    item.querySelector(".conv-del").addEventListener("click", e => { e.stopPropagation(); deleteConversation(conv.id); });
    convList.appendChild(item);
  });
}

async function loadConversation(id) {
  const { data } = await sb.from("ai_conversations").select("*").eq("id", id).single();
  if (!data) return;
  currentConvId = data.id;
  history = data.messages || [];
  aiOutput.innerHTML = "";
  if (welcome) welcome.style.display = "none";
  history.filter(m => m.role !== "system").forEach(m => {
    if (m.role === "user") {
      const att = m.fileUrl ? { name: m.fileName||"file", previewUrl: m.fileUrl, mimeType: m.fileUrl?.match(/\.(jpe?g|png|gif|webp)/i) ? "image/jpeg" : "application/octet-stream" } : null;
      appendUserBubble(m.content, att);
    } else {
      appendAssistantBubble(m.content);
    }
  });
  scrollBottom();
  loadConversations();
}

async function deleteConversation(id) {
  if (!confirm("Delete this chat?")) return;
  await sb.from("ai_conversations").delete().eq("id", id);
  if (currentConvId === id) startNewChat();
  else loadConversations();
}

function startNewChat() {
  currentConvId = null;
  history = [];
  aiOutput.innerHTML = "";
  if (welcome) { welcome.style.display = "flex"; }
  loadConversations();
}

document.getElementById("new-chat-btn").addEventListener("click", startNewChat);

/* ── Toast ── */
function showToast(msg) {
  const t = document.createElement("div");
  t.className = "ai-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ── Auth ── */
let authReady = false;
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  currentUserId = session?.user?.id || null;
  authReady = true;
  scheduleLoad();
})();

let authInitDone = false;
sb.auth.onAuthStateChange((event, s) => {
  if (event === "INITIAL_SESSION") { authInitDone = true; return; }
  currentUserId = s?.user?.id || null;
  scheduleLoad();
});
