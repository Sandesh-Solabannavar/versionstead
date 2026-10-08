import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { applySavedAppearance } from "./theme";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");

// Before the first render, so the saved palette is there from the first frame.
applySavedAppearance();

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
