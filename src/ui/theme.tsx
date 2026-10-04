import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { isTauriShell } from "./tauri-env";

export type Theme = "light" | "dark";
const STORAGE_KEY = "tatai.theme";
interface ThemeValue { theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void }
const ThemeContext = createContext<ThemeValue>({ theme: "light", setTheme: () => {}, toggleTheme: () => {} });

// Window.setTheme in installed @tauri-apps/api 2.11.1 invokes this exact command.
// The Rust 2.11.5 command defaults an omitted label to the current window. Using
// the injected bridge avoids adding a direct dependency just for this one call.
type NativeBridge = { invoke: (command: string, args: { value: Theme }) => Promise<unknown> };
let pendingNativeTheme: Theme | null = null;
let applyingNativeTheme = false;
function syncNativeTheme(theme: Theme): void {
  if (!isTauriShell()) return;
  pendingNativeTheme = theme;
  if (applyingNativeTheme) return;
  applyingNativeTheme = true;
  void (async () => {
    try {
      while (pendingNativeTheme !== null) {
        const next = pendingNativeTheme;
        pendingNativeTheme = null;
        try {
          const bridge = (window as Window & { __TAURI_INTERNALS__?: NativeBridge }).__TAURI_INTERNALS__;
          if (typeof bridge?.invoke !== "function") throw new Error("Tauri window bridge unavailable");
          await bridge.invoke("plugin:window|set_theme", { value: next });
        } catch (error) {
          // Older shells / denied permission retain usable web UI and a diagnostic.
          console.warn("[tatai] 原生窗口外观未更新，页面主题仍可使用：", error);
        }
      }
    } finally { applyingNativeTheme = false; }
  })();
}

/** A denied/full browser store must never prevent opening the workbench. */
function storedTheme(): Theme {
  try { return window.localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light"; }
  catch { return "light"; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(storedTheme);
  const setTheme = useCallback((next: Theme) => updateTheme(next), []);
  const toggleTheme = useCallback(() => updateTheme(current => current === "light" ? "dark" : "light"), []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch { /* Appearance still works for this session. */ }
    syncNativeTheme(theme);
  }, [theme]);
  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): ThemeValue => useContext(ThemeContext);
