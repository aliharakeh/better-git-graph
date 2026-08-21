package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/firebase/genkit/go/ai"
	"github.com/firebase/genkit/go/core/api"
	"github.com/firebase/genkit/go/genkit"
	"github.com/firebase/genkit/go/plugins/compat_oai"
	"github.com/firebase/genkit/go/plugins/googlegenai"
	openaiGo "github.com/openai/openai-go"
)

// This file holds the reusable AI setup: the Genkit runtime construction,
// provider plugin wiring, and the lazily-cached service that hands out a
// runtime for the current config. It is intentionally free of app-specific
// knowledge (like the git tool), so the same code can be dropped into another
// app. Configuration structs and resolution live in ai_config.go; the app's
// AI features live in ai_app.go.

// oaiChatConfig is the per-request config for OpenAI-compatible models served by
// this app. It embeds RequestConfig (per-request API-key override, version,
// passthrough) and adds the sampling knobs the app exposes.
type oaiChatConfig struct {
	compat_oai.RequestConfig

	Temperature     *float64 `json:"temperature,omitempty" jsonschema:"minimum=0,maximum=2" jsonschema_description:"Sampling temperature from 0 to 2."`
	MaxOutputTokens int      `json:"maxOutputTokens,omitempty" jsonschema:"minimum=1" jsonschema_description:"Maximum number of tokens to generate."`
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
// reuses it until the configuration changes.
type aiService struct {
	mu        sync.Mutex
	g         *genkit.Genkit
	cfg       AIProviderConfig
	modelName string
	tools     []ai.ToolRef
}

var aiSvc aiService

// ensure returns a cached Genkit runtime for cfg, building a fresh one (and
// registering the given tools on it) the first time the config is seen. All
// call sites must pass the same tools so an already-built runtime has exactly
// the set the caller needs; the git app always passes registerGitTools (see
// ai_app.go).
func (s *aiService) ensure(ctx context.Context, cfg AIProviderConfig, tools func(g *genkit.Genkit) []ai.ToolRef) (*genkit.Genkit, string, []ai.ToolRef, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.g != nil && s.cfg == cfg {
		return s.g, s.modelName, s.tools, nil
	}
	g, modelName, refs, err := buildAI(ctx, cfg, tools)
	if err != nil {
		return nil, "", nil, err
	}
	s.g = g
	s.cfg = cfg
	s.modelName = modelName
	s.tools = refs
	return g, modelName, refs, nil
}

// buildAI constructs a Genkit runtime with the plugin matching the provider
// and registers the app's tools via the tools callback, so the runtime
// construction here stays provider-agnostic and reusable. Plugin Init may
// panic on invalid credentials, so it is wrapped and converted to an error to
// keep the desktop app alive.
func buildAI(ctx context.Context, cfg AIProviderConfig, tools func(g *genkit.Genkit) []ai.ToolRef) (g *genkit.Genkit, modelName string, refs []ai.ToolRef, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("AI provider failed to initialize: %v", r)
		}
	}()

	if cfg.Provider == "google" {
		g = genkit.Init(ctx, genkit.WithPlugins(&googlegenai.GoogleAI{APIKey: cfg.APIKey}))
		if tools != nil {
			refs = tools(g)
		}
		return g, "googleai/" + cfg.Model, refs, nil
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
				Tools:      true, // tools are provided on every chat request
				Output:     []string{"text", "json"},
			},
		},
	}))
	if tools != nil {
		refs = tools(g)
	}
	return g, cfg.Provider + "/" + cfg.Model, refs, nil
}

// aiChat runs one generation against the configured model and returns the
// generated text. It loads the persisted config, (re)builds the runtime when
// the config changed, and returns user-friendly errors on provider failures.
// tools registers whatever tools the request needs and must match the tools
// used by every other call (see aiService.ensure).
func (a *App) aiChat(ctx context.Context, tools func(g *genkit.Genkit) []ai.ToolRef, system, prompt string) (string, error) {
	cfg, err := loadAIConfig()
	if err != nil {
		return "", err
	}
	cfg, err = resolveAIConfig(cfg)
	if err != nil {
		return "", err
	}
	g, model, _, err := aiSvc.ensure(ctx, cfg, tools)
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

// aiContext returns the Wails context, falling back to Background before the
// app has started up.
func (a *App) aiContext() (context.Context, context.CancelFunc) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, 2*time.Minute)
}
