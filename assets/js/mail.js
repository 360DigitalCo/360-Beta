/* ============================================================
   mail.js — 360Mail client logic
   Requires: supabaseClient (from main.js), mail.css
   ============================================================ */
(() => {
  const sb       = supabaseClient;
  const SB_URL   = "https://wiswfpfsjiowtrdyqpxy.supabase.co";
  const SB_ANON  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpc3dmcGZzamlvd3RyZHlxcHh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzg4OTcsImV4cCI6MjA4MzkxNDg5N30.z_4FtM2c8UwgrRlafPYjolQuod4IoHQats95XHio1zM";

  // ── State ──────────────────────────────────────────────────
  let currentUser   = null;
  let mailAddress   = null;   // e.g. username@360-search.com
  let currentFolder = "inbox";
  let currentCatId  = null;
  let allEmails     = [];
  let filteredEmails= [];
  let selectedId    = null;
  let deleteTarget  = null;
  let categories    = [];
  let rules         = {};     // { catId: [sender, ...] }
  let newCatRules   = [];
  let editCatId     = null;
  let editCatRules  = [];

  // ── DOM refs ───────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const mailGate     = $("mailGate");
  const mailApp      = $("mailApp");
  const listScroll   = $("mailListScroll");
  const skeletons    = $("mailSkeletons");
  const listTitle    = $("listTitle");
  const listCount    = $("listCount");
  const inboxBadge   = $("inboxBadge");
  const noSelect     = $("noMailSelected");
  const readContent  = $("mailReadContent");
  const addrPill     = $("myAddressPill");
  const searchInput  = $("mailSearch");
  const composeModal = $("composeModal");
  const customList   = $("customFolderList");
  const rdBack       = $("rdBack");

  // ── Boot ───────────────────────────────────────────────────
  (async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { mailGate.style.display = "flex"; return; }
    currentUser = session.user;
    await loadProfile();
    mailApp.style.display = "flex";
    setupBuiltinFolders();
    setupCompose();
    setupSearch();
    setupReloadButtons();
    setupCategoryModals();
    setupRealtime();
    await loadCategories();
    await loadMail();
  })();

  sb.auth.onAuthStateChange((ev) => {
    if (ev === "SIGNED_OUT") {
      mailGate.style.display = "flex";
      mailApp.style.display  = "none";
    }
  });

  // ── Profile ────────────────────────────────────────────────
  async function loadProfile() {
    const { data: p } = await sb.from("profiles")
      .select("mail_address,username")
      .eq("id", currentUser.id)
      .maybeSingle();
    mailAddress =
      p?.mail_address ||
      (p?.username ? p.username.toLowerCase().replace(/\s+/g,"") + "@360-search.com" : null) ||
      currentUser.email;
    addrPill.textContent = mailAddress || "No address";
  }

  // ── Load mail ──────────────────────────────────────────────
  async function loadMail() {
    if (!mailAddress) return;
    skeletons.style.display = "block";
    const { data, error } = await sb.from("inbox")
      .select("*")
      .eq("owner_email", mailAddress)
      .order("received_at", { ascending: false });
    skeletons.style.display = "none";
    if (error) {
      listScroll.innerHTML = `<div class="mail-empty">
        <div class="mail-empty-icon">⚠️</div>
        <div class="mail-empty-text">Failed to load mail</div>
        <div class="mail-empty-sub">${esc(error.message)}</div>
      </div>`;
      return;
    }
    allEmails = data || [];
    updateBadge();
    applyFilter();
  }

  function updateBadge() {
    const n = allEmails.filter(e => e.direction === "in" && !e.read).length;
    inboxBadge.textContent    = n > 99 ? "99+" : n;
    inboxBadge.style.display  = n > 0 ? "flex" : "none";
  }

  // ── Filter & render list ───────────────────────────────────
  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    let list = [...allEmails];

    if      (currentFolder === "inbox")    list = list.filter(e => e.direction === "in");
    else if (currentFolder === "sent")     list = list.filter(e => e.direction === "out");
    else if (currentFolder === "starred")  list = list.filter(e => e.starred);
    else if (currentFolder === "category" && currentCatId) {
      const senders = (rules[currentCatId] || []).map(s => s.toLowerCase());
      list = list.filter(e => e.direction === "in" && senders.includes((e.from_addr||"").toLowerCase()));
    }

    if (q) list = list.filter(e =>
      (e.subject||"").toLowerCase().includes(q)  ||
      (e.from_addr||"").toLowerCase().includes(q) ||
      (e.to_addr||"").toLowerCase().includes(q)   ||
      (e.body_text||"").toLowerCase().includes(q)
    );

    filteredEmails = list;
    listCount.textContent = list.length;
    renderList();
  }

  function renderList() {
    if (!filteredEmails.length) {
      const icons = { inbox:"📭", sent:"📤", starred:"⭐", category:"📂" };
      const msgs  = { inbox:"No messages yet", sent:"No sent messages", starred:"Nothing starred", category:"No messages from these senders" };
      listScroll.innerHTML = `<div class="mail-empty">
        <div class="mail-empty-icon">${icons[currentFolder]||"📭"}</div>
        <div class="mail-empty-text">${msgs[currentFolder]||"Empty"}</div>
        <div class="mail-empty-sub">${searchInput.value ? "Try a different search" : ""}</div>
      </div>`;
      return;
    }
    listScroll.innerHTML = filteredEmails.map(e => {
      const unread  = e.direction === "in" && !e.read;
      const active  = e.id === selectedId;
      const display = e.direction === "out" ? (e.to_addr||"") : (e.from_addr||"");
      const preview = e.body_text || stripHtml(e.body_html||"") || "";
      return `<div class="mail-item${unread?" unread":""}${active?" active":""}" data-id="${e.id}">
        <button class="mi-star${e.starred?" starred":""}" data-id="${e.id}">★</button>
        <div class="mi-row1">
          <span class="mi-from">${esc(display)}</span>
          <span class="mi-time">${relTime(e.received_at)}</span>
        </div>
        <div class="mi-subject">${esc(e.subject||"(no subject)")}</div>
        <div class="mi-preview">${esc(preview.slice(0,90))}</div>
      </div>`;
    }).join("");

    listScroll.querySelectorAll(".mail-item").forEach(el => {
      el.addEventListener("click", ev => {
        if (ev.target.classList.contains("mi-star")) return;
        openEmail(el.dataset.id);
      });
    });
    listScroll.querySelectorAll(".mi-star").forEach(btn => {
      btn.addEventListener("click", ev => { ev.stopPropagation(); toggleStar(btn.dataset.id); });
    });
  }

  // ── Open email ─────────────────────────────────────────────
  async function openEmail(id) {
    selectedId = id;
    renderList();
    const e = allEmails.find(x => x.id === id);
    if (!e) return;

    if (!e.read && e.direction === "in") {
      e.read = true;
      await sb.from("inbox").update({ read: true }).eq("id", id);
      updateBadge();
    }

    const isSent = e.direction === "out";
    $("rdSubject").textContent = e.subject || "(no subject)";
    $("rdFrom").textContent    = isSent ? "To: " + (e.to_addr||"") : "From: " + (e.from_addr||"");
    $("rdAddr").textContent    = isSent ? "" : "→ " + (e.to_addr||"");
    $("rdTime").textContent    = fmtDate(e.received_at);
    $("rdStar").textContent    = e.starred ? "★ Unstar" : "☆ Star";

    const body = $("rdBody");
    if      (e.body_html) body.innerHTML = `<div class="mail-body-html">${e.body_html}</div>`;
    else if (e.body_text) body.innerHTML = `<pre class="mail-body-plain">${esc(e.body_text)}</pre>`;
    else                  body.innerHTML = `<div class="mail-body-plain" style="opacity:.4">No message body.</div>`;

    noSelect.style.display     = "none";
    readContent.style.display  = "flex";

    const mobile = window.innerWidth < 900;
    rdBack.style.display = mobile ? "flex" : "none";
    if (mobile) {
      $("mailReadPane").classList.add("show");
      $("mailListPanel").classList.remove("show");
    }

    $("rdReply").onclick   = () => openCompose(e.from_addr||"", "Re: "+(e.subject||""));
    $("rdForward").onclick = () => openCompose("", "Fwd: "+(e.subject||""),
      "\n\n--- Forwarded ---\nFrom: "+(e.from_addr||"")+"\n\n"+(e.body_text||stripHtml(e.body_html||"")));
    $("rdStar").onclick    = () => toggleStar(id);
    $("rdDelete").onclick  = () => triggerDelete(id);
  }

  function hideReadPane() {
    noSelect.style.display    = "flex";
    readContent.style.display = "none";
  }

  rdBack.addEventListener("click", () => {
    $("mailReadPane").classList.remove("show");
    $("mailListPanel").classList.add("show");
  });

  // ── Star ───────────────────────────────────────────────────
  async function toggleStar(id) {
    const e = allEmails.find(x => x.id === id);
    if (!e) return;
    e.starred = !e.starred;
    await sb.from("inbox").update({ starred: e.starred }).eq("id", id);
    renderList();
    if (selectedId === id) $("rdStar").textContent = e.starred ? "★ Unstar" : "☆ Star";
    if (currentFolder === "starred") applyFilter();
  }

  // ── Delete ─────────────────────────────────────────────────
  function triggerDelete(id) {
    deleteTarget = id;
    $("confirmOverlay").classList.add("open");
  }
  $("confirmCancel").addEventListener("click", () => {
    $("confirmOverlay").classList.remove("open");
    deleteTarget = null;
  });
  $("confirmDelete").addEventListener("click", async () => {
    if (!deleteTarget) return;
    await sb.from("inbox").delete().eq("id", deleteTarget);
    allEmails = allEmails.filter(e => e.id !== deleteTarget);
    if (selectedId === deleteTarget) { selectedId = null; hideReadPane(); }
    deleteTarget = null;
    $("confirmOverlay").classList.remove("open");
    updateBadge();
    applyFilter();
  });

  // ── Search ─────────────────────────────────────────────────
  function setupSearch() {
    searchInput.addEventListener("input", applyFilter);
  }

  // ── Folder navigation ──────────────────────────────────────
  function setupBuiltinFolders() {
    document.querySelectorAll(".folder-item[data-builtin]").forEach(el => {
      el.addEventListener("click", ev => {
        if (ev.target.classList.contains("folder-reload-btn")) return;
        setFolder(el.dataset.folder, null,
          { inbox:"Inbox", sent:"Sent", starred:"Starred" }[el.dataset.folder] || el.dataset.folder);
      });
    });
  }

  function setFolder(folder, catId, title) {
    currentFolder = folder;
    currentCatId  = catId || null;
    listTitle.textContent = title;
    selectedId = null;
    hideReadPane();
    document.querySelectorAll(".folder-item").forEach(f => f.classList.remove("active"));
    const target = catId
      ? document.querySelector(`.folder-item[data-cat-id="${catId}"]`)
      : document.querySelector(`.folder-item[data-builtin][data-folder="${folder}"]`);
    if (target) target.classList.add("active");
    applyFilter();
  }

  // ── Reload buttons ─────────────────────────────────────────
  function setupReloadButtons() {
    // Built-in sidebar reloads
    document.querySelectorAll(".folder-item[data-builtin] .folder-reload-btn").forEach(btn => {
      btn.addEventListener("click", async ev => { ev.stopPropagation(); spinBtn(btn); await loadMail(); });
    });
    // Top-of-list reload
    $("listReloadBtn").addEventListener("click", async () => {
      spinBtn($("listReloadBtn"));
      await loadMail();
    });
  }

  function spinBtn(btn) {
    btn.classList.add("spinning");
    setTimeout(() => btn.classList.remove("spinning"), 500);
  }

  // ── Realtime ───────────────────────────────────────────────
  function setupRealtime() {
    if (!mailAddress) return;
    sb.channel("inbox_rt")
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "inbox",
        filter: `owner_email=eq.${mailAddress}`
      }, payload => {
        allEmails.unshift(payload.new);
        updateBadge();
        applyFilter();
      })
      .subscribe();
  }

  // ── Compose ────────────────────────────────────────────────
  function setupCompose() {
    $("composeBtn").addEventListener("click", () => openCompose());
    $("composeClose").addEventListener("click", closeCompose);
    $("cSendBtn").addEventListener("click", sendMail);
  }

  function openCompose(to = "", subject = "", body = "") {
    $("cTo").value      = to;
    $("cSubject").value = subject;
    $("cBody").value    = body;
    $("cStatus").textContent = "";
    $("cStatus").className   = "compose-status";
    $("cSendBtn").disabled   = false;
    $("cSendBtn").innerHTML  = "<span>✈</span> Send";
    composeModal.classList.add("open");
    setTimeout(() => $("cTo").focus(), 80);
  }

  function closeCompose() { composeModal.classList.remove("open"); }

  async function sendMail() {
    const to      = $("cTo").value.trim();
    const subject = $("cSubject").value.trim();
    const text    = $("cBody").value.trim();
    const btn     = $("cSendBtn");
    const status  = $("cStatus");

    if (!to || !subject || !text) {
      status.textContent = "To, subject, and message are required.";
      status.className   = "compose-status err";
      return;
    }

    btn.disabled   = true;
    btn.innerHTML  = "<span>⏳</span> Sending…";
    status.textContent = "";

    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch(`${SB_URL}/functions/v1/send-email`, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey":        SB_ANON,
        },
        body: JSON.stringify({ to, subject, text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.error || "Send failed");
      status.textContent = "Sent ✓";
      status.className   = "compose-status ok";
      btn.innerHTML      = "<span>✈</span> Send";
      btn.disabled       = false;
      setTimeout(closeCompose, 1200);
      await loadMail();
    } catch (err) {
      status.textContent = err.message;
      status.className   = "compose-status err";
      btn.innerHTML      = "<span>✈</span> Send";
      btn.disabled       = false;
    }
  }

  // ── Categories ─────────────────────────────────────────────
  async function loadCategories() {
    if (!mailAddress) return;
    const { data: cats } = await sb.from("mail_categories")
      .select("*").eq("owner_email", mailAddress).order("created_at");
    categories = cats || [];
    if (categories.length) {
      const { data: ruleRows } = await sb.from("mail_category_rules")
        .select("*").eq("owner_email", mailAddress);
      rules = {};
      (ruleRows||[]).forEach(r => {
        if (!rules[r.category_id]) rules[r.category_id] = [];
        rules[r.category_id].push(r.sender_email);
      });
    }
    renderCategoryFolders();
  }

  function renderCategoryFolders() {
    customList.innerHTML = "";

    categories.forEach(cat => {
      const div = document.createElement("div");
      div.className = "folder-item";
      div.dataset.catId  = cat.id;
      div.dataset.folder = "category";
      div.innerHTML = `
        <span class="fi-icon" style="color:${esc(cat.color)}">●</span>
        <span class="fi-name">${esc(cat.name)}</span>
        <button class="folder-reload-btn" title="Reload">↻</button>
        <button class="folder-del-btn"    title="Edit">✎</button>`;

      div.addEventListener("click", ev => {
        if (ev.target.classList.contains("folder-del-btn"))    { openEditCat(cat.id); return; }
        if (ev.target.classList.contains("folder-reload-btn")) { spinBtn(ev.target); loadMail(); return; }
        setFolder("category", cat.id, cat.name);
      });
      customList.appendChild(div);
    });

    // Attach reload spin to freshly rendered custom reload btns
    customList.querySelectorAll(".folder-reload-btn").forEach(btn => {
      btn.addEventListener("click", async ev => { ev.stopPropagation(); spinBtn(btn); await loadMail(); });
    });

    // Show/hide "Categories" header with its + button
    const label = $("customFolderLabel");
    if (categories.length > 0) {
      label.style.display = "flex";
      label.innerHTML     = `Categories <button class="folder-add-btn" id="catLabelAddBtn">＋</button>`;
      $("catLabelAddBtn").addEventListener("click", openNewCatModal);
    } else {
      label.style.display = "none";
    }
  }

  // ── Category modals setup ──────────────────────────────────
  function setupCategoryModals() {
    $("addCategoryBtnAlt").addEventListener("click", openNewCatModal);
    $("catModalCancel").addEventListener("click",    () => $("catModal").classList.remove("open"));
    $("catModalSave").addEventListener("click",      saveNewCategory);

    $("ruleAddBtn").addEventListener("click", () =>
      addRule($("ruleInput"), newCatRules, "ruleList", renderNewRules));
    $("ruleInput").addEventListener("keydown", ev => {
      if (ev.key === "Enter") addRule($("ruleInput"), newCatRules, "ruleList", renderNewRules);
    });

    $("catEditCancel").addEventListener("click",  () => $("catEditModal").classList.remove("open"));
    $("catEditSave").addEventListener("click",    saveEditCategory);
    $("catEditDelete").addEventListener("click",  deleteCategory);

    $("editRuleAddBtn").addEventListener("click", () =>
      addRule($("editRuleInput"), editCatRules, "editRuleList", renderEditRules));
    $("editRuleInput").addEventListener("keydown", ev => {
      if (ev.key === "Enter") addRule($("editRuleInput"), editCatRules, "editRuleList", renderEditRules);
    });
  }

  function openNewCatModal() {
    newCatRules = [];
    $("catName").value  = "";
    $("catColor").value = "#6366f1";
    $("ruleList").innerHTML  = "";
    $("ruleInput").value     = "";
    $("catModal").classList.add("open");
    setTimeout(() => $("catName").focus(), 80);
  }

  function addRule(input, arr, listId, renderFn) {
    const val = input.value.trim().toLowerCase();
    if (!val || arr.includes(val)) { input.value = ""; return; }
    arr.push(val);
    input.value = "";
    renderFn();
  }

  function renderNewRules() {
    renderRuleList("ruleList", newCatRules, sender => {
      newCatRules.splice(newCatRules.indexOf(sender), 1);
      renderNewRules();
    });
  }

  function renderEditRules() {
    renderRuleList("editRuleList", editCatRules, sender => {
      editCatRules.splice(editCatRules.indexOf(sender), 1);
      renderEditRules();
    });
  }

  function renderRuleList(listId, arr, onRemove) {
    const el = $(listId);
    if (!arr.length) { el.innerHTML = ""; return; }
    el.innerHTML = arr.map(s => `
      <div class="rule-item">
        <span>${esc(s)}</span>
        <button class="rule-remove" data-sender="${esc(s)}">✕</button>
      </div>`).join("");
    el.querySelectorAll(".rule-remove").forEach(btn => {
      btn.addEventListener("click", () => onRemove(btn.dataset.sender));
    });
  }

  async function saveNewCategory() {
    const name  = $("catName").value.trim();
    const color = $("catColor").value;
    if (!name) return;
    const { data: cat, error } = await sb.from("mail_categories")
      .insert({ owner_email: mailAddress, name, color })
      .select().maybeSingle();
    if (error || !cat) return;
    categories.push(cat);
    rules[cat.id] = [...newCatRules];
    if (newCatRules.length) {
      await sb.from("mail_category_rules").insert(
        newCatRules.map(s => ({ category_id: cat.id, owner_email: mailAddress, sender_email: s }))
      );
    }
    $("catModal").classList.remove("open");
    renderCategoryFolders();
  }

  function openEditCat(catId) {
    editCatId    = catId;
    editCatRules = [...(rules[catId] || [])];
    const cat    = categories.find(c => c.id === catId);
    $("catEditName").value  = cat.name;
    $("catEditColor").value = cat.color;
    renderEditRules();
    $("editRuleInput").value = "";
    $("catEditModal").classList.add("open");
  }

  async function saveEditCategory() {
    const name  = $("catEditName").value.trim();
    const color = $("catEditColor").value;
    if (!name || !editCatId) return;
    await sb.from("mail_categories").update({ name, color }).eq("id", editCatId);
    await sb.from("mail_category_rules").delete().eq("category_id", editCatId);
    if (editCatRules.length) {
      await sb.from("mail_category_rules").insert(
        editCatRules.map(s => ({ category_id: editCatId, owner_email: mailAddress, sender_email: s }))
      );
    }
    const cat = categories.find(c => c.id === editCatId);
    if (cat) { cat.name = name; cat.color = color; }
    rules[editCatId] = [...editCatRules];
    $("catEditModal").classList.remove("open");
    renderCategoryFolders();
    if (currentCatId === editCatId) { listTitle.textContent = name; applyFilter(); }
  }

  async function deleteCategory() {
    if (!editCatId) return;
    await sb.from("mail_categories").delete().eq("id", editCatId);
    categories = categories.filter(c => c.id !== editCatId);
    delete rules[editCatId];
    $("catEditModal").classList.remove("open");
    if (currentFolder === "category" && currentCatId === editCatId) setFolder("inbox", null, "Inbox");
    renderCategoryFolders();
  }

  // ── Utilities ──────────────────────────────────────────────
  function esc(s) {
    return String(s||"")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function stripHtml(h) {
    const d = document.createElement("div"); d.innerHTML = h;
    return d.textContent || d.innerText || "";
  }
  function relTime(ts) {
    const d = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (d < 60)     return "just now";
    if (d < 3600)   return Math.floor(d/60)   + "m ago";
    if (d < 86400)  return Math.floor(d/3600)  + "h ago";
    if (d < 604800) return Math.floor(d/86400) + "d ago";
    return new Date(ts).toLocaleDateString(undefined, { month:"short", day:"numeric" });
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleString(undefined, {
      month:"short", day:"numeric", year:"numeric",
      hour:"numeric", minute:"2-digit"
    });
  }
})();
