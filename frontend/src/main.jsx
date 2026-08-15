import React from "react"
import { createRoot } from "react-dom/client"
import "./style.css"
import App from "./App"

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0", "_"].includes(e.key)) e.preventDefault()
})
window.addEventListener("wheel", (e) => {
  if (e.ctrlKey) e.preventDefault()
}, { passive: false })

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
