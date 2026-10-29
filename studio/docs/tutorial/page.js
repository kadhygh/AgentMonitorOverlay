// 页面本身：右上角的深浅色切换（不记住，跟着系统开始）。
(function () {
  const btn = document.querySelector(".theme");
  if (!btn) return;
  const dark = () => {
    const r = document.documentElement;
    return r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const label = () => (btn.textContent = dark() ? "换成浅色" : "换成深色");
  btn.addEventListener("click", () => {
    document.documentElement.dataset.theme = dark() ? "light" : "dark";
    label();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", label);
  label();
})();
