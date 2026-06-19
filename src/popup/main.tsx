import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing — popup html is broken.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
