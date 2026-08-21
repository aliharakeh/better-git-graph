package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/firebase/genkit/go/ai"
	"github.com/firebase/genkit/go/core/api"
	"github.com/firebase/genkit/go/genkit"
	"github.com/firebase/genkit/go/plugins/compat_oai"
	"github.com/firebase/genkit/go/plugins/googlegenai"
	openaiGo "github.com/openai/openai-go"
)

// Provider choices that map to OpenAI-compatible endpoints (Genkit's
// compat_oai plugin). "google" is served by the googlegenai plugin instead.
func normalizeProvider(p string) string {
	p = strings.ToLower(strings.TrimSpace(p))
	switch p {
	case "google", "gemini", "googleai", "google-genai":
		return "google"
	default:
		return p
	}
}

// oaiDefaults are sensible starting values for well-known OpenAI-compatible
// providers. An empty baseURL means "use the provider's default endpoint" (the
// OpenAI SDK default). An empty model means the model is required from config.
type oaiDefaults struct {
	baseURL string
	model   string
}

var openAICompatDefaults = map[string]oaiDefaults{
	"opencode":   {baseURL: "http://localhost:4096/v1", model: "claude-sonnet-4-20250514"},
	"openai":     {baseURL: "", model: "gpt-4o-mini"},
	"openrouter": {baseURL: "https://openrouter.ai/api/v1", model: ""},
	"anthropic":  {baseURL: "https://api.anthropic.com/v1", model: ""},
	"deepseek":   {baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat"},
	"xai":        {baseURL: "https://api.x.ai/v1", model: ""},
}

// resolveAIConfig normalizes the provider and applies defaults, returning a
// config that is guaranteed to be buildable (or an actionable error).
func resolveAIConfig(cfg AIProviderConfig) (AIProviderConfig, error) {
	p := normalizeProvider(cfg.Provider)
	if p == "" {
		return cfg, fmt.Errorf("no AI provider configured")
	}
	cfg.Provider = p

	if p == "google" {
		if cfg.APIKey == "" {
			return cfg, fmt.Errorf("google models need an API key (GEMINI_API_KEY)")
		}
		if cfg.Model == "" {
			cfg.Model = "gemini-2.5-flash"
		}
		return cfg, nil
	}

	if d, ok := openAICompatDefaults[p]; ok {
		if cfg.BaseURL == "" {
			cfg.BaseURL = d.baseURL
		}
		if cfg.Model == "" {
			cfg.Model = d.model
		}
	} else if cfg.BaseURL == "" {
		return cfg, fmt.Errorf("provider %q needs a baseURL pointing at an OpenAI-compatible endpoint", p)
	}
	if cfg.Model == "" {
		return cfg, fmt.Errorf("no model configured for provider %q", p)
	}
	return cfg, nil
}

// oaiBaseURL normalizes a user-supplied OpenAI-compatible base URL so the SDK
// builds the endpoint the user intended. The openai-go SDK resolves the
// per-request path ("chat/completions") against the base URL, and that
// resolution silently drops the last path segment when the base URL has no
// trailing slash (so ".../v1" would become ".../chat/completions"). Ending the
// root with a slash yields exactly <base>/chat/completions. If the user pasted
// the full endpoint, that suffix is dropped first so it is not doubled.
func oaiBaseURL(base string) string {
	b := strings.TrimSpace(base)
	if b == "" {
		return ""
	}
	b = strings.TrimRight(b, "/")
	if strings.HasSuffix(strings.ToLower(b), "/chat/completions") {
		b = b[:len(b)-len("/chat/completions")]
	}
	return b + "/"
}

// chatConfig is the per-request config for OpenAI-compatible models served by
// this app. It embeds RequestConfig (per-request API-key override, version,
// passthrough) and adds the sampling knobs the app exposes.
type oaiChatConfig struct {
	compat_oai.RequestConfig

	Temperature    *float64 `json:"temperature,omitempty" jsonschema:"minimum=0,maximum=2" jsonschema_description:"Sampling temperature from 0 to 2."`
	MaxOutputTokens int     `json:"maxOutputTokens,omitempty" jsonschema:"minimum=1" jsonschema_description:"Maximum number of tokens to generate."`
}

func (c oaiChatConfig) ApplyToChatCompletion(params *openaiGo.ChatCompletionNewParams) {
	c.ApplyVersion(params)
	if c.Temperature != nil {
		params.Temperature = openaiGo.Float(*c.Temperature)
	}
	if c.MaxOutputTokens > 0 {
		params.MaxCompletionTokens = openaiGo.Int(int64(c.MaxOutputTokens))
	}
}

// oaiPlugin adapts an OpenAI-compatible endpoint into a Genkit plugin. Its
// Init builds the client and returns the model action, which genkit.Init then
// registers under "<provider>/<model>".
type oaiPlugin struct {
	comp    *compat_oai.OpenAICompatible
	modelID string
	model   ai.ModelOptions
}

func (p *oaiPlugin) Name() string { return p.comp.Provider }

func (p *oaiPlugin) Init(ctx context.Context) []api.Action {
	p.comp.Init(ctx)
	return []api.Action{
		compat_oai.NewChatModel[oaiChatConfig](p.comp, p.modelID, p.model),
	}
}

// aiService lazily builds a Genkit runtime for the current AI config and
// reuses it until the configuration changes. toolRef is the get_commit_diff
// tool bound to repoPath, the repository the user currently has open.
type aiService struct {
	mu        sync.Mutex
	g         *genkit.Genkit
	cfg       AIProviderConfig
	modelName string
	toolRef   ai.ToolRef
	repoPath  string
}

var aiSvc aiService

func (s *aiService) ensure(ctx context.Context, cfg AIProviderConfig) (*genkit.Genkit, string, ai.ToolRef, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.g != nil && s.cfg == cfg {
		return s.g, s.modelName, s.toolRef, nil
	}
	g, modelName, toolRef, err := buildAI(ctx, cfg, &s.repoPath)
	if err != nil {
		return nil, "", nil, err
	}
	s.g = g
	s.cfg = cfg
	s.modelName = modelName
	s.toolRef = toolRef
	return g, modelName, s.toolRef, nil
}

// buildAI constructs a Genkit runtime with the plugin matching the provider and
// registers the get_commit_diff tool. Plugin Init may panic on invalid
// credentials, so it is wrapped and converted to an error to keep the desktop
// app alive.
func buildAI(ctx context.Context, cfg AIProviderConfig, repoPath *string) (g *genkit.Genkit, modelName string, toolRef ai.ToolRef, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("AI provider failed to initialize: %v", r)
		}
	}()

	const diffToolName = "get_commit_diff"
	diffTool := func(_ *ai.ToolContext, in commitDiffInput) (string, error) {
		path := strings.TrimSpace(*repoPath)
		if path == "" {
			return "", errors.New("no repository is open — load a repository before asking about commits")
		}
		return commitDiff(path, in)
	}
	diffDesc := "Fetch the diff (code changes) introduced by a commit in the repository the user has open. " +
		"Use this to answer questions about what a commit changed, which files it touched, and the actual " +
		"added/removed lines. Pass the commit's hash; for merge commits you can diff against a specific " +
		"parent with the 'against' field, and stat=true returns just the per-file summary for large changes."

	if cfg.Provider == "google" {
		g = genkit.Init(ctx, genkit.WithPlugins(&googlegenai.GoogleAI{APIKey: cfg.APIKey}))
		toolRef = genkit.DefineTool(g, diffToolName, diffDesc, diffTool)
		return g, "googleai/" + cfg.Model, toolRef, nil
	}

	g = genkit.Init(ctx, genkit.WithPlugins(&oaiPlugin{
		comp: &compat_oai.OpenAICompatible{
			Provider: cfg.Provider,
			APIKey:   cfg.APIKey,
			// Normalize here (not in the stored config) so the base URL is
			// kept exactly as the user entered it while the SDK still builds
			// <base>/chat/completions instead of mangling the last path.
			BaseURL: oaiBaseURL(cfg.BaseURL),
		},
		modelID: cfg.Model,
		model: ai.ModelOptions{
			Label: cfg.Provider + "/" + cfg.Model,
			Supports: &ai.ModelSupports{
				Multiturn:  true,
				SystemRole: true,
				Tools:      true, // get_commit_diff is provided on every chat request
				Output:     []string{"text", "json"},
			},
		},
	}))
	toolRef = genkit.DefineTool(g, diffToolName, diffDesc, diffTool)
	return g, cfg.Provider + "/" + cfg.Model, toolRef, nil
}

// aiChat runs one generation against the configured model and returns the
// generated text. It loads the persisted config, (re)builds the runtime when
// the config changed, and returns user-friendly errors on provider failures.
func (a *App) aiChat(ctx context.Context, system, prompt string) (string, error) {
	cfg, err := loadAIConfig()
	if err != nil {
		return "", err
	}
	cfg, err = resolveAIConfig(cfg)
	if err != nil {
		return "", err
	}
	g, model, _, err := aiSvc.ensure(ctx, cfg)
	if err != nil {
		return "", err
	}

	opts := []ai.GenerateOption{
		ai.WithModelName(model),
		ai.WithMessages(ai.NewSystemTextMessage(system), ai.NewUserTextMessage(prompt)),
	}
	if cfg.Provider != "google" && cfg.Temperature != nil {
		opts = append(opts, ai.WithConfig(oaiChatConfig{Temperature: cfg.Temperature}))
	}
	return genkit.GenerateText(ctx, g, opts...)
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
		b.WriteString("\nThe repository is:\n" + path)
	}
	b.WriteString("\nTo inspect actual code changes, call the get_commit_diff tool with a commit's hash. ")
	b.WriteString("Always call it before asserting what a commit changed, and quote the files and lines from the diff you rely on.")
	if c := strings.TrimSpace(context); c != "" {
		b.WriteString("\n\nThe user is asking about these commits:")
		b.WriteString("\n" + c)
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
	g, model, toolRef, err := aiSvc.ensure(ctx, cfg)
	if err != nil {
		return "", err
	}

	aiSvc.mu.Lock()
	aiSvc.repoPath = strings.TrimSpace(req.Path)
	aiSvc.mu.Unlock()

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
	if toolRef != nil {
		opts = append(opts, ai.WithTools(toolRef))
	}
	if cfg.Provider != "google" && cfg.Temperature != nil {
		opts = append(opts, ai.WithConfig(oaiChatConfig{Temperature: cfg.Temperature}))
	}
	return genkit.GenerateText(ctx, g, opts...)
}

// aiContext returns the Wails context, falling back to Background before the
// app has started up.
func (a *App) aiContext() (context.Context, context.CancelFunc) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, 2*time.Minute)
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
	return a.aiChat(ctx, "", "Reply with exactly: OK")
}
