async function loadLegacyApp() {
  const root = document.getElementById("legacy-root");
  if (!root) return;

  // 1) Fetch legacy HTML
  const htmlText = await fetch(new URL("./legacy/app.html", import.meta.url)).then(r => r.text());

  // 2) If it's a full document, inject only its <body> contents
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  root.innerHTML = doc.body ? doc.body.innerHTML : htmlText;

  // 3) Load legacy CSS
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./legacy/legacy.app.css", import.meta.url).toString();
  document.head.appendChild(css);

  // 4) Load legacy JS (as a module) and fire injected event after it loads
  const script = document.createElement("script");
  script.type = "module";
  script.src = new URL("./legacy/legacy.app.js", import.meta.url).toString();

  script.onload = () => {
    window.dispatchEvent(new CustomEvent("legacy:injected"));
  };

  script.onerror = (e) => {
    console.error("Failed to load legacy.app.js", e);
  };

  document.body.appendChild(script);
}

loadLegacyApp();
