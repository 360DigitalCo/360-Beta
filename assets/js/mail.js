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
  let mailAddress   = null;
  let currentFolder = "inbox";
  let currentCatId  = null;
  let allEmails     = [];
  let filteredEmails= [];
  let selectedId    = null;
  let deleteTarget  = null;
  let categories    = [];
  let rules         = {};
  let newCatRules   = [];
  let editCatId     = null;
  let editCatRules  = [];
  let pendingAttachments = []; // [{ filename, content_type, content (base64), size }]

  // ── DOM helpers ────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  // Null-safe style setter — avoids "Cannot read properties of null (reading 'style')"
  const safeStyle = (id, prop, val) => { const el = $(id); if (el) el.style[prop] = val; };
  const safeClass = (id, method, cls) => { const el = $(id); if (el) el.classList[method](cls); };

  // ── Boot ───────────────────────────────────────────────────
  (async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { $("mailGate").style.display = "flex"; return; }
    currentUser = session.user;
    await loadProfile();
    $("mailApp").style.display = "flex";
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
      $("mailGate").style.display = "flex";
      $("mailApp").style.display  = "none";
    }
  });

  // ── Profile ────────────────────────────────────────────────
  async function loadProfile() {
    const { data: p } = await sb.from("profiles")
      .select("mail_address,username").eq("id", currentUser.id).maybeSingle();
    mailAddress =
      p?.mail_address ||
      (p?.username ? p.username.toLowerCase().replace(/\s+/g,"") + "@360-search.com" : null) ||
      currentUser.email;
    $("myAddressPill").textContent = mailAddress || "No address";
  }

  // ── Load mail ──────────────────────────────────────────────
  async function loadMail() {
    if (!mailAddress) return;
    $("mailSkeletons").style.display = "block";
    const { data, error } = await sb.from("inbox")
      .select("*").eq("owner_email", mailAddress)
      .order("received_at", { ascending: false });
    $("mailSkeletons").style.display = "none";
    if (error) {
      $("mailListScroll").innerHTML = `<div class="mail-empty">
        <div class="mail-empty-icon">⚠️</div>
        <div class="mail-empty-text">Failed to load mail</div>
        <div class="mail-empty-sub">${esc(error.message)}</div></div>`;
      return;
    }
    allEmails = data || [];
    updateBadge(); applyFilter();
  }

  function updateBadge() {
    const n = allEmails.filter(e => e.direction === "in" && !e.read).length;
    $("inboxBadge").textContent   = n > 99 ? "99+" : n;
    $("inboxBadge").style.display = n > 0 ? "flex" : "none";
    const s = allEmails.filter(e => e.direction === "out" && e.status === "scheduled").length;
    $("scheduledBadge").textContent   = s > 99 ? "99+" : s;
    $("scheduledBadge").style.display = s > 0 ? "flex" : "none";
  }

  // ── Filter ─────────────────────────────────────────────────
  function applyFilter() {
    const q = $("mailSearch").value.trim().toLowerCase();
    let list = [...allEmails];
    if      (currentFolder === "inbox")    list = list.filter(e => e.direction === "in");
    else if (currentFolder === "sent")     list = list.filter(e => e.direction === "out" && e.status !== "scheduled");
    else if (currentFolder === "starred")  list = list.filter(e => e.starred);
    else if (currentFolder === "scheduled")list = list.filter(e => e.direction === "out" && e.status === "scheduled");
    else if (currentFolder === "category" && currentCatId) {
      const senders = (rules[currentCatId] || []).map(s => s.toLowerCase());
      list = list.filter(e => e.direction === "in" && senders.includes((e.from_addr||"").toLowerCase()));
    }
    if (q) list = list.filter(e =>
      (e.subject||"").toLowerCase().includes(q)   ||
      (e.from_addr||"").toLowerCase().includes(q)  ||
      (e.to_addr||"").toLowerCase().includes(q)    ||
      (e.body_text||"").toLowerCase().includes(q)
    );
    filteredEmails = list;
    $("listCount").textContent = list.length;
    renderList();
  }

  function renderList() {
    const scroll = $("mailListScroll");
    if (!filteredEmails.length) {
      const icons = { inbox:"📭", sent:"📨", starred:"⭐", scheduled:"⏰", category:"📂" };
      const msgs  = { inbox:"No messages yet", sent:"No sent messages", starred:"Nothing starred", scheduled:"Nothing scheduled", category:"No messages from these senders" };
      scroll.innerHTML = `<div class="mail-empty">
        <div class="mail-empty-icon">${icons[currentFolder]||"📭"}</div>
        <div class="mail-empty-text">${msgs[currentFolder]||"Empty"}</div>
        <div class="mail-empty-sub">${$("mailSearch").value ? "Try a different search" : ""}</div></div>`;
      return;
    }
    scroll.innerHTML = filteredEmails.map(e => {
      const unread  = e.direction === "in" && !e.read;
      const active  = e.id === selectedId;
      const display = e.direction === "out" ? (e.to_addr||"") : (e.from_addr||"");
      const preview = e.body_text || stripHtml(e.body_html||"") || "";
      const hasAtt  = e.attachments?.length > 0;
      const flags   = (e.status==="scheduled" ? `<span class="mi-flag" title="Scheduled for ${esc(fmtDate(e.scheduled_at))}">⏰</span>` : "")
                    + (e.expires_at ? `<span class="mi-flag" title="Expires ${esc(fmtDate(e.expires_at))}">⏳</span>` : "")
                    + (e.self_destruct ? `<span class="mi-flag" title="Self-destructs after reading">🔥</span>` : "");
      return `<div class="mail-item${unread?" unread":""}${active?" active":""}" data-id="${e.id}">
        <button class="mi-star${e.starred?" starred":""}" data-id="${e.id}">★</button>
        <div class="mi-row1">
          <span class="mi-from">${esc(display)}</span>
          ${hasAtt ? '<span class="mi-att" title="Has attachments">📎</span>' : ''}
          ${flags}
          <span class="mi-time">${e.status==="scheduled" ? relTime(e.scheduled_at) : relTime(e.received_at)}</span>
        </div>
        <div class="mi-subject">${esc(e.subject||"(no subject)")}</div>
        <div class="mi-preview">${esc(preview.slice(0,90))}</div>
      </div>`;
    }).join("");
    scroll.querySelectorAll(".mail-item").forEach(el =>
      el.addEventListener("click", ev => { if(ev.target.classList.contains("mi-star")) return; openEmail(el.dataset.id); })
    );
    scroll.querySelectorAll(".mi-star").forEach(btn =>
      btn.addEventListener("click", ev => { ev.stopPropagation(); toggleStar(btn.dataset.id); })
    );
  }

  // ── Open email ─────────────────────────────────────────────
  async function openEmail(id) {
    selectedId = id; renderList();
    const e = allEmails.find(x => x.id === id);
    if (!e) return;
    const willBurn = !!e.self_destruct && e.direction === "in";
    if (!e.read && e.direction === "in") {
      e.read = true;
      await sb.from("inbox").update({ read: true }).eq("id", id);
      updateBadge();
    }
    const isSent = e.direction === "out";
    $("rdSubject").textContent = e.subject || "(no subject)";
    $("rdFrom").textContent    = isSent ? "To: "+(e.to_addr||"") : "From: "+(e.from_addr||"");
    $("rdAddr").textContent    = isSent ? "" : "→ "+(e.to_addr||"");
    $("rdTime").textContent    = e.status === "scheduled" ? "Scheduled for "+fmtDate(e.scheduled_at) : fmtDate(e.received_at);
    $("rdStar").textContent    = e.starred ? "★ Unstar" : "☆ Star";

    // Badges
    const badges = [];
    if (e.status === "scheduled") badges.push(`<span class="mrh-badge scheduled">⏰ Scheduled — ${esc(fmtDate(e.scheduled_at))}</span>`);
    if (e.expires_at)             badges.push(`<span class="mrh-badge">⏳ Expires ${esc(fmtDate(e.expires_at))}</span>`);
    if (e.self_destruct)          badges.push(`<span class="mrh-badge burn">🔥 Self-destructs after reading</span>`);
    $("rdBadges").innerHTML = badges.join("");

    // Body — sanitized on render regardless of what's already in the DB
    const body = $("rdBody");
    let bodyHTML = "";
    if (willBurn) bodyHTML += `<div class="burn-banner">🔥 This message will self-destruct now that you've opened it.</div>`;
    if (e.body_html)       bodyHTML += `<div class="mail-body-html">${purify(e.body_html)}</div>`;
    else if (e.body_text)  bodyHTML += `<pre class="mail-body-plain">${esc(e.body_text)}</pre>`;
    else                   bodyHTML += `<div class="mail-body-plain" style="opacity:.4">No message body.</div>`;

    // Attachments display
    const atts = e.attachments || [];
    if (atts.length) {
      bodyHTML += `<div class="att-list">
        <div class="att-list-title">${atts.length} attachment${atts.length>1?"s":""}</div>
        ${atts.map((a,i) => `
          <div class="att-chip" data-att-idx="${i}" style="cursor:pointer;">
            <span class="att-icon-svg">${attIconSvg(a.content_type)}</span>
            <span class="att-name">${esc(a.filename)}</span>
            <span class="att-size">${fmtSize(a.size)}</span>
            ${a.download_url ? `<a class="att-dl" href="${esc(a.download_url)}" target="_blank" download="${esc(a.filename)}" onclick="event.stopPropagation()">Download</a>` : ""}
          </div>`).join("")}
      </div>`;
    }
    body.innerHTML = bodyHTML;
    // Attach viewer click handlers after innerHTML is set
    body.querySelectorAll(".att-chip[data-att-idx]").forEach(chip => {
      chip.addEventListener("click", () => openAttViewer(atts[parseInt(chip.dataset.attIdx)]));
    });
    return; // skip the duplicate body.innerHTML below
    $("noMailSelected").style.display  = "none";
    $("mailReadContent").style.display = "flex";
    $("rdBack").style.display          = window.innerWidth < 900 ? "flex" : "none";
    if (window.innerWidth < 900) {
      $("mailReadPane").classList.add("show");
      $("mailListPanel").classList.remove("show");
    }
    $("rdReply").onclick   = () => openCompose(e.from_addr||"", "Re: "+(e.subject||""));
    $("rdForward").onclick = () => openCompose("", "Fwd: "+(e.subject||""),
      null, "\n\n--- Forwarded ---\nFrom: "+(e.from_addr||"")+"\n\n"+(e.body_text||stripHtml(e.body_html||"")));
    $("rdStar").onclick    = () => toggleStar(id);
    $("rdDelete").onclick  = () => triggerDelete(id);
    safeStyle("rdCancelSchedule", "display", e.status === "scheduled" ? "flex" : "none");
    const _rcs = $("rdCancelSchedule"); if (_rcs) _rcs.onclick = () => cancelScheduled(id);

    if (willBurn) await burnEmail(id);
  }

  // ── Self-destruct ─────────────────────────────────────────
  async function burnEmail(id) {
    const email = allEmails.find(e => e.id === id);
    await deleteAttachments(email);
    await sb.from("inbox").delete().eq("id", id);
    allEmails = allEmails.filter(e => e.id !== id);
    updateBadge(); applyFilter();
  }

  // ── Cancel a scheduled send ─────────────────────────────────
  async function cancelScheduled(id) {
    await sb.from("inbox").delete().eq("id", id);
    allEmails = allEmails.filter(e => e.id !== id);
    if (selectedId === id) { selectedId = null; hideReadPane(); }
    updateBadge(); applyFilter();
  }

  function hideReadPane() {
    safeStyle("noMailSelected",  "display", "flex");
    safeStyle("mailReadContent", "display", "none");
  }

  $("rdBack").addEventListener("click", () => {
    $("mailReadPane").classList.remove("show");
    $("mailListPanel").classList.add("show");
  });

  // ── Star ───────────────────────────────────────────────────
  async function toggleStar(id) {
    const e = allEmails.find(x => x.id === id); if (!e) return;
    e.starred = !e.starred;
    await sb.from("inbox").update({ starred: e.starred }).eq("id", id);
    renderList();
    if (selectedId === id) $("rdStar").textContent = e.starred ? "★ Unstar" : "☆ Star";
    if (currentFolder === "starred") applyFilter();
  }

  // ── Delete ─────────────────────────────────────────────────
  function triggerDelete(id) { deleteTarget = id; $("confirmOverlay").classList.add("open"); }
  $("confirmCancel").addEventListener("click", () => { $("confirmOverlay").classList.remove("open"); deleteTarget = null; });
  $("confirmDelete").addEventListener("click", async () => {
    if (!deleteTarget) return;
    const _delEmail = allEmails.find(e => e.id === deleteTarget);
    await deleteAttachments(_delEmail);
    await sb.from("inbox").delete().eq("id", deleteTarget);
    allEmails = allEmails.filter(e => e.id !== deleteTarget);
    if (selectedId === deleteTarget) { selectedId = null; hideReadPane(); }
    deleteTarget = null;
    $("confirmOverlay").classList.remove("open");
    updateBadge(); applyFilter();
  });

  // ── Search ─────────────────────────────────────────────────
  function setupSearch() { $("mailSearch").addEventListener("input", applyFilter); }

  // ── Folder navigation ──────────────────────────────────────
  function setupBuiltinFolders() {
    document.querySelectorAll(".folder-item[data-builtin]").forEach(el => {
      el.addEventListener("click", ev => {
        if (ev.target.classList.contains("folder-reload-btn")) return;
        setFolder(el.dataset.folder, null,
          { inbox:"Inbox", sent:"Sent", starred:"Starred", scheduled:"Scheduled" }[el.dataset.folder] || el.dataset.folder);
      });
    });
  }

  function setFolder(folder, catId, title) {
    currentFolder = folder; currentCatId = catId || null;
    $("listTitle").textContent = title;
    selectedId = null; hideReadPane();
    document.querySelectorAll(".folder-item").forEach(f => f.classList.remove("active"));
    const target = catId
      ? document.querySelector(`.folder-item[data-cat-id="${catId}"]`)
      : document.querySelector(`.folder-item[data-builtin][data-folder="${folder}"]`);
    if (target) target.classList.add("active");
    applyFilter();
  }

  // ── Reload ─────────────────────────────────────────────────
  function setupReloadButtons() {
    document.querySelectorAll(".folder-item[data-builtin] .folder-reload-btn").forEach(btn => {
      btn.addEventListener("click", async ev => { ev.stopPropagation(); spinBtn(btn); await loadMail(); });
    });
    $("listReloadBtn").addEventListener("click", async () => { spinBtn($("listReloadBtn")); await loadMail(); });
  }
  function spinBtn(btn) { btn.classList.add("spinning"); setTimeout(() => btn.classList.remove("spinning"), 500); }

  // ── Realtime ───────────────────────────────────────────────
  function setupRealtime() {
    if (!mailAddress) return;
    sb.channel("inbox_rt")
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"inbox", filter:`owner_email=eq.${mailAddress}` },
        payload => { allEmails.unshift(payload.new); updateBadge(); applyFilter(); })
      .subscribe();
  }

  // ══════════════════════════════════════════════════════════
  // COMPOSE — rich text editor
  // ══════════════════════════════════════════════════════════
  function setupCompose() {
    $("composeBtn").addEventListener("click", () => openCompose());
    $("composeClose").addEventListener("click", closeCompose);
    $("cSendBtn").addEventListener("click", sendMail);
    setupRichEditor();
    setupAttachmentPicker();
    setupMailOptions();
    setupSelfDestructWatcher();
  }

  function setupSelfDestructWatcher() {
    const toInput   = $("cTo");
    const sdRow     = $("cSelfDestructRow");
    const sdToggle  = $("cSelfDestructToggle");
    const sdLock    = $("cSelfDestructLock");
    if (!toInput || !sdRow) return;
    function update() {
      const is360 = toInput.value.trim().toLowerCase().endsWith("@360-search.com");
      sdRow.classList.toggle("sd-locked", !is360);
      if (!is360) sdToggle.checked = false;
      sdToggle.disabled = !is360;
      if (sdLock) sdLock.style.display = is360 ? "none" : "flex";
    }
    toInput.addEventListener("input", update);
    update();
  }

  // ── Custom date/time picker helpers ───────────────────────
  function getDtValue(dateId, timeId) {
    const d = $(dateId).value.trim();
    const t = $(timeId).value.trim() || "00:00";
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    if (!/^\d{2}:\d{2}$/.test(t)) return null;
    return `${d}T${t}`;
  }
  function setDtValue(dateId, timeId, isoStr) {
    if (!isoStr) { $(dateId).value = ""; $(timeId).value = ""; return; }
    const d = new Date(isoStr);
    const pad = n => String(n).padStart(2,"0");
    $(dateId).value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    $(timeId).value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function buildCalendar(calId, dateInputId, timeInputId) {
    const cal = $(calId), dateInput = $(dateInputId), timeInput = $(timeInputId);
    dateInput.addEventListener("click", ev => {
      ev.stopPropagation();
      cal.style.display = cal.style.display === "none" ? "block" : "none";
      if (cal.style.display === "block") renderCal();
    });
    dateInput.addEventListener("input", () => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) renderCal();
    });
    document.addEventListener("click", ev => {
      if (!cal.contains(ev.target) && ev.target !== dateInput) cal.style.display = "none";
    });
    timeInput.addEventListener("input", ev => {
      let v = ev.target.value.replace(/[^\d]/g,"");
      if (v.length > 2) v = v.slice(0,2) + ":" + v.slice(2,4);
      ev.target.value = v;
    });
    function renderCal() {
      let cur = new Date(dateInput.value || Date.now());
      if (isNaN(cur)) cur = new Date();
      const year = cur.getFullYear(), month = cur.getMonth();
      const today = new Date(); today.setHours(0,0,0,0);
      const firstDay = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month+1, 0).getDate();
      const pad = n => String(n).padStart(2,"0");
      const mNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      let html = `<div class="cdt-cal-head">
        <button class="cdt-nav" data-m="-1">‹</button>
        <span class="cdt-month-label">${mNames[month]} ${year}</span>
        <button class="cdt-nav" data-m="1">›</button>
      </div><div class="cdt-cal-grid">`;
      ["Su","Mo","Tu","We","Th","Fr","Sa"].forEach(d => html += `<div class="cdt-dow">${d}</div>`);
      for (let i=0; i<firstDay; i++) html += `<div></div>`;
      for (let d=1; d<=daysInMonth; d++) {
        const dt = new Date(year, month, d);
        const isPast = dt < today;
        const isSel  = dateInput.value === `${year}-${pad(month+1)}-${pad(d)}`;
        html += `<button class="cdt-day${isSel?" sel":""}${isPast?" past":""}" data-date="${year}-${pad(month+1)}-${pad(d)}" ${isPast?"disabled":""}>${d}</button>`;
      }
      html += `</div>`;
      cal.innerHTML = html;
      cal.querySelectorAll(".cdt-nav").forEach(btn => btn.addEventListener("click", ev => {
        ev.stopPropagation();
        const nc = new Date(year, month + parseInt(btn.dataset.m), 1);
        dateInput.value = `${nc.getFullYear()}-${pad(nc.getMonth()+1)}-01`;
        renderCal();
      }));
      cal.querySelectorAll(".cdt-day:not([disabled])").forEach(btn => btn.addEventListener("click", ev => {
        ev.stopPropagation();
        dateInput.value = btn.dataset.date;
        cal.style.display = "none";
      }));
    }
  }

  function setupMailOptions() {
    buildCalendar("cExpireCal",   "cExpireDate",   "cExpireTime");
    buildCalendar("cScheduleCal", "cScheduleDate", "cScheduleTime");
    $("cExpireToggle").addEventListener("change", ev => {
      $("cExpireInputWrap").classList.toggle("show", ev.target.checked);
      if (ev.target.checked && !getDtValue("cExpireDate","cExpireTime"))
        setDtValue("cExpireDate","cExpireTime", new Date(Date.now()+24*3600*1000).toISOString());
    });
    $("cScheduleBtn").addEventListener("click", () => {
      const active = $("cScheduleRow").style.display !== "none";
      if (active) {
        $("cScheduleRow").style.display = "none";
        setDtValue("cScheduleDate","cScheduleTime",null);
        $("cScheduleBtn").classList.remove("active");
        $("cScheduleBtn").innerHTML = "<span class=\"sched-icon\"></span> Schedule";
      } else {
        $("cScheduleRow").style.display = "flex";
        if (!getDtValue("cScheduleDate","cScheduleTime"))
          setDtValue("cScheduleDate","cScheduleTime", new Date(Date.now()+3600*1000).toISOString());
        $("cScheduleBtn").classList.add("active");
        $("cScheduleBtn").innerHTML = "<span class=\"cancel-icon\"></span> Cancel schedule";
      }
    });
  }

  function setupRichEditor() {
    // Formatting toolbar buttons
    document.querySelectorAll(".fmt-btn[data-cmd]").forEach(btn => {
      btn.addEventListener("mousedown", ev => {
        ev.preventDefault(); // keep focus in editor
        const cmd = btn.dataset.cmd;
        const val = btn.dataset.val || null;
        if (cmd === "createLink") {
          const url = prompt("Enter URL:", "https://");
          if (url) document.execCommand("createLink", false, url);
        } else {
          document.execCommand(cmd, false, val);
        }
        updateToolbarState();
      });
    });

    // Font size select
    $("cFontSize") && $("cFontSize").addEventListener("change", ev => {
      document.execCommand("fontSize", false, ev.target.value);
      $("cEditor").focus();
    });

    // Update toolbar active states on cursor move
    const editor = $("cEditor");
    editor.addEventListener("keyup",   updateToolbarState);
    editor.addEventListener("mouseup", updateToolbarState);
    editor.addEventListener("focus",   updateToolbarState);

    // Raw HTML source toggle — write/paste actual HTML directly
    $("cHtmlToggle").addEventListener("click", () => {
      const src = $("cHtmlSource"), ed = $("cEditor");
      const goingToHtml = !src.classList.contains("show");
      if (goingToHtml) {
        src.value = ed.innerHTML;
        ed.classList.add("hide"); src.classList.add("show");
      } else {
        ed.innerHTML = purify(src.value);
        ed.classList.remove("hide"); src.classList.remove("show");
      }
      $("cHtmlToggle").classList.toggle("active", goingToHtml);
    });
  }

  function updateToolbarState() {
    const cmds = ["bold","italic","underline","strikeThrough","insertOrderedList","insertUnorderedList"];
    cmds.forEach(cmd => {
      const btn = document.querySelector(`.fmt-btn[data-cmd="${cmd}"]`);
      if (btn) btn.classList.toggle("active", document.queryCommandState(cmd));
    });
  }

  function setupAttachmentPicker() {
    const input = $("cAttachInput");
    $("cAttachBtn").addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      for (const file of Array.from(input.files)) {
        if (file.size > 10 * 1024 * 1024) { alert(`${file.name} is too large (max 10MB).`); continue; }
        const b64 = await fileToBase64(file);
        pendingAttachments.push({ filename: file.name, content_type: file.type || "application/octet-stream", content: b64, size: file.size });
      }
      input.value = "";
      renderPendingAttachments();
    });
  }

  function renderPendingAttachments() {
    const wrap = $("cAttachList");
    if (!pendingAttachments.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = pendingAttachments.map((a, i) => `
      <div class="c-att-chip">
        <span class="att-icon">${attIcon(a.content_type)}</span>
        <span class="c-att-name">${esc(a.filename)}</span>
        <span class="att-size">${fmtSize(a.size)}</span>
        <button class="c-att-remove" data-idx="${i}">✕</button>
      </div>`).join("");
    wrap.querySelectorAll(".c-att-remove").forEach(btn =>
      btn.addEventListener("click", () => {
        pendingAttachments.splice(parseInt(btn.dataset.idx), 1);
        renderPendingAttachments();
      })
    );
  }

  function openCompose(to = "", subject = "", htmlBody = null, textBody = "") {
    $("cTo").value      = to;
    $("cSubject").value = subject;
    $("cEditor").classList.remove("hide");
    $("cHtmlSource").classList.remove("show");
    $("cHtmlToggle").classList.remove("active");
    $("cEditor").innerHTML = htmlBody || (textBody ? `<p>${esc(textBody).replace(/\n/g,"<br>")}</p>` : "");
    $("cHtmlSource").value = "";
    $("cStatus").textContent = "";
    $("cStatus").className   = "compose-status";
    $("cSendBtn").disabled   = false;
    $("cSendBtn").innerHTML  = "<span class=\"send-icon\"></span> Send";
    pendingAttachments = [];
    renderPendingAttachments();
    $("cExpireToggle").checked = false;
    $("cExpireInputWrap").classList.remove("show");
    setDtValue("cExpireDate","cExpireTime",null);
    $("cSelfDestructToggle").checked = false;
    $("cScheduleRow").style.display = "none";
    setDtValue("cScheduleDate","cScheduleTime",null);
    $("cScheduleBtn").classList.remove("active");
    $("cScheduleBtn").innerHTML = "<span class=\"sched-icon\"></span> Schedule";
    $("composeModal").classList.add("open");
    setTimeout(() => $("cTo").focus(), 80);
  }

  function closeCompose() { $("composeModal").classList.remove("open"); }

  async function sendMail() {
    const to      = $("cTo").value.trim();
    const subject = $("cSubject").value.trim();
    // If the raw-HTML view is open, fold its contents back into the editor first
    if ($("cHtmlSource").classList.contains("show")) {
      $("cEditor").innerHTML = purify($("cHtmlSource").value);
    }
    const html    = purify($("cEditor").innerHTML.trim());
    const text    = $("cEditor").innerText.trim();
    const btn     = $("cSendBtn");
    const status  = $("cStatus");

    if (!to || !subject || !text) {
      status.textContent = "To, subject, and message are required.";
      status.className   = "compose-status err"; return;
    }

    const expireOn    = $("cExpireToggle").checked;
    const _expDt = getDtValue("cExpireDate","cExpireTime");
    const expiresAt = expireOn && _expDt ? new Date(_expDt).toISOString() : null;
    if (expireOn && !expiresAt) {
      status.textContent = "Pick an expiration date, or turn the toggle off.";
      status.className   = "compose-status err"; return;
    }
    const selfDestruct = $("cSelfDestructToggle").checked;
    const scheduleOn   = $("cScheduleRow").style.display !== "none";
    const _schDt = getDtValue("cScheduleDate","cScheduleTime");
    const scheduledAt = scheduleOn && _schDt ? new Date(_schDt).toISOString() : null;
    if (scheduleOn && !scheduledAt) {
      status.textContent = "Pick a send time, or click Schedule again to cancel.";
      status.className   = "compose-status err"; return;
    }

    btn.disabled  = true;
    btn.innerHTML = "<span class=\"send-icon spin\"></span> Sending…";
    status.textContent = "";

    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch(`${SB_URL}/functions/v1/send-email`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "Authorization":`Bearer ${session.access_token}`, "apikey":SB_ANON },
        body: JSON.stringify({
          to, subject, html, text,
          attachments: pendingAttachments.map(a => ({ filename: a.filename, content_type: a.content_type, content: a.content })),
          expiresAt, selfDestruct, scheduledAt,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.error || "Send failed");
      status.textContent = json.delivery === "scheduled" ? "Scheduled" : "Sent";
      status.className = "compose-status ok";
      btn.innerHTML = "<span class=\"send-icon\"></span> Send"; btn.disabled = false;
      setTimeout(closeCompose, 1200);
      await loadMail();
    } catch (err) {
      status.textContent = err.message; status.className = "compose-status err";
      btn.innerHTML = "<span class=\"send-icon\"></span> Send"; btn.disabled = false;
    }
  }


  // ══════════════════════════════════════════════════════════
  // ATTACHMENT VIEWER
  // ══════════════════════════════════════════════════════════
  function openAttViewer(att) {
    if (!att) return;
    const overlay = $("attViewerOverlay");
    const body    = $("attViewerBody");
    const name    = $("attViewerName");
    const dlBtn   = $("attViewerDl");
    const runWrap = $("attRunWrap");
    const runTog  = $("attRunToggle");
    if (!overlay || !body) return;

    name.textContent = att.filename || "Attachment";
    dlBtn.href       = att.download_url || "#";
    dlBtn.download   = att.filename || "attachment";
    dlBtn.style.display = att.download_url ? "inline-flex" : "none";

    const ct  = (att.content_type || "").toLowerCase();
    const ext = (att.filename || "").split(".").pop().toLowerCase();

    // Determine type
    const isImage = ct.startsWith("image/") || ["png","jpg","jpeg","gif","webp","svg","bmp"].includes(ext);
    const isAudio = ct.startsWith("audio/") || ["mp3","wav","ogg","flac","aac","m4a"].includes(ext);
    const isVideo = ct.startsWith("video/") || ["mp4","webm","mov","avi","mkv"].includes(ext);
    const isPdf   = ct.includes("pdf") || ext === "pdf";
    const isText  = ct.startsWith("text/") || ["txt","md","csv","log","ini","conf","yaml","yml","toml","xml","json"].includes(ext);
    const isCode  = ["js","ts","jsx","tsx","html","css","py","java","c","cpp","cs","php","rb","go","rs","sh","bash","sql"].includes(ext);
    const isRunnable = ["html","js"].includes(ext); // only safe-ish to run

    runTog.checked = false;
    runWrap.style.display = isRunnable ? "flex" : "none";

    function renderContent(run) {
      if (isImage && att.download_url) {
        body.innerHTML = `<div class="av-img-wrap"><img src="${esc(att.download_url)}" alt="${esc(att.filename)}" class="av-img"/></div>`;
      } else if (isAudio && att.download_url) {
        body.innerHTML = `<div class="av-audio-wrap"><audio controls src="${esc(att.download_url)}" class="av-audio"></audio><div class="av-audio-label">${esc(att.filename)}</div></div>`;
      } else if (isVideo && att.download_url) {
        body.innerHTML = `<video controls src="${esc(att.download_url)}" class="av-video"></video>`;
      } else if (isPdf && att.download_url) {
        body.innerHTML = `<iframe src="${esc(att.download_url)}" class="av-pdf" title="${esc(att.filename)}"></iframe>`;
      } else if ((isText || isCode) && att.download_url) {
        if (isRunnable && run) {
          if (ext === "html") {
            body.innerHTML = `<iframe src="${esc(att.download_url)}" class="av-run-frame" sandbox="allow-scripts allow-same-origin" title="Preview"></iframe>`;
          } else {
            body.innerHTML = `<div class="av-placeholder">JS execution requires the file to be embedded in a page.<br>Download to run locally.</div>`;
          }
        } else {
          body.innerHTML = `<div class="av-loading">Loading…</div>`;
          fetch(att.download_url)
            .then(r => r.text())
            .then(text => {
              body.innerHTML = `<pre class="av-code ${isCode ? "av-code-hl" : ""}">${esc(text)}</pre>`;
            })
            .catch(() => { body.innerHTML = `<div class="av-placeholder">Could not load file content.</div>`; });
        }
      } else {
        body.innerHTML = `<div class="av-placeholder">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="opacity:.35;margin-bottom:12px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8L14 2Z" stroke="currentColor" stroke-width="1.6"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          <div>No preview available</div>
          ${att.download_url ? `<a href="${esc(att.download_url)}" download="${esc(att.filename)}" class="att-dl-btn" style="margin-top:12px;">Download to view</a>` : ""}
        </div>`;
      }
    }

    runTog.onchange = () => renderContent(runTog.checked);
    renderContent(false);
    overlay.classList.add("open");
  }

  $("attViewerClose") && $("attViewerClose").addEventListener("click", () => {
    $("attViewerOverlay").classList.remove("open");
    // Stop any media playing
    $("attViewerBody").querySelectorAll("audio,video").forEach(m => m.pause());
    $("attViewerBody").innerHTML = "";
  });
  $("attViewerOverlay") && $("attViewerOverlay").addEventListener("click", ev => {
    if (ev.target === $("attViewerOverlay")) {
      $("attViewerOverlay").classList.remove("open");
      $("attViewerBody").querySelectorAll("audio,video").forEach(m => m.pause());
      $("attViewerBody").innerHTML = "";
    }
  });

  // Delete attachments from Resend when email is burned/deleted
  async function deleteAttachments(email) {
    const atts = email?.attachments || [];
    if (!atts.length || !email?.resend_id) return;
    // Resend stores inbound attachments; we can only inform — no public delete API yet.
    // Just clear from our DB record.
    await sb.from("inbox").update({ attachments: [] }).eq("id", email.id).catch(() => {});
  }


  // ── Categories ─────────────────────────────────────────────
  async function loadCategories() {
    if (!mailAddress) return;
    const { data: cats } = await sb.from("mail_categories").select("*").eq("owner_email", mailAddress).order("created_at");
    categories = cats || [];
    if (categories.length) {
      const { data: ruleRows } = await sb.from("mail_category_rules").select("*").eq("owner_email", mailAddress);
      rules = {};
      (ruleRows||[]).forEach(r => { if (!rules[r.category_id]) rules[r.category_id]=[]; rules[r.category_id].push(r.sender_email); });
    }
    renderCategoryFolders();
  }

  function renderCategoryFolders() {
    const customList = $("customFolderList");
    customList.innerHTML = "";
    categories.forEach(cat => {
      const div = document.createElement("div");
      div.className = "folder-item"; div.dataset.catId = cat.id; div.dataset.folder = "category";
      div.innerHTML = `<span class="fi-icon" style="color:${esc(cat.color)}">●</span>
        <span class="fi-name">${esc(cat.name)}</span>
        <button class="folder-reload-btn" title="Reload">↻</button>
        <button class="folder-del-btn" title="Edit">✎</button>`;
      div.addEventListener("click", ev => {
        if (ev.target.classList.contains("folder-del-btn"))    { openEditCat(cat.id); return; }
        if (ev.target.classList.contains("folder-reload-btn")) { spinBtn(ev.target); loadMail(); return; }
        setFolder("category", cat.id, cat.name);
      });
      customList.appendChild(div);
    });
    customList.querySelectorAll(".folder-reload-btn").forEach(btn =>
      btn.addEventListener("click", async ev => { ev.stopPropagation(); spinBtn(btn); await loadMail(); })
    );
    const label = $("customFolderLabel");
    if (categories.length > 0) {
      label.style.display = "flex";
      label.innerHTML = `Categories <button class="folder-add-btn" id="catLabelAddBtn">＋</button>`;
      $("catLabelAddBtn").addEventListener("click", openNewCatModal);
    } else { label.style.display = "none"; }
  }

  function setupCategoryModals() {
    $("addCategoryBtnAlt").addEventListener("click", openNewCatModal);
    $("catModalCancel").addEventListener("click",    () => $("catModal").classList.remove("open"));
    $("catModalSave").addEventListener("click",      saveNewCategory);
    $("ruleAddBtn").addEventListener("click", () => addRule($("ruleInput"), newCatRules, "ruleList", renderNewRules));
    $("ruleInput").addEventListener("keydown", ev => { if(ev.key==="Enter") addRule($("ruleInput"),newCatRules,"ruleList",renderNewRules); });
    $("catEditCancel").addEventListener("click",  () => $("catEditModal").classList.remove("open"));
    $("catEditSave").addEventListener("click",    saveEditCategory);
    $("catEditDelete").addEventListener("click",  deleteCategory);
    $("editRuleAddBtn").addEventListener("click", () => addRule($("editRuleInput"),editCatRules,"editRuleList",renderEditRules));
    $("editRuleInput").addEventListener("keydown", ev => { if(ev.key==="Enter") addRule($("editRuleInput"),editCatRules,"editRuleList",renderEditRules); });
  }

  function openNewCatModal() {
    newCatRules = []; $("catName").value=""; $("catColor").value="#6366f1";
    $("ruleList").innerHTML=""; $("ruleInput").value="";
    $("catModal").classList.add("open"); setTimeout(() => $("catName").focus(), 80);
  }
  function addRule(input, arr, listId, renderFn) {
    const val = input.value.trim().toLowerCase(); if (!val||arr.includes(val)){input.value="";return;}
    arr.push(val); input.value=""; renderFn();
  }
  function renderNewRules() { renderRuleList("ruleList", newCatRules, s=>{newCatRules.splice(newCatRules.indexOf(s),1);renderNewRules();}); }
  function renderEditRules(){ renderRuleList("editRuleList",editCatRules,s=>{editCatRules.splice(editCatRules.indexOf(s),1);renderEditRules();}); }
  function renderRuleList(listId, arr, onRemove) {
    const el = $(listId); if (!arr.length){el.innerHTML="";return;}
    el.innerHTML = arr.map(s=>`<div class="rule-item"><span>${esc(s)}</span><button class="rule-remove" data-sender="${esc(s)}">✕</button></div>`).join("");
    el.querySelectorAll(".rule-remove").forEach(btn=>btn.addEventListener("click",()=>onRemove(btn.dataset.sender)));
  }
  async function saveNewCategory() {
    const name=$("catName").value.trim(), color=$("catColor").value; if(!name)return;
    const {data:cat,error}=await sb.from("mail_categories").insert({owner_email:mailAddress,name,color}).select().maybeSingle();
    if(error||!cat)return;
    categories.push(cat); rules[cat.id]=[...newCatRules];
    if(newCatRules.length) await sb.from("mail_category_rules").insert(newCatRules.map(s=>({category_id:cat.id,owner_email:mailAddress,sender_email:s})));
    $("catModal").classList.remove("open"); renderCategoryFolders();
  }
  function openEditCat(catId) {
    editCatId=catId; editCatRules=[...(rules[catId]||[])];
    const cat=categories.find(c=>c.id===catId);
    $("catEditName").value=cat.name; $("catEditColor").value=cat.color;
    renderEditRules(); $("editRuleInput").value=""; $("catEditModal").classList.add("open");
  }
  async function saveEditCategory() {
    const name=$("catEditName").value.trim(), color=$("catEditColor").value; if(!name||!editCatId)return;
    await sb.from("mail_categories").update({name,color}).eq("id",editCatId);
    await sb.from("mail_category_rules").delete().eq("category_id",editCatId);
    if(editCatRules.length) await sb.from("mail_category_rules").insert(editCatRules.map(s=>({category_id:editCatId,owner_email:mailAddress,sender_email:s})));
    const cat=categories.find(c=>c.id===editCatId); if(cat){cat.name=name;cat.color=color;}
    rules[editCatId]=[...editCatRules];
    $("catEditModal").classList.remove("open"); renderCategoryFolders();
    if(currentCatId===editCatId){$("listTitle").textContent=name;applyFilter();}
  }
  async function deleteCategory() {
    if(!editCatId)return;
    await sb.from("mail_categories").delete().eq("id",editCatId);
    categories=categories.filter(c=>c.id!==editCatId); delete rules[editCatId];
    $("catEditModal").classList.remove("open");
    if(currentFolder==="category"&&currentCatId===editCatId) setFolder("inbox",null,"Inbox");
    renderCategoryFolders();
  }

  // ── Utilities ──────────────────────────────────────────────
  function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  // Sanitize on render, in addition to server-side sanitization — covers
  // older rows written before sanitization existed and any future insert
  // path that bypasses the edge functions.
  function purify(html) {
    if (window.DOMPurify) {
      return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p','br','b','strong','i','em','u','s','strike','span','div','a','img','ul','ol','li',
          'blockquote','h1','h2','h3','h4','h5','h6','hr','table','thead','tbody','tr','td','th','code','pre','font','sub','sup'],
        ALLOWED_ATTR: ['href','title','target','rel','src','alt','width','height','style','color','size','face','colspan','rowspan'],
      });
    }
    return esc(html); // DOMPurify failed to load — fail safe to plain text
  }
  function stripHtml(h){ const d=document.createElement("div");d.innerHTML=h;return d.textContent||d.innerText||""; }
  function relTime(ts){
    const d=Math.floor((Date.now()-new Date(ts).getTime())/1000);
    if(d<60) return "just now"; if(d<3600) return Math.floor(d/60)+"m ago";
    if(d<86400) return Math.floor(d/3600)+"h ago"; if(d<604800) return Math.floor(d/86400)+"d ago";
    return new Date(ts).toLocaleDateString(undefined,{month:"short",day:"numeric"});
  }
  function fmtDate(ts){ return new Date(ts).toLocaleString(undefined,{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}); }
  function fmtSize(b){ if(!b)return ""; if(b<1024)return b+"B"; if(b<1048576)return (b/1024).toFixed(1)+"KB"; return (b/1048576).toFixed(1)+"MB"; }
  function attIcon(ct){ return ""; }
  function attIconSvg(ct) {
    const t = (ct||"").toLowerCase();
    if (t.startsWith("image/"))  return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="8.5" r="1.5" fill="currentColor"/><path d="m2 14 4-4 3 3 3-2 5 4" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    if (t.includes("pdf"))       return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M12 2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7l-4-5Z" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    if (t.startsWith("audio/"))  return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M4 13V8l8-5v10" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="4" cy="13" r="2" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="13" r="2" stroke="currentColor" stroke-width="1.6"/></svg>';
    if (t.startsWith("video/"))  return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><rect x="2" y="5" width="11" height="10" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="m13 8 5-3v10l-5-3V8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    if (t.includes("zip"))       return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M12 2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7l-4-5Z" stroke="currentColor" stroke-width="1.6"/><path d="M10 10v5M8 12h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    if (t.includes("sheet"))     return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M2 7h16M7 7v11" stroke="currentColor" stroke-width="1.4"/></svg>';
    return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M12 2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7l-4-5Z" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  }
  function fileToBase64(file){
    return new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=()=>res(r.result.split(",")[1]);
      r.onerror=()=>rej(new Error("Read failed"));
      r.readAsDataURL(file);
    });
  }
})();
