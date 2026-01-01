import Quill from "quill";
import "quill/dist/quill.snow.css";

// ---- storage ----
  const LS_API = "breadpoll_api";
  const LS_TOKENS = "breadpoll_tokens"; // map poll_id -> voter_token

  function getTokens(){ try { return JSON.parse(localStorage.getItem(LS_TOKENS) || "{}"); } catch { return {}; } }
  function setToken(pollId, token){ const t=getTokens(); t[pollId]=token; localStorage.setItem(LS_TOKENS, JSON.stringify(t)); }
  function getToken(pollId){ const t=getTokens(); return t[pollId] || null; }

  const params = new URLSearchParams(location.search);
  const apiOverride = params.get("api");
  let API = apiOverride || localStorage.getItem(LS_API) || `${location.origin}/api`;

  let es = null; // EventSource
  let currentPollId = null; // used for Share button

  // ---- advanced settings UI ----
  const apiCard = document.getElementById("apiCard");
  const apiBase = document.getElementById("apiBase");
  const apiStatus = document.getElementById("apiStatus");
  apiBase.value = API;

  let quill = null;

function initQuestionEditor() {
  const el = document.getElementById("questionEditor");
  if (!el) return;

  quill = new Quill(el, {
    theme: "snow",
    placeholder: "Write the full question here… You can add links, emphasis, and lists.",
    modules: {
      toolbar: [
        ["bold", "italic", "underline"],
        [{ list: "ordered" }, { list: "bullet" }],
        ["link"],
        ["clean"],
      ],
    },
  });
}

window.addEventListener("DOMContentLoaded", initQuestionEditor);
  
  function showApiCardIfNeeded(){
    if (params.get("settings") === "1") apiCard.style.display = "block";
  }

  async function ping(){
    try {
      const r = await fetch(`${API}/health`, { cache:"no-store" });
      apiStatus.textContent = r.ok ? "OK" : "Not OK";
    } catch {
      apiStatus.textContent = "Unreachable";
    }
  }

  document.getElementById("saveApi").onclick = () => {
    API = apiBase.value.trim().replace(/\/$/, "");
    localStorage.setItem(LS_API, API);
    ping().then(refreshPolls).catch(()=>{});
  };

  // ---- list ----
  async function refreshPolls(){
    const list = document.getElementById("pollList");
    const empty = document.getElementById("emptyState");
    const q = (document.getElementById("search").value || "").toLowerCase().trim();

    let polls = [];
    try {
      const r = await fetch(`${API}/polls`, { cache:"no-store" });
      const raw = await r.text();
      if (!r.ok) throw new Error(`GET /polls failed ${r.status}: ${raw.slice(0,200)}`);
      polls = JSON.parse(raw);
    } catch (e) {
      list.innerHTML = "";
      empty.style.display = "block";
      empty.textContent = "Could not load polls.";
      console.log(e);
      return;
    }

    const filtered = q ? polls.filter(p => (p.title || "").toLowerCase().includes(q)) : polls;

    list.innerHTML = "";
    if (!filtered.length){
      empty.style.display = "block";
      empty.textContent = "No polls yet. Create one above.";
      return;
    }
    empty.style.display = "none";

    for (const p of filtered){
      const div = document.createElement("div");
      const isClosed = !!(p.closed || p.is_closed || p.status === "CLOSED");

      div.className = "list-item";
      div.innerHTML = `
        <div style="min-width:0;">
          <div class="title" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${p.title || "(untitled)"}
          </div>
          <div class="meta">
            <span>${p.poll_type || ""}</span>
            <span class="chip ${isClosed ? "closed" : "open"}">${isClosed ? "Closed" : "Open"}</span>
          </div>
        </div>
        <button class="btn-small btn-primary" type="button">Vote</button>
      `;

      const voteBtn = div.querySelector("button");
      voteBtn.onclick = (e) => { e.stopPropagation(); openPoll(p); };

      div.onclick = () => openPoll(p);
      list.appendChild(div);
    }
  }

  document.getElementById("refreshPolls").onclick = refreshPolls;
  document.getElementById("search").addEventListener("input", refreshPolls);

  // ---- create ----
  document.getElementById("createPoll").onclick = async () => {
    const out = document.getElementById("createOut");
    const btn = document.getElementById("createPoll");

    const title = document.getElementById("newTitle").value.trim();
    const poll_type = document.getElementById("newType").value;
    const raw = document.getElementById("newOptions").value.split("\n").map(x=>x.trim()).filter(Boolean);
    const options = (poll_type === "YES_NO" && raw.length === 0) ? ["Yes","No"] : raw;
    const question_html = quill ? quill.root.innerHTML : "";

    if (!title){ out.textContent = "Title required."; return; }
    if (options.length < 2){ out.textContent = "Need at least 2 options."; return; }

    btn.disabled = true;
    out.textContent = "Creating...";

    try {
      const r = await fetch(`${API}/polls`, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ title, poll_type, options, question_html })
      });

      const rawBody = await r.text();

      if (!r.ok){
        out.textContent = `Create failed (${r.status}).`;
        console.log("Create failed:", r.status, rawBody);
        return;
      }

      let data;
      try { data = JSON.parse(rawBody); }
      catch {
        out.textContent = "Create failed (server returned non-JSON).";
        console.log("Non-JSON success body:", rawBody);
        return;
      }

      if (!data?.id){
        out.textContent = "Create failed (missing poll id).";
        console.log("Bad success payload:", data);
        return;
      }

      out.textContent = "Created.";
      document.getElementById("newTitle").value = "";
      document.getElementById("newOptions").value = "";

      await refreshPolls();
      openPoll(data);

    } catch (e) {
      out.textContent = "Create failed (network error).";
      console.log(e);
    } finally {
      btn.disabled = false;
    }
  };

  // ---- poll view ----
  function closeStream(){
    if (es){ es.close(); es = null; }
  }

  function pollLink(pollId){
    return `${location.origin}${location.pathname}#${pollId}`;
  }

  function openPoll(p){
    if (!p?.id) return;

    currentPollId = p.id;

    closeStream();
    const view = document.getElementById("pollView");
    view.style.display = "block";

    document.getElementById("pollTitle").textContent = p.title || "(untitled)";
    document.getElementById("pollMeta").textContent = `${p.poll_type || ""} · ${p.id}`;

    const link = pollLink(p.id);
    const a = document.getElementById("shareLink");
    a.textContent = link;
    a.href = link;

    document.getElementById("copyLink").onclick = async () => {
      try { await navigator.clipboard.writeText(link); }
      catch {}
    };

    document.getElementById("closePoll").onclick = () => {
      closeStream();
      view.style.display = "none";
      currentPollId = null;
    };

    const vb = document.getElementById("voteButtons");
    vb.innerHTML = "";
    (p.options || []).forEach(opt => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt;
      b.onclick = () => castVote(p.id, opt);
      vb.appendChild(b);
    });

    es = new EventSource(`${API}/polls/${p.id}/stream`);
    es.addEventListener("results", (ev) => {
      try {
        document.getElementById("resultsBox").textContent = JSON.stringify(JSON.parse(ev.data), null, 2);
      } catch {
        document.getElementById("resultsBox").textContent = ev.data;
      }
    });
    es.onerror = () => {
      document.getElementById("resultsBox").textContent = "Stream disconnected.";
    };
  }

  async function castVote(pollId, choice){
    const voter_token = getToken(pollId);
    const payload = voter_token ? { choice, voter_token } : { choice };

    const r = await fetch(`${API}/polls/${pollId}/vote`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(()=>({}));
    if (data?.voter_token) setToken(pollId, data.voter_token);
    document.getElementById("voteOut").textContent = "Vote saved.";
  }

  // auto-open poll from hash
  async function openFromHash(){
    const pollId = location.hash.replace("#","");
    if (!pollId) return;

    try {
      const r = await fetch(`${API}/polls`, { cache:"no-store" });
      const polls = await r.json();
      const found = polls.find(x => x.id === pollId);
      if (found) openPoll(found);
    } catch {}
  }

  window.addEventListener("hashchange", openFromHash);

  // ---- QR modal ----
  const qrModal = document.getElementById("qrModal");
  const qrBox = document.getElementById("qrBox");
  const qrClose = document.getElementById("qrClose");
  const qrLinkText = document.getElementById("qrLinkText");
  const copyLinkBtn = document.getElementById("copyLinkQr");
  const copyStatus = document.getElementById("copyStatus");

  function openQr(link){
    qrBox.innerHTML = "";
    copyStatus.textContent = "";
    qrLinkText.textContent = link;

    try{
      new QRCode(qrBox, { text: link, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M });
    } catch (e){
      qrBox.textContent = "QR failed to render (missing qrcode.min.js).";
      console.log(e);
    }

    qrModal.style.display = "block";
  }

  function closeQr(){ qrModal.style.display = "none"; }
  qrClose.addEventListener("click", closeQr);
  qrModal.addEventListener("click", (e)=>{ if (e.target === qrModal) closeQr(); });

  copyLinkBtn.addEventListener("click", async ()=>{
    const link = qrLinkText.textContent || "";
    try{
      await navigator.clipboard.writeText(link);
      copyStatus.textContent = "Copied.";
    } catch {
      copyStatus.textContent = "Copy failed — press and hold the link to copy.";
    }
  });

  document.getElementById("shareBtn").addEventListener("click", ()=>{
    const link = currentPollId ? pollLink(currentPollId) : window.location.href;
    openQr(link);
  });

  // ---- PWA ----
  if ("serviceWorker" in navigator){
    navigator.serviceWorker.register("/sw.js").catch(()=>{});
  }

  showApiCardIfNeeded();
  ping().catch(()=>{});
  refreshPolls().then(openFromHash).catch(()=>{});
