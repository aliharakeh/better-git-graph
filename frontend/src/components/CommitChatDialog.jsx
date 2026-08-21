import { useEffect, useRef, useState } from "react"
import { Bot, Loader2, Send, X } from "lucide-react"
import { CommitChat } from "../../wailsjs/go/main/App"
import { wailsError } from "../lib/utils"
import { Button } from "./ui/button"

// Modal AI chat about the commits currently selected in the inspector. The
// backend gives the model a get_commit_diff tool, so questions about what the
// commits changed are answered against the real diffs.
export function CommitChatDialog({ path, context, onClose }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState("")
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState(null)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, pending])

  async function send(text) {
    const prompt = (text ?? input).trim()
    if (!prompt || pending) return
    const prior = messages
    setStatus(null)
    setInput("")
    setPending(true)
    setMessages((m) => [...m, { role: "user", content: prompt }])
    try {
      const reply = await CommitChat({ path, context, followUps: prior, prompt })
      setMessages((m) => [...m, { role: "assistant", content: reply }])
    } catch (e) {
      setStatus({ ok: false, text: wailsError(e) })
    } finally {
      setPending(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-lg">
        <div className="flex items-center gap-2 border-b border-border p-4">
          <Bot className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Ask about these commits</h3>
          <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={onClose} title="Close">
            <X className="size-4" />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-background p-4">
          {messages.length === 0 && !pending && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Ask what changed in these commits — e.g. “what did <code className="text-foreground">abc1234</code> change?”. The assistant
              fetches the real diff for each commit before answering.
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  m.role === "user" ? "bg-primary/15 text-foreground" : "border border-border bg-muted/40 text-foreground"
                }`}
              >
                <p className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${m.role === "user" ? "text-primary" : "text-muted-foreground"}`}>
                  {m.role === "user" ? "You" : "AI"}
                </p>
                <p className="whitespace-pre-wrap break-words">{m.content}</p>
              </div>
            </div>
          ))}
          {pending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Thinking — fetching diffs…
            </div>
          )}
          {status && <p className={`text-xs ${status.ok ? "text-muted-foreground" : "text-destructive"}`}>{status.text}</p>}
        </div>

        <div className="flex items-end gap-2 border-t border-border p-3">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            placeholder="Ask about the changed code…"
            className="max-h-40 min-h-9 flex-1 resize-y rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={pending}
            autoFocus
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <Button onClick={() => send()} disabled={pending || !input.trim()} title="Send">
            {pending ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </div>
      </div>
    </div>
  )
}
