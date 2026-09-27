import { useState, useEffect, useCallback } from "react";
import { it } from "./locales/it";
import { en } from "./locales/en";
import type { AppLanguage, TranslationKey, TranslationParams } from "./types";

export * from "./types";

export const APP_LANGUAGE_STORAGE_KEY = "sketchforge.language";

export const APP_LANGUAGE_OPTIONS = [
  { value: "it", label: "Italiano" },
  { value: "en", label: "English" },
] as const;

const dictionaries = { it, en } as const;

let currentLanguage: AppLanguage = "it";

export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === "en" ? "en" : "it";
}

export function readStoredAppLanguage(storage?: Pick<Storage, "getItem"> | null): AppLanguage {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!store) return "it";
  try {
    return normalizeAppLanguage(store.getItem(APP_LANGUAGE_STORAGE_KEY));
  } catch {
    return "it";
  }
}

export function storeAppLanguage(
  language: AppLanguage,
  storage?: Pick<Storage, "setItem"> | null
) {
  currentLanguage = language;
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (store) {
    try {
      store.setItem(APP_LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Storage might be disabled
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("sketchforge:languageChange", { detail: language }));
  }
}

// Initialize from storage on browser
if (typeof window !== "undefined") {
  currentLanguage = readStoredAppLanguage();
}

function resolvePath(obj: any, path: string): string | undefined {
  const parts = path.split(".");
  let curr = obj;
  for (const part of parts) {
    if (!curr || typeof curr !== "object") return undefined;
    curr = curr[part];
  }
  return typeof curr === "string" ? curr : undefined;
}

export function t(key: TranslationKey, params?: TranslationParams, lang?: AppLanguage): string {
  const selectedLang = lang ?? currentLanguage;
  const dict = dictionaries[selectedLang] ?? it;
  let text = resolvePath(dict, key);
  
  if (text === undefined) {
    // Fallback to Italian, then to key itself
    text = resolvePath(it, key) ?? key;
  }

  if (params && typeof text === "string") {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }

  return text;
}

export function useTranslation() {
  const [lang, setLang] = useState<AppLanguage>(() => {
    return typeof window !== "undefined" ? readStoredAppLanguage() : "it";
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<AppLanguage>;
      if (customEvent.detail && (customEvent.detail === "it" || customEvent.detail === "en")) {
        setLang(customEvent.detail);
      }
    };
    window.addEventListener("sketchforge:languageChange", handler);
    return () => window.removeEventListener("sketchforge:languageChange", handler);
  }, []);

  const changeLanguage = useCallback((newLang: AppLanguage) => {
    storeAppLanguage(newLang);
    setLang(newLang);
  }, []);

  const translate = useCallback(
    (key: TranslationKey, params?: TranslationParams) => {
      return t(key, params, lang);
    },
    [lang]
  );

  return {
    t: translate,
    language: lang,
    setLanguage: changeLanguage,
    languages: APP_LANGUAGE_OPTIONS,
  };
}
