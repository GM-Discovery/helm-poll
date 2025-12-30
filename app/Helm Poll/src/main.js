async function loadLegacyApp() {
  const root = document.getElementById("legacy-root");
  if (!root) return;

  // Load legacy HTML into the mount point
  const html = await fetch(new URL("./legacy/app.html", import.meta.url)).then(r => r.text());
  root.innerHTML = html;

  // Load legacy CSS
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./legacy/app.css", import.meta.url).toString();
  document.head.appendChild(css);

  // Load legacy JS
  const script = document.createElement("script");
  script.type = "module";
  script.src = new URL("./legacy/app.js", import.meta.url).toString();
  document.body.appendChild(script);
}

loadLegacyApp();

const { invoke } = window.__TAURI__.core;

let greetInputEl;
let greetMsgEl;

async function greet() {
  // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
  greetMsgEl.textContent = await invoke("greet", { name: greetInputEl.value });
}

window.addEventListener("DOMContentLoaded", () => {
  greetInputEl = document.querySelector("#greet-input");
  greetMsgEl = document.querySelector("#greet-msg");
  document.querySelector("#greet-form").addEventListener("submit", (e) => {
    e.preventDefault();
    greet();
  });
});
