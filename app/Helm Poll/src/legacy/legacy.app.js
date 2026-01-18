(() => {
  "use strict";

  // =========================
  // Storage keys
  // =========================
  const LS_API = "breadpoll_api";
  const LS_TOKENS = "breadpoll_tokens"; // poll_id -> voter_token (device-local)
  const LS_LOCAL_POLLS = "breadpoll_local_polls_v1"; // array of poll objects
  const LS_LOCAL_VOTES = "breadpoll_local_votes_v1"; // poll_id -> { byToken: {token: choice}, counts: {option: n} }

  // =========================
  // API base selection (optional)
  // =========================
  const params = new URLSearchParams(location.search);
  const apiOverride = params.get("api");
  let API = apiOverride || localStorage.getItem(LS_API) || "http://127.0.0.1:8787/api";

  // =========================
  // Runtime state
  // =========================
  let es = null; // EventSource (remote live stream only)
  let currentPollId = null;
  let quill = null; // optional Quill instance

  // =========================
  // Helpers: tokens
  // =========================
  function getTokens() {
    try {
      return JSON.parse(localStorage.getItem(LS_TOKENS) || "{}");
    } catch (e) {
      return {};
    }
  }

  function setToken(pollId, token) {
    const t = getTokens();
    t[pollId] = token;
    localStorage.setItem(LS_TOKENS, JSON.stringify(t));
  }

  function getToken(pollId) {
    const t = getTokens();
    return t[pollId] || null;
  }

  function ensureLocalToken(pollId) {
    let tok = getToken(pollId);
    if (!tok) {
      tok = "localtok_" + makeId();
      setToken(pollId, tok);
    }
    return tok;
  }

  // =========================
  // Helpers: local polls
  // =========================
  function loadLocalPolls() {
    try {
      return JSON.parse(localStorage.getItem(LS_LOCAL_POLLS) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveLocalPolls(polls) {
    localStorage.setItem(LS_LOCAL_POLLS, JSON.stringify(polls));
  }

  function addLocalPoll(p) {
    const polls = loadLocalPolls();
    polls.unshift(p);
    saveLocalPolls(polls);
  }

  function removeLocalPoll(id) {
    const polls = loadLocalPolls();
    const next = polls.filter(p => p.id !== id);
    saveLocalPolls(next);
  }

  function getLocalPoll(id) {
    const polls = loadLocalPolls();
    return polls.find(p => p.id === id) || null;
  }

  // =========================
  // Helpers: local votes/results
  // =========================
  function loadLocalVotesAll() {
    try {
      return JSON.parse(localStorage.getItem(LS_LOCAL_VOTES) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveLocalVotesAll(obj) {
    localStorage.setItem(LS_LOCAL_VOTES, JSON.stringify(obj));
  }

  function getLocalVoteState(pollId, options) {
    const all = loadLocalVotesAll();
    const st = all[pollId] || { byToken: {}, counts: {} };

    // Ensure counts keys exist for current options
    const counts = st.counts || {};
    (options || []).forEach(opt => {
      if (typeof counts[opt] !== "number") counts[opt] = 0;
    });

    st.counts = counts;
    all[pollId] = st;
    saveLocalVotesAll(all);

    return st;
  }

  function setLocalVote(pollId, token, choice, options) {
    const all = loadLocalVotesAll();
    const st = all[pollId] || { byToken: {}, counts: {} };

    st.byToken = st.byToken || {};
    st.counts = st.counts || {};

    // Initialize counts for options
    (options || []).forEach(opt => {
      if (typeof st.counts[opt] !== "number") st.counts[opt] = 0;
    });

    const prev = st.byToken[token];

    // If changing vote, decrement old choice
    if (prev && typeof st.counts[prev] === "number") {
      st.counts[prev] = Math.max(0, st.counts[prev] - 1);
    }

    // Set new
    st.byToken[token] = choice;
    if (typeof st.counts[choice] !== "number") st.counts[choice] = 0;
    st.counts[choice] += 1;

    all[pollId] = st;
    saveLocalVotesAll(all);
  }

  function buildLocalResults(poll) {
    const st = getLocalVoteState(poll.id, poll.options || []);
    const counts = st.counts || {};
    const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);

    return {
      poll_id: poll.id,
      total_votes: total,
      counts: counts,
    };
  }
 
  // =========================
  // Exchange operator write-gate (TEMPORARY)
  // =========================
  // Purpose: prevent unauthenticated public writes to the exchange (anti-vandalism).
  // This is NOT identity, legitimacy, delta, or vote-weighting.
  // Replace later with governance-native mechanisms.
  function getExchangeBasicAuthHeaderOrNull() {
    const user = (localStorage.getItem("exchange_basic_user") || "").trim();
    const pass = (localStorage.getItem("exchange_basic_pass") || "").trim();
    if (!user || !pass) return null;
    // btoa expects latin1; keep creds ASCII for now.
    return "Basic " + btoa(user + ":" + pass);
  }


  // =========================
  // UI helpers
  // =========================
  function escapeHtml(s) {
    return String(s).replace(/[&<>\"']/g, m => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;",
    }[m]));
  }

  function makeId() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return String(Date.now()) + "_" + Math.random().toString(16).slice(2);
  }

  function closeStream() {
    if (es) {
      try { es.close(); } catch {}
    }
    es = null;
  }

  function showApiCardIfNeeded() {
    const apiCard = document.getElementById("apiCard");
    if (!apiCard) return;
    if (params.get("settings") === "1") apiCard.style.display = "block";
  }

  async function ping() {
    const apiStatus = document.getElementById("apiStatus");
    try {
      const r = await fetch(`${API}/health`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      if (apiStatus) apiStatus.textContent = "Connected.";
      return true;
    } catch (e) {
      if (apiStatus) apiStatus.textContent = "Not connected.";
      return false;
    }
  }

  // =========================
  // Quill (optional)
  // =========================
  function initQuestionEditor() {
    const el = document.getElementById("questionEditor");
    if (!el) return null;

    if (typeof window.Quill === "undefined") {
      console.warn("Quill not loaded; editor disabled (safe).");
      return null;
    }

    if (el.__quill_inited) return quill;
    el.__quill_inited = true;

    quill = new window.Quill(el, {
      theme: "snow",
      placeholder: "Write details here… (links, emphasis, lists)",
      modules: {
        toolbar: [
          ["bold", "italic", "underline"],
          [{ list: "ordered" }, { list: "bullet" }],
          ["link"],
          ["clean"],
        ],
      },
    });

    return quill;
  }

  // =========================
  // Share / QR (optional)
  // =========================
  function pollLink(pollId) {
    const url = new URL(window.location.href);
    url.hash = `#poll=${encodeURIComponent(String(pollId))}`;
    return url.toString();
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  function openQr(link) {
    const modal = document.getElementById("qrModal");
    const qrBox = document.getElementById("qrBox");
    const linkText = document.getElementById("qrLinkText");

    if (linkText) linkText.textContent = link;
    if (modal) modal.style.display = "block";
    if (qrBox) qrBox.innerHTML = "";

    if (typeof window.QRCode === "undefined") {
      console.warn("QRCode library not loaded; showing link only.");
      return;
    }

    try {
      if (qrBox) new window.QRCode(qrBox, { text: link, width: 220, height: 220 });
    } catch (e) {
      console.log("QR render failed:", e);
    }
  }

  // =========================
  // Poll list rendering
  // =========================
  function renderPollList(polls) {
    const list = document.getElementById("pollList");
    const empty = document.getElementById("emptyState");
    const q = (document.getElementById("search")?.value || "").trim().toLowerCase();

    if (!list || !empty) return;

    list.innerHTML = "";
    empty.style.display = "block";
    empty.textContent = "";

    const filtered = q
      ? polls.filter(p => (p.title || "").toLowerCase().includes(q))
      : polls;

    if (!filtered.length) {
      empty.style.display = "block";
      empty.textContent = "No local polls yet. Create one above.";
      return;
    }

    empty.style.display = "none";

    for (const p of filtered) {
      const div = document.createElement("div");
      const isClosed = !!(p.closed || p.is_closed || p.status === "CLOSED");
      const badge = p.is_local ? "Local" : "Remote";

      div.className = "list-item";
      div.innerHTML = `
        <div style="min-width:0;">
          <div class="title" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(p.title || "(untitled)")}
          </div>
          <div class="meta">
            <span>${escapeHtml(p.poll_type || "")}</span>
            <span class="chip ${isClosed ? "closed" : "open"}">${isClosed ? "Closed" : "Open"}</span>
            <span class="chip">${badge}</span>
          </div>
        </div>
        <button class="btn-small btn-primary" type="button">Vote</button>
      `;

      const voteBtn = div.querySelector("button");
      if (voteBtn) voteBtn.onclick = (e) => { e.stopPropagation(); openPoll(p); };
      div.onclick = () => openPoll(p);

      list.appendChild(div);
    }
  }

  // =========================
  // Refresh polls (Local-first; remote optional)
  // =========================
  async function refreshPolls() {
    const local = loadLocalPolls().map(p => ({ ...p, is_local: true }));
    renderPollList(local);

    // Optional remote merge (never breaks local)
    try {
      const r = await fetch(`${API}/polls`, { cache: "no-store" });
      if (!r.ok) return;
      const remote = await r.json();
      const remotePolls = remote?.polls;
      if (!Array.isArray(remotePolls)) return;

      const localIds = new Set(local.map(p => p.id));
      const merged = [...local];

      for (const p of remotePolls) {
        if (!localIds.has(p.id)) merged.push({ ...p, is_local: false });
      }

      renderPollList(merged);
    } catch (e) {
      // ignore; local already shown
    }
  }

  // =========================
  // Open poll (Local-first)
  // =========================
  
  function openFromHash() {
    const m = /#poll=([^&]+)/.exec(window.location.hash || "");
    if (!m) return;
    const pollId = decodeURIComponent(m[1] || "");
    if (!pollId) return;

    const local = getLocalPoll(pollId);
    if (local) {
      openPoll({ ...local, is_local: true });
    } else {
      openPoll({ id: pollId, is_local: false });
    }
  }

  async function openPoll(p) {
    const pollId = p?.id;
    if (!pollId) return;

    const isLocal = !!p?.is_local || String(pollId).startsWith("local_");
    currentPollId = pollId;

    const pollView = document.getElementById("pollView");
    const pollTitle = document.getElementById("pollTitle");
    const pollMeta = document.getElementById("pollMeta");
    const voteOut = document.getElementById("voteOut");
    const resultsBox = document.getElementById("resultsBox");
    const vb = document.getElementById("voteButtons");
    const shareLinkEl = document.getElementById("shareLink");
    const assertBtn = document.getElementById("assertBtn");
    const assertOut = document.getElementById("assertOut");
    if (shareLinkEl) {
      const url = location.origin + location.pathname + "#poll=" + pollId;
      shareLinkEl.href = url;
      shareLinkEl.textContent = url;
    }

    if (pollView) pollView.style.display = "block";
    if (voteOut) voteOut.textContent = "";
    if (resultsBox) resultsBox.textContent = "";
    if (vb) vb.innerHTML = "";
    if (assertOut) assertOut.textContent = "";

    let full = p;

    if (isLocal) {
      full = getLocalPoll(pollId) || p;
      full.is_local = true;
    } else {
      // Remote best-effort: exchange doesn't support GET /api/polls/:id.
      // We show a shell and let the SSE snapshot ("poll" event) fill in details.
      full = { ...p, id: pollId, is_local: false };
    }

    const isLocalNow = !!full?.is_local || String(full?.id).startsWith("local_");

    const pollTypeText = full?.poll_type ?? full?.meta?.poll_type ?? "";
    if (pollTitle) pollTitle.textContent = (full && full.title) ? full.title : "(untitled)";
    if (pollMeta) pollMeta.textContent = `${pollTypeText}${isLocalNow ? " • Local" : " • Remote"}`;

    // Assertion-to-exchange UI (local drafts only)
    if (assertBtn) {
      assertBtn.style.display = isLocalNow ? "" : "none";
      assertBtn.onclick = () => assertPollToExchange(full);
    }

    // Vote buttons
    if (vb) {
      (full?.options || []).forEach(opt => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = opt?.label ?? opt;
        b.onclick = () => castVote(full, opt?.label ?? opt);
        vb.appendChild(b);
      });
    }

    // Results display
    closeStream();

    if (isLocalNow) {
      const res = buildLocalResults(full);
      if (resultsBox) resultsBox.textContent = JSON.stringify(res, null, 2);
    } else {
      // Remote stream (optional)
      try {
        es = new EventSource(`${API}/polls/${pollId}/stream`);
        es.addEventListener("poll", (ev) => {
          try {
            const obj = JSON.parse(ev.data);
            if (obj?.poll) {
              full = { ...obj.poll, is_local: false };
              if (pollTitle) pollTitle.textContent = full.title || "(untitled)";
              const pt = full?.meta?.poll_type ?? full?.poll_type ?? "";
              if (pollMeta) pollMeta.textContent = `${pt} • Remote`;
              if (vb) {
                vb.innerHTML = "";
                (full.options || []).forEach(opt => {
                  const b = document.createElement("button");
                  b.type = "button";
                  b.textContent = opt?.label ?? opt;
                  b.onclick = () => castVote(full, opt?.label ?? opt);
                  vb.appendChild(b);
                });
              }
            }
            if (obj?.results && resultsBox) resultsBox.textContent = JSON.stringify(obj.results, null, 2);
          } catch (_) {}
        });
        es.addEventListener("results", (ev) => {
          try {
            const obj = JSON.parse(ev.data);
            if (resultsBox) resultsBox.textContent = JSON.stringify(obj, null, 2);
          } catch (e) {
            if (resultsBox) resultsBox.textContent = ev.data;
          }
        });
        es.onerror = () => {
          if (resultsBox) resultsBox.textContent = "Stream disconnected.";
        };
      } catch (e) {
        if (resultsBox) resultsBox.textContent = "Live results unavailable.";
      }
    }
  }

  // =========================
  // Vote (Local-first; remote optional)
  // =========================
  async function assertPollToExchange(localPoll) {
    const out = document.getElementById("assertOut");
    if (out) out.textContent = "Asserting…";

    const pollId = localPoll?.id;
    const isLocal = !!localPoll?.is_local || String(pollId).startsWith("local_");
    if (!isLocal) { if (out) out.textContent = "Already asserted."; return; }

    const auth = getExchangeBasicAuthHeaderOrNull();
    if (!auth) { if (out) out.textContent = "Missing exchange credentials."; return; }

    // Build exchange-shaped canonical payload from existing local fields (no re-asking)
    const payload = {
      title: localPoll.title,
      description: localPoll.question_html || "",
      type: "single",
      options: (localPoll.options || []).map(label => ({ label: String(label) })),
      meta: {
        poll_type: localPoll.poll_type || "",
        question_html: localPoll.question_html || "",
        created_local_id: pollId,
        asserted_at: Date.now(),
      },
    };

    try {
      const r = await fetch(`${API}/polls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": auth },
        body: JSON.stringify(payload),
      });

      const raw = await r.text();
      if (!r.ok) {
        if (out) out.textContent = `Assert failed (${r.status}).`;
        console.log("Assert failed:", r.status, raw);
        return;
      }

      const data = JSON.parse(raw);
      const remotePoll = data?.poll;
      if (!remotePoll?.id) {
        if (out) out.textContent = "Assert ok, but response missing poll id.";
        console.log("Assert response:", data);
        return;
      }

      // Replace local draft with a local cached copy of remote poll
      // (So your UI can treat it as non-local and votes go remote.)
      try { removeLocalPoll(pollId); } catch (_) {}
      addLocalPoll({ ...remotePoll, is_local: false });

      if (out) out.textContent = "Asserted.";
      await refreshPolls();
      await openPoll({ id: remotePoll.id, is_local: false });
    } catch (e) {
      if (out) out.textContent = "Assert failed (network error).";
      console.log(e);
    }
  }

 
  async function castVote(poll, choice) {
    const pollId = poll.id;
    const isLocal = !!poll.is_local || String(pollId).startsWith("local_");
    const out = document.getElementById("voteOut");
    const resultsBox = document.getElementById("resultsBox");

    if (out) out.textContent = "Submitting…";

    if (isLocal) {
      const token = ensureLocalToken(pollId);
      setLocalVote(pollId, token, choice, poll.options || []);
      if (out) out.textContent = "Voted (local).";
      const res = buildLocalResults(poll);
      if (resultsBox) resultsBox.textContent = JSON.stringify(res, null, 2);
      return;
    }

    // Remote best-effort
    const auth = getExchangeBasicAuthHeaderOrNull();
    const voter_token = getToken(pollId);

    // Map the clicked label -> exchange option_id.
    // Exchange polls use option objects: { id: "1", label: "Yes" }.
    // Local polls use string options; on assert we preserve ordering.
    const opts = (poll.options || []);
    const idx = opts.findIndex(o => (o?.label ?? o) === choice);
    if (idx < 0) { if (out) out.textContent = "Vote failed (bad option)."; return; }

    const optObj = opts[idx];
    const option_id = (optObj && typeof optObj === "object" && optObj.id != null)
      ? String(optObj.id)
      : String(idx + 1); // fallback to 1-based ordering
    const payload = voter_token ? { option_id, voter_token } : { option_id };

    try {
      const r = await fetch(`${API}/polls/${pollId}/vote`, {
        method: "POST",

        // OPERATOR WRITE-GATE (TEMPORARY)
        // Purpose: prevent unauthenticated public writes to the exchange (anti-vandalism).
        // This is NOT identity, legitimacy, delta, or vote-weighting.
        //
        // Replace later with governance-native mechanisms:
        // 1) Poll-scoped capability tokens issued at ASSERT:
        //    - manage_token (COOL / CLOSE / steward actions for this poll)
        //    - appeal_token (APPEAL for this poll)
        // 2) Delegation + recall/override during COOLING (constituent correction signal)
        // 3) Steward rekey via electorate vote (supermajority + quorum + timeout)
        // 4) Validator/claim attestations that grant *power points* (capped per person) and
        //    feed exchange-to-exchange legitimacy comparisons (delta vectors).
        //
        // Until those exist, Basic Auth is just an operator gate on writes.
        // Reads can remain public.

        headers: auth
          ? {
              "Content-Type": "application/json",
              "Authorization": auth,
            }
          : {
              "Content-Type": "application/json",
            },


        body: JSON.stringify(payload),
      });

      const rawBody = await r.text();
      if (!r.ok) {
        if (out) out.textContent = `Vote failed (${r.status}).`;
        console.log("Vote failed:", r.status, rawBody);
        return;
      }

      let data = null;
      try { data = JSON.parse(rawBody); } catch { data = null; }
      if (data?.voter_token) setToken(pollId, data.voter_token);

      if (out) out.textContent = "Voted.";
    } catch (e) {
      if (out) out.textContent = "Vote failed (network error).";
      console.log(e);
    }
  }

  // =========================
  // Main init (runs after app.html injected)
  // =========================
  function initLegacyUI() {
    // Guard: injected HTML must exist
    if (!document.getElementById("createPoll")) return;

    if (window.__initLegacyUI_ran) return;
    window.__initLegacyUI_ran = true;

    // Optional editor
    try { initQuestionEditor(); } catch {}

    // Advanced settings UI
    const apiBase = document.getElementById("apiBase");
    const apiStatus = document.getElementById("apiStatus");
    if (apiBase) apiBase.value = API;

    const saveApi = document.getElementById("saveApi");
    if (saveApi) {
      saveApi.onclick = async () => {
        const v = (apiBase?.value || "").trim().replace(/\/+$/, "");
        if (!v) return;
        API = v;
        localStorage.setItem(LS_API, API);
        if (apiStatus) apiStatus.textContent = "Saved. Checking…";
        await ping();
        await refreshPolls();
      };
        // Publish-to-exchange toggle: reveal the hidden API settings card
      
      const publishEl = document.getElementById("publishToExchange");
      const apiCardEl = document.getElementById("apiCard");

      const syncPublishUi = () => {
        if (!apiCardEl) return;

        if (publishEl && publishEl.checked) {
          apiCardEl.style.display = "block";

          // Make it feel like a “pop-up”: scroll to it and focus the API box.
          apiCardEl.scrollIntoView({ behavior: "smooth", block: "start" });
          setTimeout(() => {
            const apiBaseEl = document.getElementById("apiBase");
            if (apiBaseEl) apiBaseEl.focus();
          }, 50);
        } else {
          // Keep old behavior: only show if ?settings=1
          const params = new URLSearchParams(location.search);
          apiCardEl.style.display = (params.get("settings") === "1") ? "block" : "none";
        }
      };

        if (publishEl) publishEl.onchange = syncPublishUi;
        syncPublishUi();
    }

    // Close poll view
    const closeBtn = document.getElementById("closePoll");
    if (closeBtn) {
      closeBtn.onclick = () => {
        closeStream();
        const pollView = document.getElementById("pollView");
        if (pollView) pollView.style.display = "none";
      };
    }

    // Refresh
    const refreshBtn = document.getElementById("refreshPolls");
    if (refreshBtn) refreshBtn.onclick = refreshPolls;

    // Search
    const searchEl = document.getElementById("search");
    if (searchEl) searchEl.addEventListener("input", refreshPolls);

    // Create (LOCAL-FIRST)
    const createBtn = document.getElementById("createPoll");
    if (createBtn) {
      createBtn.onclick = async () => {
        const out = document.getElementById("createOut");
        const btn = document.getElementById("createPoll");
        if (!out || !btn) return;

        const title = (document.getElementById("newTitle")?.value || "").trim();
        const poll_type = document.getElementById("newType")?.value || "YES_NO";
        const raw = (document.getElementById("newOptions")?.value || "")
          .split("\n").map(x => x.trim()).filter(Boolean);
        const options = (poll_type === "YES_NO" && raw.length === 0) ? ["Yes", "No"] : raw;

        const question_html = (quill && quill.root) ? quill.root.innerHTML : "";

        if (!title) { out.textContent = "Title required."; return; }
        if (options.length < 2) { out.textContent = "Need at least 2 options."; return; }

        btn.disabled = true;
        out.textContent = "Creating (local)…";

        try {
          const id = "local_" + makeId();
          const localPoll = {
            id,
            title,
            poll_type,
            options,
            question_html,
            created_at: Date.now(),
            is_local: true,
            status: "OPEN",
          };

          addLocalPoll(localPoll);

          out.textContent = "Created (local).";

          const tEl = document.getElementById("newTitle");
          const oEl = document.getElementById("newOptions");
          if (tEl) tEl.value = "";
          if (oEl) oEl.value = "";

          await refreshPolls();
          await openPoll(localPoll);
        } finally {
          btn.disabled = false;
        }
      };
    }

    // Share
    const shareBtn = document.getElementById("shareBtn");
    if (shareBtn) {
      shareBtn.onclick = () => {
        const link = currentPollId ? pollLink(currentPollId) : window.location.href;
        openQr(link);
      };
    }

    // QR modal wiring
    const qrClose = document.getElementById("qrClose");
    if (qrClose) {
      qrClose.onclick = () => {
        const modal = document.getElementById("qrModal");
        if (modal) modal.style.display = "none";
      };
    }

    const copyLink = document.getElementById("copyLink");
    const copyLinkQr = document.getElementById("copyLinkQr");
    const copyStatus = document.getElementById("copyStatus");

    async function doCopy() {
      const link = currentPollId ? pollLink(currentPollId) : window.location.href;
      const ok = await copyToClipboard(link);
      if (copyStatus) copyStatus.textContent = ok ? "Copied." : "Copy failed.";
      setTimeout(() => { if (copyStatus) copyStatus.textContent = ""; }, 1200);
    }

    if (copyLink) copyLink.onclick = doCopy;
    if (copyLinkQr) copyLinkQr.onclick = doCopy;

    // Boot
    showApiCardIfNeeded();
    ping().catch(() => {});
    refreshPolls().then(openFromHash).catch(() => {});
  }

  // IMPORTANT: event hook is inside this IIFE (scope-safe)
  window.addEventListener("legacy:injected", initLegacyUI);
})();