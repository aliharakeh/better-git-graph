package main

import (
	"encoding/json"
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
