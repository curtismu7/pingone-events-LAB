import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./standalone-ui.css";
import "./tokens.css";
import "./top-menu/top-menu.css";
import "./app.css";

createRoot(document.getElementById("root")).render(<App />);
