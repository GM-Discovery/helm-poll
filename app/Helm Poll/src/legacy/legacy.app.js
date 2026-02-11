(() => {
  "use strict";

  // =========================
  // Storage keys
  // =========================
  const LS_API = "breadpoll_api";
  const LS_TOKENS = "breadpoll_tokens"; // poll_id -> voter_token (device-local)
  const LS_LOCAL_POLLS = "breadpoll_local_polls_v1"; // array of poll objects
  const LS_LOCAL_VOTES = "breadpoll_local_votes_v1"; // poll_id -> { byToken: {token: choice}, counts: {option: n} }
  const LS_REMOTE_LAST_CHOICE = "breadpoll_remote_last_choice_v1"; // poll_id -> last chosen label (UI hint only)

  // =========================
  // API base selection (optional)
  // =========================
  const params = new URLSearchParams(location.search);
  const apiOverride = params.get("api");
  let API = apiOverride || localStorage.getItem(LS_API) || "https://exchange.breadstandard.com/api";
  const EXCHANGE_API = "https://exchange.breadstandard.com/api";

  // =========================
  // Runtime state
  // =========================
  let es = null; // EventSource (remote live stream only)
  let currentPollId = null;
  let quill = null; // optional Quill instance
  let currentTab = "create";   // "create" | "polls" | "settings"
  let inPollDetail = false;   // true when viewing a single poll

  // =========================
  // HMAC signing (Web Crypto)
  // =========================

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function hexToBytes(hex) {
    const clean = String(hex || "").trim();
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) return null;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
    return bytesToHex(new Uint8Array(buf));
  }

  function makeNonceHex(byteLen = 12) {
    const b = new Uint8Array(byteLen);
    crypto.getRandomValues(b);
    return bytesToHex(b);
  }

  async function hmacSha256Hex(keyHex, message) {
    const keyBytes = hexToBytes(keyHex);
    if (!keyBytes) throw new Error("Signing key must be hex (even length).");
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const enc = new TextEncoder();
    const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
    return bytesToHex(new Uint8Array(sigBuf));
  }

  async function buildHmacHeaders(method, path, bodyObjOrNull) {
    const creds = getExchangeHmacCredsOrNull();
    if (!creds) throw new Error("Missing Exchange identity (self_id / signing_key).");

    const ts = String(Date.now()); // unix ms
    const nonce = makeNonceHex(12);

    const bodyText = bodyObjOrNull == null ? "" : JSON.stringify(bodyObjOrNull);
    const bodyHash = await sha256Hex(bodyText);

    const base =
      String(method).toUpperCase() + "\n" +
      String(path) + "\n" +
      ts + "\n" +
      nonce + "\n" +
      bodyHash;

    const sigHex = await hmacSha256Hex(creds.signing_key, base);

    return {
      "X-Self-ID": creds.self_id,
      "X-Timestamp": ts,
      "X-Nonce": nonce,
      "X-Signature": sigHex,
    };
  }

  // Fetch helper for Exchange endpoints that require HMAC.
  // path is like "/stamp" (we will prefix EXCHANGE_API)
  async function exchangeFetchAuthed(path, opts) {
    const method = (opts?.method || "GET").toUpperCase();
    const bodyObj = (opts && "body" in opts) ? opts.body : null;

    const apiPrefix = new URL(EXCHANGE_API).pathname.replace(/\/$/, ""); // e.g. "/api"
    const signPath = `${apiPrefix}${path}`; // e.g. "/api/stamp"
    const h = await buildHmacHeaders(method, signPath, bodyObj);

    const headers = {
      "Content-Type": "application/json",
      ...(opts?.headers || {}),
      ...h,
    };
    
    console.log("[exchangeFetchAuthed]", method, `${EXCHANGE_API}${path}`, "signPath=", signPath);

    return fetch(`${EXCHANGE_API}${path}`, {
      method,
      headers,
      body: bodyObj == null ? undefined : JSON.stringify(bodyObj),
    });
  }

  // =========================
  // Identity create (PoW-lite)
  // =========================

  async function exchangeGetIdentityChallenge() {
    const r = await fetch(`${EXCHANGE_API}/identity/challenge`, { method: "GET" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Challenge failed (${r.status}). ${t}`);
    }
    return r.json(); // expected: { challenge, difficulty }
  }

  async function solvePowLite(challenge, difficulty) {
    // Goal: find nonce such that sha256(challenge + ":" + nonce) has N leading zeros (hex).
    // This is intentionally simple and auditable. Difficulty should be low for MVP.
    const targetPrefix = "0".repeat(Math.max(0, Number(difficulty) || 0));

    let nonce = 0;
    while (true) {
      const candidate = String(nonce);
      const h = await sha256Hex(`${challenge}:${candidate}`);
      if (h.startsWith(targetPrefix)) return candidate;
      nonce++;
      // Yield occasionally so UI doesn't feel frozen
      if (nonce % 500 === 0) await new Promise(r => setTimeout(r, 0));
    }
  }

  async function exchangeCreateIdentityWithPow(statusEl) {
    if (statusEl) statusEl.textContent = "Requesting challenge…";

    const { challenge, difficulty } = await exchangeGetIdentityChallenge();

    if (statusEl) statusEl.textContent = `Solving proof-of-work (difficulty ${difficulty})…`;

    const nonce = await solvePowLite(challenge, difficulty);

    if (statusEl) statusEl.textContent = "Creating identity…";

    const r = await fetch(`${EXCHANGE_API}/identity/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, nonce }),
    });

    const raw = await r.text().catch(() => "");
    if (!r.ok) throw new Error(`Identity create failed (${r.status}). ${raw}`);

    let data = null;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!data?.self_id || !data?.signing_key) {
      throw new Error("Identity create returned unexpected payload (missing self_id/signing_key).");
    }

    // Store locally (do not log)
    localStorage.setItem(LS_EXCHANGE_SELF_ID, String(data.self_id));
    localStorage.setItem(LS_EXCHANGE_SIGNING_KEY, String(data.signing_key));
    if (data.public_alias) localStorage.setItem(LS_EXCHANGE_PUBLIC_ALIAS, String(data.public_alias));

    return data; // { self_id, signing_key, public_alias? }
  }

  async function copyTextToClipboardOrThrow(text) {
    // Tauri + modern browsers should support navigator.clipboard in secure contexts.
    // If clipboard fails, we throw and show a user-facing message.
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard not available.");
    await navigator.clipboard.writeText(String(text));
  }

  // --- Exchange Stamp storage keys ---
  const LS_EXCHANGE_STAMPS = "exchange_stamps";
  const LS_EXCHANGE_PERSONA_ID = "exchange_persona_id";

  // Read the local stamp pool (array of strings)
  function getExchangeStampPool() {
    try {
      const raw = localStorage.getItem(LS_EXCHANGE_STAMPS);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  // Save/merge stamps without duplicates
  function addStampsToPool(newStamps) {
    const cur = getExchangeStampPool();
    const set = new Set(cur);
    for (const s of (newStamps || [])) {
      if (typeof s === "string" && s.startsWith("s_")) set.add(s);
    }
    localStorage.setItem(LS_EXCHANGE_STAMPS, JSON.stringify(Array.from(set)));
  }

  // Pick ONE stamp and REMOVE it from the pool immediately.
  // This prevents reuse of a consumed stamp (which causes 403 forever).
  function pickOneStampOrNull() {
    const pool = getExchangeStampPool();
    if (!pool.length) return null;

    const stamp = pool.shift(); // take the first stamp
    localStorage.setItem(LS_EXCHANGE_STAMPS, JSON.stringify(pool)); // persist remaining pool
    return stamp;
  }
  // Pick one stamp (random) for later use (voting, future)
  function pickOneStampOrNull() {
    const pool = getExchangeStampPool();
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  let currentPollApiBase = null; // "https://…/api" for the currently open poll

  // Ephemeral stamp (never persisted)
  let EPHEMERAL_STAMP = "";

  // Assert: mint ONE stamp and hold it only long enough to create a ballot
  async function handleAssertClick() {
    const statusEl = document.getElementById("assertStatus");
    const outEl = document.getElementById("assertOut");

    if (statusEl) statusEl.textContent = "Asserting…";
    if (outEl) outEl.textContent = "";

    try {
      const res = await fetch(`${EXCHANGE_API}/stamp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        if (statusEl) statusEl.textContent = "Assert failed";
        if (outEl) outEl.textContent = JSON.stringify(data, null, 2);
        return;
      }

      // We expect "issued" to contain at least one active stamp token.
      // If it's empty, UI can't proceed to first-vote without another change.
      const stamp = Array.isArray(data.issued) && data.issued[0] ? data.issued[0] : "";
      EPHEMERAL_STAMP = stamp;

      if (statusEl) statusEl.textContent = stamp ? "Asserted (stamp ready)" : "Asserted (no stamp issued)";
      if (outEl) outEl.textContent = JSON.stringify({ ok: true, stamp_ready: !!stamp }, null, 2);
    } catch (e) {
      if (statusEl) statusEl.textContent = "Assert failed (network)";
      if (outEl) outEl.textContent = String(e);
    }
  }

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
 
  function clearExchangeStampPool() {
    localStorage.removeItem("exchange_stamps");
    localStorage.removeItem("exchange_persona_id");
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
  // Helpers: remote "sticky vote" (UI hint only)
  // =========================
  function getRemoteLastChoiceMap() {
    try {
      return JSON.parse(localStorage.getItem(LS_REMOTE_LAST_CHOICE) || "{}");
    } catch {
      return {};
    }
  }

  function setRemoteLastChoice(pollId, label) {
    const m = getRemoteLastChoiceMap();
    m[String(pollId)] = String(label || "");
    localStorage.setItem(LS_REMOTE_LAST_CHOICE, JSON.stringify(m));
  }

  function getRemoteLastChoice(pollId) {
    const m = getRemoteLastChoiceMap();
    const v = m[String(pollId)];
    return v ? String(v) : null;
  }

  // =========================
  // Helpers: local vote lookup (for assert carry-forward)
  // =========================
  function getLocalSelectedChoice(poll) {
    if (!poll?.id) return null;
    const token = ensureLocalToken(poll.id);
    const all = loadLocalVotesAll();
    const st = all[poll.id];
    const choice = st?.byToken?.[token];
    return choice ? String(choice) : null;
  }

  // =========================
  // Helpers: purge local poll + local vote reality after assert
  // =========================
  function purgeLocalPollState(localPollId) {
    const id = String(localPollId || "");
    if (!id) return;

    // 1) Remove poll itself
    try { removeLocalPoll(id); } catch {}

    // 2) Remove local votes/results for that poll
    try {
      const allVotes = loadLocalVotesAll();
      if (allVotes && typeof allVotes === "object") {
        delete allVotes[id];
        saveLocalVotesAll(allVotes);
      }
    } catch {}

    // 3) Remove token entry (local voter_token)
    try {
      const t = getTokens();
      if (t && typeof t === "object") {
        delete t[id];
        localStorage.setItem(LS_TOKENS, JSON.stringify(t));
      }
    } catch {}
  }

  // =========================
  // UI: render vote buttons with selected state
  // =========================
  function renderVoteButtons(containerEl, poll, selectedLabel) {
    if (!containerEl) return;
    containerEl.innerHTML = "";

    const opts = Array.isArray(poll?.options) ? poll.options : [];

    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i];

      const label = (opt && typeof opt === "object" && opt.label != null)
        ? String(opt.label)
        : String(opt);

      // Remote polls often have option ids; local polls usually don't.
      const optionId = (opt && typeof opt === "object" && opt.id != null)
        ? String(opt.id)
        : String(i + 1);

      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;

      // Visual selection
      b.className = (selectedLabel && String(label) === String(selectedLabel))
        ? "btn-primary"
        : "btn-ghost";

      b.onclick = () => castVote(poll, optionId, label);

      containerEl.appendChild(b);
    }
  }
 
  // =========================
  // Exchange: vote by label (used by Assert carry-forward)
  // =========================
  async function castExchangeVoteByLabel(poll, choiceLabel, statusEl) {
    const pollId =
      poll?.meta?.exchange_poll_id ||
      poll?.meta?.exchange_id ||
      poll?.exchange_poll_id ||
      poll?.exchange_id ||
      poll?.id;

    // Safety: never try to vote a local_* id against the Exchange
    if (String(pollId).startsWith("local_")) {
      if (statusEl) statusEl.textContent = "This poll is local-only (not on exchange yet).";
      return { ok: false, error: "local_poll_id_not_valid_on_exchange" };
    }

    if (!pollId) return { ok: false, error: "missing poll id" };

    const voter_token = getToken(pollId);

    const opts = (poll.options || []);
    const idx = opts.findIndex(o => (o?.label ?? o) === choiceLabel);
    if (idx < 0) return { ok: false, error: "bad option" };

    const optObj = opts[idx];
    const option_id = (optObj && typeof optObj === "object" && optObj.id != null)
      ? String(optObj.id)
      : String(idx + 1);

    // Body no longer includes voter_token; revote uses X-Voter-Token header.
    const payload = { option_id };

    // First vote needs X-Stamp; revote uses X-Voter-Token
    let stamp = null;
    const headers = { "Content-Type": "application/json" };

    if (voter_token) {
      headers["X-Voter-Token"] = String(voter_token);
    } else {
      stamp = await getOrFetchOneStampOrNull();
      if (!stamp) return { ok: false, error: "no stamp" };
      headers["X-Stamp"] = stamp;
    }

    console.log("[stamp] pool_after_pick=", getExchangeStampPool().length, "stamp=", String(stamp || "").slice(0, 12));
    console.log("[vote] pollId=", pollId, "option_id=", option_id, "using=", voter_token ? "X-Voter-Token" : "X-Stamp");

    const r = await fetch(`${EXCHANGE_API}/polls/${pollId}/vote`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const rawBody = await r.text();

    if (!r.ok) {
      // If we tried to do a FIRST vote with a stamp and got rejected,
      // our local stamp pool is probably stale. Clear it and retry once.
      if (!voter_token && r.status === 403) {
        try { clearExchangeStampPool(); } catch {}
        try {
          const stamp2 = await getOrFetchOneStampOrNull();
          if (stamp2) {
            const headers2 = { "Content-Type": "application/json", "X-Stamp": stamp2 };
            const r2 = await fetch(`${EXCHANGE_API}/polls/${pollId}/vote`, {
              method: "POST",
              headers: headers2,
              body: JSON.stringify(payload),
            });

            const raw2 = await r2.text();
            if (r2.ok) {
              let data2 = null;
              try { data2 = JSON.parse(raw2); } catch {}
              if (data2?.voter_token) setToken(pollId, data2.voter_token);
              setRemoteLastChoice(pollId, choiceLabel);
              return { ok: true };
            }
          }
        } catch (_) {
          // fall through to normal failure below
        }
      }

      if (statusEl) statusEl.textContent = `Vote failed (${r.status}).`;
      return { ok: false, error: rawBody || String(r.status) };
    }


    let data = null;
    try { data = JSON.parse(rawBody); } catch { data = null; }

    if (data?.voter_token) setToken(pollId, data.voter_token);
    setRemoteLastChoice(pollId, choiceLabel);

    return { ok: true };
  }

  // =========================
  // Exchange Identity (HMAC client creds stored locally)
  // =========================
  const LS_EXCHANGE_SELF_ID = "exchange_self_id";
  const LS_EXCHANGE_SIGNING_KEY = "exchange_signing_key";
  const LS_EXCHANGE_PUBLIC_ALIAS = "exchange_public_alias";

  function getExchangeSelfIdOrNull() {
    const v = (localStorage.getItem(LS_EXCHANGE_SELF_ID) || "").trim();
    return v || null;
  }

  function getExchangeSigningKeyOrNull() {
    const v = (localStorage.getItem(LS_EXCHANGE_SIGNING_KEY) || "").trim();
    return v || null;
  }

  function getExchangeAliasOrNull() {
    const v = (localStorage.getItem(LS_EXCHANGE_PUBLIC_ALIAS) || "").trim();
    return v || null;
  }

  function getExchangeHmacCredsOrNull() {
    const self_id = getExchangeSelfIdOrNull();
    const signing_key = getExchangeSigningKeyOrNull();
    if (!self_id || !signing_key) return null;
    return { self_id, signing_key };
  }

  // UI helpers
  // =========================
  // Results normalization + rendering (Weighted-first)
  // =========================

  function normalizeResults(obj) {
    const raw = obj || {};

    // Some callers pass { poll_id, results: {...} }
    const r = raw.results && typeof raw.results === "object" ? raw.results : raw;

    // totals: prefer totals, else counts (and allow nested variants)
    const totals =
      (r && r.totals && typeof r.totals === "object") ? r.totals :
      (r && r.counts && typeof r.counts === "object") ? r.counts :
      (raw && raw.totals && typeof raw.totals === "object") ? raw.totals :
      (raw && raw.counts && typeof raw.counts === "object") ? raw.counts :
      {};

    const people_voted =
      (typeof r.people_voted === "number") ? r.people_voted :
      (typeof raw.people_voted === "number") ? raw.people_voted :
      null;

    const total_votes =
      (typeof r.total_votes === "number") ? r.total_votes :
      (typeof raw.total_votes === "number") ? raw.total_votes :
      null;

    const weights_used =
      (r.weights_used && typeof r.weights_used === "object") ? r.weights_used :
      (raw.weights_used && typeof raw.weights_used === "object") ? raw.weights_used :
      null;

    const validated =
      (typeof r.validated === "boolean") ? r.validated :
      (typeof raw.validated === "boolean") ? raw.validated :
      null;

    // represented weight: prefer weights_used.sum, else represented_people, else sum(totals)
    let represented_weight = null;

    if (weights_used && typeof weights_used.sum === "number") {
      represented_weight = weights_used.sum;
    } else if (typeof r.represented_people === "number") {
      represented_weight = r.represented_people;
    } else if (typeof raw.represented_people === "number") {
      represented_weight = raw.represented_people;
    } else {
      represented_weight = Object.values(totals).reduce((a, b) => a + (Number(b) || 0), 0);
    }

    return {
      totals,
      people_voted,
      represented_weight,
      total_votes,
      validated,
      weights_used,
      raw,
    };
  }

  function renderPrettyResults(poll, normalized) {
    const rowsEl = document.getElementById("resultsRows");
    const representedEl = document.getElementById("resultsRepresented");
    const peopleEl = document.getElementById("resultsPeople");
    const ballotsEl = document.getElementById("resultsBallots");
    const validatedEl = document.getElementById("resultsValidated");
    const resultsBox = document.getElementById("resultsBox");
    const localWarnEl = document.getElementById("resultsLocalWarn");
    // Show a loud warning when this poll is local-only (not on Exchange).
    // We treat a poll as local if poll.is_local is true OR id starts with "local_".
    const isLocalOnly = !!poll?.is_local || String(poll?.id || "").startsWith("local_");
    if (localWarnEl) localWarnEl.style.display = isLocalOnly ? "inline-flex" : "none";


    if (!poll || !normalized) return;

    // Keep audit JSON always available
    if (resultsBox) {
      try { resultsBox.textContent = JSON.stringify(normalized.raw, null, 2); }
      catch { resultsBox.textContent = String(normalized.raw || ""); }
    }

    const totals = normalized.totals || {};

    // Build option map: id -> label
    // Remote: options are objects {id,label}
    // Local: options are strings ["Yes","No"] (no ids), so we map "1..N"
    const optMap = {};
    const opts = Array.isArray(poll.options) ? poll.options : [];

    const optionsAreObjects = opts.length && typeof opts[0] === "object";
    if (optionsAreObjects) {
      for (const o of opts) {
        const id = (o && o.id != null) ? String(o.id) : "";
        const label = (o && o.label != null) ? String(o.label) : "";
        if (id) optMap[id] = label || `Option ${id}`;
      }
    } else {
      for (let i = 0; i < opts.length; i++) {
        optMap[String(i + 1)] = String(opts[i]);
      }
    }

    // Ensure we include any totals keys even if option list is missing
    for (const k of Object.keys(totals)) {
      if (!optMap[k]) optMap[k] = `Option ${k}`;
    }

    const sumWeight = Object.values(totals).reduce((a, b) => a + (Number(b) || 0), 0);

    // Headline numbers
    if (representedEl) representedEl.textContent =
      (normalized.represented_weight == null) ? "—" : String(normalized.represented_weight);

    if (peopleEl) peopleEl.textContent =
      (normalized.people_voted == null) ? "—" : String(normalized.people_voted);

    if (ballotsEl) ballotsEl.textContent =
      (normalized.total_votes == null) ? "—" : String(normalized.total_votes);

    if (validatedEl) {
      if (normalized.validated === true) {
        validatedEl.textContent = "Validated";
        validatedEl.classList.remove("bad");
        validatedEl.classList.add("ok");
      } else if (normalized.validated === false) {
        validatedEl.textContent = "Not validated";
        validatedEl.classList.remove("ok");
        validatedEl.classList.add("bad");
      } else {
        validatedEl.textContent = "";
        validatedEl.classList.remove("ok");
        validatedEl.classList.remove("bad");
      }
    }

    // Rows
    if (!rowsEl) return;
    rowsEl.innerHTML = "";

    if (sumWeight <= 0) {
      const div = document.createElement("div");
      div.className = "muted";
      div.style.textAlign = "center";
      div.style.padding = "10px 0";
      div.textContent = "No votes yet.";
      rowsEl.appendChild(div);
      return;
    }

    // Render in option order (1..N for local; poll order for remote)
    const idsInOrder = optionsAreObjects
      ? opts.map(o => String(o.id))
      : opts.map((_, i) => String(i + 1));

    // Also include any totals-only ids not in the option list
    for (const k of Object.keys(totals)) {
      if (!idsInOrder.includes(k)) idsInOrder.push(k);
    }

    for (const id of idsInOrder) {
      const w = Number(totals[id] || 0);
      const pct = sumWeight > 0 ? (w / sumWeight) : 0;
      const pctText = `${Math.round(pct * 100)}%`;

      const row = document.createElement("div");
      row.className = "resultRow";

      row.innerHTML = `
        <div class="resultRowTop">
          <div class="resultLabel">${escapeHtml(optMap[id] || `Option ${id}`)}</div>
          <div class="resultNums">
            <span>${escapeHtml(String(w))}</span>
            <span>•</span>
            <span>${escapeHtml(pctText)}</span>
          </div>
        </div>
        <div class="barTrack">
          <div class="barFill" style="width:${Math.max(0, Math.min(100, pct * 100)).toFixed(2)}%;"></div>
        </div>
      `;

      rowsEl.appendChild(row);
    }
  }


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

  async function castExchangeVote(poll, optionId, statusEl) {
    const pollId = poll?.meta?.exchange_poll_id || poll?.id;
    if (!pollId) throw new Error("missing poll id");
    if (String(pollId).startsWith("local_")) {
      if (statusEl) statusEl.textContent = "Poll is not on Exchange yet.";
      return { ok: false, error: "local_id_on_exchange" };
    }

    const headers = { "Content-Type": "application/json" };

    const voterToken = getVoterToken(pollId);
    if (voterToken) {
      headers["X-Voter-Token"] = voterToken;
    } else {
      if (!EPHEMERAL_STAMP) {
        throw new Error("must assert before first vote");
      }
      headers["X-Stamp"] = EPHEMERAL_STAMP;
    }

    const res = await fetch(`${EXCHANGE_API}/polls/${pollId}/vote`, {
      method: "POST",
      headers,
      body: JSON.stringify({ option_id: String(optionId) }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      if (headers["X-Voter-Token"] && data?.error === "invalid X-Voter-Token") {
        clearVoterToken(pollId);
      }
      throw new Error(data?.error || "vote failed");
    }

    if (data.voter_token) setVoterToken(pollId, data.voter_token);

    // Shred stamp after first successful vote
    if (!headers["X-Voter-Token"]) {
      EPHEMERAL_STAMP = "";
    }

    return data;
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

  async function fetchStampsFromExchange() {
    // HMAC identity required to mint stamps on the Exchange
    const creds = getExchangeHmacCredsOrNull();
    if (!creds) throw new Error("Missing Exchange identity (self_id / signing_key).");

    const r = await exchangeFetchAuthed("/stamp", {
      method: "POST",
      body: {}, // empty JSON object
    });

    const data = await r.json();

    // Expected: { ok:true, issued:[...], issued_weights, issued_weight_combined, ... }
    if (data && data.persona_id) localStorage.setItem(LS_EXCHANGE_PERSONA_ID, data.persona_id);
    if (data && Array.isArray(data.issued) && data.issued.length) addStampsToPool(data.issued);
    // Store "last computed" stats for Settings page (local-only)
    try {
      if (data?.issued_weight_combined != null) localStorage.setItem("exchange_last_weight_combined", String(data.issued_weight_combined));
      if (data?.issued_weights && typeof data.issued_weights === "object") {
        localStorage.setItem("exchange_last_issued_weights", JSON.stringify(data.issued_weights));
      }
      localStorage.setItem("exchange_last_stamp_ts", String(Date.now()));
    } catch {}

    return data;
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
      const r = await fetch(`${EXCHANGE_API}/polls`, { cache: "no-store" });
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
    currentPollApiBase = isLocal ? API : EXCHANGE_API;
    currentPollId = pollId;
    // Phase 1: poll drilldown replaces list view
    const listCard = document.getElementById("pollsListCard");
    if (listCard) listCard.style.display = "none";

    const pollViewEl = document.getElementById("pollView");
    if (pollViewEl) pollViewEl.style.display = "block";
    // Ensure in Polls tab + show detail view
    window.scrollTo(0, 0);
    showTab("polls");
    showPollDetail();
    window.scrollTo(0, 0);

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

    // Vote buttons (with selected state)
    if (vb) {
      const selected = isLocalNow ? getLocalSelectedChoice(full) : getRemoteLastChoice(pollId);
      renderVoteButtons(vb, full, selected);
    }

    // Results display
    closeStream();

    if (isLocalNow) {
      const res = buildLocalResults(full);
      const norm = normalizeResults(res);
      renderPrettyResults(full, norm);
    } else {
      // --- NEW: Remote poll hydration (do not rely on SSE) ---
      // Exchange does not guarantee /stream exists (can 404), so we must fetch poll data once.
      try {
        const r = await fetch(`https://exchange.breadstandard.com/api/polls`, { method: "GET" });
        if (r.ok) {
          const data = await r.json();
          const polls = Array.isArray(data?.polls) ? data.polls : [];
          const found = polls.find(p => String(p?.id) === String(pollId));
          if (found) {
            full = { ...found, is_local: false };

            if (pollTitle) pollTitle.textContent = full.title || "(untitled)";
            const pt = full?.meta?.poll_type ?? full?.poll_type ?? "";
            if (pollMeta) pollMeta.textContent = `${pt} • Remote`;

            if (vb) {
              renderVoteButtons(vb, full, getRemoteLastChoice(pollId));
            }

            if (full?.results) {
              const norm = normalizeResults(full.results);
              renderPrettyResults(full, norm);
            }
          }
        }
      } catch (e) {
        // If this fails, we still try SSE below.
        console.warn("Remote poll hydration failed:", e);
      }    
      // Remote stream (optional)
      try {
        es = new EventSource(`https://exchange.breadstandard.com/api/polls/${pollId}/stream`);
        es.addEventListener("poll", (ev) => {
          try {
            const obj = JSON.parse(ev.data);
            if (obj?.poll) {
              full = { ...obj.poll, is_local: false };
              if (pollTitle) pollTitle.textContent = full.title || "(untitled)";
              const pt = full?.meta?.poll_type ?? full?.poll_type ?? "";
              if (pollMeta) pollMeta.textContent = `${pt} • Remote`;
              if (vb) {
                renderVoteButtons(vb, full, getRemoteLastChoice(pollId));
              }

            }
            if (obj?.results) {
              const norm = normalizeResults(obj.results);
              renderPrettyResults(full, norm);
            }
          } catch (_) {}
        });
        es.addEventListener("results", (ev) => {
          try {
            const obj = JSON.parse(ev.data);

            // Exchange sends { poll_id, results: {...} }
            const norm = normalizeResults(obj);
            renderPrettyResults(full, norm);
          } catch (e) {
            // If parsing fails, keep something visible in audit JSON.
            const resultsBox = document.getElementById("resultsBox");
            if (resultsBox) resultsBox.textContent = String(ev.data || "");
          }
        });
        es.onerror = () => {
          // Exchange can legitimately return 404 for /stream even when the poll exists.
          // Don't overwrite valid results with a scary error message.
          try { es.close(); } catch (_) {}
          // Leave whatever results are already shown in resultsBox.
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
    const localKey = String(localPoll?.meta?.created_local_id || pollId);
    const isLocal = !!localPoll?.is_local || String(pollId).startsWith("local_");
    if (!isLocal) { if (out) out.textContent = "Already asserted."; return; }

    // HMAC identity is required to assert a local poll to the Exchange
    const creds = getExchangeHmacCredsOrNull();
    if (!creds) { if (out) out.textContent = "Missing identity: create/import an Exchange identity first."; return; }
    
    const localChoice = getLocalSelectedChoice(localPoll);

    // --- NEW: Fetch stamps once (human-triggered, not on app open) ---
    // This proves stamp issuance works, and stores the pool in localStorage.
    try {
      const before = getExchangeStampPool().length;
      if (!before) {
        if (out) out.textContent = "Fetching stamps…";
        await fetchStampsFromExchange();
      }
      const after = getExchangeStampPool().length;
      if (out) out.textContent = `Stamps stored: ${after}. Asserting…`;
    } catch (e) {
      // Stamp fetch failure should not block assertion (for now).
      console.warn("Stamp fetch failed:", e);
      if (out) out.textContent = "Stamp fetch failed (continuing assert)…";
    }

    // --- NEW: If this poll was already asserted before, reuse the existing exchange poll ---
    // We match by meta.created_local_id (which you already set during assert).
    try {
      const rList = await fetch(`${EXCHANGE_API}/polls`, { method: "GET" });
      if (rList.ok) {
        const list = await rList.json();
        const polls = Array.isArray(list?.polls) ? list.polls : [];

        // Find an exchange poll whose meta.created_local_id matches our local poll id.
        // If multiple exist (because of past duplicates), pick the newest by created_at.
        const matches = polls.filter(p => String(p?.meta?.created_local_id || "") === String(localKey));
        if (matches.length) {
          matches.sort((a, b) => String(b?.created_at || "").localeCompare(String(a?.created_at || "")));
          const found = matches[0];

          if (out) out.textContent = localChoice
            ? "Already on Exchange — casting your vote…"
            : "Already on Exchange — opening…";

          // If we have a local vote, cast it on the Exchange (visible failure, no rollback)
          if (localChoice) {
            try {
              // We only have an id here; fetch full poll to get options/ids
              const rList2 = await fetch(`${EXCHANGE_API}/polls`, { method: "GET" });
              if (rList2.ok) {
                const list2 = await rList2.json();
                const polls2 = Array.isArray(list2?.polls) ? list2.polls : [];
                const fullRemote = polls2.find(p => String(p?.id) === String(found.id));
                if (fullRemote) {
                  const r = await castExchangeVoteByLabel(fullRemote, localChoice, out);

                  // Ensure UI shows the selection after carry-forward
                  const vb = document.getElementById("voteButtons");
                  if (vb) renderVoteButtons(vb, fullRemote, localChoice);

                  // (optional) also refresh results immediately from the returned payload
                  if (r?.results) {
                    updatePollResults(fullRemote.id, r.results);
                    renderPrettyResults(fullRemote, normalizeResults(r.results));
                  }
                }
              }
            } catch (e) {
              if (out) out.textContent = "Vote carry failed (network). Poll is live.";
              console.warn(e);
            }
          }

          // Exchange is authoritative: purge local reality
          purgeLocalPollState(pollId);

          await refreshPolls();
          await openPoll({ id: found.id, is_local: false });
          return;

        }
      }
    } catch (e) {
      // If lookup fails, we fall back to POST assert below.
      console.warn("Exchange poll lookup failed (continuing with POST):", e);
    }

    // Build exchange-shaped canonical payload from existing local fields (no re-asking)
    const payload = {
      title: localPoll.title,
      description: localPoll.question_html || "",
      type: "single",
      options: (localPoll.options || []).map(label => ({ label: String(label) })),
      meta: {
        poll_type: localPoll.poll_type || "",
        question_html: localPoll.question_html || "",
        created_local_id: localKey,
        asserted_at: Date.now(),
      },
    };

    try {
      const r = await exchangeFetchAuthed("/polls", {
        method: "POST",
        body: payload,
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

      // Optional: carry local vote forward (visible failure, no rollback)
      if (localChoice) {
        if (out) out.textContent = "Poll live — casting your vote…";
        try {
          const r = await castExchangeVoteByLabel(remotePoll, localChoice, out);

          const vb = document.getElementById("voteButtons");
          if (vb) renderVoteButtons(vb, remotePoll, localChoice);

          if (r?.results) {
            updatePollResults(remotePoll.id, r.results);
            renderPrettyResults(remotePoll, normalizeResults(r.results));
          }
        } catch (e) {
          if (out) out.textContent = "Vote carry failed (network). Poll is live.";
          console.warn(e);
        }
      } else {
        if (out) out.textContent = "Poll live on Exchange.";
      }

      // Exchange is authoritative: purge local poll + local votes
      purgeLocalPollState(pollId);

      await refreshPolls();
      await openPoll({ id: remotePoll.id, is_local: false });
    } catch (e) {
      if (out) out.textContent = "Assert failed (network error).";
      console.log(e);
    }
  }

  async function getOrFetchOneStampOrNull() {
    // If we already have stamps, pick one.
    const pool = getExchangeStampPool();
    if (pool.length) return pickOneStampOrNull();

    // If we have an identity (HMAC creds), try to mint stamps.
    const creds = getExchangeHmacCredsOrNull();
    if (!creds) return null;

    try {
      await fetchStampsFromExchange();
      return pickOneStampOrNull();
    } catch (e) {
      console.warn("Stamp fetch failed:", e);
      return null;
    }
  }
 
  async function castVote(poll, optionId, labelForUI) {
    const statusEl = document.getElementById("voteStatus");

    const pollId = poll?.id;
    if (!pollId) return;

    const isLocal = !!poll?.is_local || String(pollId).startsWith("local_");

    // -------------------------
    // LOCAL VOTE PATH
    // -------------------------
    if (isLocal) {
      try {
        // Store the selection locally so assert can carry it forward later
        const token = ensureLocalToken(pollId);

        // Local polls: options are usually ["Yes","No"] etc.
        const labels = (poll?.options || []).map(o => (o?.label ?? o));

        setLocalVote(pollId, token, String(labelForUI), labels);

        // Re-render buttons with highlight
        const vb = document.getElementById("voteButtons");
        if (vb) renderVoteButtons(vb, poll, String(labelForUI));

        // Re-render local results immediately
        const res = buildLocalResults(poll);
        const norm = normalizeResults(res);
        renderPrettyResults(poll, norm);

        if (statusEl) statusEl.textContent = "Saved locally.";
      } catch (e) {
        if (statusEl) statusEl.textContent = String(e);
        console.log(e);
      }
      return;
    }

    // -------------------------
    // REMOTE (EXCHANGE) VOTE PATH
    // -------------------------
    try {
      const result = await castExchangeVoteByLabel(poll, labelForUI, statusEl);

      // After a successful vote, refresh the poll view so results + highlight update
      if (result?.ok) {
        setRemoteLastChoice(pollId, labelForUI);

        // Force a quick refresh of the remote poll list (so results appear)
        try { await refreshPolls(); } catch {}

        // Re-open the poll using the id we just voted on
        try { await openPoll({ id: pollId, is_local: false }); } catch {}
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = String(e);
      console.log(e);
    }
  }

  // =========================
  // Phase 1: Tabs / page switching
  // =========================
  function showTab(tabName) {
    // Remember current tab in memory (you already added currentTab)
    currentTab = tabName;

    // Find the 3 page containers from the new HTML
    const viewCreate = document.getElementById("viewCreate");
    const viewPolls = document.getElementById("viewPolls");
    const viewSettings = document.getElementById("viewSettings");

    // Hide all, then show the requested one
    if (viewCreate) viewCreate.style.display = (tabName === "create") ? "" : "none";
    if (viewPolls) viewPolls.style.display = (tabName === "polls") ? "" : "none";
    if (viewSettings) viewSettings.style.display = (tabName === "settings") ? "" : "none";

    // Update tab visual active state (uses your existing .pill.active CSS)
    const tabCreate = document.getElementById("tabCreate");
    const tabPolls = document.getElementById("tabPolls");
    const tabSettings = document.getElementById("tabSettings");

    if (tabCreate) tabCreate.classList.toggle("active", tabName === "create");
    if (tabPolls) tabPolls.classList.toggle("active", tabName === "polls");
    if (tabSettings) tabSettings.classList.toggle("active", tabName === "settings");
  }

  function showPollList() {
    const listCard = document.getElementById("pollsListCard");
    const pollView = document.getElementById("pollView");
    if (listCard) listCard.style.display = "";
    if (pollView) pollView.style.display = "none";
    inPollDetail = false;
  }

  function showPollDetail() {
    const listCard = document.getElementById("pollsListCard");
    const pollView = document.getElementById("pollView");
    if (listCard) listCard.style.display = "none";
    if (pollView) pollView.style.display = "block";
    inPollDetail = true;
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

    // =========================
    // Settings: Identity wiring (device-local)
    // =========================
    const identityDisplayNameEl = document.getElementById("identityDisplayName");
    const identityPasswordEl = document.getElementById("identitySigningKey"); // UX label is "Password"
    const createIdentityBtn = document.getElementById("createIdentityBtn");
    const copyRecoveryBtn = document.getElementById("copyIdentityBackupBtn");
    const identityStatus = document.getElementById("identityStatus");
    const exchangeStatus = document.getElementById("exchangeStatus"); // optional status line on Settings

    // Load saved display name
    if (identityDisplayNameEl) {
      identityDisplayNameEl.value = (localStorage.getItem("exchange_display_name") || "");
      identityDisplayNameEl.onchange = () => {
        localStorage.setItem("exchange_display_name", String(identityDisplayNameEl.value || "").trim());
      };
    }

    // If identity exists, hide Create button.
    const refreshIdentityUi = () => {
      const has = !!getExchangeHmacCredsOrNull();
      if (createIdentityBtn) createIdentityBtn.style.display = has ? "none" : "";
      if (copyRecoveryBtn) copyRecoveryBtn.style.display = has ? "" : "none";
      if (identityPasswordEl) {
        // Never show the stored signing key; just show a neutral placeholder
        identityPasswordEl.value = "";
        identityPasswordEl.placeholder = has
          ? "Identity is stored on this device. Use Copy Recovery Code if needed."
          : "Create identity to enable Exchange actions (or paste recovery key + save).";
      }
      if (identityStatus) identityStatus.textContent = has
        ? "Identity loaded (details hidden)."
        : "No identity on this device.";
    };

    // Allow “import” by pasting the signing key and hitting Enter (MVP).
    // NOTE: Without self_id we can’t sign; so this is placeholder until we add full recovery paste format.
    if (identityPasswordEl) {
      identityPasswordEl.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          // We intentionally do NOT support partial import here yet.
          // Recovery is via the copied JSON blob (next button).
          if (identityStatus) identityStatus.textContent = "Use Copy Recovery Code to backup, or Create Identity to generate.";
        }
      };
    }

    if (createIdentityBtn) {
      createIdentityBtn.onclick = async () => {
        try {
          if (createIdentityBtn) createIdentityBtn.disabled = true;
          const data = await exchangeCreateIdentityWithPow(identityStatus);
          if (identityStatus) identityStatus.textContent = "Identity created. Copy your recovery code now.";
          refreshIdentityUi();

          // Seed stats placeholders (we will populate from stamps after first assert/mint)
          const tp = document.getElementById("statTrustPoints");
          const et = document.getElementById("statEarnedTrust");
          const dt = document.getElementById("statDelegatedTrust");
          if (tp) tp.textContent = "1";
          if (et) et.textContent = "—";
          if (dt) dt.textContent = "—";

          if (exchangeStatus) exchangeStatus.textContent = "Identity ready. Assert will mint stamps as needed.";
        } catch (e) {
          if (identityStatus) identityStatus.textContent = String(e?.message || e);
        } finally {
          if (createIdentityBtn) createIdentityBtn.disabled = false;
        }
      };
    }

    if (copyRecoveryBtn) {
      copyRecoveryBtn.onclick = async () => {
        try {
          const self_id = getExchangeSelfIdOrNull();
          const signing_key = getExchangeSigningKeyOrNull();
          const public_alias = getExchangeAliasOrNull();

          if (!self_id || !signing_key) {
            if (identityStatus) identityStatus.textContent = "No identity to back up.";
            return;
          }

          // Copy a JSON blob (human-auditable)
          const blob = JSON.stringify({ self_id, signing_key, public_alias }, null, 2);

          await copyTextToClipboardOrThrow(blob);

          if (identityStatus) identityStatus.textContent = "Recovery code copied to clipboard. Store it safely.";
        } catch (e) {
          if (identityStatus) identityStatus.textContent = `Copy failed: ${String(e?.message || e)}`;
        }
      };
    }

    refreshIdentityUi();

    // Close poll view
    const closeBtn = document.getElementById("closePoll");
    if (closeBtn) {
      closeBtn.onclick = () => {
        closeStream();
        showPollList();
        const pollView = document.getElementById("pollView");
        if (pollView) pollView.style.display = "none";
      };
    }
      
    // Back to list (Poll Detail -> Poll List)
    const backToListBtn = document.getElementById("backToList");
    if (backToListBtn) {
      backToListBtn.onclick = () => {
        currentPollId = null;
        showPollList(); // you will add/confirm this helper in the next step
        // Optional: clear hash so reload doesn't auto-open
        // window.location.hash = "";
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
      // =========================
    // Phase 1: Global tabs wiring
    // =========================
    const tabCreate = document.getElementById("tabCreate");
    const tabPolls = document.getElementById("tabPolls");
    const tabSettings = document.getElementById("tabSettings");

    if (tabCreate) tabCreate.onclick = () => showTab("create");
    if (tabPolls) tabPolls.onclick = () => showTab("polls");
    if (tabSettings) tabSettings.onclick = () => showTab("settings");

    // Default view on startup
    showTab(currentTab || "create");

    if (backToListBtn) {
      backToListBtn.onclick = () => {
        currentPollId = null;
        showPollList();
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