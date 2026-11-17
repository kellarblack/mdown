import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startRouting } from "./routing";
import "./app.css";
import "./mobile.css";

try {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
} catch {
  /* fine */
}

startRouting();
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
