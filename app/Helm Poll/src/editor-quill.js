export function initEditor() {
  const el = document.getElementById("questionEditor");
  if (!el || !window.Quill) {
    console.warn("Quill not available; editor disabled.");
    return;
  }

  window.App.quill = new Quill(el, {
    theme: "snow"
  });
}
