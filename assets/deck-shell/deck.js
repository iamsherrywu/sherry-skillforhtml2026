(() => {
  "use strict";

  const stage = document.getElementById("deck-stage");
  const slides = Array.from(stage.querySelectorAll(":scope > section.slide"));
  let currentIndex = 0;
  let touchStartX = null;

  function decodedHash() {
    try {
      return decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return "";
    }
  }

  function normalizedIndex(indexOrId) {
    if (typeof indexOrId === "number" && Number.isFinite(indexOrId)) {
      return Math.max(0, Math.min(slides.length - 1, Math.trunc(indexOrId)));
    }
    if (typeof indexOrId === "string") {
      const requestedId = indexOrId.replace(/^#/, "");
      const index = slides.findIndex((slide) => slide.id === requestedId);
      if (index >= 0) return index;
    }
    return currentIndex;
  }

  function show(indexOrId) {
    if (slides.length === 0) return null;
    currentIndex = normalizedIndex(indexOrId);
    slides.forEach((slide, index) => {
      const active = index === currentIndex;
      slide.classList.toggle("is-active", active);
      slide.setAttribute("aria-hidden", String(!active));
    });
    const id = slides[currentIndex].id;
    if (window.location.hash !== `#${id}`) {
      window.history.replaceState(null, "", `#${id}`);
    }
    return id;
  }

  function next() {
    return show(Math.min(currentIndex + 1, slides.length - 1));
  }

  function previous() {
    return show(Math.max(currentIndex - 1, 0));
  }

  function fit() {
    const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    return scale;
  }

  function currentId() {
    return slides[currentIndex]?.id ?? null;
  }

  function slideIds() {
    return slides.map((slide) => slide.id);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      document.documentElement.requestFullscreen?.();
    }
  }

  window.__sherryDeck = { show, next, previous, fit, currentId, slideIds };

  window.addEventListener("keydown", (event) => {
    if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      next();
    } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
      event.preventDefault();
      previous();
    } else if (event.key === "Home") {
      show(0);
    } else if (event.key === "End") {
      show(slides.length - 1);
    } else if (event.key.toLowerCase() === "f") {
      toggleFullscreen();
    }
  });

  window.addEventListener("touchstart", (event) => {
    touchStartX = event.changedTouches[0]?.clientX ?? null;
  }, { passive: true });

  window.addEventListener("touchend", (event) => {
    if (touchStartX === null) return;
    const distance = (event.changedTouches[0]?.clientX ?? touchStartX) - touchStartX;
    touchStartX = null;
    if (Math.abs(distance) < 48) return;
    if (distance < 0) next();
    else previous();
  }, { passive: true });

  window.addEventListener("hashchange", () => {
    show(decodedHash());
  });
  window.addEventListener("resize", fit);
  document.addEventListener("fullscreenchange", fit);

  const initialId = decodedHash();
  show(initialId || 0);
  fit();
})();
