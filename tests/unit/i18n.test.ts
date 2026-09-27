import { describe, expect, it } from "vitest";
import {
  APP_LANGUAGE_STORAGE_KEY,
  normalizeAppLanguage,
  readStoredAppLanguage,
  storeAppLanguage,
  t,
} from "@/lib/i18n";

describe("i18n translation system", () => {
  it("defaults to Italian and normalizes language codes", () => {
    expect(normalizeAppLanguage("it")).toBe("it");
    expect(normalizeAppLanguage("en")).toBe("en");
    expect(normalizeAppLanguage("fr")).toBe("it");
    expect(normalizeAppLanguage(null)).toBe("it");
  });

  it("translates keys in Italian by default", () => {
    expect(t("common.save")).toBe("Salva");
    expect(t("common.cancel")).toBe("Annulla");
    expect(t("dashboard.newProject")).toBe("Nuovo progetto");
    expect(t("shapes.box")).toBe("Cubo");
    expect(t("shapes.cylinder")).toBe("Cilindro");
    expect(t("shapes.sphere")).toBe("Sfera");
  });

  it("translates keys in English when requested", () => {
    expect(t("common.save", undefined, "en")).toBe("Save");
    expect(t("common.cancel", undefined, "en")).toBe("Cancel");
    expect(t("dashboard.newProject", undefined, "en")).toBe("New project");
    expect(t("shapes.box", undefined, "en")).toBe("Box");
  });

  it("interpolates parameters in messages", () => {
    expect(t("dashboard.deleteConfirmMessage", { name: "MioCubo" }, "it")).toBe(
      'Sei sicuro di voler eliminare "MioCubo"? Questa operazione non può essere annullata.'
    );
    expect(t("dashboard.deleteConfirmMessage", { name: "MyBox" }, "en")).toBe(
      'Are you sure you want to delete "MyBox"? This action cannot be undone.'
    );
  });

  it("persists language selection in storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    storeAppLanguage("en", storage);
    expect(values.get(APP_LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(readStoredAppLanguage(storage)).toBe("en");

    storeAppLanguage("it", storage);
    expect(values.get(APP_LANGUAGE_STORAGE_KEY)).toBe("it");
    expect(readStoredAppLanguage(storage)).toBe("it");
  });
});
