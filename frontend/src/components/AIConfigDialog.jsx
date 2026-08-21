import { useEffect, useState } from "react"
import { Loader2, Sparkles, X } from "lucide-react"
import { GetAIConfig, SaveAIConfig, TestAI } from "../../wailsjs/go/main/App"
import { wailsError } from "../lib/utils"
import { Button } from "./ui/button"
import { Input } from "./ui/input"

// Known providers, mirroring the defaults the Go side applies in
// resolveAIConfig. model/baseURL double as the "leave blank to use the
// default" placeholders shown in the form.
const PROVIDERS = [
  { id: "google", label: "Google Gemini", model: "gemini-2.5-flash", baseURL: "", keyRequired: true },
  { id: "openai", label: "OpenAI", model: "gpt-4o-mini", baseURL: "https://api.openai.com/v1", keyRequired: true },
  { id: "anthropic", label: "Anthropic", model: "", baseURL: "https://api.anthropic.com/v1", keyRequired: true },
  { id: "openrouter", label: "OpenRouter", model: "", baseURL: "https://openrouter.ai/api/v1", keyRequired: true },
  { id: "deepseek", label: "DeepSeek", model: "deepseek-chat", baseURL: "https://api.deepseek.com/v1", keyRequired: true },
  { id: "xai", label: "xAI (Grok)", model: "", baseURL: "https://api.x.ai/v1", keyRequired: true },
  { id: "opencode", label: "OpenCode (local)", model: "claude-sonnet-4-20250514", baseURL: "http://localhost:4096/v1", keyRequired: false },
]

const CUSTOM = "custom"

export function AIConfigDialog({ onClose, onSaved }) {
  const [info, setInfo] = useState(null)
  const [provider, setProvider] = useState("")
  const [customName, setCustomName] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [temperature, setTemperature] = useState("")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState(null)

  useEffect(() => {
    GetAIConfig()
      .then((cfg) => {
        setInfo(cfg)
        const known = PROVIDERS.some((p) => p.id === cfg.provider)
        setProvider(cfg.provider ? (known ? cfg.provider : CUSTOM) : "")
        setCustomName(known ? "" : cfg.provider || "")
        setModel(cfg.model || "")
        setBaseURL(cfg.baseURL || "")
        setTemperature(cfg.temperature != null ? String(cfg.temperature) : "")
      })
      .catch((e) => setStatus({ ok: false, text: wailsError(e) }))
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const prov = PROVIDERS.find((p) => p.id === provider)
  const keyOptional = provider === CUSTOM || (prov && !prov.keyRequired)
  const hasKey = !!info?.hasApiKey

  function pickProvider(next) {
    setProvider(next)
    // Provider-specific fields restart from the new provider's defaults.
    setCustomName("")
    setModel("")
    setBaseURL("")
  }

  function validate() {
    if (!provider) return null
    if (provider === CUSTOM) {
      if (!customName.trim()) return "Enter a name for the custom provider"
      if (!baseURL.trim()) return "Custom providers need a base URL"
    }
    if (prov?.keyRequired && !apiKey.trim() && !hasKey) return `${prov.label} needs an API key`
    if (!model.trim() && !prov?.model) return "Enter a model — this provider has no default"
    const t = temperature.trim()
    if (t !== "") {
      const n = Number(t)
      if (!Number.isFinite(n) || n < 0 || n > 2) return "Temperature must be between 0 and 2"
    }
    return null
  }

  async function save({ clearKey = false } = {}) {
    const problem = validate()
    if (problem) {
      setStatus({ ok: false, text: problem })
      return false
    }
    const t = temperature.trim()
    setSaving(true)
    try {
      await SaveAIConfig({
        provider: provider === CUSTOM ? customName.trim() : provider,
        baseURL: provider === "google" ? "" : baseURL.trim(),
        apiKey: clearKey ? "" : apiKey.trim(),
        model: model.trim(),
        temperature: t === "" || provider === "google" ? undefined : Number(t),
        clearApiKey: clearKey || undefined,
      })
      setApiKey("")
      setInfo(await GetAIConfig())
      setStatus({
        ok: true,
        text: !provider
          ? "Saved — AI disabled"
          : clearKey
            ? "Saved — API key removed"
            : hasKey && !apiKey.trim()
              ? "Saved — kept stored API key"
              : "Saved",
      })
      onSaved?.()
      return true
    } catch (e) {
      setStatus({ ok: false, text: wailsError(e) })
      return false
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    if (!(await save())) return
    setTesting(true)
    try {
      const reply = await TestAI()
      setStatus({ ok: true, text: `Model replied: ${reply || "(empty)"}` })
    } catch (e) {
      setStatus({ ok: false, text: wailsError(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-xl border border-border bg-card text-card-foreground shadow-lg">
        <div className="flex items-center gap-2 border-b border-border p-4">
          <Sparkles className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">AI provider</h3>
          <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={onClose} title="Close">
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Provider</label>
            <select
              value={provider}
              onChange={(e) => pickProvider(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-muted/60 px-3 text-sm text-foreground shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Disabled</option>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value={CUSTOM}>Custom (OpenAI-compatible)</option>
            </select>
            {!provider && <p className="text-[11px] text-muted-foreground">Disables AI features and removes the stored settings.</p>}
          </div>

          {provider !== "" && (
            <>
              {provider === CUSTOM && (
                <Field label="Provider name">
                  <Input value={customName} placeholder="my-gateway" onChange={(e) => setCustomName(e.target.value)} />
                </Field>
              )}

              <Field
                label="API key"
                action={
                  hasKey && !apiKey && provider !== "google" ? (
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                      onClick={() => save({ clearKey: true })}
                      disabled={saving}
                    >
                      Clear saved key
                    </button>
                  ) : null
                }
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder={hasKey ? "Key saved — paste to replace" : keyOptional ? "Optional" : "API key"}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </Field>

              <Field label="Model" hint={prov?.model ? `Blank uses ${prov.model}` : "No default model for this provider"}>
                <Input value={model} placeholder={prov?.model || "Required"} onChange={(e) => setModel(e.target.value)} />
              </Field>

              {provider !== "google" && (
                <Field
                  label="Base URL"
                  hint={
                    provider === CUSTOM
                      ? "Required — used verbatim as the API root; /chat/completions is appended"
                      : `Blank uses ${prov?.baseURL || "the provider default"}`
                  }
                >
                  <Input value={baseURL} placeholder={prov?.baseURL || "https://host/v1"} onChange={(e) => setBaseURL(e.target.value)} />
                </Field>
              )}

              {provider !== "google" && (
                <Field label="Temperature" hint="Sampling randomness, 0–2. Blank uses the provider default.">
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={temperature}
                    placeholder="Default"
                    className="[color-scheme:dark]"
                    onChange={(e) => setTemperature(e.target.value)}
                  />
                </Field>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border p-4">
          {status ? (
            <p className={`min-w-0 flex-1 truncate text-[11px] ${status.ok ? "text-muted-foreground" : "text-destructive"}`} title={status.text}>
              {status.text}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <Button variant="outline" onClick={test} disabled={!provider || saving || testing} title="Save the settings, then send a test prompt">
            {testing ? <Loader2 className="animate-spin" /> : null}
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button onClick={() => save()} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, action, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        {action}
      </div>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
