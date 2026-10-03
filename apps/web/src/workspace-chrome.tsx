import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { workspaceHref } from "./settings-navigation";
import { hasOpenModal } from "./ui";

let mainAppHref = "/";
const Chrome = createContext<{
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  back: () => void;
  focusSettingsSearch: () => void;
} | null>(null);
export function WorkspaceChromeProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const href = useLocation({ select: (l) => l.href });
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("versionstead.sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const pendingSearchFocus = useRef(false);
  const focusSettingsSearch = useCallback(() => {
    if (collapsed) {
      pendingSearchFocus.current = true;
      setCollapsed(false);
    } else document.getElementById("settings-search")?.focus();
  }, [collapsed]);
  useLayoutEffect(() => {
    if (!collapsed && pendingSearchFocus.current) {
      pendingSearchFocus.current = false;
      document.getElementById("settings-search")?.focus();
    }
  }, [collapsed]);
  useEffect(() => {
    const next = workspaceHref(href);
    if (next !== null) mainAppHref = next;
  }, [href]);
  useEffect(() => {
    try {
      localStorage.setItem("versionstead.sidebar-collapsed", String(collapsed));
    } catch {
      /* Current session still works. */
    }
  }, [collapsed]);
  const back = useCallback(() => {
    void navigate({ href: mainAppHref });
  }, [navigate]);
  useEffect(() => {
    const root = document.documentElement;
    const desktop = window.versionstead;
    if (desktop) root.dataset.desktop = desktop.platform ?? "unknown";
    const overlay = (
      navigator as Navigator & { windowControlsOverlay?: EventTarget & { visible: boolean } }
    ).windowControlsOverlay;
    const update = () => root.classList.toggle("wco", Boolean(overlay?.visible));
    update();
    overlay?.addEventListener("geometrychange", update);
    return () => {
      overlay?.removeEventListener("geometrychange", update);
      root.classList.remove("wco");
      delete root.dataset.desktop;
    };
  }, []);
  useEffect(() => {
    if (!href.startsWith("/settings/")) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.key !== "Escape" ||
        hasOpenModal() ||
        (event.target instanceof HTMLElement &&
          event.target.closest('[data-slot="toast-viewport"]')) ||
        [...document.querySelectorAll<HTMLElement>('[data-slot$="popup"]')].some(
          (popup) =>
            popup.getClientRects().length > 0 && getComputedStyle(popup).visibility !== "hidden",
        )
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input,textarea,select,[contenteditable="true"]') &&
        event.target.id !== "settings-search"
      )
        return;
      event.preventDefault();
      back();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [href, back]);
  return <Chrome value={{ collapsed, setCollapsed, back, focusSettingsSearch }}>{children}</Chrome>;
}
export function useWorkspaceChrome() {
  const value = useContext(Chrome);
  if (!value) throw new Error("Workspace chrome provider is missing.");
  return value;
}
