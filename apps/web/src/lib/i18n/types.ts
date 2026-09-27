import type { it } from "./locales/it";

export type AppLanguage = "it" | "en";

export type TranslationSchema = typeof it;

export type Leaves<T> = T extends object
  ? { [K in keyof T]: `${Exclude<K, symbol>}${Leaves<T[K]> extends never ? "" : `.${Leaves<T[K]>}`}` }[keyof T]
  : never;

export type TranslationKey = Leaves<TranslationSchema>;

export type TranslationParams = Record<string, string | number>;
