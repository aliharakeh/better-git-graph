package main

import (
	"errors"
	"strings"
	"sync"

	"github.com/firebase/genkit/go/ai"
	"github.com/firebase/genkit/go/genkit"
)

// This file holds the AI features that are specific to this Git app: the
// get_commit_diff tool the model uses to inspect commits, the commit chat, and
// the config bindings the UI calls. The generic runtime setup lives in ai.go
// and ai_config.go so it can be reused by other apps.

// aiRepoPath is the repository the user currently has open. The
// get_commit_diff tool reads it at call time, and CommitChat updates it before
// each conversation.
var (
	aiRepoPathMu sync.Mutex
	aiRepoPath   string
)

// registerGitTools defines the tools this app exposes to the model. It is the
// tools callback handed to the reusable AI runtime, which keeps the git
// knowledge (and the open-repository binding) out of the setup code.
func registerGitTools(g *genkit.Genkit) []ai.ToolRef {
	const name = "get_commit_diff"
	desc := "Fetch the diff (code changes) introduced by a commit in the repository the user has open. " +
		"Use this to answer questions about what a commit changed, which files it touched, and the actual " +
		"added/removed lines. Pass the commit's hash; for merge commits you can diff against a specific " +
		"parent with the 'against' field, and stat=true returns just the per-file summary for large changes."

	diffTool := func(_ *ai.ToolContext, in commitDiffInput) (string, error) {
		aiRepoPathMu.Lock()
		path := strings.TrimSpace(aiRepoPath)
		aiRepoPathMu.Unlock()
		if path == "" {
			return "", errors.New("no repository is open — load a repository before asking about commits")
		}
		return commitDiff(path, in)
	}
	return []ai.ToolRef{genkit.DefineTool(g, name, desc, diffTool)}
}

// ChatMessage is one turn in a conversation: the sender role plus the text.
type ChatMessage struct {
	Role    string `json:"role"` // "user" or "assistant"
	Content string `json:"content"`
}

// CommitChatRequest is the input to CommitChat: the repository the user has
// open, a description of the commits they are asking about, any prior turns of
// the conversation, and the latest question.
type CommitChatRequest struct {
	Path      string        `json:"path"`
	Context   string        `json:"context"`
	FollowUps []ChatMessage `json:"followUps,omitempty"`
	Prompt    string        `json:"prompt"`
}

// commitChatSystem frames the assistant for the commit chat: it points it at
// the get_commit_diff tool and lists the commits in scope so it knows which
// hashes it can inspect.
func commitChatSystem(path, context string) string {
	var b strings.Builder
	b.WriteString("You are a coding assistant inside a Git commit visualizer, helping a developer understand specific commits in the repository they have open. ")
	if path != "" {
		b.WriteString("\nThe repository is:\n")
		b.WriteString(path)
	}
	b.WriteString("\nTo inspect actual code changes, call the get_commit_diff tool with a commit's hash. ")
	b.WriteString("Always call it before asserting what a commit changed, and quote the files and lines from the diff you rely on.")
	if c := strings.TrimSpace(context); c != "" {
		b.WriteString("\n\nThe user is asking about these commits:")
		b.WriteString("\n")
		b.WriteString(c)
	}
	b.WriteString("\nAnswer only about the commits listed; if asked about anything else, say it is outside the scope of these commits.")
	return b.String()
}

// CommitChat runs an AI conversation about the selected commits. The model is
// given the get_commit_diff tool so it fetches the actual diffs before
// answering questions about the changed code.
func (a *App) CommitChat(req CommitChatRequest) (string, error) {
	ctx, cancel := a.aiContext()
	defer cancel()

	cfg, err := loadAIConfig()
	if err != nil {
		return "", err
	}
	cfg, err = resolveAIConfig(cfg)
	if err != nil {
		return "", err
	}
	g, model, refs, err := aiSvc.ensure(ctx, cfg, registerGitTools)
	if err != nil {
		return "", err
	}

	aiRepoPathMu.Lock()
	aiRepoPath = strings.TrimSpace(req.Path)
	aiRepoPathMu.Unlock()

	msgs := []*ai.Message{ai.NewSystemTextMessage(commitChatSystem(req.Path, req.Context))}
	for _, m := range req.FollowUps {
		switch m.Role {
		case "user":
			msgs = append(msgs, ai.NewUserTextMessage(m.Content))
		case "assistant", "model":
			msgs = append(msgs, ai.NewTextMessage(ai.RoleModel, m.Content))
		}
	}
	msgs = append(msgs, ai.NewUserTextMessage(req.Prompt))

	opts := []ai.GenerateOption{
		ai.WithModelName(model),
		ai.WithMessages(msgs...),
	}
	if len(refs) > 0 {
		opts = append(opts, ai.WithTools(refs...))
	}
	if cfg.Provider != "google" && cfg.Temperature != nil {
		opts = append(opts, ai.WithConfig(oaiChatConfig{Temperature: cfg.Temperature}))
	}
	return genkit.GenerateText(ctx, g, opts...)
}

// GetAIConfig returns the persisted AI provider settings (API key omitted).
func (a *App) GetAIConfig() (AIConfigInfo, error) {
	cfg, err := loadAIConfig()
	if err != nil {
		return AIConfigInfo{}, err
	}
	return AIConfigInfo{
		Provider:    cfg.Provider,
		BaseURL:     cfg.BaseURL,
		Model:       cfg.Model,
		HasAPIKey:   cfg.APIKey != "",
		Temperature: cfg.Temperature,
	}, nil
}

// SaveAIConfig persists AI provider settings and validates them early so a
// config that cannot build is rejected with a clear message. The frontend
// never sees the stored API key, so an empty key keeps the previously stored
// one; ClearAPIKey removes it. An empty Provider disables AI. The resolved
// config (normalized provider, applied defaults) is what gets persisted.
func (a *App) SaveAIConfig(cfg AIProviderConfig) error {
	if cfg.Provider == "" {
		return saveAIConfig(AIProviderConfig{})
	}
	if cfg.APIKey == "" && !cfg.ClearAPIKey {
		if existing, err := loadAIConfig(); err == nil {
			cfg.APIKey = existing.APIKey
		}
	}
	resolved, err := resolveAIConfig(cfg)
	if err != nil {
		return err
	}
	resolved.ClearAPIKey = false
	return saveAIConfig(resolved)
}

// TestAI sends a tiny prompt to the configured model to verify credentials and
// connectivity.
func (a *App) TestAI() (string, error) {
	ctx, cancel := a.aiContext()
	defer cancel()
	return a.aiChat(ctx, registerGitTools, "", "Reply with exactly: OK")
}
