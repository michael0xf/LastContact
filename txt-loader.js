(function (global) {
  "use strict";

  const fetchText = async (url, options = {}) => {
    const response = await fetch(url, {
      cache: "no-cache",
      ...options
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return response.text();
  };

  const loadInto = async (target, url, options = {}) => {
    const element = typeof target === "string"
      ? document.querySelector(target)
      : target;

    if (!element) {
      throw new Error("TXT loader target element was not found");
    }

    const {
      fetchOptions = {},
      onLoad,
      onError,
      ...displayOptions
    } = options;

    try {
      const text = await fetchText(url, fetchOptions);
      element.textContent = text;
      if (typeof onLoad === "function") onLoad(text, element);
      return text;
    } catch (error) {
      if (displayOptions.showError !== false) {
        element.textContent = `Не удалось загрузить текст: ${error.message}`;
      }
      if (typeof onError === "function") onError(error, element);
      throw error;
    }
  };

  global.TxtLoader = Object.freeze({
    fetchText,
    loadInto
  });
})(window);
