package main

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/firebase/genkit/go/ai"
	"github.com/firebase/genkit/go/genkit"
)

func TestResolveAIConfig(t *testing.T) {
	tests := []struct {
		name     string
		cfg      AIProviderConfig
		wantProv string
		wantMod  string
		wantErr  string
	}{
		{name: "empty provider", cfg: AIProviderConfig{}, wantErr: "no AI provider"},
		{name: "google default model", cfg: AIProviderConfig{Provider: "google", APIKey: "k"}, wantProv: "google", wantMod: "gemini-2.5-flash"},
		{name: "google needs key", cfg: AIProviderConfig{Provider: "gemini"}, wantErr: "API key"},
		{name: "google custom model", cfg: AIProviderConfig{Provider: "GoogleAI", APIKey: "k", Model: "gemini-2.0-flash"}, wantProv: "google", wantMod: "gemini-2.0-flash"},
		{name: "opencode defaults", cfg: AIProviderConfig{Provider: "opencode"}, wantProv: "opencode", wantMod: "claude-sonnet-4-20250514"},
		{name: "opencode custom base+model", cfg: AIProviderConfig{Provider: "opencode", BaseURL: "http://127.0.0.1:9999/v1", Model: "x", APIKey: "y"}, wantProv: "opencode", wantMod: "x"},
		{name: "openai default model", cfg: AIProviderConfig{Provider: "openai", APIKey: "k"}, wantProv: "openai", wantMod: "gpt-4o-mini"},
		{name: "unknown provider needs base url", cfg: AIProviderConfig{Provider: "myproxy", Model: "m"}, wantErr: "baseURL"},
		{name: "unknown provider with base url", cfg: AIProviderConfig{Provider: "myproxy", BaseURL: "http://x/v1", Model: "m"}, wantProv: "myproxy", wantMod: "m"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveAIConfig(tt.cfg)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("resolveAIConfig() error = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveAIConfig() unexpected error: %v", err)
			}
			if got.Provider != tt.wantProv || got.Model != tt.wantMod {
				t.Fatalf("resolveAIConfig() = (%s, %s), want (%s, %s)", got.Provider, got.Model, tt.wantProv, tt.wantMod)
			}
		})
	}
}

// TestOAIBaseURL verifies that an OpenAI-compatible base URL is used as-is
// (no path segments dropped or doubled) when the SDK resolves the
// "chat/completions" request path against it.
func TestOAIBaseURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/"},
		{"http://localhost:4096/v1/", "http://localhost:4096/v1/"},
		{"http://localhost:4096", "http://localhost:4096/"},
		{"https://myproxy.example.com/custom-endpoint", "https://myproxy.example.com/custom-endpoint/"},
		{"https://myproxy.example.com/custom-endpoint/chat/completions", "https://myproxy.example.com/custom-endpoint/"},
		{"  http://localhost:4096/v1  ", "http://localhost:4096/v1/"},
		{"", ""},
	}
	for _, c := range cases {
		if got := oaiBaseURL(c.in); got != c.want {
			t.Errorf("oaiBaseURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	// The SDK resolves the request path against the normalized base URL; this
	// mirrors the openai-go SDK's cfg.BaseURL.Parse("chat/completions").
	endpoints := map[string]string{
		"http://localhost:4096/v1":       "http://localhost:4096/v1/chat/completions",
		"https://openrouter.ai/api/v1":    "https://openrouter.ai/api/v1/chat/completions",
		"https://myproxy/custom-endpoint": "https://myproxy/custom-endpoint/chat/completions",
		"https://myproxy/chat/completions": "https://myproxy/chat/completions",
	}
	for in, want := range endpoints {
		base, err := url.Parse(oaiBaseURL(in))
		if err != nil {
			t.Fatalf("parse %q: %v", in, err)
		}
		got, err := base.Parse("chat/completions")
		if err != nil {
			t.Fatalf("resolve %q: %v", in, err)
		}
		if got.String() != want {
			t.Errorf("%q resolves to %s, want %s", in, got, want)
		}
	}
}

func TestAIConfigRoundTrip(t *testing.T) {
	prev := authDir
	authDir = t.TempDir()
	t.Cleanup(func() { authDir = prev })

	temp := 0.4
	cfg := AIProviderConfig{
		Provider:    "opencode",
		BaseURL:     "http://localhost:4096/v1",
		APIKey:      "sk-local",
		Model:       "claude-sonnet-4-20250514",
		Temperature: &temp,
	}
	if err := saveAIConfig(cfg); err != nil {
		t.Fatal(err)
	}
	got, err := loadAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.Provider != cfg.Provider || got.BaseURL != cfg.BaseURL || got.APIKey != cfg.APIKey || got.Model != cfg.Model {
		t.Fatalf("loadAIConfig() = %+v, want %+v", got, cfg)
	}
	if (got.Temperature == nil) != (cfg.Temperature == nil) || (got.Temperature != nil && *got.Temperature != *cfg.Temperature) {
		t.Fatalf("loadAIConfig() temperature = %v, want %v", got.Temperature, cfg.Temperature)
	}

	info, err := (&App{}).GetAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !info.HasAPIKey || info.Provider != "opencode" || info.Temperature == nil || *info.Temperature != 0.4 {
		t.Fatalf("GetAIConfig() = %+v", info)
	}
}

// TestSaveAIConfig verifies the save semantics the config UI relies on: an
// empty API key keeps the stored key, ClearAPIKey removes it, an empty
// provider disables AI, invalid configs are rejected, and the resolved
// config is what gets persisted.
func TestSaveAIConfig(t *testing.T) {
	prev := authDir
	authDir = t.TempDir()
	t.Cleanup(func() { authDir = prev })

	app := &App{}
	if err := app.SaveAIConfig(AIProviderConfig{Provider: "openai", APIKey: "sk-1"}); err != nil {
		t.Fatal(err)
	}

	// Saving without a key keeps the stored key; defaults are baked in.
	if err := app.SaveAIConfig(AIProviderConfig{Provider: "openai", Model: "gpt-4o"}); err != nil {
		t.Fatal(err)
	}
	got, err := loadAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.APIKey != "sk-1" || got.Model != "gpt-4o" {
		t.Fatalf("loadAIConfig() = %+v, want key sk-1 and model gpt-4o", got)
	}

	// ClearAPIKey removes the stored key and is not persisted.
	if err := app.SaveAIConfig(AIProviderConfig{Provider: "openai", Model: "gpt-4o", ClearAPIKey: true}); err != nil {
		t.Fatal(err)
	}
	got, err = loadAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.APIKey != "" || got.ClearAPIKey {
		t.Fatalf("loadAIConfig() = %+v, want empty key", got)
	}

	// Provider aliases normalize on save.
	if err := app.SaveAIConfig(AIProviderConfig{Provider: "Gemini", APIKey: "g"}); err != nil {
		t.Fatal(err)
	}
	got, err = loadAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.Provider != "google" || got.Model != "gemini-2.5-flash" {
		t.Fatalf("loadAIConfig() = %+v, want google defaults", got)
	}

	// An empty provider disables AI and wipes the stored settings.
	if err := app.SaveAIConfig(AIProviderConfig{}); err != nil {
		t.Fatal(err)
	}
	got, err = loadAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.Provider != "" || got.APIKey != "" {
		t.Fatalf("loadAIConfig() = %+v, want disabled config", got)
	}

	// Configs that cannot build are rejected without touching the stored one.
	if err := app.SaveAIConfig(AIProviderConfig{Provider: "google"}); err == nil {
		t.Fatal("expected error for google without key")
	}
	if err := app.SaveAIConfig(AIProviderConfig{Provider: "myproxy", Model: "m"}); err == nil {
		t.Fatal("expected error for unknown provider without baseURL")
	}
}

// TestAIModelAdvertisesTools ensures the built model action declares tool
// support: CommitChat always passes get_commit_diff, and Genkit rejects the
// request with "model does not support tool use" when Supports.Tools is false.
func TestAIModelAdvertisesTools(t *testing.T) {
	cfg, err := resolveAIConfig(AIProviderConfig{Provider: "opencode", APIKey: "sk-test"})
	if err != nil {
		t.Fatal(err)
	}
	g, modelName, _, err := aiSvc.ensure(context.Background(), cfg, registerGitTools)
	if err != nil {
		t.Fatal(err)
	}
	m := genkit.LookupModel(g, modelName)
	ma, ok := m.(*ai.ModelAction)
	if !ok {
		t.Fatalf("looked up model is %T, want *ai.ModelAction", m)
	}
	supports, ok := ma.Desc().Metadata["model"].(map[string]any)["supports"].(map[string]any)
	if !ok {
		t.Fatalf("model metadata missing supports map: %+v", ma.Desc().Metadata)
	}
	if tools, _ := supports["tools"].(bool); !tools {
		t.Fatalf("model %q is not advertised as tool-capable: supports=%v", modelName, supports)
	}
}

// TestAIServiceBuild verifies the OpenAI-compatible provider builds a Genkit
// runtime off a resolved config without network access (client creation is
// lazy) and that it is cached until the config changes.
func TestAIServiceBuild(t *testing.T) {
	cfg, err := resolveAIConfig(AIProviderConfig{Provider: "opencode", APIKey: "sk-test"})
	if err != nil {
		t.Fatal(err)
	}
	g1, model, refs, err := aiSvc.ensure(context.Background(), cfg, registerGitTools)
	if err != nil {
		t.Fatalf("ensure() = %v", err)
	}
	if model != "opencode/claude-sonnet-4-20250514" {
		t.Fatalf("model = %q", model)
	}
	if len(refs) != 1 || refs[0].Name() != "get_commit_diff" {
		t.Fatalf("expected get_commit_diff tool registered, got %v", refs)
	}
	g2, _, refs2, err := aiSvc.ensure(context.Background(), cfg, registerGitTools)
	if err != nil {
		t.Fatal(err)
	}
	if g1 != g2 {
		t.Fatal("expected cached Genkit runtime for identical config")
	}
	if len(refs2) != 1 || refs2[0].Name() != refs[0].Name() {
		t.Fatal("expected the same tool ref on a reused runtime")
	}

	// A different config must rebuild (and provider rename must not panic).
	cfg2, err := resolveAIConfig(AIProviderConfig{Provider: "myproxy", BaseURL: "http://unused:1/v1", Model: "m", APIKey: "k"})
	if err != nil {
		t.Fatal(err)
	}
	g3, model3, _, err := aiSvc.ensure(context.Background(), cfg2, registerGitTools)
	if err != nil {
		t.Fatalf("ensure(cfg2) = %v", err)
	}
	if g3 == g1 {
		t.Fatal("expected a new Genkit runtime for changed config")
	}
	if model3 != "myproxy/m" {
		t.Fatalf("model = %q", model3)
	}
}
