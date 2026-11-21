import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { boot } from "./store/actions";
import "./styles.css";

void boot();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
