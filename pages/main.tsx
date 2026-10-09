import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AetherApp } from "@/components/aether-app";
import "./pages.css";

// The GitHub Pages build: the particle field alone, reading Coinbase from the browser.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AetherApp />
  </StrictMode>,
);
