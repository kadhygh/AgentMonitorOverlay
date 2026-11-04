// 展示页本身：深色开始，右上角切浅色；每一屏滚到时淡入（不看「减少动态效果」，原因见 engine.js）。
(function () {
  const root = document.documentElement;
  const btn = document.querySelector(".theme");
  const label = () => btn && (btn.textContent = root.dataset.theme === "light" ? "换成深色" : "换成浅色");
  btn?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    label();
  });
  label();
  const screens = document.querySelectorAll(".screen");
  if (!("IntersectionObserver" in window)) return screens.forEach((s) => s.classList.add("in"));
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
    { threshold: 0.18 },
  );
  screens.forEach((s) => io.observe(s));
})();
