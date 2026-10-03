import { createContext, type RefObject } from "react";

// Native dialog is a browser top layer: body portals cannot appear above it.
export const DialogPortalContainer = createContext<RefObject<HTMLElement | null> | undefined>(
  undefined,
);
