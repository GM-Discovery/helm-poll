async function loadLegacyApp() {
  const root = document.getElementById("legacy-root");
  if (!root) return;

  // Fetch legacy HTML and inject its body into the root container.
  const htmlText = await fetch(new URL("./legacy/app.html", import.meta.url)).then(r => r.text());
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  root.innerHTML = doc.body ? doc.body.innerHTML : htmlText;

  // Load legacy CSS.
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./legacy/legacy.app.css", import.meta.url).toString();
  document.head.appendChild(css);

  // Load legacy JS and notify once injected.
  const script = document.createElement("script");
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
