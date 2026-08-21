package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AIProviderConfig is the persisted AI provider settings. The API key is
// stored cleartext next to auth.json in the app's config directory. An empty
// Provider means AI is not configured. ClearAPIKey is a save-time flag that
// removes a stored key; it is never persisted.
type AIProviderConfig struct {
	Provider    string   `json:"provider"`
	BaseURL     string   `json:"baseURL,omitempty"`
	APIKey      string   `json:"apiKey,omitempty"`
	Model       string   `json:"model,omitempty"`
	Temperature *float64 `json:"temperature,omitempty"`
	ClearAPIKey bool     `json:"clearApiKey,omitempty"`
}

// AIConfigInfo is what the frontend sees: the persisted config without the
// API key, plus a flag for whether a key is stored.
type AIConfigInfo struct {
	Provider    string   `json:"provider"`
	BaseURL     string   `json:"baseURL,omitempty"`
	Model       string   `json:"model,omitempty"`
	HasAPIKey   bool     `json:"hasApiKey"`
	Temperature *float64 `json:"temperature,omitempty"`
}

// configDir returns the app's config directory. Tests override authDir to
// redirect both auth.json and ai.json to a temp directory.
func configDir() (string, error) {
	if authDir != "" {
		return authDir, nil
	}
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "git-merge-timeline"), nil
}

func aiConfigPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ai.json"), nil
}

func loadAIConfig() (AIProviderConfig, error) {
	p, err := aiConfigPath()
	if err != nil {
		return AIProviderConfig{}, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return AIProviderConfig{}, nil
		}
		return AIProviderConfig{}, err
	}
	var cfg AIProviderConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		return AIProviderConfig{}, err
	}
	return cfg, nil
}

func saveAIConfig(cfg AIProviderConfig) error {
	cfg.Provider = strings.TrimSpace(cfg.Provider)
	cfg.BaseURL = strings.TrimSpace(cfg.BaseURL)
	cfg.APIKey = strings.TrimSpace(cfg.APIKey)
	cfg.Model = strings.TrimSpace(cfg.Model)
	p, err := aiConfigPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

// normalizeProvider maps the provider names a user might type onto the
// canonical ids used by the plugins. "google" is served by the googlegenai
// plugin; every other provider goes through the OpenAI-compatible compat_oai
// plugin.
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
