(function (global) {
  "use strict";

  const LINES_PER_PAGE = 34;
  const COLOR_COUNT = 7;
  const VIEWER_VERSION = 2;
  let started = false;

  const styleText = `
    .doc-page { padding-top: 0; margin: 0 0 8px; }
    .doc-page + .doc-page { border-top: 1px solid rgba(232, 232, 232, 0.12); padding-top: 4px; }
    .page-label { text-align: center; font-size: 0.78em; line-height: inherit; color: cyan !important; margin: 0 0 2px; opacity: 0.62; }
    pre { margin: 0; font: inherit; tab-size: 4; }
    .text-block { --line-gutter-width: 6ch; --line-gutter-gap: 0.5ch; white-space: pre-wrap; overflow-wrap: break-word; }
    .text-block.line-numbered { white-space: normal; overflow-wrap: normal; }
    .line-row { display: grid; grid-template-columns: var(--line-gutter-width) minmax(0, 1fr); column-gap: var(--line-gutter-gap); align-items: start; }
    .line-row-even .line-content { color: lightgreen; }
    .line-row-color-0 .line-content { color: #ffcc80; }
    .line-row-color-1 .line-content { color: lightpink; }
    .line-row-color-2 .line-content { color: #ffee80; }
    .line-row-color-3 .line-content { color: lightgreen; }
    .line-row-color-4 .line-content { color: lightyellow; }
    .line-row-color-5 .line-content { color: cyan; }
    .line-row-color-6 .line-content { color: #ffddee; }
    .line-number { position: relative; min-height: 1em; padding-right: 0.25ch; text-align: right; color: cyan; font-size: 0.78em; line-height: inherit; opacity: 0.42; user-select: none; }
    .line-number-value { position: relative; z-index: 1; }
    .line-content { min-width: 0; white-space: pre-wrap; overflow-wrap: break-word; }
    .line-content-no-wrap { white-space: pre; overflow-wrap: normal; word-break: normal; }
    .line-content.align-center { text-align: center; }
    .line-content.align-right { text-align: right; }
    .line-content:empty::before { content: " "; }
    .align-center .line-content { text-align: center; }
    .align-center { text-align: center; }
    body[data-hide-page-dividers] .doc-page { margin-bottom: 0; }
    body[data-hide-page-dividers] .doc-page + .doc-page { border-top: 0; padding-top: 0; }
    body[data-hide-page-dividers] .page-label { display: none; }
    .viewer-version { color: cyan; font-size: 0.78em; line-height: inherit; opacity: 0.42; text-align: right; padding-right: 0.25ch; user-select: none; }
    .loading, .error, .file-load { color: cyan; }
    .file-load { margin-top: 8px; }
    .file-load input { display: block; max-width: 100%; margin-top: 4px; font: inherit; color: cyan; }
  `;

  const ensureStyles = () => {
    if (document.querySelector("style[data-text-viewer-styles]")) return;
    const style = document.createElement("style");
    style.dataset.textViewerStyles = "";
    style.textContent = styleText;
    document.head.append(style);
  };

  const startFractal = () => {
    const canvas = document.querySelector("[data-fractal-background]");
    if (!canvas || document.querySelector("[data-starfield]")) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false
    });
    if (!gl) return;

    const createShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
      return shader;
    };

    const vertexShader = createShader(gl.VERTEX_SHADER, `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, `
      precision highp float;
      uniform vec2 resolution;
      uniform vec2 center;
      uniform vec2 span;

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution;
        vec2 c = center + (uv - 0.5) * span;
        vec2 z = vec2(0.0);
        float iterations = 0.0;
        const float limit = 240.0;

        for (int i = 0; i < 240; i++) {
          if (dot(z, z) > 256.0) break;
          z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
          iterations += 1.0;
        }

        if (iterations >= limit) {
          gl_FragColor = vec4(0.003, 0.009, 0.035, 1.0);
          return;
        }

        float shade = pow(iterations / limit, 0.42);
        vec3 color = vec3(
          0.005 + shade * 0.018,
          0.018 + shade * 0.090,
          0.070 + shade * 0.300
        );
        gl_FragColor = vec4(color, 1.0);
      }
    `);
    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, "position");
    const resolutionLocation = gl.getUniformLocation(program, "resolution");
    const centerLocation = gl.getUniformLocation(program, "center");
    const spanLocation = gl.getUniformLocation(program, "span");
    let frame = 0;
    let scrollIdleTimer = 0;

    const draw = () => {
      frame = 0;
      const cssWidth = Math.max(1, global.innerWidth || 1);
      const cssHeight = Math.max(1, global.innerHeight || 1);
      const scale = Math.min(global.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(cssWidth * scale));
      const height = Math.max(1, Math.round(cssHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const maximumScroll = Math.max(1, document.documentElement.scrollHeight - cssHeight);
      const scrollPosition = Math.min(1, Math.max(0, global.scrollY / maximumScroll));
      const journey = scrollPosition * scrollPosition * (3.0 - 2.0 * scrollPosition);
      const zoom = Math.pow(2.0, -journey * 16.0);
      const startCenter = { real: -0.62, imaginary: 0.0 };
      const targetCenter = { real: -0.743643887037151, imaginary: 0.13182590420533 };
      const centerReal = targetCenter.real + (startCenter.real - targetCenter.real) * zoom;
      const centerImaginary = targetCenter.imaginary
        + (startCenter.imaginary - targetCenter.imaginary) * zoom;
      const spanX = 3.15 * zoom;
      const spanY = spanX * height / width;

      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(resolutionLocation, width, height);
      gl.uniform2f(centerLocation, centerReal, centerImaginary);
      gl.uniform2f(spanLocation, spanX, spanY);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const schedule = () => {
      if (!frame) frame = global.requestAnimationFrame(draw);
    };
    global.addEventListener("scroll", () => {
      global.clearTimeout(scrollIdleTimer);
      scrollIdleTimer = global.setTimeout(schedule, 300);
    }, { passive: true });
    global.addEventListener("resize", schedule);
    schedule();
  };

  const normalize = (value) => String(value).toLocaleLowerCase();

  const start = (options = {}) => {
    startFractal();
    if (started) return;

    const form = document.querySelector("[data-find-form]");
    const input = document.querySelector("[data-find-input]");
    const prevPageButton = document.querySelector("[data-prev-page]");
    const halfPageUpButton = document.querySelector("[data-half-page-up]");
    const findUpButton = document.querySelector("[data-find-up]");
    const halfPageDownButton = document.querySelector("[data-half-page-down]");
    const nextPageButton = document.querySelector("[data-next-page]");
    const root = document.querySelector("[data-pages-root]");
    if (!form || !input || !root) return;

    started = true;
    ensureStyles();

    const textUrl = options.textUrl || document.body.dataset.textUrl || "";
    let pages = [];
    let lastQuery = "";
    let lastMatch = null;
    let scrollHashTimer = 0;
    let imageFitFrame = 0;
    const versionElement = document.createElement("div");
    versionElement.className = "viewer-version";
    versionElement.textContent = `v${VIEWER_VERSION}`;
    root.parentElement.insertBefore(versionElement, root);

    const toolbarOffset = () => Math.ceil(
      document.querySelector(".toolbar-row")?.getBoundingClientRect().height || 0
    ) + 4;
    const viewportHeight = () => Math.floor(
      global.visualViewport?.height || document.documentElement.clientHeight || global.innerHeight
    );
    const pageLabelText = (pageNumber) => `page ${pageNumber}`;
    const imageLinePattern = /^\s*<img\s+([^>]*?)\/?>\s*$/iu;
    const attributePattern = /([^\s=\/<>{}]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;

    const parseImageLine = (line) => {
      const match = imageLinePattern.exec(line);
      if (!match) return null;
      const attributes = {};
      match[1].replace(attributePattern, (_, name, doubleQuoted, singleQuoted, bare) => {
        attributes[name.toLocaleLowerCase()] = doubleQuoted ?? singleQuoted ?? bare ?? "";
        return "";
      });
      const src = (attributes.src || "").trim();
      return src ? { src, alt: attributes.alt || "" } : null;
    };

    const appendText = (element, text) => {
      element.append(document.createTextNode(text));
    };

    const parseTextLine = (line) => {
      const centerMatch = /^\s*<center>([\s\S]*?)<\/center>\s*$/iu.exec(line);
      if (centerMatch) return { text: centerMatch[1], alignment: "center" };

      const rightMatch = /^\s*<p\s+align\s*=\s*["']right["']\s*>([\s\S]*?)<\/p>\s*$/iu.exec(line);
      if (rightMatch) return { text: rightMatch[1], alignment: "right" };

      return { text: line, alignment: "" };
    };

    const lineNumberedBlock = (block, firstLineNumber) => {
      if (block.classList.contains("line-numbered")) return firstLineNumber;
      const lines = block.textContent.split("\n");
      let nextLineNumber = firstLineNumber;
      block.textContent = "";
      block.classList.add("line-numbered");

      lines.forEach((line) => {
        const parsedLine = parseTextLine(line);
        const displayLine = parsedLine.text;
        const row = document.createElement("span");
        row.className = "line-row";

        const number = document.createElement("span");
        number.className = "line-number";
        number.setAttribute("aria-hidden", "true");

        const value = document.createElement("span");
        value.className = "line-number-value";
        if (displayLine.trim()) {
          const lineNumber = nextLineNumber;
          value.textContent = lineNumber;
          row.id = `line-${lineNumber}`;
          row.dataset.line = String(lineNumber);
          row.classList.add(`line-row-color-${lineNumber % COLOR_COUNT}`);
          if (lineNumber % 2 === 0) row.classList.add("line-row-even");
          nextLineNumber += 1;
        }
        number.append(value);

        const content = document.createElement("span");
        content.className = "line-content";
        if (parsedLine.alignment) content.classList.add(`align-${parsedLine.alignment}`);
        if (displayLine.trimStart().startsWith("|")) {
          content.classList.add("line-content-no-wrap");
        }
        appendText(content, displayLine);

        row.append(number, content);
        block.append(row);
      });

      return nextLineNumber;
    };

    const applyPageLabels = () => {
      root.querySelectorAll(".doc-page").forEach((page) => {
        const label = page.querySelector(".page-label");
        if (label && page.dataset.page) label.textContent = pageLabelText(page.dataset.page);
      });
    };

    const applyLineNumbers = () => {
      let lineNumber = 1;
      root.querySelectorAll(".text-block").forEach((block) => {
        if (!block.classList.contains("loading") && !block.classList.contains("error")) {
          lineNumber = lineNumberedBlock(block, lineNumber);
        }
      });
    };

    const availableImageHeight = () => Math.max(180, viewportHeight() - toolbarOffset() - 24);

    const fitImageBlock = (block) => {
      const image = block.querySelector("img");
      if (!image || !image.naturalWidth || !image.naturalHeight) return;
      const availableWidth = block.getBoundingClientRect().width;
      const heightByWidth = availableWidth * image.naturalHeight / image.naturalWidth;
      const maxHeight = availableImageHeight();
      if (heightByWidth > maxHeight) {
        block.classList.add("fit-height");
        image.style.width = "auto";
        image.style.height = `${maxHeight}px`;
      } else {
        block.classList.remove("fit-height");
        image.style.width = "";
        image.style.height = "";
      }
    };

    const fitAllImages = () => root.querySelectorAll(".image-block").forEach(fitImageBlock);
    const scheduleImageFits = () => {
      global.cancelAnimationFrame(imageFitFrame);
      imageFitFrame = global.requestAnimationFrame(fitAllImages);
    };

    const scrollToTop = (top, behavior = "smooth") => {
      try {
        global.scrollTo({ top, behavior });
      } catch (_) {
        global.scrollTo(0, top);
      }
    };

    const pageTop = (page) => Math.max(
      0,
      global.scrollY + page.getBoundingClientRect().top - toolbarOffset()
    );

    const pageForNode = (node) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return element?.closest(".doc-page") || null;
    };

    const lineRowForNode = (node) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return element?.closest(".line-row[data-line]") || null;
    };

    const lineRowsForPage = (page) => page
      ? Array.from(page.querySelectorAll(".line-row[data-line]"))
      : [];

    const closestLineRow = (page, requestedLine) => {
      const rows = lineRowsForPage(page);
      if (!rows.length) return null;
      if (!Number.isInteger(requestedLine) || requestedLine < 1) return rows[0];
      return rows.reduce((closest, row) => {
        const distance = Math.abs(Number(row.dataset.line) - requestedLine);
        const closestDistance = Math.abs(Number(closest.dataset.line) - requestedLine);
        return distance < closestDistance ? row : closest;
      });
    };

    const lineNumberForNode = (node) => {
      const row = lineRowForNode(node);
      return row ? Number(row.dataset.line) : null;
    };

    const locationFromHash = () => {
      const match = /^#page-(\d+)(?:-line-(\d+))?$/u.exec(global.location.hash);
      return match
        ? { pageNumber: match[1], lineNumber: match[2] ? Number(match[2]) : null }
        : null;
    };

    const replacePageHash = (page, lineNumber = null) => {
      if (!page?.dataset.page) return;
      const hash = Number.isInteger(lineNumber) && lineNumber > 0
        ? `#page-${page.dataset.page}-line-${lineNumber}`
        : `#page-${page.dataset.page}`;
      if (global.location.hash !== hash) history.replaceState({}, "", hash);
    };

    const pageIndexFromHash = () => {
      const target = locationFromHash();
      if (!target) return -1;
      if (target.lineNumber) {
        const lineRow = root.querySelector(`.line-row[data-line="${target.lineNumber}"]`);
        const linePage = lineRow?.closest(".doc-page");
        if (linePage) return pages.indexOf(linePage);
      }
      if (target.pageNumber) return pages.findIndex((page) => page.dataset.page === target.pageNumber);
      return -1;
    };

    const textNodes = () => {
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) if (node.nodeValue) nodes.push(node);
      return nodes;
    };

    const makeRange = (node, start, length) => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + length);
      return range;
    };

    const selectRange = (range) => {
      const selection = global.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      const toolbarHeight = toolbarOffset();
      const usableHeight = Math.max(1, viewportHeight() - toolbarHeight);
      const targetViewportCenter = toolbarHeight + usableHeight / 2;
      const matchCenter = rect.top + rect.height / 2;
      scrollToTop(Math.max(0, global.scrollY + matchCenter - targetViewportCenter));
    };

    const selectMatch = (query, node, start) => {
      const range = makeRange(node, start, query.length);
      lastMatch = { query: normalize(query), node, start, end: start + query.length };
      replacePageHash(pageForNode(node), lineNumberForNode(node));
      selectRange(range);
    };

    const findFirst = (query) => {
      const needle = normalize(query);
      for (const node of textNodes()) {
        const start = normalize(node.nodeValue).indexOf(needle);
        if (start !== -1) return { node, start };
      }
      return false;
    };

    const findLast = (query) => {
      const needle = normalize(query);
      let last = null;
      for (const node of textNodes()) {
        const haystack = normalize(node.nodeValue);
        let start = 0;
        while ((start = haystack.indexOf(needle, start)) !== -1) {
          last = { node, start };
          start += Math.max(query.length, 1);
        }
      }
      return last;
    };

    const findFromViewport = (query, direction) => {
      const needle = normalize(query);
      const viewportTop = toolbarOffset() + 2;
      let first = null;
      let previous = null;
      let last = null;
      for (const node of textNodes()) {
        const haystack = normalize(node.nodeValue);
        let start = 0;
        while ((start = haystack.indexOf(needle, start)) !== -1) {
          const match = { node, start };
          const top = makeRange(node, start, query.length).getBoundingClientRect().top;
          if (!first) first = match;
          last = match;
          if (direction === "down" && top >= viewportTop) return match;
          if (direction === "up") {
            if (top < viewportTop) previous = match;
            else if (previous) return previous;
          }
          start += Math.max(query.length, 1);
        }
      }
      return direction === "down" ? first : (previous || last);
    };

    const findAfterLast = (query) => {
      const needle = normalize(query);
      let afterLast = false;
      for (const node of textNodes()) {
        let start = 0;
        if (!afterLast) {
          if (!lastMatch || node !== lastMatch.node) continue;
          afterLast = true;
          start = lastMatch.end;
        }
        const haystack = normalize(node.nodeValue);
        const next = haystack.indexOf(needle, start);
        if (next !== -1) return { node, start: next };
      }
      return afterLast ? findFirst(query) : findFromViewport(query, "down");
    };

    const findBeforeLast = (query) => {
      const needle = normalize(query);
      let previous = null;
      for (const node of textNodes()) {
        const haystack = normalize(node.nodeValue);
        let start = 0;
        while ((start = haystack.indexOf(needle, start)) !== -1) {
          if (lastMatch && node === lastMatch.node && start >= lastMatch.start) {
            return previous || findLast(query);
          }
          previous = { node, start };
          start += Math.max(query.length, 1);
        }
      }
      return lastMatch ? previous : findFromViewport(query, "up");
    };

    const runFind = (direction) => {
      const query = input.value.trim();
      if (!query) return;
      const normalizedQuery = normalize(query);
      const sameQuery = normalizedQuery === lastQuery && lastMatch?.query === normalizedQuery;
      const match = sameQuery
        ? (direction === "down" ? findAfterLast(query) : findBeforeLast(query))
        : findFromViewport(query, direction);
      input.blur();
      lastQuery = normalizedQuery;
      if (match) selectMatch(query, match.node, match.start);
      else lastMatch = null;
    };

    const resetSearch = () => {
      lastQuery = "";
      lastMatch = null;
    };

    const currentPageIndex = () => {
      if (!pages.length) return 0;
      const marker = global.scrollY + toolbarOffset() + 6;
      let currentIndex = 0;
      pages.forEach((page, index) => {
        if (global.scrollY + page.getBoundingClientRect().top <= marker) currentIndex = index;
      });
      return currentIndex;
    };

    const navigationPageIndex = () => {
      const hashIndex = pageIndexFromHash();
      return hashIndex >= 0 ? hashIndex : currentPageIndex();
    };

    const currentLineNumber = (page) => {
      const rows = lineRowsForPage(page);
      if (!rows.length) return null;
      const marker = global.scrollY + toolbarOffset() + 6;
      let current = rows[0];
      rows.forEach((row) => {
        if (global.scrollY + row.getBoundingClientRect().top <= marker) current = row;
      });
      return Number(current.dataset.line);
    };

    const syncHashToCurrentPage = () => {
      if (!pages.length) return;
      const page = pages[currentPageIndex()];
      replacePageHash(page, currentLineNumber(page));
    };

    const scrollToPageIndex = (index, behavior = "smooth", shouldResetSearch = true, requestedLine = null) => {
      if (!pages.length) return;
      const safeIndex = Math.min(Math.max(index, 0), pages.length - 1);
      const page = pages[safeIndex];
      const lineRow = Number.isInteger(requestedLine) ? closestLineRow(page, requestedLine) : null;
      const destination = lineRow || page;
      const actualLine = lineRow ? Number(lineRow.dataset.line) : Number(closestLineRow(page, null)?.dataset.line) || null;
      scrollToTop(pageTop(destination), behavior);
      replacePageHash(page, actualLine);
      if (shouldResetSearch) resetSearch();
    };

    const maxScrollTop = () => Math.max(
      0,
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - viewportHeight()
    );
    const screenStep = () => Math.max(1, viewportHeight() - toolbarOffset()) * 0.75;
    const scrollByScreenStep = (direction) => {
      scrollToTop(Math.min(Math.max(global.scrollY + direction * screenStep(), 0), maxScrollTop()));
      resetSearch();
    };

    const createPage = (pageNumber) => {
      const section = document.createElement("section");
      section.className = "doc-page";
      section.id = `page-${pageNumber}`;
      section.dataset.page = String(pageNumber);
      const label = document.createElement("div");
      label.className = "page-label";
      label.textContent = pageLabelText(pageNumber);
      section.append(label);
      return section;
    };

    const appendTextPage = (pageNumber, lines) => {
      const section = createPage(pageNumber);
      const pre = document.createElement("pre");
      pre.className = "text-block";
      pre.textContent = lines.join("\n").replace(/\s+$/u, "");
      section.append(pre);
      root.append(section);
    };

    const appendImagePage = (pageNumber, image) => {
      const section = createPage(pageNumber);
      const block = document.createElement("div");
      block.className = "image-block";
      const element = document.createElement("img");
      element.src = image.src;
      element.alt = image.alt;
      element.loading = "lazy";
      element.decoding = "async";
      element.addEventListener("load", scheduleImageFits);
      block.append(element);
      section.append(block);
      root.append(section);
    };

    const renderPages = (text) => {
      root.innerHTML = "";
      const lines = text.replace(/\r\n?/gu, "\n").split("\n");
      let pageNumber = 1;
      let textLines = [];
      const flushTextPage = () => {
        if (!textLines.length) return;
        appendTextPage(pageNumber, textLines);
        pageNumber += 1;
        textLines = [];
      };
      for (const line of lines) {
        const image = parseImageLine(line);
        if (image) {
          flushTextPage();
          appendImagePage(pageNumber, image);
          pageNumber += 1;
        } else {
          textLines.push(line);
          if (textLines.length >= LINES_PER_PAGE) flushTextPage();
        }
      }
      flushTextPage();
      pages = Array.from(root.querySelectorAll(".doc-page"));
      applyPageLabels();
      applyLineNumbers();
      scheduleImageFits();
      resetSearch();
    };

    const renderError = (error) => {
      root.innerHTML = "";
      const section = createPage(1);
      const message = document.createElement("pre");
      message.className = "text-block error";
      message.textContent = `Не удалось автоматически загрузить текст: ${error.message}`;
      const fallback = document.createElement("div");
      fallback.className = "file-load";
      fallback.textContent = "Загрузить текст вручную:";
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".txt,text/plain";
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        renderPages(await file.text());
        scrollToPageIndex(0, "auto", false);
      });
      fallback.append(fileInput);
      section.append(message, fallback);
      root.append(section);
      pages = [section];
    };

    const scrollToHashTarget = () => {
      const target = locationFromHash();
      const index = pageIndexFromHash();
      if (index >= 0) scrollToPageIndex(index, "auto", false, target?.lineNumber);
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runFind("down");
    });
    input.addEventListener("input", resetSearch);
    findUpButton?.addEventListener("click", () => runFind("up"));
    prevPageButton?.addEventListener("click", () => scrollToPageIndex(navigationPageIndex() - 1));
    nextPageButton?.addEventListener("click", () => scrollToPageIndex(navigationPageIndex() + 1));
    halfPageUpButton?.addEventListener("click", () => scrollByScreenStep(-1));
    halfPageDownButton?.addEventListener("click", () => scrollByScreenStep(1));
    global.addEventListener("scroll", () => {
      global.clearTimeout(scrollHashTimer);
      scrollHashTimer = global.setTimeout(syncHashToCurrentPage, 120);
    });
    global.addEventListener("resize", scheduleImageFits);
    global.addEventListener("hashchange", scrollToHashTarget);

    const load = async (url = textUrl) => {
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      renderPages(await response.text());
      scrollToHashTarget();
      global.requestAnimationFrame(() => global.requestAnimationFrame(scrollToHashTarget));
    };

    load().catch(renderError);
  };

  global.TextViewerLibrary = Object.freeze({ start });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => start(), { once: true });
  } else {
    start();
  }
})(window);
